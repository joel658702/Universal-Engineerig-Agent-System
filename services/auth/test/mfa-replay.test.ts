/**
 * Suite de TASK-006 — prevención de replay de TOTP.
 *
 * Todos los casos requieren PostgreSQL real: `ON CONFLICT ... DO UPDATE ... WHERE`
 * no está soportado por pg-mem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { claimTotpCode, cleanupUsedTotpCodes, totpAt } from "../src/mfa.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "replay@example.com";

const USING_REAL_PG = Boolean(process.env["TEST_DATABASE_URL"]);
const SKIP_NO_PG = USING_REAL_PG ? false : "requiere PostgreSQL real: ON CONFLICT ... DO UPDATE ... WHERE";

type Ctx = { baseUrl: string; db: any };

async function withApp<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const db = await makeMemDb();
  const tokens = await makeTokenConfig();
  const app = createApp({ db, tokens, mfaKey: randomBytes(32) });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, db });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (baseUrl: string, route: string, body: unknown, token?: string) =>
  fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function bootstrap(baseUrl: string) {
  await post(baseUrl, "/auth/register", { email: EMAIL, password: PASSWORD });
  const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
  const { access_token } = (await login.json()) as { access_token: string };

  const setup = await post(baseUrl, "/auth/mfa/setup", {}, access_token);
  const { secret } = (await setup.json()) as { secret: string };

  const verified = await post(baseUrl, "/auth/mfa/verify-setup", { code: totpAt(secret, Date.now()) }, access_token);
  assert.equal(verified.status, 200);
  const body = (await verified.json()) as { access_token: string };

  return { secret, accessToken: body.access_token };
}

async function startMfaLogin(baseUrl: string) {
  const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
  return (await login.json()) as { mfa_required?: boolean; mfa_token: string };
}

test("replay bloqueado: el mismo código no vale dos veces dentro de la ventana", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl }) => {
    const { secret } = await bootstrap(baseUrl);
    const code = totpAt(secret, Date.now());

    const first = await startMfaLogin(baseUrl);
    assert.equal((await post(baseUrl, "/auth/mfa/verify", { mfa_token: first.mfa_token, code })).status, 200);

    const second = await startMfaLogin(baseUrl);
    const replay = await post(baseUrl, "/auth/mfa/verify", { mfa_token: second.mfa_token, code });
    assert.equal(replay.status, 400, "el mismo código debe rechazarse");
    assert.deepEqual(await replay.json(), { error: "mfa_verification_failed" });
  });
});

test("el código vuelve a valer pasada la ventana", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl, db }) => {
    const { secret } = await bootstrap(baseUrl);
    const code = totpAt(secret, Date.now());

    const first = await startMfaLogin(baseUrl);
    assert.equal((await post(baseUrl, "/auth/mfa/verify", { mfa_token: first.mfa_token, code })).status, 200);

    // Se envejece la fila sin borrarla: cubre el camino ON CONFLICT DO UPDATE.
    await db.query(`update mfa_used_codes set used_at = now() - interval '2 minutes'`);

    const second = await startMfaLogin(baseUrl);
    assert.equal(
      (await post(baseUrl, "/auth/mfa/verify", { mfa_token: second.mfa_token, code })).status,
      200,
      "fuera de la ventana, el código debe aceptarse de nuevo",
    );
  });
});

test("usuarios distintos pueden usar el mismo código", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ db }) => {
    const a = await db.query<{ id: string }>(
      `insert into users (email, password_hash) values ('a@example.com', 'h') returning id`,
    );
    const b = await db.query<{ id: string }>(
      `insert into users (email, password_hash) values ('b@example.com', 'h') returning id`,
    );

    const code = "123456";
    assert.equal(await claimTotpCode(db, a.rows[0]!.id, code), true, "usuario A la primera vez");
    assert.equal(await claimTotpCode(db, b.rows[0]!.id, code), true, "usuario B no colisiona");
    assert.equal(await claimTotpCode(db, a.rows[0]!.id, code), false, "A no puede repetir");
  });
});

test("la limpieza borra solo los códigos antiguos", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ db }) => {
    const user = await db.query<{ id: string }>(
      `insert into users (email, password_hash) values ('clean@example.com', 'h') returning id`,
    );
    const userId = user.rows[0]!.id;

    await db.query(
      `insert into mfa_used_codes (user_id, code_hash, used_at)
       values ($1, $2, now() - interval '10 minutes'), ($1, $3, now())`,
      [userId, "a".repeat(64), "b".repeat(64)],
    );

    const deleted = await cleanupUsedTotpCodes(db);
    assert.equal(deleted, 1, "solo la fila antigua");

    const remaining = await db.query<{ n: number }>(`select count(*)::int as n from mfa_used_codes`);
    assert.equal(remaining.rows[0]!.n, 1);
  });
});

test("integración: un código usado en el login no sirve para desactivar MFA", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl }) => {
    const { secret } = await bootstrap(baseUrl);
    const code = totpAt(secret, Date.now());

    const login = await startMfaLogin(baseUrl);
    const verified = await post(baseUrl, "/auth/mfa/verify", { mfa_token: login.mfa_token, code });
    assert.equal(verified.status, 200);
    const { access_token: access } = (await verified.json()) as { access_token: string };

    const disable = await post(baseUrl, "/auth/mfa/disable", { password: PASSWORD, code }, access);
    assert.equal(disable.status, 400, "el código ya consumido no puede desactivar MFA");
    assert.deepEqual(await disable.json(), { error: "mfa_verification_failed" });

    // Y MFA sigue activo: un login nuevo lo pide.
    assert.equal((await startMfaLogin(baseUrl)).mfa_required, true);
  });
});
