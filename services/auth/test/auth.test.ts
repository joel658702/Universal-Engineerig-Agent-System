/**
 * Suite de fases 2 y 3 — registro, login y verificación de access tokens.
 *
 * Corre contra pg-mem (emulador en memoria), NO contra PostgreSQL.
 * El detalle de esa limitación está en README.md y en la evidencia UEAS-007.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import argon2 from "argon2";

import { createApp } from "../src/app.ts";
import { hashRefreshToken, signAccessToken } from "../src/tokens.ts";
import { base64urlJson, makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";

async function withApp<T>(
  fn: (ctx: { baseUrl: string; db: Awaited<ReturnType<typeof makeMemDb>>; config: Awaited<ReturnType<typeof makeTokenConfig>> }) => Promise<T>,
): Promise<T> {
  const db = await makeMemDb();
  const config = await makeTokenConfig();
  const app = createApp({ db, tokens: config });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, db, config });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function register(baseUrl: string, email: string, password = PASSWORD) {
  return fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function login(baseUrl: string, email: string, password = PASSWORD) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

test("registro crea el usuario y guarda argon2id, nunca la contraseña", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const response = await register(baseUrl, "Ana@Example.com");
    assert.equal(response.status, 201);
    const body = (await response.json()) as { id: string; email: string };
    assert.equal(body.email, "ana@example.com", "el correo se normaliza a minúsculas");

    const stored = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [body.id]);
    const hash = stored.rows[0]?.password_hash ?? "";
    assert.ok(hash.startsWith("$argon2id$"), `se esperaba argon2id, se obtuvo: ${hash.slice(0, 12)}`);
    assert.ok(!hash.includes(PASSWORD), "el hash no puede contener la contraseña");
    assert.equal(await argon2.verify(hash, PASSWORD), true);
  });
});

test("registro duplicado responde 409", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl, "dup@example.com");
    const again = await register(baseUrl, "DUP@example.com");
    assert.equal(again.status, 409);
  });
});

test("registro inválido responde 400 (contraseña corta, correo mal formado)", async () => {
  await withApp(async ({ baseUrl }) => {
    assert.equal((await register(baseUrl, "ok@example.com", "corta")).status, 400);
    assert.equal((await register(baseUrl, "no-es-correo", PASSWORD)).status, 400);
  });
});

test("login devuelve access token verificable y refresh opaco guardado como hash", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await register(baseUrl, "login@example.com");
    const response = await login(baseUrl, "login@example.com");
    assert.equal(response.status, 200);

    const body = (await response.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    assert.equal(body.token_type, "Bearer");
    assert.equal(body.expires_in, 900);
    assert.match(body.access_token, /^[\w-]+\.[\w-]+\.[\w-]+$/);

    const stored = await db.query<{ token_hash: string }>("select token_hash from refresh_tokens");
    assert.equal(stored.rows.length, 1);
    const hash = stored.rows[0]?.token_hash ?? "";
    assert.equal(hash.length, 64, "el hash se guarda como SHA-256 hexadecimal");
    assert.equal(hash, hashRefreshToken(body.refresh_token).toString("hex"));
    assert.ok(!hash.includes(body.refresh_token), "el refresh no se guarda en claro");
  });
});

test("login con contraseña incorrecta y con usuario inexistente dan la misma respuesta", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl, "real@example.com");

    const wrongPassword = await login(baseUrl, "real@example.com", "otra-contraseña-larga");
    const unknownUser = await login(baseUrl, "fantasma@example.com");

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(await wrongPassword.json(), await unknownUser.json(), "no debe distinguirse el caso");
  });
});

test("/auth/me sin token responde 401", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/auth/me`);
    assert.equal(response.status, 401);
  });
});

test("/auth/me con token manipulado responde 401", async () => {
  await withApp(async ({ baseUrl, config, db }) => {
    await register(baseUrl, "tamper@example.com");
    const user = await db.query<{ id: string; token_version: number }>("select id, token_version from users");
    const token = await signAccessToken(config, user.rows[0]!.id, user.rows[0]!.token_version);
    const tampered = `${token.slice(0, -3)}aaa`;

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${tampered}` } });
    assert.equal(response.status, 401);
  });
});

test("/auth/me con token firmado por otra clave responde 401", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await register(baseUrl, "otraclave@example.com");
    const user = await db.query<{ id: string; token_version: number }>("select id, token_version from users");
    const foreign = await makeTokenConfig();
    const token = await signAccessToken(foreign, user.rows[0]!.id, user.rows[0]!.token_version);

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  });
});

test("/auth/me rechaza alg:none", async () => {
  await withApp(async ({ baseUrl, config, db }) => {
    await register(baseUrl, "none@example.com");
    const user = await db.query<{ id: string }>("select id from users");
    const now = Math.floor(Date.now() / 1000);

    const forged = [
      base64urlJson({ alg: "none", typ: "JWT" }),
      base64urlJson({ sub: user.rows[0]!.id, typ: "access", iss: config.issuer, aud: config.audience, exp: now + 600, iat: now, tv: 1 }),
      "",
    ].join(".");

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${forged}` } });
    assert.equal(response.status, 401);
  });
});

test("/auth/me rechaza un token expirado", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await register(baseUrl, "exp@example.com");
    const user = await db.query<{ id: string; token_version: number }>("select id, token_version from users");
    const expiredConfig = await makeTokenConfig({ accessTtlSeconds: -600 });
    const token = await signAccessToken(expiredConfig, user.rows[0]!.id, user.rows[0]!.token_version);

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  });
});

test("/auth/me rechaza el token si sube token_version (revocación global)", async () => {
  await withApp(async ({ baseUrl, config, db }) => {
    const created = await register(baseUrl, "revoca@example.com");
    const body = (await created.json()) as { id: string };
    const token = await signAccessToken(config, body.id, 1);
    await db.query("update users set token_version = token_version + 1 where id = $1", [body.id]);

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  });
});

test("/auth/me devuelve el perfil con un token válido", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl, "perfil@example.com");
    const { access_token } = (await (await login(baseUrl, "perfil@example.com")).json()) as { access_token: string };

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${access_token}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { id: string; email: string };
    assert.equal(body.email, "perfil@example.com");
    assert.ok(body.id.length > 0);
  });
});
