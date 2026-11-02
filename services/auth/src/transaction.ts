/**
 * Transacciones — TASK-001.
 *
 * `Queryable` es deliberadamente genérico (pg en producción, pg-mem en tests),
 * así que la transacción se expresa en SQL y no con una API del driver.
 * Si el motor no soporta BEGIN/COMMIT, el error sube: no se degrada en
 * silencio a una ejecución sin transacción.
 */

import type { Queryable } from "./users.ts";

export async function runInTransaction<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // Si el ROLLBACK falla, el error original sigue siendo el relevante.
    }
    throw error;
  }
}
