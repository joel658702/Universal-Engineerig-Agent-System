/**
 * migrate.mjs — runner de migraciones con libro de estado.
 *
 * Cambios respecto a la versión anterior (deuda 15):
 *   · tabla `schema_migrations` con version, nombre, checksum y fecha;
 *   · `up` solo aplica lo pendiente → idempotente;
 *   · cada migración va en su propia transacción: si falla, no deja fila ni efecto;
 *   · checksum sha256 para detectar migraciones ya aplicadas que fueron editadas;
 *   · bloqueo entre procesos con pg_advisory_lock (si el motor lo soporta);
 *   · comando `baseline` para bases migradas antes de existir el libro.
 *
 * Contrato conservado: `applyMigrations` y `rollbackMigrations` reciben un
 * `client` con `.query()` y devuelven el array de nombres afectados.
 *
 * CLI:  DATABASE_URL=postgres://... node scripts/migrate.mjs up|down|baseline [--force]
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, "..", "migrations");

const LOCK_KEY = 918_273_645;
const LOCK_TIMEOUT_MS = 10_000;
const BOOKKEEPING = "schema_migrations";

/**
 * Capacidad por cliente, no global: en un mismo proceso conviven pg-mem
 * (tests unitarios) y pg real, y desactivar el bloqueo globalmente al tocar
 * el emulador dejaba sin protección a los clientes reales.
 */
const clientsWithoutLock = new WeakSet();
let lockWarningEmitted = false;

function versionOf(file) {
  return path.basename(file).split("_")[0] ?? "";
}

function checksumOf(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Crea el libro si no existe.
 *
 * No se usa `create table if not exists`: pg-mem no soporta esa variante con
 * constraints (falla con «parts have not been read by the query planner»).
 * En su lugar se comprueba la existencia con una consulta trivial, que además
 * funciona aunque el esquema se haya recreado entre dos llamadas.
 */
export async function ensureBookkeeping(client) {
  try {
    await client.query(`select 1 from ${BOOKKEEPING} limit 0`);
    return;
  } catch {
    /* no existe todavía */
  }

  try {
    await client.query(
      `create table ${BOOKKEEPING} (
         version    text        primary key,
         name       text        not null,
         checksum   text        not null,
         applied_at timestamptz not null default now()
       )`,
    );
  } catch (error) {
    // Carrera entre procesos: PostgreSQL responde duplicate_table (42P07),
    // duplicate_object (42710) o unique_violation sobre pg_type (23505).
    const code = error?.code;
    if (code === "42P07" || code === "42710" || code === "23505") return;
    if (/exist/i.test(String(error?.message ?? error))) return;
    throw error;
  }
}

export async function appliedMigrations(client) {
  await ensureBookkeeping(client);
  const result = await client.query(`select version, name, checksum from ${BOOKKEEPING}`);
  return result.rows;
}

async function withLock(client, work) {
  if (clientsWithoutLock.has(client)) return work();

  let locked = false;
  try {
    // Limpieza defensiva: si esta sesión arrastra un lock de una ejecución
    // anterior interrumpida, se libera antes de pedir el nuevo.
    try {
      await client.query("select pg_advisory_unlock_all()");
    } catch {
      /* el motor puede no tenerla; no es bloqueante */
    }

    // Espera acotada: un lock bloqueante sin timeout puede colgar la suite
    // (o un despliegue) indefinidamente.
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      const result = await client.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
      if (result.rows?.[0]?.ok) {
        locked = true;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "no se pudo obtener el bloqueo de migraciones en 10 s: otro proceso está migrando",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    const unsupported =
      error?.code === "42883" || /pg_advisory_lock|does not exist|not supported|no existe/i.test(message);

    if (!unsupported) throw error;

    clientsWithoutLock.add(client);
    if (!lockWarningEmitted) {
      lockWarningEmitted = true;
      console.warn(
        "aviso: el motor no soporta pg_advisory_lock; se continúa SIN bloqueo entre procesos",
      );
    }
  }

  try {
    return await work();
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
      } catch {
        try {
          await client.query("select pg_advisory_unlock_all()");
        } catch {
          console.warn("aviso: no se pudo liberar el bloqueo de migraciones; la sesión lo retiene");
        }
      }
    }
  }
}

