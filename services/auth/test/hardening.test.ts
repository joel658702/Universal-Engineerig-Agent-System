/**
 * Suite de fase 6 — hardening en los tres modos.
 *
 * Node's fetch no mantiene cookies: se capturan de Set-Cookie y se reenvían a
 * mano. Eso permite además inspeccionar los atributos exactos (HttpOnly,
 * Secure, SameSite), que es justo lo que hay que verificar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp, type AppDeps } from "../src/app.ts";
import type { AuthMode } from "../src/hardening.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "hardening@example.com";

type Ctx = { baseUrl: string; db: Awaited<ReturnType<typeof makeMemDb>> };

async function withMode<T>(mode: AuthMode, fn: (ctx: Ctx) => Promise<T>, extra: Partial<AppDeps> = {}): Promise<T> {
  const db = await makeMemDb();
  const config = await makeTokenConfig();
  const app = createApp({ db, tokens: config, mode, ...extra });
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

function cookieList(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: string[], name: string): string | null {
  const found = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (!found) return null;
  return decodeURIComponent(found.slice(name.length + 1).split(";")[0] ?? "");
}

function rawCookie(cookies: string[], name: string): string | undefined {
  return cookies.find((entry) => entry.startsWith(`${name}=`));
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((entry) => entry.split(";")[0]).join("; ");
}

async function register(baseUrl: string) {
  return fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
}

async function login(baseUrl: string) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
}

test("headers de seguridad presentes en los tres modos", async () => {
  for (const mode of ["bearer", "cookie", "both"] as const) {
    await withMode(mode, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", mode);
      assert.equal(response.headers.get("x-frame-options"), "DENY", mode);
      assert.equal(response.headers.get("x-xss-protection"), "0", mode);
      assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=31536000/, mode);
      assert.equal(response.headers.get("x-powered-by"), null, `${mode}: sin X-Powered-By`);
    });
  }
});

test("bearer: CORS bloquea un origen fuera de la lista blanca", async () => {
  await withMode("bearer", async ({ baseUrl }) => {
    const blocked = await fetch(`${baseUrl}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);

    const allowed = await fetch(`${baseUrl}/health`, { headers: { origin: "https://app.example" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");
  }, { allowedOrigins: ["https://app.example"] });
});

test("bearer: sin Authorization responde 401 y no emite cookies", async () => {
  await withMode("bearer", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    assert.equal(session.status, 200);
    assert.equal(cookieList(session).length, 0, "el modo bearer no debe fijar cookies");

    const me = await fetch(`${baseUrl}/auth/me`);
    assert.equal(me.status, 401);
  });
});

test("cookie: fija cookies httpOnly, Secure y SameSite=Strict, y CSP", async () => {
  await withMode("cookie", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    assert.equal(session.status, 200);

    const cookies = cookieList(session);
    const access = rawCookie(cookies, "access_token");
    const refresh = rawCookie(cookies, "refresh_token");
    const csrf = rawCookie(cookies, "csrf_token");

    for (const [name, raw] of [["access_token", access], ["refresh_token", refresh]] as const) {
      assert.ok(raw, `${name} debe estar presente`);
      assert.match(raw!, /HttpOnly/i, `${name} debe ser HttpOnly`);
      assert.match(raw!, /Secure/i, `${name} debe ser Secure`);
      assert.match(raw!, /SameSite=Strict/i, `${name} debe ser SameSite=Strict`);
    }

    // El token CSRF SÍ debe ser legible por JS (doble envío), pero sigue siendo Secure/Strict.
    assert.ok(csrf);
    assert.doesNotMatch(csrf!, /HttpOnly/i);
    assert.match(csrf!, /SameSite=Strict/i);

    assert.match(session.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(session.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  });
});

test("cookie: /auth/me funciona con cookie y exige CSRF solo en POST", async () => {
  await withMode("cookie", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const cookies = cookieList(session);
    const jar = cookieHeader(cookies);

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: jar } });
    assert.equal(me.status, 200);

    const withoutCsrf = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ current_password: PASSWORD, new_password: "otra-clave-suficiente" }),
    });
    assert.equal(withoutCsrf.status, 403);
    assert.deepEqual(await withoutCsrf.json(), { error: "csrf_failed" });

    const csrf = cookieValue(cookies, "csrf_token")!;
    const withCsrf = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar, "x-csrf-token": csrf },
      body: JSON.stringify({ current_password: "equivocada-larga-1", new_password: "otra-clave-suficiente" }),
    });
    assert.equal(withCsrf.status, 401, "con CSRF válido llega a evaluar la contraseña");
  });
});

test("both: el Authorization tiene prioridad sobre la cookie", async () => {
  await withMode("both", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const body = (await session.json()) as { access_token: string };
    const jar = cookieHeader(cookieList(session));

    const viaHeader = await fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${body.access_token}`, cookie: `${jar}; access_token=basura` },
    });
    assert.equal(viaHeader.status, 200, "gana el encabezado aunque la cookie sea inválida");
  });
});

test("both: CSRF solo se valida cuando se usa la cookie", async () => {
  await withMode("both", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const body = (await session.json()) as { access_token: string };
    const cookies = cookieList(session);

    // Por encabezado: sin CSRF, no debe dar 403 (llega a evaluar la contraseña).
    const viaHeader = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${body.access_token}` },
      body: JSON.stringify({ current_password: "equivocada-larga-1", new_password: "otra-clave-suficiente" }),
    });
    assert.equal(viaHeader.status, 401);

    // Por cookie: sin CSRF, 403.
    const viaCookie = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader(cookies) },
      body: JSON.stringify({ current_password: "equivocada-larga-1", new_password: "otra-clave-suficiente" }),
    });
    assert.equal(viaCookie.status, 403);
  });
});

test("both: el refresh por cookie exige CSRF y rota", async () => {
  await withMode("both", async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const cookies = cookieList(session);
    const jar = cookieHeader(cookies);

    const blocked = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({}),
    });
    assert.equal(blocked.status, 403);

    const csrf = cookieValue(cookies, "csrf_token")!;
    const rotated = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar, "x-csrf-token": csrf },
      body: JSON.stringify({}),
    });
    assert.equal(rotated.status, 200);
    assert.ok(rawCookie(cookieList(rotated), "access_token"), "emite cookies nuevas");
  });
});
