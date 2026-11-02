/**
 * Segundo factor TOTP — TASK-004.
 *
 * Implementación propia de RFC 6238 sobre `node:crypto` (HMAC-SHA1 + truncado
 * dinámico), validada contra los cinco vectores del Apéndice B del RFC.
 *
 * Motivo de no usar librería: `otplib@12.0.1` no acepta base32, ignora el
 * tiempo por argumento y no reproduce los vectores publicados (ver UEAS-020).
 * Las 30 líneas de TOTP son la especificación, no una invención.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { runInTransaction } from "./transaction.ts";
import type { Queryable } from "./users.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CIPHER = "aes-256-gcm";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

// Secreto señuelo: se usa para gastar el mismo tiempo cuando la cuenta no tiene
// MFA activo, de modo que el tiempo de respuesta no delate si existe o no.
const DECOY_SECRET = (() => {
  const buf = randomBytes(20);
  return { buf };
})();

// ---------------------------------------------------------------- base32

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`base32 inválido: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ TOTP

/** Secreto de 160 bits en base32 (recomendación de RFC 4226 §4). */
export function generateMfaSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(
  secretBase32: string,
  epochMs: number,
  digits: number = TOTP_DIGITS,
  stepSeconds: number = TOTP_STEP_SECONDS,
): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(epochMs / 1000 / stepSeconds);

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Compara en tiempo constante contra la ventana ±1 paso. */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: { now?: number; window?: number; digits?: number; stepSeconds?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
  const window = options.window ?? TOTP_WINDOW;
  const digits = options.digits ?? TOTP_DIGITS;
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;

  const candidate = String(token).replace(/\s+/g, "");
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const code = totpAt(secretBase32, now + offset * step * 1000, digits, step);
    if (safeEqual(code, candidate)) matched = true; // no se corta: mismo coste
  }
  return matched;
}

/** Gasta el mismo trabajo que una verificación real, sin revelar nada. */
export function burnTotpTime(token: string, now: number = Date.now()): void {
  const decoy = base32Encode(DECOY_SECRET.buf);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const code = totpAt(decoy, now + offset * TOTP_STEP_SECONDS * 1000);
    safeEqual(code, String(token));
  }
}

export function buildOtpAuthUri(secretBase32: string, account: string, issuer = "UEAS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// -------------------------------------------------------------- cifrado

export type EncryptedSecret = { ciphertext: string; iv: string; authTag: string };

export function loadMfaKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env["MFA_MASTER_KEY"];
  if (!raw) throw new Error("Falta MFA_MASTER_KEY (32 bytes en base64)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MFA_MASTER_KEY debe decodificar a exactamente 32 bytes");
  return key;
}

