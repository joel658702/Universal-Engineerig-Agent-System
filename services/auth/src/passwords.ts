/**
 * Hashing de contraseñas — argon2id (TASK-001, fase 2).
 *
 * Parámetros alineados con la recomendación OWASP para argon2id:
 * memoria 19 MiB, 2 iteraciones, paralelismo 1.
 */

import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/** Devuelve false en lugar de lanzar: un hash corrupto no debe tumbar el login. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Consume el mismo tiempo que una verificación real cuando el usuario no existe.
 * Sin esto, el tiempo de respuesta delata qué correos están registrados.
 */
export async function burnPasswordTime(plain: string): Promise<void> {
  dummyHash ??= argon2.hash(randomBytes(32).toString("hex"), OPTIONS);
  const hash = await dummyHash;
  try {
    await argon2.verify(hash, plain);
  } catch {
    /* irrelevante: solo buscamos el coste temporal */
  }
}
