/**
 * Suite de fase 1 — forma del esquema y reversibilidad de las migraciones.
 *
 * IMPORTANTE: se ejecuta contra `pg-mem`, un emulador en memoria, NO contra
 * PostgreSQL. En este entorno el servidor no puede abrir sockets
 * (`could not bind IPv4 address: Permission denied`), así que la ejecución
 * contra PostgreSQL real queda declarada `not_run` en la evidencia.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { newDb, DataType } from "pg-mem";

import { applyMigrations, listMigrations, rollbackMigrations } from "../scripts/migrate.mjs";

// Los nombres se derivan del directorio: añadir una migración no debe romper tests.
const UP_NAMES = (await listMigrations("up")).map((file) => path.basename(file));
const DOWN_NAMES = (await listMigrations("down")).map((file) => path.basename(file));

async function freshClient() {
  const db = newDb();
  // pg-mem implementa muy pocas funciones nativas; en PostgreSQL real estas
  // existen de serie. Se registran para que el emulador acepte el esquema.
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });
  db.public.registerFunction({
    name: "lower",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.toLowerCase(),
  });
  db.public.registerFunction({
    name: "trim",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.trim(),
  });
  db.public.registerFunction({
    name: "length",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });
  const adapter = db.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  return client;
}

test("las migraciones crean users y refresh_tokens", async () => {
  const client = await freshClient();
  const applied = await applyMigrations(client);
  assert.deepEqual(applied, UP_NAMES);

  const users = await client.query("select count(*)::int as n from users");
  assert.equal(users.rows[0].n, 0);
  const tokens = await client.query("select count(*)::int as n from refresh_tokens");
  assert.equal(tokens.rows[0].n, 0);
});

test("el email es único sin distinguir mayúsculas", async () => {
  const client = await freshClient();
  await applyMigrations(client);
  await client.query(
    "insert into users (email, password_hash) values ($1, $2)",
    ["Alice@Example.com", "hash"],
  );
  await assert.rejects(
    () => client.query("insert into users (email, password_hash) values ($1, $2)", ["alice@example.com", "hash"]),
    /duplicate|unique/i,
  );
});

test("refresh_tokens exige un usuario existente (FK)", async () => {
  const client = await freshClient();
  await applyMigrations(client);
  await assert.rejects(
    () =>
      client.query(
        "insert into refresh_tokens (user_id, family_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '30 days')",
        [randomUUID(), randomUUID(), Buffer.from("abc")],
      ),
    /foreign key|violat|no existe/i,
  );
});

test("expires_at debe ser posterior a issued_at", async () => {
  const client = await freshClient();
  await applyMigrations(client);
  const user = await client.query(
    "insert into users (email, password_hash) values ($1, $2) returning id",
    ["check@example.com", "hash"],
  );
  await assert.rejects(
    () =>
      client.query(
        "insert into refresh_tokens (user_id, family_id, token_hash, expires_at) values ($1, $2, $3, now() - interval '1 day')",
        [user.rows[0].id, randomUUID(), Buffer.from("xyz")],
      ),
    /check|constraint|violat/i,
  );
});

test("el rollback elimina las tablas en orden inverso", async () => {
  const client = await freshClient();
  await applyMigrations(client);
  const reverted = await rollbackMigrations(client);
  assert.deepEqual(reverted, DOWN_NAMES);
  await assert.rejects(() => client.query("select 1 from users"), /no existe|does not exist|not find/i);
});
