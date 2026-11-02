/**
 * Suite de transacciones — TASK-001.
 *
 * La primera prueba de este archivo es también la que dice si `pg-mem`
 * soporta BEGIN/COMMIT: si no, falla aquí y no en producción.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../src/app.ts";
import { runInTransaction } from "../src/transaction.ts";
import type { Queryable } from "../src/users.ts";
import { makeMemDb, makeTokenConfig } from "./support/fixtures.ts";

const PASSWORD = "correct-horse-battery-staple";
const EMAIL = "transaccion@example.com";

/**
 * pg-mem acepta BEGIN/COMMIT pero IGNORA ROLLBACK: el cambio persiste aunque
 * se lance el error. Verificado en este mismo archivo (53/55 con fallo).
 * Por eso las pruebas que dependen de revertir solo corren contra PostgreSQL.
 */
const USING_REAL_PG = Boolean(process.env["TEST_DATABASE_URL"]);
const SKIP_NO_PG = USING_REAL_PG ? false : "requiere PostgreSQL real: pg-mem ignora ROLLBACK";

test("la transacción hace COMMIT y el cambio persiste", async () => {
  const db = await makeMemDb();
  await runInTransaction(db, async () => {
    await db.query("insert into users (email, password_hash) values ($1, $2)", ["commit@example.com", "h"]);
  });
  const rows = await db.query<{ n: number }>("select count(*)::int as n from users");
  assert.equal(rows.rows[0]?.n, 1);
});

test("la transacción hace ROLLBACK y no deja rastro", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  await assert.rejects(
    () =>
      runInTransaction(db, async () => {
        await db.query("insert into users (email, password_hash) values ($1, $2)", ["rollback@example.com", "h"]);
        throw new Error("fallo simulado");
      }),
    /fallo simulado/,
  );
  const rows = await db.query<{ n: number }>("select count(*)::int as n from users");
  assert.equal(rows.rows[0]?.n, 0, "el insert debe haberse deshecho");
});

test("si falla el cambio de hash, las sesiones NO quedan revocadas", { skip: SKIP_NO_PG }, async () => {
  const db = await makeMemDb();
  const config = await makeTokenConfig();

  // Envoltorio que simula un fallo justo en el UPDATE de la contraseña.
  const faulty: Queryable = {
    query: async (text: string, params?: unknown[]) => {
      if (/update\s+users\s+set\s+password_hash/i.test(text)) throw new Error("fallo simulado en la BD");
      return db.query(text, params);
    },
  };

  const app = createApp({ db: faulty, tokens: config });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const session = (await (
      await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      })
    ).json()) as { access_token: string; refresh_token: string };

    const response = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ current_password: PASSWORD, new_password: "otra-clave-suficiente" }),
    });
    assert.equal(response.status, 500, "el fallo interno no debe filtrarse como éxito");

    const alive = await db.query<{ n: number }>(
      "select count(*)::int as n from refresh_tokens where revoked_at is null",
    );
    assert.equal(alive.rows[0]?.n, 1, "el ROLLBACK debe devolver la sesión a su estado previo");

    const stillWorks = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.equal(stillWorks.status, 200, "la sesión sigue viva porque no se revocó nada");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
