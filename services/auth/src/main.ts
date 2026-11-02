/**
 * Bootstrap del servicio de autenticación — TASK-001, fase 0.
 *
 * Deliberadamente sin dependencias externas: Node 24 ejecuta TypeScript
 * nativamente (type stripping), de modo que este esqueleto es verificable
 * antes de instalar nada. Las fases 2+ (argon2, jose, pg) requieren
 * `npm install` y quedan bloqueadas mientras no haya red.
 *
 * Contrato actual: GET /health → 200 {"status":"ok"} ; cualquier otra → 404.
 */

import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

export const ROUTES = ["/health"] as const;

export function createHealthServer(): Server {
  return createServer((request, response) => {
    const url = request.url ?? "/";

    if (request.method === "GET" && url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

export async function start(port = 0): Promise<Server> {
  const server = createHealthServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env["PORT"] ?? 3000);
  const server = await start(port);
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  console.log(`auth-service escuchando en http://127.0.0.1:${bound}`);
}
