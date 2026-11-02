/**
 * API HTTP de autenticación — TASK-001, fases 2 y 3.
 *
 * Endpoints: POST /auth/register · POST /auth/login · GET /auth/me
 * Sin dependencias del driver: recibe un `Queryable`.
 */

import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { authenticateRequest } from "./authenticate.ts";
import { createNullMailer, type DevMailer, type Mailer } from "./mailer.ts";
import { consumeResetToken, createResetRequest } from "./passwordReset.ts";
import {
  clearAuthCookies,
  corsMiddleware,
  csrfTokenMatches,
  issueCsrfToken,
  parseCookies,
  securityHeaders,
  setAuthCookies,
  wantsCookies,
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  type AuthMode,
} from "./hardening.ts";
import { burnPasswordTime, hashPassword, verifyPassword } from "./passwords.ts";
import { createRateLimiter, type RateLimiter } from "./rateLimiter.ts";
import { runInTransaction } from "./transaction.ts";
import { revokeSession, rotateRefreshToken } from "./refresh.ts";
import { generateRefreshToken, signAccessToken, type TokenConfig } from "./tokens.ts";
import {
  createUser,
  findUserByEmail,
  insertRefreshToken,
  isUniqueViolation,
  revokeAllUserRefreshTokens,
  updatePasswordHash,
  type Queryable,
} from "./users.ts";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .refine((value) => EMAIL_RE.test(value), { message: "invalid_email" })
    .transform((value) => value.toLowerCase()),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  new_password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .refine((value) => EMAIL_RE.test(value), { message: "invalid_email" })
    .transform((value) => value.toLowerCase()),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(256),
  new_password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Express 4 no captura rechazos de promesas: se envuelve. */
function asyncHandler(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export type RateLimitSettings = {
  loginPerIp: { limit: number; windowMs: number };
  registerPerIp: { limit: number; windowMs: number };
  passwordPerUser: { limit: number; windowMs: number };
  refreshPerFamily: { limit: number; windowMs: number };
  forgotPerIp: { limit: number; windowMs: number };
  forgotPerEmail: { limit: number; windowMs: number };
};

/** Valores de arranque: ajustables por configuración, no dogma. */
export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  loginPerIp: { limit: 5, windowMs: 60_000 },
  registerPerIp: { limit: 5, windowMs: 60_000 },
  passwordPerUser: { limit: 3, windowMs: 60_000 },
  refreshPerFamily: { limit: 10, windowMs: 60_000 },
  forgotPerIp: { limit: 3, windowMs: 60_000 },
  forgotPerEmail: { limit: 3, windowMs: 60_000 },
};

export type AppDeps = {
  db: Queryable;
  tokens: TokenConfig;
  refreshTtlSeconds?: number;
  rateLimits?: Partial<RateLimitSettings>;
  /** Reloj inyectable para probar ventanas sin dormir el proceso. */
  clock?: () => number;
  /** Modo de autenticación. Por defecto bearer (el más restrictivo). */
  mode?: AuthMode;
  /** Orígenes permitidos por CORS. Vacío = ninguno (mismo origen). */
  allowedOrigins?: string[];
  /** Puerto de salida del correo. Por defecto, adaptador nulo. */
  mailer?: Mailer;
  /** Monta GET /_dev/outbox. El llamador debe aplicarlo solo con doble guardia. */
  devOutbox?: boolean;
};

