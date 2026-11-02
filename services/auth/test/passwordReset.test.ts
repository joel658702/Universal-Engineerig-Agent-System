/**
 * Suite de TASK-003 — recuperación de contraseña.
 *
 * Cubre el flujo completo, el uso único, la expiración, la anti-enumeración
 * (cuerpo y latencia), el rate limit por hash de correo y la revocación de
 * sesiones posteriores.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp, type AppDeps } from "../src/app.ts";
import { createDevMailer, isDevOutboxEnabled } from "../src/mailer.ts";
import { hashResetToken } from "../src/passwordReset.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "una-clave-nueva-suficiente";

type Ctx = {
  baseUrl: string;
  db: Awaited<ReturnType<typeof makeMemDb>>;
  mailer: ReturnType<typeof createDevMailer>;
};

async function withApp<T>(fn: (ctx: Ctx) => Promise<T>, extra: Partial<AppDeps> = {}): Promise<T> {
  const db = await makeMemDb();
  const tokens = await makeTokenConfig();
  const mailer = createDevMailer();
  const app = createApp({ db, tokens, mailer, devOutbox: true, ...extra });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, db, mailer });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (baseUrl: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const register = (baseUrl: string, email: string) =>
  post(baseUrl, "/auth/register", { email, password: PASSWORD });

const login = (baseUrl: string, email: string, password = PASSWORD) =>
  post(baseUrl, "/auth/login", { email, password });

const forgot = (baseUrl: string, email: string) => post(baseUrl, "/auth/forgot-password", { email });

const reset = (baseUrl: string, token: string, newPassword = NEW_PASSWORD) =>
  post(baseUrl, "/auth/reset-password", { token, new_password: newPassword });

test("flujo completo: solicitud → outbox → reset → login con la clave nueva", async () => {
  await withApp(async ({ baseUrl, mailer }) => {
    await register(baseUrl, "flujo@example.com");

    const request = await forgot(baseUrl, "flujo@example.com");
    assert.equal(request.status, 202);
    assert.deepEqual(await request.json(), { status: "accepted" });

    const entry = mailer.last();
    assert.ok(entry, "el outbox de desarrollo debe contener el mensaje");
    assert.equal(entry!.to, "flujo@example.com");

    const done = await reset(baseUrl, entry!.token);
    assert.equal(done.status, 204);

    assert.equal((await login(baseUrl, "flujo@example.com", PASSWORD)).status, 401, "la vieja no sirve");
    assert.equal((await login(baseUrl, "flujo@example.com", NEW_PASSWORD)).status, 200, "la nueva sí");
  });
});

test("el token es de un solo uso: el segundo intento responde 400", async () => {
  await withApp(async ({ baseUrl, mailer }) => {
    await register(baseUrl, "unico@example.com");
    await forgot(baseUrl, "unico@example.com");
    const token = mailer.last()!.token;

    assert.equal((await reset(baseUrl, token)).status, 204);
    assert.equal((await reset(baseUrl, token, "otra-clave-distinta-1")).status, 400);
  });
});

test("un token expirado responde 400 igual que uno inexistente", async () => {
  await withApp(async ({ baseUrl, db }) => {
    await register(baseUrl, "expirado@example.com");
    const user = await db.query<{ id: string }>("select id from users");

    const expired = "token-que-ya-caduco-1234567890";
    await db.query(
      `insert into password_resets (user_id, token_hash, created_at, expires_at)
       values ($1, $2, now() - interval '20 minutes', now() - interval '5 minutes')`,
      [user.rows[0]!.id, hashResetToken(expired)],
    );

    const response = await reset(baseUrl, expired);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_token" });
  });
});

test("anti-enumeración: mismo estado y cuerpo exista o no la cuenta", async () => {
  await withApp(async ({ baseUrl }) => {
    await register(baseUrl, "existe@example.com");

    const real = await forgot(baseUrl, "existe@example.com");
    const ghost = await forgot(baseUrl, "no-existe-en-absoluto@example.com");

    assert.equal(real.status, ghost.status);
    assert.equal(real.status, 202);
    assert.deepEqual(await real.json(), await ghost.json());
  });
});

test("anti-enumeración: la latencia no distingue cuentas (tolerancia 50 ms)", async () => {
  await withApp(
    async ({ baseUrl }) => {
      await register(baseUrl, "tiempo@example.com");

      const real: number[] = [];
      const ghost: number[] = [];

      for (let i = 0; i < 8; i += 1) {
        for (const [bucket, email] of [
          [real, "tiempo@example.com"],
          [ghost, `fantasma${i}@example.com`],
        ] as const) {
          const started = performance.now();
          const response = await forgot(baseUrl, email);
          bucket.push(performance.now() - started);
          assert.equal(response.status, 202);
        }
      }

      const median = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)]!;
      };

      const difference = Math.abs(median(real) - median(ghost));
      assert.ok(
        difference < 50,
        `diferencia de medianas ${difference.toFixed(1)} ms supera la tolerancia de 50 ms ` +
          `(real ${median(real).toFixed(1)} ms, inexistente ${median(ghost).toFixed(1)} ms)`,
      );
    },
    { rateLimits: { forgotPerIp: { limit: 100, windowMs: 60_000 }, forgotPerEmail: { limit: 100, windowMs: 60_000 } } },
  );
});

test("rate limit por hash de correo: el cuarto intento falla exista o no la cuenta", async () => {
  await withApp(
    async ({ baseUrl }) => {
      await register(baseUrl, "limite@example.com");

      for (let i = 0; i < 3; i += 1) {
        assert.equal((await forgot(baseUrl, "limite@example.com")).status, 202, `intento ${i + 1} existente`);
      }
      const blockedReal = await forgot(baseUrl, "limite@example.com");
      assert.equal(blockedReal.status, 429, "el cuarto con correo existente debe fallar");
      assert.ok(Number(blockedReal.headers.get("retry-after")) > 0);

      for (let i = 0; i < 3; i += 1) {
        assert.equal((await forgot(baseUrl, "otro-fantasma@example.com")).status, 202, `intento ${i + 1} inexistente`);
      }
      const blockedGhost = await forgot(baseUrl, "otro-fantasma@example.com");
      assert.equal(blockedGhost.status, 429, "el cuarto con correo inexistente falla igual");
      assert.deepEqual(await blockedGhost.json(), await blockedReal.json(), "el 429 tampoco distingue");
    },
    { rateLimits: { forgotPerIp: { limit: 100, windowMs: 60_000 } } },
  );
});

test("tras el reset, las sesiones anteriores quedan revocadas", async () => {  await withApp(async ({ baseUrl, mailer }) => {
    await register(baseUrl, "sesiones@example.com");
    const session = (await (await login(baseUrl, "sesiones@example.com")).json()) as {
      access_token: string;
      refresh_token: string;
    };

    assert.equal(
      (await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } })).status,
      200,
      "antes del reset el access funciona",
    );

    await forgot(baseUrl, "sesiones@example.com");
    const token = mailer.last()!.token;
    assert.equal((await reset(baseUrl, token)).status, 204);

    const me = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
    assert.equal(me.status, 401, "token_version subió: el access anterior ya no vale");

    const refreshed = await post(baseUrl, "/auth/refresh", { refresh_token: session.refresh_token });
    assert.equal(refreshed.status, 401, "los refresh también fueron revocados");
  });
});

test("sin la doble guardia, el outbox de desarrollo no existe (404)", async () => {
  await withApp(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/_dev/outbox`);
      assert.equal(response.status, 404);
    },
    { devOutbox: false },
  );
});

test("la doble guardia exige development Y AUTH_DEV_OUTBOX=1", () => {
  assert.equal(isDevOutboxEnabled({ NODE_ENV: "development", AUTH_DEV_OUTBOX: "1" }), true);
  assert.equal(isDevOutboxEnabled({ NODE_ENV: "development" }), false);
  assert.equal(isDevOutboxEnabled({ AUTH_DEV_OUTBOX: "1" }), false);
  assert.equal(isDevOutboxEnabled({ NODE_ENV: "production", AUTH_DEV_OUTBOX: "1" }), false);
});
