-- 004_mfa.down.sql — reversión exacta

DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS user_mfa_backup_codes;
DROP TABLE IF EXISTS user_mfa_secrets;
