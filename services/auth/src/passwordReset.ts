/**
 * Recuperación de contraseña — TASK-003.
 *
 * Token de 256 bits, guardado solo como SHA-256, con TTL de 15 minutos.
 * El consumo es un UPDATE atómico dentro de la misma transacción que cambia la
 * contraseña y revoca todas las sesiones: o se hace todo, o no se hace nada.
 */

import { createHash, randomBytes } from "node:crypto";

import { runInTransaction } from "./transaction.ts";
import { revokeAllUserRefreshTokens, type Queryable } from "./users.ts";

export const RESET_TOKEN_TTL_MINUTES = 15;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashResetToken(token) };
}

/** Crea una solicitud y devuelve el token en claro (para el mailer, nunca para la BD). */
export async function createResetRequest(
  db: Queryable,
  userId: string,
  ipHash: Buffer | null = null,
  ttlMinutes: number = RESET_TOKEN_TTL_MINUTES,
): Promise<string> {
  const { token, hash } = generateResetToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  await db.query(
    `insert into password_resets (user_id, token_hash, expires_at, ip_hash)
     values ($1, $2, $3, $4)`,
    [userId, hash, expiresAt, ipHash],
  );

  return token;
}

export type ConsumeResult = { ok: true; userId: string } | { ok: false };

/**
 * Consume el token y aplica el cambio de contraseña de forma atómica.
 * Devuelve { ok: false } tanto si el token no existe como si expiró o ya se usó:
 * el cliente no debe poder distinguirlos.
 */
export async function consumeResetToken(
  db: Queryable,
  token: string,
  newPasswordHash: string,
  now: Date = new Date(),
): Promise<ConsumeResult> {
  const hash = hashResetToken(token);

  return runInTransaction(db, async () => {
    // Reclamo atómico: solo uno gana, y solo si sigue vigente.
    const claimed = await db.query<{ user_id: string }>(
      `update password_resets
          set used_at = $2
        where token_hash = $1
          and used_at is null
          and expires_at > $2
        returning user_id`,
      [hash, now],
    );

    const row = claimed.rows[0];
    if (!row) return { ok: false };

    // Un token nuevo invalida los demás pendientes del mismo usuario.
    await db.query(
      `update password_resets
          set used_at = $2
        where user_id = $1
          and used_at is null`,
      [row.user_id, now],
    );

    // Revocación global de sesiones (reutiliza TASK-001).
    await revokeAllUserRefreshTokens(db, row.user_id);

    const updated = await db.query<{ id: string }>(
      `update users
          set password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        where id = $1
        returning id`,
      [row.user_id, newPasswordHash],
    );

    if (updated.rows.length === 0) throw new Error("user_missing_during_reset");

    return { ok: true, userId: row.user_id };
  });
}
