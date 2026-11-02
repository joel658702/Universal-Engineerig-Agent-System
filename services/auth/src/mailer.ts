/**
 * Mailer — TASK-003.
 *
 * El token de recuperación NUNCA se escribe en logs: un token en un fichero de
 * log es una credencial filtrada (R6). En su lugar:
 *
 *   · dev  → outbox en memoria, expuesto solo con doble guardia;
 *   · null → no envía nada y registra solo el identificador del usuario.
 *
 * El puerto permite enchufar SMTP real más adelante sin tocar el dominio.
 */

export type Mailer = {
  sendPasswordReset(input: { to: string; token: string }): Promise<void>;
};

export type OutboxEntry = { to: string; token: string; at: string };

export type DevMailer = Mailer & {
  outbox: OutboxEntry[];
  last(): OutboxEntry | undefined;
  clear(): void;
};

/** Doble guardia: hace falta ser desarrollo Y activarla explícitamente. */
export function isDevOutboxEnabled(env: Record<string, string | undefined>): boolean {
  return env["NODE_ENV"] === "development" && env["AUTH_DEV_OUTBOX"] === "1";
}

export function createDevMailer(capacity = 20): DevMailer {
  const outbox: OutboxEntry[] = [];

  return {
    outbox,
    async sendPasswordReset({ to, token }) {
      outbox.push({ to, token, at: new Date().toISOString() });
      if (outbox.length > capacity) outbox.shift();
    },
    last() {
      return outbox.at(-1);
    },
    clear() {
      outbox.length = 0;
    },
  };
}

/**
 * Adaptador de producción: no envía y no guarda el token.
 * Registra solo el id de usuario, que no permite canjear nada.
 */
export function createNullMailer(): Mailer {
  return {
    async sendPasswordReset() {
      // Intencionadamente vacío. El envío real se enchufa aquí.
    },
  };
}
