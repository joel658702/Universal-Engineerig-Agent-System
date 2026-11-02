/**
 * F7 — rollback drill contra PostgreSQL real.
 *
 * Requiere DATABASE_URL apuntando a una base desechable.
 * Cada comprobación imprime JSON para que la evidencia sea la salida, no mi resumen.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { createApp } from "../src/app.ts";
import { loadKeys } from "../src/tokens.ts";
import { applyMigrations, rollbackMigrations } from "./migrate.mjs";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("Falta DATABASE_URL");
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ check: name, pass, detail });
  console.log(JSON.stringify({ check: name, pass, detail }));
};

const pool = new pg.Pool({ connectionString: url, max: 4, allowExitOnIdle: true });
const exists = async (table) => {
  const r = await pool.query("select to_regclass($1) as reg", [`public.${table}`]);
  return r.rows[0].reg !== null;
};

// --- (b) rollback de migraciones restaura el estado anterior -----------------
await rollbackMigrations(pool);
const afterDown = !(await exists("users")) && !(await exists("refresh_tokens"));
await applyMigrations(pool);
const afterUp = (await exists("users")) && (await exists("refresh_tokens"));
record("migrate down elimina ambas tablas y up las recrea", afterDown && afterUp, { afterDown, afterUp });

// --- (a) fallo durante una migración no deja esquema a medias ----------------
const brokenDir = path.resolve(process.cwd(), ".f7-tmp");
await mkdir(brokenDir, { recursive: true });
await writeFile(
  path.join(brokenDir, "900_broken.up.sql"),
  "CREATE TABLE f7_probe (id integer);\nSELECT * FROM tabla_que_no_existe;\n",
  "utf8",
);
let migrationThrew = false;
try {
  await applyMigrations(pool, brokenDir);
} catch {
  migrationThrew = true;
}
const probeSurvived = (await exists("f7_probe")) !== null && (await exists("f7_probe"));
record("migración fallida revierte su propia sentencia válida", migrationThrew && !probeSurvived, {
  migrationThrew,
  probeSurvived,
});
await rm(brokenDir, { recursive: true, force: true });

// --- (c) concurrencia real ---------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = await loadKeys(
  privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKey.export({ type: "spki", format: "pem" }).toString(),
);
const config = {
  ...keys,
  issuer: "https://auth.ueas.local",
  audience: "ueas-api",
  accessTtlSeconds: 900,
  kid: "f7-drill",
};

const app = createApp({ db: pool, tokens: config, allowedOrigins: [] });
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const email = `f7-${Date.now()}@example.com`;
const password = "correct-horse-battery-staple";
const post = (route, body, headers = {}) =>
  fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// Dos registros simultáneos con el mismo correo.
const registers = await Promise.all([
  post("/auth/register", { email, password }),
  post("/auth/register", { email, password }),
]);
const regStatuses = registers.map((r) => r.status).sort();
record("registro concurrente: exactamente un 201 y un 409", regStatuses.join(",") === "201,409", {
  statuses: regStatuses,
});

// Dos refresh simultáneos con el mismo token.
const login = await post("/auth/login", { email, password });
const { refresh_token } = await login.json();
const refreshes = await Promise.all([
  post("/auth/refresh", { refresh_token }),
  post("/auth/refresh", { refresh_token }),
]);
const refStatuses = refreshes.map((r) => r.status).sort();
const alive = await pool.query(
  "select count(*)::int as n from refresh_tokens where revoked_at is null",
);
record("refresh concurrente: una rotación gana y la otra se detecta como reutilización", refStatuses.join(",") === "200,401", {
  statuses: refStatuses,
  tokens_vivos: alive.rows[0].n,
});

// --- (d) transacción explícita ----------------------------------------------
await pool.query("BEGIN");
await pool.query("insert into users (email, password_hash) values ($1, $2)", ["f7-tx@example.com", "h"]);
await pool.query("ROLLBACK");
const txCount = await pool.query("select count(*)::int as n from users where email = $1", ["f7-tx@example.com"]);
record("BEGIN/ROLLBACK no deja el insert", txCount.rows[0].n === 0, { filas: txCount.rows[0].n });

await new Promise((resolve) => server.close(resolve));
await pool.end();

const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ resumen: { total: results.length, fallos: failed } }));
process.exit(failed === 0 ? 0 : 1);
