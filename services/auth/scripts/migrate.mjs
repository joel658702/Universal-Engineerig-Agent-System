/**
 * migrate.mjs — runner de migraciones (TASK-001, fase 1)
 *
 * Aplica los `.up.sql` en orden y los `.down.sql` en orden inverso.
 * No incluye driver: recibe un `client` con `.query()`, de modo que el mismo
 * código sirve para `pg` (producción) y para `pg-mem` (tests sin servidor).
 *
 * CLI:  DATABASE_URL=postgres://... node scripts/migrate.mjs up|down
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, "..", "migrations");

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

/** Aplica todas las migraciones hacia delante. Devuelve los archivos aplicados. */
export async function applyMigrations(client, dir = MIGRATIONS_DIR) {
  const applied = [];
  for (const file of await listMigrations("up", dir)) {
    const sql = await readFile(file, "utf8");
    await client.query(sql);
    applied.push(path.basename(file));
  }
  return applied;
}

/** Revierte todas las migraciones en orden inverso. */
export async function rollbackMigrations(client, dir = MIGRATIONS_DIR) {
  const reverted = [];
  for (const file of await listMigrations("down", dir)) {
    const sql = await readFile(file, "utf8");
    await client.query(sql);
    reverted.push(path.basename(file));
  }
  return reverted;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const direction = process.argv[2] ?? "up";
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("Falta DATABASE_URL. Ejemplo: DATABASE_URL=postgres://auth:auth@127.0.0.1:5432/auth node scripts/migrate.mjs up");
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const done =
      direction === "down" ? await rollbackMigrations(client) : await applyMigrations(client);
    for (const name of done) console.log(`${direction === "down" ? "revertida" : "aplicada"}: ${name}`);
  } finally {
    await client.end();
  }
}
