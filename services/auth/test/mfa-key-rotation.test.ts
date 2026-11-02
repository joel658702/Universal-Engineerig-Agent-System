/**
 * Suite de TASK-005 — custodia de la clave maestra de MFA.
 *
 * Los tests de base de datos requieren PostgreSQL real: `SELECT ... FOR UPDATE`
 * y el ROLLBACK de verdad no existen en pg-mem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { decryptSecret, encryptSecret, generateMfaSecret, totpAt } from "../src/mfa.ts";
import { parseRecoveryArgs, recoverMfaLoss } from "../scripts/recover-mfa-loss.mjs";
import { rotateMfaKey } from "../scripts/rotate-mfa-key.mjs";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const USING_REAL_PG = Boolean(process.env["TEST_DATABASE_URL"]);
const SKIP_NO_PG = USING_REAL_PG ? false : "requiere PostgreSQL real: FOR UPDATE y ROLLBACK";

const PASSWORD = "correct-horse-battery-staple";

async function seedUserWithSecret(db: any, email: string, key: Buffer) {
  const user = await db.query<{ id: string }>(
    `insert into users (email, password_hash) values ($1, 'hash') returning id`,
    [email],
  );
  const userId = user.rows[0]!.id;

  const encrypted = encryptSecret(generateMfaSecret(), key);
  await db.query(
    `insert into user_mfa_secrets (user_id, secret_ciphertext, iv, auth_tag, key_id)
     values ($1, $2, $3, $4, 'v1')`,
    [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
  );

  return userId;
}

// ------------------------------------------------------- validación pura

test("recover exige usuario, confirmación y motivo", () => {
  const env = { OPERATOR: "ana" };
  assert.equal(parseRecoveryArgs([], env).ok, false);
  assert.equal(parseRecoveryArgs(["--user", "a"], env).ok, false);
  assert.equal(parseRecoveryArgs(["--user", "a", "--confirm", "a"], env).ok, false, "sin motivo");
  assert.equal(parseRecoveryArgs(["--user", "a", "--confirm", "a", "--reason", "ticket 1"], { OPERATOR: "" }).ok, false, "sin operador");
  assert.equal(parseRecoveryArgs(["--user", "a", "--confirm", "a", "--reason", "ticket 1"], env).ok, true);
});

test("la confirmación debe coincidir exactamente con el usuario", () => {
  const env = { OPERATOR: "ana" };
  const parsed = parseRecoveryArgs(["--user", "a@x.com", "--confirm", "b@x.com", "--reason", "ticket 1"], env);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /no coincide/);
});

// --------------------------------------------------------------- rotación

test("la rotación re-cifra todo y cambia key_id", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  const userId = await seedUserWithSecret(db, "rot@example.com", oldKey);

  const result = await rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2" });
  assert.equal(result.rotated, 1);

  const row = await db.query<any>(`select key_id, secret_ciphertext, iv, auth_tag from user_mfa_secrets where user_id = $1`, [userId]);
  assert.equal(row.rows[0].key_id, "v2");

  const record = { ciphertext: row.rows[0].secret_ciphertext, iv: row.rows[0].iv, authTag: row.rows[0].auth_tag };
  assert.doesNotThrow(() => decryptSecret(record, newKey), "la clave nueva debe descifrar");
  assert.throws(() => decryptSecret(record, oldKey), "la vieja ya no debe servir");
});

test("--dry-run no modifica nada", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  await seedUserWithSecret(db, "dry@example.com", oldKey);

  const result = await rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2", dryRun: true });
  assert.equal(result.total, 1);
  assert.equal(result.rotated, 0);

  const rows = await db.query<any>(`select key_id from user_mfa_secrets`);
  assert.equal(rows.rows[0].key_id, "v1", "el dry-run no puede tocar la tabla");
});

test("la rotación es idempotente", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  await seedUserWithSecret(db, "idem@example.com", oldKey);

  assert.equal((await rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2" })).rotated, 1);
  assert.equal((await rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2" })).rotated, 0, "la segunda no rota nada");
});

test("fallo a mitad: la transacción deja todos los key_id intactos", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  await seedUserWithSecret(db, "ok1@example.com", oldKey);
  const brokenId = await seedUserWithSecret(db, "ok2@example.com", oldKey);

  // Se corrompe el criptograma de la segunda fila: descifrar lanzará.
  await db.query(`update user_mfa_secrets set secret_ciphertext = 'AAAA' where user_id = $1`, [brokenId]);

  await assert.rejects(() => rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2" }));

  const rows = await db.query<any>(`select key_id from user_mfa_secrets order by key_id`);
  assert.deepEqual(rows.rows.map((r: any) => r.key_id), ["v1", "v1"], "ninguna fila puede haber cambiado");
});

// ------------------------------------------------------------ recuperación

test("recover desactiva MFA, revoca sesiones y deja auditoría", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const key = randomBytes(32);
  const userId = await seedUserWithSecret(db, "recover@example.com", key);

  await db.query(`update user_mfa_secrets set confirmed_at = now() where user_id = $1`, [userId]);
  await db.query(`insert into user_mfa_backup_codes (user_id, code_hash) values ($1, $2)`, [userId, "a".repeat(64)]);

  const result = await recoverMfaLoss({ client: db, user: "recover@example.com", operator: "ana", reason: "ticket #42" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.wasEnabled, true);

  const secrets = await db.query<any>(`select 1 from user_mfa_secrets where user_id = $1`, [userId]);
  assert.equal(secrets.rows.length, 0, "el secreto debe desaparecer");
  const codes = await db.query<any>(`select 1 from user_mfa_backup_codes where user_id = $1`, [userId]);
  assert.equal(codes.rows.length, 0, "los códigos deben desaparecer");

  const version = await db.query<any>(`select token_version from users where id = $1`, [userId]);
  assert.equal(version.rows[0].token_version, 2, "token_version debe subir");

  const audit = await db.query<any>(`select operator, reason, mfa_was_enabled from mfa_recovery_audit where user_id = $1`, [userId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].operator, "ana");
  assert.equal(audit.rows[0].reason, "ticket #42");
  assert.equal(audit.rows[0].mfa_was_enabled, true);
});

test("recover sobre usuario sin MFA no borra nada y audita el intento", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const user = await db.query<{ id: string }>(
    `insert into users (email, password_hash) values ('nomfa@example.com', 'h') returning id`,
  );

  const result = await recoverMfaLoss({ client: db, user: "nomfa@example.com", operator: "ana", reason: "ticket #43" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.wasEnabled, false);

  const audit = await db.query<any>(`select mfa_was_enabled from mfa_recovery_audit where user_id = $1`, [user.rows[0]!.id]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].mfa_was_enabled, false);
});

test("recover con usuario inexistente no escribe auditoría", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const result = await recoverMfaLoss({ client: db, user: "nadie@example.com", operator: "ana", reason: "ticket #44" });
  assert.equal(result.ok, false);

  const audit = await db.query<any>(`select 1 from mfa_recovery_audit`);
  assert.equal(audit.rows.length, 0);
});

// --------------------------------------------------------------- integración

test("tras rotar, el login con MFA sigue funcionando con la clave nueva", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const tokens = await makeTokenConfig();
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  const startServer = async (key: Buffer) => {
    const app = createApp({ db, tokens, mfaKey: key });
    return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  };

  const before = await startServer(oldKey);
  try {
    await fetch(`${before.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "integ@example.com", password: PASSWORD }),
    });
    const login = await fetch(`${before.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "integ@example.com", password: PASSWORD }),
    });
    const { access_token } = (await login.json()) as { access_token: string };

    const setup = await fetch(`${before.baseUrl}/auth/mfa/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
      body: "{}",
    });
    const { secret } = (await setup.json()) as { secret: string };

    const verified = await fetch(`${before.baseUrl}/auth/mfa/verify-setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ code: totpAt(secret, Date.now()) }),
    });
    assert.equal(verified.status, 200);
  } finally {
    await new Promise<void>((resolve) => before.server.close(() => resolve()));
  }

  // Rotación real con la base ya poblada.
  const result = await rotateMfaKey({ client: db, oldKey, newKey, newKeyId: "v2" });
  assert.equal(result.rotated, 1);

  // La app arranca con la clave nueva: debe poder leer el secreto rotado.
  const after = await startServer(newKey);
  try {
    const login = await fetch(`${after.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "integ@example.com", password: PASSWORD }),
    });
    const body = (await login.json()) as { mfa_required?: boolean; mfa_token?: string };
    assert.equal(body.mfa_required, true);

    const row = await db.query<any>(`select secret_ciphertext, iv, auth_tag from user_mfa_secrets`);
    const secret = decryptSecret(
      { ciphertext: row.rows[0].secret_ciphertext, iv: row.rows[0].iv, authTag: row.rows[0].auth_tag },
      newKey,
    );

    const verified = await fetch(`${after.baseUrl}/auth/mfa/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mfa_token: body.mfa_token, code: totpAt(secret, Date.now()) }),
    });
    assert.equal(verified.status, 200, "el login con MFA debe funcionar tras la rotación");
  } finally {
    await new Promise<void>((resolve) => after.server.close(() => resolve()));
  }
});
