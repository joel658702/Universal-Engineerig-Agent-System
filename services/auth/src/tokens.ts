/**
 * Emisión y verificación de tokens — TASK-001, fase 3.
 *
 * - Access token: JWT firmado con EdDSA (Ed25519). Asimétrico para que los
 *   servicios que solo validan no necesiten la clave de firma.
 * - Refresh token: opaco (no JWT), 256 bits, almacenado como SHA-256.
 *
 * Toda verificación fija el algoritmo permitido: `alg: none` y la confusión
 * HS/RS son los fallos clásicos de JWT.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

export type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

export type TokenConfig = {
  privateKey: SigningKey;
  publicKey: SigningKey;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  kid: string;
};

export type AccessClaims = {
  sub: string;
  tokenVersion: number;
};

const ALGORITHM = "EdDSA";

export async function loadKeys(privatePem: string, publicPem: string): Promise<{ privateKey: SigningKey; publicKey: SigningKey }> {
  return {
    privateKey: await importPKCS8(privatePem, ALGORITHM),
    publicKey: await importSPKI(publicPem, ALGORITHM),
  };
}

export async function signAccessToken(
  config: TokenConfig,
  subject: string,
  tokenVersion: number,
): Promise<string> {
  return new SignJWT({ typ: "access", tv: tokenVersion })
    .setProtectedHeader({ alg: ALGORITHM, kid: config.kid, typ: "JWT" })
    .setSubject(subject)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSeconds}s`)
    .setJti(randomUUID())
    .sign(config.privateKey);
}

/** Lanza si el token no es válido. El llamador traduce a 401. */
export async function verifyAccessToken(config: TokenConfig, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, config.publicKey, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: [ALGORITHM],
    clockTolerance: 30,
  });

  // Un refresh token no puede servir como access token aunque comparta firma.
  if (payload["typ"] !== "access") throw new Error("token_typ_mismatch");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("token_missing_sub");

  const tokenVersion = Number(payload["tv"] ?? 0);
  if (!Number.isInteger(tokenVersion)) throw new Error("token_bad_tv");

  return { sub: payload.sub, tokenVersion };
}

export type RefreshToken = { token: string; hash: Buffer };

export function generateRefreshToken(): RefreshToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
