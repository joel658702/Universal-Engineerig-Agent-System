-- 002_refresh_tokens.up.sql — refresh tokens con familias y revocación (TASK-001, fase 1)

CREATE TABLE refresh_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id  uuid        NOT NULL,
    token_hash text        NOT NULL,
    issued_at  timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    rotated_at timestamptz,
    revoked_at timestamptz,
    user_agent text,
    ip_hash    bytea,
    CONSTRAINT refresh_tokens_expiry_after_issue CHECK (expires_at > issued_at),
    -- SHA-256 en hexadecimal (64 caracteres). Se usa text en lugar de bytea
    -- para que el contrato sea idéntico en PostgreSQL y en el emulador de tests.
    CONSTRAINT refresh_tokens_hash_is_sha256 CHECK (length(token_hash) = 64)
);

-- Un token no puede repetirse jamás: el hash es la clave de búsqueda.
CREATE UNIQUE INDEX refresh_tokens_hash_uidx ON refresh_tokens (token_hash);

-- Consulta caliente: tokens vivos de un usuario.
CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Purga por caducidad.
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);
