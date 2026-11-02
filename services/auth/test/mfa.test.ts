/**
 * Suite de TASK-004 — segundo factor TOTP.
 *
 * Incluye los cinco vectores del RFC 6238 (independientes de la implementación),
 * el cifrado de secretos, el flujo completo en dos pasos, el mfa_token de un
 * solo uso, los códigos de recuperación y el rate limiting por usuario.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp, type AppDeps } from "../src/app.ts";
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  hashBackupCode,
  totpAt,
} from "../src/mfa.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "mfa@example.com";

// Los flujos con código VÁLIDO pasan por claimTotpCode (ON CONFLICT ... WHERE),
// que pg-mem no soporta desde TASK-006.
const USING_REAL_PG = Boolean(process.env["TEST_DATABASE_URL"]);
const SKIP_NO_PG = USING_REAL_PG ? false : "requiere PostgreSQL real: anti-replay con ON CONFLICT ... WHERE";

type Ctx = { baseUrl: string; mfaKey: Buffer };

async function withApp<T>(fn: (ctx: Ctx) => Promise<T>, extra: Partial<AppDeps> = {}): Promise<T> {
  const db = await makeMemDb();
  const tokens = await makeTokenConfig();
  const mfaKey = randomBytes(32);
  const app = createApp({ db, tokens, mfaKey, ...extra });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, mfaKey });
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

const get = (baseUrl: string, route: string, token?: string) =>
  fetch(`${baseUrl}${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

async function registerAndLogin(baseUrl: string) {
  await post(baseUrl, "/auth/register", { email: EMAIL, password: PASSWORD });
  const response = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
  return (await response.json()) as { access_token: string; refresh_token: string };
}

async function enableMfa(baseUrl: string, accessToken: string) {
  const setup = await post(baseUrl, "/auth/mfa/setup", {}, accessToken);
  assert.equal(setup.status, 200);
  const { secret } = (await setup.json()) as { secret: string; otpauth_uri: string };

  const code = totpAt(secret, Date.now());
  const verified = await post(baseUrl, "/auth/mfa/verify-setup", { code }, accessToken);
  assert.equal(verified.status, 200);
  const body = (await verified.json()) as { backup_codes: string[]; access_token: string };
  return { secret, backupCodes: body.backup_codes, accessToken: body.access_token };
}

// ---------------------------------------------------- RFC 6238 (vectores)

test("TOTP coincide con los 5 vectores del RFC 6238 (8 dígitos)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "utf8"));

  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];

  for (const [seconds, expected] of vectors) {
    assert.equal(totpAt(secret, seconds * 1000, 8), expected, `T=${seconds}`);
  }
});

// ------------------------------------------------------------- cifrado

test("el secreto se cifra con IV distinto y otra clave no lo descifra", () => {
  const key = randomBytes(32);
  const other = randomBytes(32);
  const secret = "JBSWY3DPEHPK3PXP";

  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);

  assert.notEqual(first.iv, second.iv, "el IV debe ser distinto en cada cifrado");
  assert.notEqual(first.ciphertext, second.ciphertext, "el criptograma no puede repetirse");
  assert.equal(decryptSecret(first, key), secret, "con la clave correcta se descifra");
  assert.throws(() => decryptSecret(first, other), /unable to authenticate|bad decrypt|authenticate/i);
});

test("los códigos de recuperación son únicos y su hash es estable", () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, "no puede haber códigos repetidos");
  for (const code of codes) assert.match(hashBackupCode(code), /^[0-9a-f]{64}$/);
  assert.equal(hashBackupCode(codes[0]!.toLowerCase()), hashBackupCode(codes[0]!), "normaliza mayúsculas");
});

// --------------------------------------------------------- flujo completo

test("flujo completo: setup → verify-setup → login en dos fases → canje", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    const { secret, backupCodes } = await enableMfa(baseUrl, session.access_token);

    assert.equal(backupCodes.length, 10, "debe devolver 10 códigos");

    // El access anterior a la activación quedó invalidado (token_version subió).
    assert.equal((await get(baseUrl, "/auth/me", session.access_token)).status, 401);

    const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const body = (await login.json()) as { mfa_required?: boolean; mfa_token?: string; access_token?: string };
    assert.equal(body.mfa_required, true);
    assert.equal(body.access_token, undefined, "no puede emitir tokens sin el segundo factor");

    const verify = await post(baseUrl, "/auth/mfa/verify", {
      mfa_token: body.mfa_token,
      code: totpAt(secret, Date.now()),
    });
    assert.equal(verify.status, 200);
    const tokens = (await verify.json()) as { access_token: string };
    assert.equal((await get(baseUrl, "/auth/me", tokens.access_token)).status, 200);
  });
});

test("el mfa_token es de un solo uso", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    const { secret } = await enableMfa(baseUrl, session.access_token);

    const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const { mfa_token } = (await login.json()) as { mfa_token: string };
    const code = totpAt(secret, Date.now());

    assert.equal((await post(baseUrl, "/auth/mfa/verify", { mfa_token, code })).status, 200);
    assert.equal((await post(baseUrl, "/auth/mfa/verify", { mfa_token, code })).status, 400, "reutilizarlo falla");
  });
});

test("código inválido y cuenta sin MFA dan la misma respuesta", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    await enableMfa(baseUrl, session.access_token);

    const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const { mfa_token } = (await login.json()) as { mfa_token: string };

    const invalidCode = await post(baseUrl, "/auth/mfa/verify", { mfa_token, code: "000000" });
    assert.equal(invalidCode.status, 400);
    const invalidBody = await invalidCode.json();

    const unknownToken = await post(baseUrl, "/auth/mfa/verify", { mfa_token: "x".repeat(40), code: "000000" });
    assert.equal(unknownToken.status, 400);
    assert.deepEqual(await unknownToken.json(), invalidBody, "mismo cuerpo en ambos casos");
  });
});

// ------------------------------------------------------------- recuperación

test("un código de recuperación sirve una sola vez", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    const { backupCodes } = await enableMfa(baseUrl, session.access_token);
    const code = backupCodes[0]!;

    const first = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const { mfa_token: token1 } = (await first.json()) as { mfa_token: string };
    assert.equal((await post(baseUrl, "/auth/mfa/recovery", { mfa_token: token1, code })).status, 200);

    const second = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const { mfa_token: token2 } = (await second.json()) as { mfa_token: string };
    assert.equal((await post(baseUrl, "/auth/mfa/recovery", { mfa_token: token2, code })).status, 400, "el mismo código no vale dos veces");
  });
});

test("regenerar códigos invalida los anteriores", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    const { backupCodes, accessToken } = await enableMfa(baseUrl, session.access_token);
    const oldCode = backupCodes[0]!;

    const regenerated = await get(baseUrl, "/auth/mfa/backup-codes", accessToken);
    assert.equal(regenerated.status, 200);
    const { backup_codes } = (await regenerated.json()) as { backup_codes: string[] };
    assert.equal(backup_codes.length, 10);

    const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const { mfa_token } = (await login.json()) as { mfa_token: string };
    assert.equal((await post(baseUrl, "/auth/mfa/recovery", { mfa_token, code: oldCode })).status, 400);
  });
});

// ---------------------------------------------------------------- límites

test("rate limit TOTP: el sexto intento por usuario responde 429", async () => {
  await withApp(
    async ({ baseUrl }) => {
      const session = await registerAndLogin(baseUrl);
      await enableMfa(baseUrl, session.access_token);

      for (let i = 0; i < 5; i += 1) {
        const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
        const { mfa_token } = (await login.json()) as { mfa_token: string };
        const attempt = await post(baseUrl, "/auth/mfa/verify", { mfa_token, code: "000000" });
        assert.equal(attempt.status, 400, `intento ${i + 1} debe evaluarse`);
      }

      const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
      const { mfa_token } = (await login.json()) as { mfa_token: string };
      const blocked = await post(baseUrl, "/auth/mfa/verify", { mfa_token, code: "000000" });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    },
    { rateLimits: { loginPerIp: { limit: 50, windowMs: 60_000 } } },
  );
});

test("rate limit de códigos de recuperación: el cuarto intento responde 429", async () => {
  await withApp(
    async ({ baseUrl }) => {
      const session = await registerAndLogin(baseUrl);
      await enableMfa(baseUrl, session.access_token);

      for (let i = 0; i < 3; i += 1) {
        const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
        const { mfa_token } = (await login.json()) as { mfa_token: string };
        const attempt = await post(baseUrl, "/auth/mfa/recovery", { mfa_token, code: "DEADBEEF00" });
        assert.equal(attempt.status, 400, `intento ${i + 1} debe evaluarse`);
      }

      const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
      const { mfa_token } = (await login.json()) as { mfa_token: string };
      const blocked = await post(baseUrl, "/auth/mfa/recovery", { mfa_token, code: "DEADBEEF00" });
      assert.equal(blocked.status, 429);
    },
    { rateLimits: { loginPerIp: { limit: 50, windowMs: 60_000 } } },
  );
});

// -------------------------------------------------------------- desactivar

test("desactivar exige contraseña y código válido, y revoca las sesiones", { skip: SKIP_NO_PG }, async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await registerAndLogin(baseUrl);
    const { secret, accessToken } = await enableMfa(baseUrl, session.access_token);

    const wrongPassword = await post(baseUrl, "/auth/mfa/disable", { password: "otra-cosa-larga-1", code: totpAt(secret, Date.now()) }, accessToken);
    assert.equal(wrongPassword.status, 401, "sin la contraseña correcta no desactiva");

    const wrongCode = await post(baseUrl, "/auth/mfa/disable", { password: PASSWORD, code: "000000" }, accessToken);
    assert.equal(wrongCode.status, 400, "con código inválido no desactiva");

    const ok = await post(baseUrl, "/auth/mfa/disable", { password: PASSWORD, code: totpAt(secret, Date.now()) }, accessToken);
    assert.equal(ok.status, 204);

    assert.equal((await get(baseUrl, "/auth/me", accessToken)).status, 401, "sesión anterior revocada");

    const login = await post(baseUrl, "/auth/login", { email: EMAIL, password: PASSWORD });
    const body = (await login.json()) as { mfa_required?: boolean; access_token?: string };
    assert.equal(body.mfa_required, undefined, "ya no pide segundo factor");
    assert.ok(body.access_token, "vuelve a emitir tokens directamente");
  });
});
