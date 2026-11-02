/**
 * Suite del runner de migraciones con libro de estado (TASK-002, deuda 15).
 *
 * Contra pg-mem salvo donde se indique: pg-mem acepta BEGIN/COMMIT pero ignora
 * ROLLBACK, así que lo que dependa de revertir de verdad exige PostgreSQL real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyMigrations,
  baselineMigrations,
  MIGRATIONS_DIR,
  rollbackMigrations,
} from "../scripts/migrate.mjs";
import { makeEmptyDb } from "./support/fixtures.ts";

const USING_REAL_PG = Boolean(process.env["TEST_DATABASE_URL"]);
const SKIP_NO_PG = USING_REAL_PG ? false : "requiere PostgreSQL real: pg-mem ignora ROLLBACK";

async function withTempCopy(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "ueas-mig-"));
  try {
    for (const name of ["001_users.up.sql", "001_users.down.sql", "002_refresh_tokens.up.sql", "002_refresh_tokens.down.sql"]) {
      await cp(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("up aplica y registra cada migración con su checksum", async () => {
  const db = await makeEmptyDb();
  const done = await applyMigrations(db);
  assert.deepEqual(done, ["001_users.up.sql", "002_refresh_tokens.up.sql"]);

  const rows = await db.query("select version, name, checksum from schema_migrations order by version");
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(rows.rows.map((r) => r.version), ["001", "002"]);
  assert.deepEqual(rows.rows.map((r) => r.name), ["001_users.up.sql", "002_refresh_tokens.up.sql"]);
  for (const row of rows.rows) assert.match(row.checksum, /^[0-9a-f]{64}$/);
});

test("segunda ejecución de up no aplica nada y no lanza (idempotencia)", async () => {
  const db = await makeEmptyDb();
  await applyMigrations(db);

  const second = await applyMigrations(db);
  assert.deepEqual(second, [], "no debe haber pendientes");

  const rows = await db.query("select count(*)::int as n from schema_migrations");
  assert.equal(rows.rows[0].n, 2, "el libro no debe duplicar filas");
});

test("down revierte lo aplicado y borra sus filas del libro", async () => {
  const db = await makeEmptyDb();
  await applyMigrations(db);

  const reverted = await rollbackMigrations(db);
  assert.deepEqual(reverted, ["002_refresh_tokens.down.sql", "001_users.down.sql"]);

  const after = await db.query("select count(*)::int as n from schema_migrations");
  assert.equal(after.rows[0].n, 0);
});

test("tras el down, up vuelve a aplicar (solo PostgreSQL real)", { skip: SKIP_NO_PG }, async () => {
  // pg-mem deja relaciones huérfanas (users_pkey) tras DROP TABLE, así que el
  // ciclo completo solo se puede comprobar contra el motor real.
  const db = await makeEmptyDb();
  await applyMigrations(db);
  await rollbackMigrations(db);

  const again = await applyMigrations(db);
  assert.deepEqual(again, ["001_users.up.sql", "002_refresh_tokens.up.sql"]);
});

test("down sin nada aplicado no hace nada y no lanza", async () => {
  const db = await makeEmptyDb();
  const reverted = await rollbackMigrations(db);
  assert.deepEqual(reverted, []);
});

test("drift: una migración aplicada que se edita aborta el up", async () => {
  await withTempCopy(async (dir) => {
    const db = await makeEmptyDb();
    await applyMigrations(db, dir);

    const target = path.join(dir, "001_users.up.sql");
    await writeFile(target, `${await readFile(target, "utf8")}\n-- editado después de aplicar\n`, "utf8");

    await assert.rejects(() => applyMigrations(db, dir), /checksum distinto en 001_users\.up\.sql/);
  });
});

test("una migración rota no deja fila en el libro", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ueas-broken-"));
  try {
    await writeFile(
      path.join(dir, "900_broken.up.sql"),
      "create table f2_probe (id integer);\nselect * from tabla_inexistente;\n",
      "utf8",
    );

    const db = await makeEmptyDb();
    await assert.rejects(() => applyMigrations(db, dir));

    const rows = await db.query("select count(*)::int as n from schema_migrations where version = '900'");
    assert.equal(rows.rows[0].n, 0, "no debe registrarse una migración que falló");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("una migración rota no deja el objeto creado (solo PostgreSQL real)", { skip: SKIP_NO_PG }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ueas-broken-"));
  try {
    await writeFile(
      path.join(dir, "900_broken.up.sql"),
      "create table f2_probe (id integer);\nselect * from tabla_inexistente;\n",
      "utf8",
    );

    const db = await makeEmptyDb();
    await assert.rejects(() => applyMigrations(db, dir));

    const probe = await db.query("select to_regclass('public.f2_probe') as reg");
    assert.equal(probe.rows[0].reg, null, "la transacción debe deshacer el CREATE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline registra una base ya migrada sin ejecutar nada", async () => {
  const db = await makeEmptyDb();

  // Simula una base migrada con la versión anterior del runner: esquema sí, libro no.
  for (const name of ["001_users.up.sql", "002_refresh_tokens.up.sql"]) {
    await db.query(await readFile(path.join(MIGRATIONS_DIR, name), "utf8"));
  }

  const registered = await baselineMigrations(db);
  assert.deepEqual(registered, ["001_users.up.sql", "002_refresh_tokens.up.sql"]);

  const rows = await db.query("select version, checksum from schema_migrations order by version");
  assert.equal(rows.rows.length, 2);
  for (const row of rows.rows) assert.match(row.checksum, /^[0-9a-f]{64}$/);

  // Y ahora un up no intenta recrear tablas.
  assert.deepEqual(await applyMigrations(db), []);
});

test("dos procesos aplicando a la vez: uno aplica, el otro no duplica", { skip: SKIP_NO_PG }, async () => {
  const url = process.env["TEST_DATABASE_URL"];
  const pg = await import("pg");

  const first = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const second = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await first.connect();
  await second.connect();

  try {
    await first.query("drop schema if exists public cascade");
    await first.query("create schema public");

    const results = await Promise.all([applyMigrations(first), applyMigrations(second)]);
    const applied = results.flat().sort();

    assert.deepEqual(applied, ["001_users.up.sql", "002_refresh_tokens.up.sql"], "entre los dos, exactamente una vez cada una");

    const rows = await first.query("select count(*)::int as n from schema_migrations");
    assert.equal(rows.rows[0].n, 2, "sin filas duplicadas");
  } finally {
    await first.end();
    await second.end();
  }
});
