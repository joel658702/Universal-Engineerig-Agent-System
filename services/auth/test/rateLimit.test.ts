/**
 * Suite de fase 5 — rate limiting por IP, por usuario y por familia.
 *
 * El reloj se inyecta, así que la ventana se prueba avanzando el tiempo en
 * memoria en lugar de dormir el proceso.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { createRateLimiter } from "../src/rateLimiter.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "limite@example.com";

type Ctx = {
  baseUrl: string;
  db: Awaited<ReturnType<typeof makeMemDb>>;
  advance: (ms: number) => void;
};

async function withApp<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const db = await makeMemDb();
  const config = await makeTokenConfig();

  let currentTime = 1_000_000_000;
  const clock = () => currentTime;

  const app = createApp({ db, tokens: config, clock });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      db,
      advance: (ms) => {
        currentTime += ms;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function login(baseUrl: string, email: string, password: string) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function register(baseUrl: string, email = EMAIL, password = PASSWORD) {
  return fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function refresh(baseUrl: string, token: string) {
  return fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });
}

test("login: 5 intentos por IP y el sexto responde 429", async () => {
  await withApp(async ({ baseUrl }) => {
    for (let i = 1; i <= 5; i += 1) {
      const response = await login(baseUrl, "nadie@example.com", "contraseña-mala-larga");
      assert.equal(response.status, 401, `intento ${i} debe pasar`);
    }

    const blocked = await login(baseUrl, "nadie@example.com", "contraseña-mala-larga");
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"), "debe traer Retry-After");
    assert.deepEqual(await blocked.json(), { error: "too_many_requests" });
  });
});

test("login: el 429 es idéntico para usuario existente e inexistente", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl);

    for (let i = 1; i <= 5; i += 1) await login(baseUrl, "fantasma@example.com", "contraseña-mala-larga");

    const unknown = await login(baseUrl, "fantasma@example.com", "contraseña-mala-larga");
    const known = await login(baseUrl, EMAIL, "contraseña-mala-larga");

    assert.equal(unknown.status, 429);
    assert.equal(known.status, 429);
    assert.deepEqual(await unknown.json(), await known.json(), "el 429 no puede distinguir si la cuenta existe");
  });
});

test("login: Retry-After refleja el tiempo restante y la ventana se reabre", async () => {
  await withApp(async ({ baseUrl, advance }) => {
    for (let i = 1; i <= 5; i += 1) await login(baseUrl, "nadie@example.com", "contraseña-mala-larga");

    advance(20_000);
    const midway = await login(baseUrl, "nadie@example.com", "contraseña-mala-larga");
    assert.equal(midway.status, 429);
    assert.equal(midway.headers.get("retry-after"), "40", "quedan 40 de los 60 segundos");

    advance(41_000);
    const reopened = await login(baseUrl, "nadie@example.com", "contraseña-mala-larga");
    assert.equal(reopened.status, 401, "pasada la ventana vuelve a evaluarse la credencial");
  });
});

test("password: 3 intentos por usuario y el cuarto responde 429", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl);
    const session = (await (await login(baseUrl, EMAIL, PASSWORD)).json()) as { access_token: string };

    const attempt = () =>
      fetch(`${baseUrl}/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ current_password: "equivocada-pero-larga", new_password: "otra-clave-suficiente" }),
      });

    for (let i = 1; i <= 3; i += 1) {
      assert.equal((await attempt()).status, 401, `intento ${i} debe evaluarse`);
    }
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  });
});

test("refresh: 10 rotaciones por familia y la onceava responde 429", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl);
    let token = ((await (await login(baseUrl, EMAIL, PASSWORD)).json()) as { refresh_token: string }).refresh_token;

    for (let i = 1; i <= 10; i += 1) {
      const response = await refresh(baseUrl, token);
      assert.equal(response.status, 200, `rotación ${i} debe pasar`);
      token = ((await response.json()) as { refresh_token: string }).refresh_token;
    }

    const blocked = await refresh(baseUrl, token);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: "too_many_requests" });
  });
});

test("uso normal: varias sesiones legítimas no se ven afectadas", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl);

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await login(baseUrl, EMAIL, PASSWORD)).status, 200, `login ${i + 1}`);
    }

    let token = ((await (await login(baseUrl, EMAIL, PASSWORD)).json()) as { refresh_token: string }).refresh_token;
    for (let i = 0; i < 5; i += 1) {
      const response = await refresh(baseUrl, token);
      assert.equal(response.status, 200, `refresh ${i + 1}`);
      token = ((await response.json()) as { refresh_token: string }).refresh_token;
    }
  });
});

test("el limitador es reutilizable y aísla claves distintas", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });

  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, true);
  const blocked = limiter.check("a");
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.retryAfterSeconds, 1);

  // Otra clave no se ve afectada por el contador de "a".
  assert.equal(limiter.check("b").allowed, true);

  now = 1_000;
  assert.equal(limiter.check("a").allowed, true, "la ventana se reabre al cumplirse el periodo");
});
