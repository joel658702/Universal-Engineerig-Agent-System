/**
 * Rotación de refresh tokens — TASK-001, fase 4.
 *
 * Reglas:
 *   1. Cada uso de un refresh emite uno nuevo de la MISMA familia y marca el
 *      anterior como rotado.
 *   2. Si llega un token ya rotado, se asume robo: se revoca la familia entera.
 *   3. La rotación se reclama con un UPDATE atómico; si otro proceso ganó la
 *      carrera, se trata también como reutilización.
 */

import { generateRefreshToken, hashRefreshToken } from "./tokens.ts";
import {
  findRefreshTokenByHash,
  findUserById,
  insertRefreshToken,
  markRefreshRotated,
  revokeRefreshFamily,
  type Queryable,
} from "./users.ts";

export type RotateFailure = "unknown" | "revoked" | "reuse" | "expired" | "user_disabled" | "rate_limited";

export type RotateResult =
  | { ok: true; refreshToken: string; userId: string; tokenVersion: number }
  | { ok: false; reason: RotateFailure; retryAfterSeconds?: number };

export type RotateHooks = {
  /**
   * Se invoca al resolver la familia del token presentado, antes de rotar.
   * Permite limitar por familia sin duplicar la consulta.
   */
  onTokenResolved?: (familyId: string) => { allowed: boolean; retryAfterSeconds?: number };
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function rotateRefreshToken(
  db: Queryable,
  presentedToken: string,
  userAgent: string | null,
  ttlSeconds: number,
  now: Date = new Date(),
  hooks: RotateHooks = {},
): Promise<RotateResult> {
  const row = await findRefreshTokenByHash(db, hashRefreshToken(presentedToken).toString("hex"));
  if (!row) return { ok: false, reason: "unknown" };

  // Límite por familia: se aplica antes de rotar, para que un token robado no
  // pueda generar rotaciones en masa.
  const gate = hooks.onTokenResolved?.(row.family_id);
  if (gate && !gate.allowed) {
    return { ok: false, reason: "rate_limited", retryAfterSeconds: gate.retryAfterSeconds ?? 60 };
  }

  if (row.revoked_at) return { ok: false, reason: "revoked" };

  // Token ya rotado presentado de nuevo → posible robo: cae toda la familia.
  if (row.rotated_at) {
    await revokeRefreshFamily(db, row.family_id);
    return { ok: false, reason: "reuse" };
  }

  if (asDate(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const claimed = await markRefreshRotated(db, row.id);
  if (!claimed) {
    await revokeRefreshFamily(db, row.family_id);
    return { ok: false, reason: "reuse" };
  }

  const user = await findUserById(db, row.user_id);
  if (!user || user.disabled_at) return { ok: false, reason: "user_disabled" };

  const next = generateRefreshToken();
  await insertRefreshToken(db, {
    userId: user.id,
    familyId: row.family_id,
    tokenHash: next.hash,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    userAgent,
  });

  return { ok: true, refreshToken: next.token, userId: user.id, tokenVersion: user.token_version };
}

/** Cierra la sesión: revoca la familia del token presentado. Idempotente. */
export async function revokeSession(db: Queryable, presentedToken: string): Promise<boolean> {
  const row = await findRefreshTokenByHash(db, hashRefreshToken(presentedToken).toString("hex"));
  if (!row) return false;
  await revokeRefreshFamily(db, row.family_id);
  return true;
}