export function encryptSecret(secret: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Lanza si la clave no es la correcta: así falla GCM, no un if. */
export function decryptSecret(record: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------- códigos de respaldo

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString("hex").toUpperCase());
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

// ------------------------------------------------------------------- BD

export type MfaSecretRow = {
  user_id: string;
  secret_ciphertext: string;
  iv: string;
  auth_tag: string;
  key_id: string;
  confirmed_at: Date | string | null;
};

export async function getMfaSecretRow(db: Queryable, userId: string): Promise<MfaSecretRow | null> {
  const result = await db.query<MfaSecretRow>(
    `select user_id, secret_ciphertext, iv, auth_tag, key_id, confirmed_at
       from user_mfa_secrets
      where user_id = $1
      limit 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function isMfaEnabled(db: Queryable, userId: string): Promise<boolean> {
  const row = await getMfaSecretRow(db, userId);
  return row !== null && row.confirmed_at !== null;
}

/**
 * Guarda un secreto pendiente. Nunca sobrescribe uno ya confirmado: para
 * cambiarlo hay que desactivar MFA primero.
 */
export async function savePendingSecret(
  db: Queryable,
  userId: string,
  encrypted: EncryptedSecret,
  keyId = "v1",
): Promise<void> {
  const existing = await getMfaSecretRow(db, userId);

  if (existing && existing.confirmed_at !== null) {
    throw new Error("mfa_already_enabled");
  }

  if (existing) {
    await db.query(
      `update user_mfa_secrets
          set secret_ciphertext = $2, iv = $3, auth_tag = $4, key_id = $5, created_at = now()
        where user_id = $1`,
      [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, keyId],
    );
    return;
  }

  await db.query(
    `insert into user_mfa_secrets (user_id, secret_ciphertext, iv, auth_tag, key_id)
     values ($1, $2, $3, $4, $5)`,
    [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, keyId],
  );
}

export async function confirmMfaSecret(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query<{ user_id: string }>(
    `update user_mfa_secrets
        set confirmed_at = now()
      where user_id = $1
        and confirmed_at is null
      returning user_id`,
    [userId],
  );
  return result.rows.length === 1;
}

export async function deleteMfa(db: Queryable, userId: string): Promise<void> {
  await runInTransaction(db, async () => {
    await db.query(`delete from user_mfa_backup_codes where user_id = $1`, [userId]);
    await db.query(`delete from user_mfa_secrets where user_id = $1`, [userId]);
  });
}

export async function replaceBackupCodes(
  db: Queryable,
  userId: string,
  hashes: string[],
): Promise<void> {
  await runInTransaction(db, async () => {
    await db.query(`delete from user_mfa_backup_codes where user_id = $1`, [userId]);
    for (const hash of hashes) {
      await db.query(
        `insert into user_mfa_backup_codes (user_id, code_hash) values ($1, $2)`,
        [userId, hash],
      );
    }
  });
}

export async function consumeBackupCode(
  db: Queryable,
  userId: string,
  hash: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update user_mfa_backup_codes
        set used_at = now()
      where user_id = $1
        and code_hash = $2
        and used_at is null
      returning id`,
    [userId, hash],
  );
  return result.rows.length === 1;
}

// -------------------------------------------------------------- desafíos

export type ChallengeResult = { ok: true; userId: string } | { ok: false };

export async function createMfaChallenge(
  db: Queryable,
  userId: string,
  ttlSeconds: number,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await db.query(
    `insert into mfa_challenges (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [userId, hash, expiresAt],
  );

  return token;
}

/** Consumo atómico: un mfa_token sirve exactamente una vez. */
export async function consumeMfaChallenge(
  db: Queryable,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  const result = await db.query<{ user_id: string }>(
    `update mfa_challenges
        set used_at = $2
      where token_hash = $1
        and used_at is null
        and expires_at > $2
      returning user_id`,
    [hash, now],
  );
  return result.rows[0]?.user_id ?? null;
}

// ------------------------------------------- prevención de replay (TASK-006)

/**
 * Reclama un código TOTP para un usuario.
 *
 * Una sola sentencia: no existe ventana entre comprobar e insertar, así que dos
 * peticiones simultáneas con el mismo código no pueden pasar ambas. Si la fila
 * existe pero es más antigua que la ventana, el DO UPDATE la renueva y el código
 * vuelve a ser válido.
 *
 * @returns true si es la primera vez dentro de la ventana; false si es replay.
 */
export async function claimTotpCode(
  db: Queryable,
  userId: string,
  code: string,
  windowSeconds: number = 60,
  now: Date = new Date(),
): Promise<boolean> {
  const hash = createHash("sha256").update(code).digest("hex");
  const step = Math.floor(now.getTime() / (TOTP_STEP_SECONDS * 1000));

  const result = await db.query<{ user_id: string }>(
    `insert into mfa_used_codes (user_id, code_hash, used_at, step)
     values ($1, $2, $3, $4)
     on conflict (user_id, code_hash) do update
        set used_at = excluded.used_at,
            step = excluded.step
      where mfa_used_codes.used_at < ($3::timestamptz - ($5::int * interval '1 second'))
     returning user_id`,
    [userId, hash, now, step, windowSeconds],
  );

  return result.rows.length === 1;
}

/** Borra los códigos usados más antiguos que `olderThanSeconds`. */
export async function cleanupUsedTotpCodes(
  db: Queryable,
  olderThanSeconds: number = 120,
  now: Date = new Date(),
): Promise<number> {
  const result = await db.query<{ user_id: string }>(
    `delete from mfa_used_codes
      where used_at < ($1::timestamptz - ($2::int * interval '1 second'))
      returning user_id`,
    [now, olderThanSeconds],
  );
  return result.rows.length;
}
