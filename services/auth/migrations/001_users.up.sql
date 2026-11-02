-- 001_users.up.sql — tabla base de usuarios (TASK-001, fase 1)

CREATE TABLE users (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email             text        NOT NULL,
    password_hash     text        NOT NULL,
    email_verified_at timestamptz,
    disabled_at       timestamptz,
    token_version     integer     NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_not_blank      CHECK (length(trim(email)) > 3),
    CONSTRAINT users_token_version_positive CHECK (token_version > 0)
);

-- Unicidad insensible a mayúsculas sin depender de la extensión citext.
CREATE UNIQUE INDEX users_email_lower_uidx ON users ((lower(email)));
