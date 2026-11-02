/**
 * Hardening configurable — TASK-001, fase 6.
 *
 * Tres modos de autenticación:
 *   bearer  → solo `Authorization: Bearer`, CORS con lista blanca.
 *   cookie  → cookies httpOnly/Secure/SameSite=Strict + CSRF + CSP.
 *   both    → el encabezado tiene prioridad; si falta, se usan cookies.
 *
 * Sin dependencias externas: CORS, cookies y CSRF se implementan aquí para no
 * añadir superficie de suministro a un servicio de autenticación.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type AuthMode = "bearer" | "cookie" | "both";

export const COOKIE_ACCESS = "access_token";
export const COOKIE_REFRESH = "refresh_token";
export const COOKIE_CSRF = "csrf_token";
export const CSRF_HEADER = "x-csrf-token";

const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

export function securityHeaders(mode: AuthMode) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // El filtro XSS de los navegadores antiguos introducía sus propios fallos:
    // el valor recomendado hoy es desactivarlo y confiar en CSP.
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    // CSP solo tiene sentido si puede haber contenido ejecutándose con cookies.
    if (mode !== "bearer") res.setHeader("Content-Security-Policy", STRICT_CSP);
    next();
  };
}

export type CorsOptions = {
  allowedOrigins: string[];
  allowCredentials: boolean;
};

/**
 * CORS con lista blanca explícita. Un origen no listado no recibe cabeceras
 * CORS: el navegador bloquea la lectura. No se refleja el origen recibido.
 */
export function corsMiddleware(options: CorsOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");

    if (origin) {
      res.setHeader("Vary", "Origin");
      if (options.allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        if (options.allowCredentials) res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-csrf-token");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Max-Age", "600");
      }
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) result[name] = decodeURIComponent(value);
  }
  return result;
}

const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(COOKIE_ACCESS, accessToken, { ...COOKIE_BASE, maxAge: 15 * 60 * 1000 });
  res.cookie(COOKIE_REFRESH, refreshToken, { ...COOKIE_BASE, maxAge: 30 * 24 * 60 * 60 * 1000 });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(COOKIE_ACCESS, COOKIE_BASE);
  res.clearCookie(COOKIE_REFRESH, COOKIE_BASE);
  res.clearCookie(COOKIE_CSRF, { ...COOKIE_BASE, httpOnly: false });
}

/**
 * Doble envío: el token viaja en una cookie legible por JS y en un encabezado
 * que el atacante cross-site no puede leer ni fijar. Debe ser httpOnly=false
 * para que la SPA pueda copiarlo al encabezado.
 */
export function issueCsrfToken(res: Response): string {
  const token = randomBytes(32).toString("base64url");
  res.cookie(COOKIE_CSRF, token, { ...COOKIE_BASE, httpOnly: false, maxAge: 2 * 60 * 60 * 1000 });
  return token;
}

export function csrfTokenMatches(req: Request): boolean {
  const cookies = parseCookies(req.header("cookie"));
  const fromCookie = cookies[COOKIE_CSRF];
  const fromHeader = req.header(CSRF_HEADER);
  if (!fromCookie || !fromHeader) return false;

  const a = Buffer.from(fromCookie);
  const b = Buffer.from(fromHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function wantsCookies(mode: AuthMode): boolean {
  return mode === "cookie" || mode === "both";
}
