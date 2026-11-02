/**
 * rotate-mfa-key.mjs — rotación de la clave maestra de MFA (TASK-005).
 *
 * Todo ocurre en UNA transacción: si cualquier fila falla al descifrar, al
 * cifrar o al verificarse después, se hace ROLLBACK y ningún `key_id` cambia.
 * No existe estado intermedio con parte de los secretos bajo una clave y parte
 * bajo otra.
 *
 * Uso:
 *   MFA_MASTER_KEY_CURRENT=<base64 32B> MFA_MASTER_KEY_NEW=<base64 32B> \
 *   DATABASE_URL=... node scripts/rotate-mfa-key.mjs [--dry-run] [--key-id v2]
 */

import { pathToFileURL } from "node:url";

import { decryptSecret, encryptSecret, loadMfaKey } from "../src/mfa.ts";

/**
 * @returns {Promise<{total: number, rotated: number, dryRun: boolean, keyId: string}>}
 */
export async function rotateMfaKey({ client, oldKey, newKey, newKeyId = "v2", dryRun = false }) {
  if (dryRun) {
    const count = await client.query(
      `select count(*)::int as n from user_mfa_secrets where key_id <> $1`,
      [newKeyId],
    );
    return { total: count.rows[0]?.n ?? 0, rotated: 0, dryRun: true, keyId: newKeyId };
  }

  await client.query("begin");

  try {
    // FOR UPDATE dentro de la transacción: nadie escribe mientras se rota.
    const rows = await client.query(
      `select user_id, secret_ciphertext, iv, auth_tag
         from user_mfa_secrets
        where key_id <> $1
        for update`,
      [newKeyId],
    );

    for (const row of rows.rows) {
      const secret = decryptSecret(
        { ciphertext: row.secret_ciphertext, iv: row.iv, authTag: row.auth_tag },
        oldKey,
      );

      const encrypted = encryptSecret(secret, newKey);
      await client.query(
        `update user_mfa_secrets
            set secret_ciphertext = $2,
                iv = $3,
                auth_tag = $4,
                key_id = $5
          where user_id = $1`,
        [row.user_id, encrypted.ciphertext, encrypted.iv, encrypted.authTag, newKeyId],
      );
    }

    // Verificación antes del COMMIT: si algo no descifra con la clave nueva,
    // el ROLLBACK lo devuelve todo a la clave vieja.
    const written = await client.query(
      `select user_id, secret_ciphertext, iv, auth_tag
         from user_mfa_secrets
        where key_id = $1`,
      [newKeyId],
    );
    for (const row of written.rows) {
      decryptSecret(
        { ciphertext: row.secret_ciphertext, iv: row.iv, authTag: row.auth_tag },
        newKey,
      );
    }

    await client.query("commit");
    return { total: rows.rows.length, rotated: rows.rows.length, dryRun: false, keyId: newKeyId };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* el error original manda */
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run");
  const keyIdFlag = process.argv.indexOf("--key-id");
  const newKeyId = keyIdFlag !== -1 ? process.argv[keyIdFlag + 1] : "v2";

  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("Falta DATABASE_URL");
    process.exit(2);
  }

  try {
    const oldKey = loadMfaKey({ MFA_MASTER_KEY: process.env["MFA_MASTER_KEY_CURRENT"] });
    const newKey = loadMfaKey({ MFA_MASTER_KEY: process.env["MFA_MASTER_KEY_NEW"] });

    if (oldKey.equals(newKey)) {
      console.error("La clave nueva es igual a la actual: no hay nada que rotar.");
      process.exit(2);
    }

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();

    try {
      const result = await rotateMfaKey({ client, oldKey, newKey, newKeyId, dryRun });

      if (result.dryRun) {
        console.log(`dry-run: ${result.total} secreto(s) se rotarían a key_id=${result.keyId}`);
      } else if (result.total === 0) {
        console.log(`nada que rotar: no quedan secretos con key_id distinto de ${result.keyId}`);
      } else {
        console.log(`rotados ${result.rotated} secreto(s) a key_id=${result.keyId}`);
      }
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
