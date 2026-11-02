-- 004_mfa.up.sql — segundo factor TOTP (TASK-004)

-- Secreto TOTP cifrado en reposo. Nunca en claro.
CREATE TABLE user_mfa_secrets (
    user_id           uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_ciphertext text        NOT NULL,
    iv                text        NOT NULL,
    auth_tag          text        NOT NULL,
    key_id            text        NOT NULL DEFAULT 'v1',
    created_at        timestamptz NOT NULL DEFAULT now(),
    -- NULL = secreto generado pero no confirmado con un código válido.
    confirmed_at      timestamptz
);

-- Códigos de recuperación: solo su hash, un solo uso.
CREATE TABLE user_mfa_backup_codes (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz,
    CONSTRAINT user_mfa_backup_codes_hash_len CHECK (length(code_hash) = 64)
);

CREATE UNIQUE INDEX user_mfa_backup_codes_hash_uidx ON user_mfa_backup_codes (code_hash);
CREATE INDEX user_mfa_backup_codes_pending_idx ON user_mfa_backup_codes (user_id) WHERE used_at IS NULL;

-- Desafío de login: el mfa_token es de un solo uso y caduca en minutos.
CREATE TABLE mfa_challenges (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    CONSTRAINT mfa_challenges_hash_len CHECK (length(token_hash) = 64),
    CONSTRAINT mfa_challenges_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX mfa_challenges_hash_uidx ON mfa_challenges (token_hash);
CREATE INDEX mfa_challenges_expires_idx ON mfa_challenges (expires_at);
