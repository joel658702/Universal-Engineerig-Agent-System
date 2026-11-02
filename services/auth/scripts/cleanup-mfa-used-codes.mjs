/**
 * cleanup-mfa-used-codes.mjs — limpieza de códigos TOTP usados (TASK-006).
 *
 * El `WHERE` de la reclamación ya acota la validez a 60 s, pero las filas se
 * acumulan. Este script borra las anteriores a 120 s (el doble, por margen).
 *
 * Uso:
 *   DATABASE_URL=... node scripts/cleanup-mfa-used-codes.mjs [--dry-run]
 */

import { pathToFileURL } from "node:url";

import { cleanupUsedTotpCodes } from "../src/mfa.ts";

export { cleanupUsedTotpCodes };

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env["DATABASE_URL"];

  if (!url) {
    console.error("Falta DATABASE_URL");
    process.exit(2);
  }

  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();

    try {
      if (dryRun) {
        const result = await client.query(
          `select count(*)::int as n from mfa_used_codes where used_at < now() - interval '120 seconds'`,
        );
        console.log(`dry-run: ${result.rows[0]?.n ?? 0} fila(s) se borrarían`);
      } else {
        const deleted = await cleanupUsedTotpCodes(client);
        console.log(`limpieza: ${deleted} fila(s) eliminadas`);
      }
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
