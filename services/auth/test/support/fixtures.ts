/**
 * Utilidades de test compartidas: PostgreSQL en memoria (pg-mem) con las
 * migraciones aplicadas y un par de claves Ed25519.
 *
 * ADVERTENCIA: pg-mem es un emulador, no PostgreSQL. Sirve para validar el
 * flujo de negocio, no semántica exacta del motor.
 */

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import { applyMigrations } from "../../scripts/migrate.mjs";
import { loadKeys } from "../../src/tokens.ts";
import type { TokenConfig } from "../../src/tokens.ts";

/**
 * Una sola conexión real compartida: los tests corren en serie, así que
 * reutilizarla evita agotar max_connections (52 tests = 52 clientes).
 * El esquema se reinicia antes de cada test, igual que un pg-mem nuevo.
 */
type RealClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
let realClient: RealClient | null = null;

async function getRealClient(): Promise<RealClient> {
  if (!realClient) {
    const pg = await import("pg");
    // allowExitOnIdle evita que el proceso de test quede vivo por una conexión
    // ociosa; max:1 fuerza serialización, que es lo que asumen los tests.
    const pool = new pg.Pool({
      connectionString: process.env["TEST_DATABASE_URL"],
      max: 1,
      allowExitOnIdle: true,
    });
    realClient = pool as unknown as RealClient;
  }
  return realClient;
}

async function makeRealDb(): Promise<RealClient> {
  const client = await getRealClient();
  await client.query("drop schema if exists public cascade");
  await client.query("create schema public");
  await applyMigrations(client);
  return client;
}

export async function makeMemDb() {
  // Con TEST_DATABASE_URL los mismos tests corren contra PostgreSQL real.
  if (process.env["TEST_DATABASE_URL"]) return makeRealDb();
  const client = await makeEmptyDb();
  await applyMigrations(client);
  return client;
}

/** pg-mem sin migraciones aplicadas, para probar el runner desde cero. */
export async function makeEmptyDb() {
  // Igual que makeMemDb: con TEST_DATABASE_URL, motor real y esquema limpio.
  if (process.env["TEST_DATABASE_URL"]) {
    const client = await getRealClient();
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
    return client;
  }

  const db = newDb();
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });
  db.public.registerFunction({
    name: "lower",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.toLowerCase(),
  });
  db.public.registerFunction({
    name: "trim",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.trim(),
  });
  db.public.registerFunction({
    name: "length",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });

  const adapter = db.adapters.createPg();
  const client = new adapter.Client();
  await client.connect();
  return client;
}

export async function makeTokenConfig(overrides: Partial<TokenConfig> = {}): Promise<TokenConfig> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = await loadKeys(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    issuer: "https://auth.ueas.local",
    audience: "ueas-api",
    accessTtlSeconds: 900,
    kid: "test-key-1",
    ...overrides,
  };
}

export function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
