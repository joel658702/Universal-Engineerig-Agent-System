/**
 * Repositorio de usuarios — TASK-001, fase 2.
 *
 * Recibe cualquier `Queryable` (pg.Pool en producción, pg-mem en tests) para
 * que la lógica no dependa del driver.
 */

export type Queryable = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  token_version: number;
  disabled_at: Date | string | null;
};

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `select id, email, password_hash, token_version, disabled_at
       from users
      where lower(email) = lower($1)
      limit 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `select id, email, password_hash, token_version, disabled_at
       from users
      where id = $1
      limit 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function createUser(db: Queryable, email: string, passwordHash: string): Promise<UserRow> {
  const result = await db.query<UserRow>(
    `insert into users (email, password_hash)
     values ($1, $2)
     returning id, email, password_hash, token_version, disabled_at`,
    [email, passwordHash],
  );
  const row = result.rows[0];
  if (!row) throw new Error("insert_returned_no_rows");
  return row;
}

export type NewRefreshToken = {
  userId: string;
  familyId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  userAgent: string | null;
};

export async function insertRefreshToken(db: Queryable, input: NewRefreshToken): Promise<void> {
  await db.query(
    `insert into refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
     values ($1, $2, $3, $4, $5)`,
    [input.userId, input.familyId, input.tokenHash.toString("hex"), input.expiresAt, input.userAgent],
  );
}

/** Código 23505 = unique_violation en PostgreSQL. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date | string;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
};

export async function findRefreshTokenByHash(db: Queryable, hashHex: string): Promise<RefreshTokenRow | null> {
  const result = await db.query<RefreshTokenRow>(
    `select id, user_id, family_id, token_hash, expires_at, rotated_at, revoked_at
       from refresh_tokens
      where token_hash = $1
      limit 1`,
    [hashHex],
  );
  return result.rows[0] ?? null;
}

/**
 * Reclama la rotación de forma atómica. Devuelve false si otro proceso ya la
 * tomó (o si el token estaba revocado): esa carrera es, en la práctica, un
 * intento de reutilización.
 */
export async function markRefreshRotated(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update refresh_tokens
        set rotated_at = now()
      where id = $1
        and rotated_at is null
        and revoked_at is null
      returning id`,
    [id],
  );
  return result.rows.length === 1;
}

export async function revokeRefreshFamily(db: Queryable, familyId: string): Promise<void> {
  await db.query(
    `update refresh_tokens
        set revoked_at = now()
      where family_id = $1
        and revoked_at is null`,
    [familyId],
  );
}

/** Revoca todas las sesiones del usuario (todas sus familias). */
export async function revokeAllUserRefreshTokens(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `update refresh_tokens
        set revoked_at = now()
      where user_id = $1
        and revoked_at is null`,
    [userId],
  );
}

/**
 * Cambia el hash y sube token_version en una sola sentencia.
 * Devuelve la versión nueva, que es la que debe viajar en el próximo access.
 */
export async function updatePasswordHash(db: Queryable, userId: string, passwordHash: string): Promise<number | null> {
  const result = await db.query<{ token_version: number }>(
    `update users
        set password_hash = $2,
            token_version = token_version + 1,
            updated_at = now()
      where id = $1
      returning token_version`,
    [userId, passwordHash],
  );
  return result.rows[0]?.token_version ?? null;
}
