-- 003_password_resets.up.sql — tokens de recuperación de contraseña (TASK-003)

CREATE TABLE password_resets (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    ip_hash    bytea,
    CONSTRAINT password_resets_expiry_after_creation CHECK (expires_at > created_at),
    -- SHA-256 hexadecimal, igual que refresh_tokens: mismo contrato en ambos motores.
    CONSTRAINT password_resets_hash_is_sha256 CHECK (length(token_hash) = 64)
);

-- Un token no puede repetirse nunca.
CREATE UNIQUE INDEX password_resets_hash_uidx ON password_resets (token_hash);

-- Tokens pendientes de un usuario (para invalidarlos al consumir uno).
CREATE INDEX password_resets_user_pending_idx ON password_resets (user_id) WHERE used_at IS NULL;

-- Purga por caducidad.
CREATE INDEX password_resets_expires_idx ON password_resets (expires_at);
