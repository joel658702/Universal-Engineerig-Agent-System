/**
 * Suite de fase 0 — sin dependencias: usa node:test y fetch nativos.
 *
 * Ejecuta:  node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { start } from "../src/main.ts";

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await start(0);
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /health responde 200 con {status:'ok'}", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("ruta desconocida responde 404 y no filtra detalles", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/usuarios`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});

test("método no permitido en /health responde 404 (no hay verbo POST)", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    assert.equal(response.status, 404);
  });
});
