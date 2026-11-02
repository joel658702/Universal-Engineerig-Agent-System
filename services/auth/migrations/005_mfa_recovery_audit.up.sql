-- 005_mfa_recovery_audit.up.sql — auditoría de recuperaciones de MFA (TASK-005)

CREATE TABLE mfa_recovery_audit (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operator        text        NOT NULL,
    reason          text        NOT NULL,
    mfa_was_enabled boolean     NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mfa_recovery_audit_operator_not_blank CHECK (length(trim(operator)) > 0),
    CONSTRAINT mfa_recovery_audit_reason_not_blank CHECK (length(trim(reason)) > 3)
);

CREATE INDEX mfa_recovery_audit_user_idx ON mfa_recovery_audit (user_id, created_at DESC);