/** Devuelve los archivos de migración ordenados por prefijo numérico. */
export async function listMigrations(direction, dir = MIGRATIONS_DIR) {
  const files = await readdir(dir);
  const suffix = direction === "up" ? ".up.sql" : ".down.sql";
  return files
    .filter((name) => name.endsWith(suffix))
    .sort((a, b) => {
      const na = Number.parseInt(a, 10);
      const nb = Number.parseInt(b, 10);
      return direction === "up" ? na - nb : nb - na;
    })
    .map((name) => path.join(dir, name));
}

/**
 * Aplica las migraciones pendientes. Devuelve solo las que se aplicaron ahora.
 * Una segunda ejecución devuelve [] en lugar de fallar.
 */
export async function applyMigrations(client, dir = MIGRATIONS_DIR) {
  return withLock(client, async () => {
    const current = await appliedMigrations(client);
    const byVersion = new Map(current.map((row) => [row.version, row]));

    const done = [];
    for (const file of await listMigrations("up", dir)) {
      const version = versionOf(file);
      const name = path.basename(file);
      const sql = await readFile(file, "utf8");
      const checksum = checksumOf(sql);

      const previous = byVersion.get(version);
      if (previous) {
        if (previous.checksum !== checksum) {
          throw new Error(
            `checksum distinto en ${name}: la migración ya aplicada fue modificada ` +
              `(registrada ${previous.checksum.slice(0, 12)}…, actual ${checksum.slice(0, 12)}…). ` +
              `No se aplica nada.`,
          );
        }
        continue; // ya aplicada: idempotencia
      }

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into ${BOOKKEEPING} (version, name, checksum) values ($1, $2, $3)`,
          [version, name, checksum],
        );
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          /* el error original manda */
        }
        throw error;
      }
      done.push(name);
    }
    return done;
  });
}

/**
 * Revierte lo registrado como aplicado, en orden inverso.
 * Devuelve solo las que se revirtieron ahora.
 */
export async function rollbackMigrations(client, dir = MIGRATIONS_DIR) {
  return withLock(client, async () => {
    const current = await appliedMigrations(client);
    const appliedVersions = new Set(current.map((row) => row.version));

    const reverted = [];
    for (const file of await listMigrations("down", dir)) {
      const version = versionOf(file);
      if (!appliedVersions.has(version)) continue;

      const sql = await readFile(file, "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`delete from ${BOOKKEEPING} where version = $1`, [version]);
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          /* el error original manda */
        }
        throw error;
      }
      reverted.push(path.basename(file));
    }
    return reverted;
  });
}

/**
 * Registra como aplicadas las migraciones que ya están en la base, sin ejecutarlas.
 * Para bases migradas antes de que existiera el libro de estado.
 */
export async function baselineMigrations(client, dir = MIGRATIONS_DIR) {
  return withLock(client, async () => {
    const current = await appliedMigrations(client);
    const known = new Set(current.map((row) => row.version));

    const registered = [];
    for (const file of await listMigrations("up", dir)) {
      const version = versionOf(file);
      if (known.has(version)) continue;

      const sql = await readFile(file, "utf8");
      await client.query(
        `insert into ${BOOKKEEPING} (version, name, checksum) values ($1, $2, $3)`,
        [version, path.basename(file), checksumOf(sql)],
      );
      registered.push(path.basename(file));
    }
    return registered;
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const command = process.argv[2] ?? "up";
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error(
      "Falta DATABASE_URL. Ejemplo: DATABASE_URL=postgres://auth:auth@127.0.0.1:5432/auth node scripts/migrate.mjs up",
    );
    process.exit(2);
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    if (command === "baseline") {
      if (!process.argv.includes("--force")) {
        console.error(
          "baseline marca migraciones como aplicadas SIN ejecutarlas. Añade --force si es lo que quieres.",
        );
        process.exit(2);
      }
      const names = await baselineMigrations(client);
      if (names.length === 0) console.log("baseline: nada que registrar (ya estaban todas)");
      for (const name of names) console.log(`registrada como aplicada: ${name}`);
    } else if (command === "down") {
      const names = await rollbackMigrations(client);
      if (names.length === 0) console.log("down: no hay migraciones aplicadas que revertir");
      for (const name of names) console.log(`revertida: ${name}`);
    } else if (command === "up") {
      const names = await applyMigrations(client);
      if (names.length === 0) console.log("up: sin migraciones pendientes (esquema al día)");
      for (const name of names) console.log(`aplicada: ${name}`);
    } else {
      console.error(`Comando desconocido: ${command}. Usa up | down | baseline.`);
      process.exit(2);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
