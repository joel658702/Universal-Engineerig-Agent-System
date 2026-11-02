/**
 * Suite del hueco de token_version — TASK-001, corrección de seguridad.
 *
 * Cierra el escenario: "un refresh robado sobrevive a un cambio de contraseña".
 * Cambiar la clave revoca TODAS las familias y sube token_version.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "otra-contraseña-mucho-mejor";
const EMAIL = "cambio@example.com";

type Ctx = { baseUrl: string; db: Awaited<ReturnType<typeof makeMemDb>> };

async function withApp<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const db = await makeMemDb();
  const config = await makeTokenConfig();
  const app = createApp({ db, tokens: config });
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

async function login(baseUrl: string, password: string) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

async function bootstrap(baseUrl: string) {
  await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: OLD_PASSWORD }),
  });
  const response = await login(baseUrl, OLD_PASSWORD);
  return (await response.json()) as { access_token: string; refresh_token: string };
}

async function changePassword(baseUrl: string, accessToken: string, current: string, next: string) {
  return fetch(`${baseUrl}/auth/password`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ current_password: current, new_password: next }),
  });
}

async function refresh(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });
}

test("cambiar la contraseña invalida el refresh emitido antes", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    assert.equal((await refresh(baseUrl, session.refresh_token)).status, 200, "antes del cambio funciona");

    const change = await changePassword(baseUrl, session.access_token, OLD_PASSWORD, NEW_PASSWORD);
    assert.equal(change.status, 204);

    // El refresh que había sobrevivido a la rotación ahora debe estar muerto.
    assert.equal((await refresh(baseUrl, session.refresh_token)).status, 401);
  });
});

test("cambiar la contraseña invalida el access token en uso", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    assert.equal(
      (await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } })).status,
      200,
    );

    await changePassword(baseUrl, session.access_token, OLD_PASSWORD, NEW_PASSWORD);

    assert.equal(
      (await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } })).status,
      401,
      "token_version subió: el access anterior ya no vale",
    );
  });
});

test("todas las familias del usuario quedan revocadas, no solo la actual", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const first = await bootstrap(baseUrl);
    // Segunda sesión (otro dispositivo) → otra familia.
    const second = (await (await login(baseUrl, OLD_PASSWORD)).json()) as { access_token: string; refresh_token: string };

    const families = await db.query<{ n: number }>("select count(distinct family_id)::int as n from refresh_tokens");
    assert.equal(families.rows[0]?.n, 2, "dos sesiones, dos familias");

    await changePassword(baseUrl, first.access_token, OLD_PASSWORD, NEW_PASSWORD);

    const alive = await db.query<{ n: number }>(
      "select count(*)::int as n from refresh_tokens where revoked_at is null",
    );
    assert.equal(alive.rows[0]?.n, 0, "ninguna sesión sobrevive al cambio de contraseña");
    assert.equal((await refresh(baseUrl, second.refresh_token)).status, 401);
  });
});

test("la contraseña nueva funciona y la vieja deja de servir", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    await changePassword(baseUrl, session.access_token, OLD_PASSWORD, NEW_PASSWORD);

    assert.equal((await login(baseUrl, OLD_PASSWORD)).status, 401, "la vieja ya no entra");
    assert.equal((await login(baseUrl, NEW_PASSWORD)).status, 200, "la nueva sí");
  });
});

test("con la contraseña actual incorrecta no se cambia nada", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);
    const before = await db.query<{ token_version: number; password_hash: string }>("select token_version, password_hash from users");

    const response = await changePassword(baseUrl, session.access_token, "contraseña-equivocada", NEW_PASSWORD);
    assert.equal(response.status, 401);

    const after = await db.query<{ token_version: number; password_hash: string }>("select token_version, password_hash from users");
    assert.deepEqual(after.rows[0], before.rows[0], "ni hash ni versión cambian");
    assert.equal((await refresh(baseUrl, session.refresh_token)).status, 200, "la sesión sigue viva");
  });
});

test("cambiar contraseña exige autenticación", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_password: OLD_PASSWORD, new_password: NEW_PASSWORD }),
    });
    assert.equal(response.status, 401);
  });
});

test("la contraseña nueva debe cumplir la política", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    const response = await changePassword(baseUrl, session.access_token, OLD_PASSWORD, "corta");
    assert.equal(response.status, 400);
  });
});

test("token_version sube exactamente uno por cambio", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);
    const before = await db.query<{ token_version: number }>("select token_version from users");
    await changePassword(baseUrl, session.access_token, OLD_PASSWORD, NEW_PASSWORD);
    const after = await db.query<{ token_version: number }>("select token_version from users");

    assert.equal(after.rows[0]!.token_version, before.rows[0]!.token_version + 1);
  });
});
