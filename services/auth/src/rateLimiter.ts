/**
 * Rate limiting en memoria — TASK-001, fase 5.
 *
 * Ventana fija por clave: al primer intento se abre la ventana; al agotar el
 * cupo se rechaza hasta que la ventana expire. `Retry-After` se calcula desde
 * el reloj inyectado, así que es testeable sin dormir el proceso.
 *
 * Limitación declarada: el estado vive en el proceso. Con varias instancias
 * hay que moverlo a Redis (o similar); la interfaz `RateLimiter` está pensada
 * para ese reemplazo.
 */

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export type RateLimiter = {
  check(key: string): RateLimitDecision;
  reset(key?: string): void;
  size(): number;
};

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  /** Reloj inyectable para tests. Por defecto Date.now. */
  now?: () => number;
  /** Barrido perezoso de ventanas caducadas al superar este tamaño. */
  sweepThreshold?: number;
};

type Bucket = { count: number; resetAt: number };

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const sweepThreshold = options.sweepThreshold ?? 5_000;
  const buckets = new Map<string, Bucket>();

  function sweep(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (nowMs >= bucket.resetAt) buckets.delete(key);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const nowMs = now();

      if (buckets.size > sweepThreshold) sweep(nowMs);

      const bucket = buckets.get(key);

      if (!bucket || nowMs >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }

      if (bucket.count >= limit) {
        // Al menos 1 segundo: nunca se responde "reintenta en 0".
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1_000));
        return { allowed: false, retryAfterSeconds };
      }

      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count };
    },

    reset(key?: string): void {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },

    size(): number {
      return buckets.size;
    },
  };
}