function rejectRateLimited(res: Response, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "too_many_requests" });
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const refreshTtl = deps.refreshTtlSeconds ?? REFRESH_TTL_SECONDS;

  const mode: AuthMode = deps.mode ?? "bearer";
  const allowedOrigins = deps.allowedOrigins ?? [];

  const limits: RateLimitSettings = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  const clock = deps.clock;

  const loginLimiter: RateLimiter = createRateLimiter({ ...limits.loginPerIp, ...(clock ? { now: clock } : {}) });
  const registerLimiter: RateLimiter = createRateLimiter({ ...limits.registerPerIp, ...(clock ? { now: clock } : {}) });
  const passwordLimiter: RateLimiter = createRateLimiter({ ...limits.passwordPerUser, ...(clock ? { now: clock } : {}) });
  const refreshLimiter: RateLimiter = createRateLimiter({ ...limits.refreshPerFamily, ...(clock ? { now: clock } : {}) });
  const forgotIpLimiter: RateLimiter = createRateLimiter({ ...limits.forgotPerIp, ...(clock ? { now: clock } : {}) });
  const forgotEmailLimiter: RateLimiter = createRateLimiter({ ...limits.forgotPerEmail, ...(clock ? { now: clock } : {}) });

  const mailer: Mailer = deps.mailer ?? createNullMailer();
  const devOutbox =
    deps.devOutbox === true && "outbox" in mailer ? (mailer as DevMailer).outbox : null;

  const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

  const readAccessToken = (req: Request): { token: string; viaCookie: boolean } | null => {
    const header = req.header("authorization");
    // En modo "both" el encabezado tiene prioridad sobre la cookie.
    if (mode !== "cookie" && header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token.length > 0) return { token, viaCookie: false };
    }
    if (wantsCookies(mode)) {
      const token = parseCookies(req.header("cookie"))[COOKIE_ACCESS];
      if (token) return { token, viaCookie: true };
    }
    return null;
  };

  /** CSRF solo aplica a peticiones que se autentican por cookie. */
  const csrfFailed = (req: Request, viaCookie: boolean): boolean => {
    if (!viaCookie) return false;
    if (req.method === "GET" || req.method === "HEAD") return false;
    return !csrfTokenMatches(req);
  };

  app.disable("x-powered-by");
  app.use(securityHeaders(mode));
  app.use(corsMiddleware({ allowedOrigins, allowCredentials: wantsCookies(mode) }));
  app.use(express.json({ limit: "64kb" }));

  app.post(
    "/auth/register",
    asyncHandler(async (req, res) => {
      const registerDecision = registerLimiter.check(`register:${clientIp(req)}`);
      if (!registerDecision.allowed) return rejectRateLimited(res, registerDecision.retryAfterSeconds);

      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const { email, password } = parsed.data;
      const passwordHash = await hashPassword(password);

      try {
        const user = await createUser(deps.db, email, passwordHash);
        // 201 no devuelve hash ni tokens: el registro no inicia sesión.
        return res.status(201).json({ id: user.id, email: user.email });
      } catch (error) {
        // Nota de diseño: el 409 revela que el correo existe. Es un compromiso
        // consciente del registro; el login NO revela nada (ver abajo).
        if (isUniqueViolation(error)) return res.status(409).json({ error: "email_taken" });
        throw error;
      }
    }),
  );

  app.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      // Se cuenta antes de mirar el cuerpo: el 429 es idéntico exista o no el
      // usuario, así que no añade un oráculo de enumeración.
      const loginDecision = loginLimiter.check(`login:${clientIp(req)}`);
      if (!loginDecision.allowed) return rejectRateLimited(res, loginDecision.retryAfterSeconds);

      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const { email, password } = parsed.data;
      const user = await findUserByEmail(deps.db, email);

      if (!user) {
        // Mismo coste temporal y misma respuesta que una contraseña incorrecta.
        await burnPasswordTime(password);
        return res.status(401).json({ error: "invalid_credentials" });
      }

      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) return res.status(401).json({ error: "invalid_credentials" });

      if (user.disabled_at) return res.status(403).json({ error: "account_disabled" });

      const accessToken = await signAccessToken(deps.tokens, user.id, user.token_version);
      const refresh = generateRefreshToken();

      await insertRefreshToken(deps.db, {
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        userAgent: req.header("user-agent") ?? null,
      });

      if (wantsCookies(mode)) {
        setAuthCookies(res, accessToken, refresh.token);
        issueCsrfToken(res);
      }

      if (mode === "cookie") return res.status(200).json({ token_type: "cookie" });

      return res.status(200).json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: deps.tokens.accessTtlSeconds,
        refresh_token: refresh.token,
      });
    }),
  );

  app.get(
    "/auth/me",
    asyncHandler(async (req, res) => {
      const resolved = readAccessToken(req);
      if (!resolved) return res.status(401).json({ error: "unauthorized" });
      if (csrfFailed(req, resolved.viaCookie)) return res.status(403).json({ error: "csrf_failed" });

      const user = await authenticateRequest(deps.db, deps.tokens, `Bearer ${resolved.token}`);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      return res.status(200).json({ id: user.id, email: user.email });
    }),
  );

  app.post(
    "/auth/password",
    asyncHandler(async (req, res) => {
      const resolved = readAccessToken(req);
      if (!resolved) return res.status(401).json({ error: "unauthorized" });
      if (csrfFailed(req, resolved.viaCookie)) return res.status(403).json({ error: "csrf_failed" });

      const user = await authenticateRequest(deps.db, deps.tokens, `Bearer ${resolved.token}`);
      if (!user) return res.status(401).json({ error: "unauthorized" });

      // Límite por usuario: un access token robado no permite probar la
      // contraseña actual a ritmo de fuerza bruta.
      const passwordDecision = passwordLimiter.check(`password:${user.id}`);
      if (!passwordDecision.allowed) return rejectRateLimited(res, passwordDecision.retryAfterSeconds);

      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

      const currentOk = await verifyPassword(user.password_hash, parsed.data.current_password);
      if (!currentOk) return res.status(401).json({ error: "invalid_credentials" });

      const nextHash = await hashPassword(parsed.data.new_password);

      // Orden deliberado: primero mueren las sesiones, después cambia la clave.
      // Todo dentro de una transacción: si el segundo paso falla, no puede
      // quedar el usuario con las sesiones revocadas y la clave vieja.
      await runInTransaction(deps.db, async () => {
        await revokeAllUserRefreshTokens(deps.db, user.id);
        await updatePasswordHash(deps.db, user.id, nextHash);
      });

      // token_version sube: el access actual y todos los refresh dejan de valer.
      return res.status(204).end();
    }),
  );

  app.post(
    "/auth/refresh",
    asyncHandler(async (req, res) => {
      const bodyToken = typeof req.body?.refresh_token === "string" ? (req.body.refresh_token as string) : null;
      const cookieToken = wantsCookies(mode) ? (parseCookies(req.header("cookie"))[COOKIE_REFRESH] ?? null) : null;
      const presented = bodyToken ?? cookieToken;
      const viaCookie = bodyToken === null && cookieToken !== null;

      if (!presented || presented.length < 20) return res.status(400).json({ error: "invalid_request" });
      if (csrfFailed(req, viaCookie)) return res.status(403).json({ error: "csrf_failed" });

      const result = await rotateRefreshToken(
        deps.db,
        presented,
        req.header("user-agent") ?? null,
        refreshTtl,
        new Date(),
        {
          onTokenResolved: (familyId) => {
            const decision = refreshLimiter.check(`refresh:${familyId}`);
            return decision.allowed
              ? { allowed: true }
              : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
          },
        },
      );

      if (!result.ok) {
        // Límite por familia: frena el uso masivo de tokens robados.
        if (result.reason === "rate_limited") return rejectRateLimited(res, result.retryAfterSeconds ?? 60);
        // Salvo la cuenta deshabilitada, el cliente no distingue el motivo:
        // saber que un token fue reutilizado no le sirve, y sí a un atacante.
        if (result.reason === "user_disabled") return res.status(403).json({ error: "account_disabled" });
        return res.status(401).json({ error: "invalid_grant" });
      }

      const accessToken = await signAccessToken(deps.tokens, result.userId, result.tokenVersion);

      if (wantsCookies(mode)) {
        setAuthCookies(res, accessToken, result.refreshToken);
        issueCsrfToken(res);
      }

      if (mode === "cookie") return res.status(200).json({ token_type: "cookie" });

      return res.status(200).json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: deps.tokens.accessTtlSeconds,
        refresh_token: result.refreshToken,
      });
    }),
  );

  app.post(
    "/auth/logout",
    asyncHandler(async (req, res) => {
      const bodyToken = typeof req.body?.refresh_token === "string" ? (req.body.refresh_token as string) : null;
      const cookieToken = wantsCookies(mode) ? (parseCookies(req.header("cookie"))[COOKIE_REFRESH] ?? null) : null;
      const presented = bodyToken ?? cookieToken;
      const viaCookie = bodyToken === null && cookieToken !== null;

      if (csrfFailed(req, viaCookie)) return res.status(403).json({ error: "csrf_failed" });

      // Idempotente y sin oráculo: un token desconocido también devuelve 204.
      if (presented) await revokeSession(deps.db, presented);
      if (wantsCookies(mode)) clearAuthCookies(res);
      return res.status(204).end();
    }),
  );

  /**
   * Solicitud de recuperación.
   *
   * Anti-enumeración: mismo estado, mismo cuerpo y mismo número de round-trips
   * exista o no la cuenta. El límite por correo se aplica SIEMPRE con la misma
   * clave (hash del correo), también para correos inexistentes: si solo se
   * limitara a los existentes, el 429 sería el oráculo que se quiere evitar.
   */
  app.post(
    "/auth/forgot-password",
    asyncHandler(async (req, res) => {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

      const email = parsed.data.email;
      const emailKey = createHash("sha256").update(email).digest("hex");

      const ipDecision = forgotIpLimiter.check(`forgot:ip:${clientIp(req)}`);
      if (!ipDecision.allowed) return rejectRateLimited(res, ipDecision.retryAfterSeconds);

      const emailDecision = forgotEmailLimiter.check(`forgot:email:${emailKey}`);
      if (!emailDecision.allowed) return rejectRateLimited(res, emailDecision.retryAfterSeconds);

      const user = await findUserByEmail(deps.db, email);

      if (user) {
        const token = await createResetRequest(deps.db, user.id, null);
        try {
          await mailer.sendPasswordReset({ to: user.email, token });
        } catch (error) {
          // Un fallo del envío no puede cambiar la respuesta: sería un oráculo.
          console.error("[auth] fallo al enviar el correo de recuperación:", error);
        }
      } else {
        // Iguala el número de round-trips con la rama que sí encuentra cuenta.
        await deps.db.query("select 1");
      }

      return res.status(202).json({ status: "accepted" });
    }),
  );

  app.post(
    "/auth/reset-password",
    asyncHandler(async (req, res) => {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

      const newHash = await hashPassword(parsed.data.new_password);
      const result = await consumeResetToken(deps.db, parsed.data.token, newHash);

      // Mismo 400 para token inexistente, expirado o ya usado.
      if (!result.ok) return res.status(400).json({ error: "invalid_token" });

      return res.status(204).end();
    }),
  );

  if (devOutbox) {
    app.get("/_dev/outbox", (_req, res) => {
      res.status(200).json({ messages: devOutbox });
    });
  }

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Nunca se filtra el error interno al cliente.
    console.error("[auth] error no controlado:", error);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
