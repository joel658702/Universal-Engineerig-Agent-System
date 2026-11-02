/**
 * Autenticación de peticiones — TASK-001.
 *
 * Extraído para que /auth/me y /auth/password compartan exactamente las mismas
 * comprobaciones. Duplicarlas es cómo se cuelan las diferencias.
 */

import { verifyAccessToken, type TokenConfig } from "./tokens.ts";
import { findUserById, type Queryable, type UserRow } from "./users.ts";

export async function authenticateRequest(
  db: Queryable,
  config: TokenConfig,
  authorizationHeader: string | undefined,
): Promise<UserRow | null> {
  const header = authorizationHeader ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token.length === 0) return null;

  let claims;
  try {
    claims = await verifyAccessToken(config, token);
  } catch {
    return null;
  }

  const user = await findUserById(db, claims.sub);
  if (!user || user.disabled_at) return null;

  // Revocación global: cualquier cambio de token_version invalida el access.
  if (user.token_version !== claims.tokenVersion) return null;

  return user;
}
