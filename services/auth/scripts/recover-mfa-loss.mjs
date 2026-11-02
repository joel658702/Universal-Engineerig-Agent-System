/**
 * recover-mfa-loss.mjs — desactivación administrativa de MFA (TASK-005).
 *
 * Es una vía para SALTAR el segundo factor, así que exige:
 *   · --user con el identificador,
 *   · --confirm con ese MISMO identificador (confirmación redundante),
 *   · --reason con el motivo.
 *
 * Sin los tres no hace nada. Deja rastro en mfa_recovery_audit y nunca imprime
 * secretos ni códigos.
 *
 * Uso:
 *   DATABASE_URL=... OPERATOR="ana" node scripts/recover-mfa-loss.mjs \
 *     --user user@example.com --confirm user@example.com --reason "ticket #123"
 */

import { pathToFileURL } from "node:url";

export const RECOVERY_USAGE =
  "Uso: --user <id|email> --confirm <mismo id|email> --reason <motivo> (OPERATOR en el entorno)";

/**
 * Valida los argumentos sin tocar la base de datos.
 * @returns {{ ok: true, user: string, reason: string, operator: string } | { ok: false, error: string }}
 */
export function parseRecoveryArgs(argv, env = process.env) {
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index !== -1 ? argv[index + 1] : undefined;
  };

  const user = valueOf("--user");
  const confirm = valueOf("--confirm");
  const reason = valueOf("--reason");
  const operator = env["OPERATOR"];

  if (!user || !confirm || !reason) return { ok: false, error: "faltan argumentos" };
  if (user !== confirm) return { ok: false, error: "la confirmación no coincide con --user" };
  if (reason.trim().length <= 3) return { ok: false, error: "el motivo es demasiado corto" };
  if (!operator || operator.trim().length === 0) return { ok: false, error: "falta OPERATOR" };

  return { ok: true, user, reason: reason.trim(), operator: operator.trim() };
}

/**
 * Desactiva MFA de un usuario en una transacción y deja auditoría.
 * @returns {Promise<{ ok: true, userId: string, wasEnabled: boolean } | { ok: false, error: string }>}
 */
export async function recoverMfaLoss({ client, user, operator, reason }) {
  await client.query("begin");

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user);
    const found = await client.query(
      `select id from users where ${isUuid ? "id = $1" : "lower(email) = lower($1)"} limit 1`,
      [user],
    );

    const row = found.rows[0];
    if (!row) {
      await client.query("rollback");
      return { ok: false, error: "usuario no encontrado" };
    }

    const userId = row.id;

    const mfa = await client.query(
      `select confirmed_at from user_mfa_secrets where user_id = $1 limit 1`,
      [userId],
    );
    const wasEnabled = mfa.rows.length > 0 && mfa.rows[0].confirmed_at !== null;

    if (!wasEnabled) {
      // Nada que desactivar: se registra igualmente para que quede la traza
      // de que alguien intentó una recuperación.
      await client.query(
        `insert into mfa_recovery_audit (user_id, operator, reason, mfa_was_enabled)
         values ($1, $2, $3, false)`,
        [userId, operator, reason],
      );
      await client.query("commit");
      return { ok: true, userId, wasEnabled: false };
    }

    await client.query(`delete from user_mfa_backup_codes where user_id = $1`, [userId]);
    await client.query(`delete from user_mfa_secrets where user_id = $1`, [userId]);
    await client.query(
      `update users set token_version = token_version + 1, updated_at = now() where id = $1`,
      [userId],
    );
    await client.query(
      `insert into mfa_recovery_audit (user_id, operator, reason, mfa_was_enabled)
       values ($1, $2, $3, true)`,
      [userId, operator, reason],
    );

    await client.query("commit");
    return { ok: true, userId, wasEnabled: true };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* el error original manda */
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const parsed = parseRecoveryArgs(process.argv.slice(2));

  if (!parsed.ok) {
    console.error(`ERROR: ${parsed.error}`);
    console.error(RECOVERY_USAGE);
    process.exit(2);
  }

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
      const result = await recoverMfaLoss({
        client,
        user: parsed.user,
        operator: parsed.operator,
        reason: parsed.reason,
      });

      if (!result.ok) {
        console.error(`ERROR: ${result.error}`);
        process.exitCode = 1;
      } else if (!result.wasEnabled) {
        console.log(`usuario ${result.userId}: no tenía MFA activo; auditoría registrada`);
      } else {
        console.log(
          `usuario ${result.userId}: MFA desactivado por ${parsed.operator} — ${parsed.reason}`,
        );
        console.log("sesiones revocadas (token_version incrementado)");
      }
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
