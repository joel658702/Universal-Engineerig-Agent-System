-- 006_mfa_used_codes.up.sql — prevención de replay de TOTP (TASK-006)

CREATE TABLE mfa_used_codes (
    user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text        NOT NULL,
    used_at   timestamptz NOT NULL DEFAULT now(),
    -- Paso TOTP en el momento del uso (floor(epoch/30)). Trazabilidad, no control.
    step      bigint      NOT NULL DEFAULT 0,
    CONSTRAINT mfa_used_codes_hash_len CHECK (length(code_hash) = 64),
    PRIMARY KEY (user_id, code_hash)
);

-- Limpieza por antigüedad.
CREATE INDEX idx_mfa_used_codes_cleanup ON mfa_used_codes (used_at);
