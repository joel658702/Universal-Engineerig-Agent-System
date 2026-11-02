# TECH DEBT — UEAS / services/auth

> Última revisión: 2026-11-02 · Referencias: `DE-003-bis` §5 y los `open_risks` de `UEAS-005…015`.
> Cada partida tiene un disparador: **cuándo deja de ser deuda y pasa a ser bloqueante**.

| # | Deuda | Impacto | Disparador para pagarla |
|---|---|---|---|
| 1 | **Rate limiting en memoria del proceso** | Con N instancias el límite real es N × configurado; un atacante reparte la carga entre réplicas | Escalar horizontalmente, o desplegar tras un balanceador |
| 2 | **Sin VERIFIER independiente** | Todas las evidencias están en `pending`; la aprobación es del operador, no de un par | Primera tarea con dos personas en el equipo |
| 3 | ~~**Sin MFA**~~ · **RESUELTO** en TASK-004 | Era: una contraseña filtrada bastaba para entrar. Ahora TOTP RFC 6238 con secreto cifrado (AES-256-GCM), activación en dos pasos, `mfa_token` de un solo uso y 10 códigos de recuperación | Evidencia: UEAS-020 |
| 4 | ~~**Sin recuperación de contraseña**~~ · **RESUELTO** en TASK-003 | Era: un usuario bloqueado no tenía salida autónoma. Ahora hay flujo con token de un solo uso (15 min), anti-enumeración, rate limit por correo/IP y revocación global de sesiones | Evidencia: UEAS-019 |
| 5 | **Sin verificación de correo** | `email_verified_at` existe pero nadie lo escribe; se puede registrar el correo de otro | Antes de usar el correo como identificador de confianza |
| 6 | **CSP con `style-src 'unsafe-inline'`** | Exfiltración por CSS posible si hay inyección de estilos | Cuando el frontend pueda usar `nonce` o `hash` |
| 7 | **HSTS y cookies `Secure` sin probar sobre TLS** | Verificado el header, no el efecto; en producción podría romper sesiones o no aplicarse | Primera puesta en escena con HTTPS real |
| 8 | **`pg-mem` acepta BEGIN/COMMIT pero ignora ROLLBACK** | Cualquier test de transacción añadido sin PostgreSQL real daría falso positivo | Cualquier test nuevo que dependa de atomicidad |
| 9 | **Rangos de dependencias sin pin exacto** | Una versión menor puede cambiar comportamiento sin que el lock lo refleje si se regenera | Primera auditoría de suministro |
| 10 | **Sin purga de refresh tokens expirados** | La tabla crece indefinidamente; el índice existe pero nadie lo usa | Primeros 100k tokens |
| 11 | **`/auth/refresh` no revalida `token_version`** | Un cambio de contraseña corta las sesiones por la vía de `DE-002`, pero la rotación no comprueba la versión directamente | Si se añade revocación selectiva por dispositivo |
| 12 | **Sin límite de tamaño en `refresh_tokens.user_agent`** | Un cliente puede enviar un `User-Agent` enorme por sesión | Primera revisión de tamaño de tabla |
| 13 | **Sin CI hasta este commit** | Nada impedía fusionar sin ejecutar las verificaciones | Resuelto en `.github/workflows/ci.yml` (pendiente de primera ejecución real) |
| 14 | **Sin rama protegida ni revisión obligatoria** | El CI avisa, pero un `push --force` a `main` lo esquiva | Al incorporar el segundo colaborador |
| 15 | ~~**`migrate up` no es idempotente** — no existe tabla `schema_migrations`~~ · **RESUELTO** en TASK-002 | Era: re-ejecutar `up` rompía con `heap_create_with_catalog`. Ahora hay libro con checksum, transacción por migración, lock entre procesos y `baseline` | Evidencia: UEAS-018 |
| 16 | ~~**Un código TOTP es reutilizable dentro de su ventana (±1 paso ≈ 90 s)**~~ · **RESUELTO** en TASK-006 | Era: un código interceptado podía canjearse dos veces. Ahora `mfa_used_codes` con reclamo atómico (`ON CONFLICT … DO UPDATE … WHERE`) en login y en disable, más script de limpieza | Evidencia: UEAS-022 |
| 17 | ~~**Sin procedimiento de rotación ni recuperación de `MFA_MASTER_KEY`**~~ · **RESUELTO** en TASK-005 | Era: perder la clave dejaba a todos los usuarios con MFA fuera, sin runbook. Ahora hay rotación transaccional, `recover-mfa-loss` con confirmación y auditoría, y `docs/mfa-key-management.md` | Evidencia: UEAS-021 |

## Cómo se paga

1. Elegir una partida.
2. Abrir propuesta con `PROPOSAL_SCHEMA.json` (nivel de riesgo por `RISK_ENGINE.md`).
3. Implementar con su evidencia; actualizar esta tabla y `DE-003-bis` §5.
