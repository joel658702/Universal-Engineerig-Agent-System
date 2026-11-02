/**
 * Suite de fase 4 — rotación de refresh, familias y detección de reutilización.
 *
 * Contra pg-mem. La rotación es lógica de aplicación, así que el emulador basta
 * para validarla; lo que NO se prueba aquí es la concurrencia real del motor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { hashRefreshToken } from "../src/tokens.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "rotacion@example.com";

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

async function bootstrap(baseUrl: string) {
  await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return (await response.json()) as { access_token: string; refresh_token: string };
}

async function refresh(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });
}

test("refresh rota el token y devuelve un par nuevo de la misma familia", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);
    const response = await refresh(baseUrl, session.refresh_token);
    assert.equal(response.status, 200);

    const body = (await response.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(body.refresh_token, session.refresh_token, "el refresh debe cambiar");
    assert.match(body.access_token, /^[\w-]+\.[\w-]+\.[\w-]+$/);

    const families = await db.query<{ family_id: string; count: number }>(
      "select family_id, count(*)::int as count from refresh_tokens group by family_id",
    );
    assert.equal(families.rows.length, 1, "rota dentro de la misma familia");
    assert.equal(families.rows[0]?.count, 2);
  });
});

test("el token rotado deja de servir; el nuevo sí funciona", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    const first = await refresh(baseUrl, session.refresh_token);
    assert.equal(first.status, 200);
    const next = (await first.json()) as { refresh_token: string };

    // El nuevo funciona ANTES de provocar la detección de reutilización:
    // presentar el viejo revoca la familia entera, incluido este.
    assert.equal((await refresh(baseUrl, next.refresh_token)).status, 200, "el nuevo sí");

    // Ahora el original, ya rotado: robo.
    assert.equal((await refresh(baseUrl, session.refresh_token)).status, 401, "el viejo ya no vale");
  });
});

test("reutilizar un token rotado revoca la familia completa", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);
    const first = await refresh(baseUrl, session.refresh_token);
    const second = (await first.json()) as { refresh_token: string };

    // Se presenta de nuevo el original: robo.
    const reuse = await refresh(baseUrl, session.refresh_token);
    assert.equal(reuse.status, 401);

    const alive = await db.query<{ n: number }>(
      "select count(*)::int as n from refresh_tokens where revoked_at is null",
    );
    assert.equal(alive.rows[0]?.n, 0, "ningún token de la familia puede seguir vivo");

    // Incluso el token legítimo más reciente queda invalidado.
    assert.equal((await refresh(baseUrl, second.refresh_token)).status, 401);
  });
});

test("logout revoca la sesión y el refresh deja de servir", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.equal(logout.status, 204);

    assert.equal((await refresh(baseUrl, session.refresh_token)).status, 401);
    const alive = await db.query<{ n: number }>(
      "select count(*)::int as n from refresh_tokens where revoked_at is null",
    );
    assert.equal(alive.rows[0]?.n, 0);
  });
});

test("refresh desconocido responde 401 y no crea nada", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await bootstrap(baseUrl);
    const response = await refresh(baseUrl, "token-que-no-existe-en-ninguna-tabla");
    assert.equal(response.status, 401);
    const count = await db.query<{ n: number }>("select count(*)::int as n from refresh_tokens");
    assert.equal(count.rows[0]?.n, 1);
  });
});

test("refresh expirado responde 401", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await bootstrap(baseUrl);
    const user = await db.query<{ id: string }>("select id from users");
    const expired = "token-expirado-de-prueba-1234567890";

    // El CHECK (expires_at > issued_at) impide insertar una fila incoherente,
    // así que se desplazan ambas fechas al pasado.
    await db.query(
      `insert into refresh_tokens (user_id, family_id, token_hash, issued_at, expires_at)
       values ($1, gen_random_uuid(), $2, now() - interval '3 days', now() - interval '1 day')`,
      [user.rows[0]!.id, hashRefreshToken(expired).toString("hex")],
    );

    assert.equal((await refresh(baseUrl, expired)).status, 401);
  });
});

test("usuario deshabilitado no puede rotar y recibe 403", async () => {
  await withApp(async ({ baseUrl, db }) => {
    const session = await bootstrap(baseUrl);
    await db.query("update users set disabled_at = now()");

    const response = await refresh(baseUrl, session.refresh_token);
    assert.equal(response.status, 403);
  });
});

test("el access token emitido por refresh sirve en /auth/me", async () => {
  await withApp(async ({ baseUrl }) => {
    const session = await bootstrap(baseUrl);
    const rotated = (await (await refresh(baseUrl, session.refresh_token)).json()) as { access_token: string };

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${rotated.access_token}` } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { email: string }).email, EMAIL);
  });
});

test("logout con token desconocido sigue siendo 204 (sin oráculo)", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "no-existe-pero-da-igual-1234" }),
    });
    assert.equal(response.status, 204);
  });
});
