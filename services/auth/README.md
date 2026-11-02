# services/auth — Servicio de autenticación (TASK-001)

> **Riesgo:** L4 · **Estado:** fase 0 (bootstrap) · **Decisión:** DE-001 (plan aprobado) + DE-002 (dispensa de doble firma)

Servicio de autenticación JWT para el módulo de usuarios. Node.js + PostgreSQL.

## Estado por fase

| Fase | Estado | Evidencia |
|---|---|---|
| 0 · Bootstrap | **hecho** | 3 tests en verde |
| 1 · Migraciones `users` / `refresh_tokens` | **hecho** | 5 tests; aplicadas y revertidas contra PostgreSQL 16 real |
| 2 · Hash + login/registro | **hecho** | 4 tests: argon2id, duplicado, validación, no-enumeración |
| 3 · JWT + middleware | **hecho** | 8 tests: firma, `alg:none`, expiración, clave ajena, `token_version`, `/auth/me` |
| 4 · Refresh / rotación / familias | **hecho** | 9 tests + concurrencia real: dos refresh simultáneos → un 200 y un 401 |
| 5 · Rate limiting | **hecho** | 7 tests: límites por IP, usuario y familia, `Retry-After`, reapertura de ventana |
| 6 · Hardening | **hecho** | 8 tests: tres modos, CORS, cookies, CSRF, CSP, headers |
| 7 · e2e + rollback drill | **hecho** | `scripts/f7-drill.mjs`: 5/5 contra PostgreSQL real |
| **Suite completa** | **55/55** contra PostgreSQL 16 · 53/55 + 2 omitidos con `pg-mem` | `node --test --test-isolation=none "test/**/*.test.ts"` |

## Cómo se ejecuta

```bash
# Dependencias (en este sandbox: caché en el workspace y sin scripts de ciclo de vida)
npm install --ignore-scripts --cache ../../.npm-cache

# Suite completa: 55 tests
node --test --test-isolation=none "test/**/*.test.ts"

# Servidor
node src/main.ts
```

Node ≥ 22.6 ejecuta TypeScript nativamente (type stripping): no hace falta `tsc`
para correr ni testear.

> **Por qué `--ignore-scripts`:** el sandbox bloquea los subprocesos con stdio
> canalizado (`spawn EPERM`), y los `postinstall` de npm los usan. Los paquetes
> funcionan igual: `argon2` trae binario precompilado y carga sin problema.

> **Por qué `--test-isolation=none`:** sin el flag, el runner lanza cada archivo en
> un subproceso y falla con `spawn EPERM`. En una máquina sin esa restricción,
> `node --test` a secas funciona y da mejor aislamiento.

## Entorno de ejecución

| Situación | Efecto |
|---|---|
| **Con Docker accesible** | `docker compose up -d` levanta PostgreSQL 16 y los 55 tests corren contra el motor real |
| Docker sin `danger-full-access` | `permission denied` sobre `npipe:////./pipe/dockerDesktopLinuxEngine`: el pipe está fuera del sandbox |
| PostgreSQL nativo (`postgres.exe` directo) | **No** arranca aquí: `could not bind IPv4 address: Permission denied`, incluso con escalado. La vía válida es el contenedor |
| `spawn EPERM` en subprocesos canalizados | `npm install` exige `--ignore-scripts`; el runner, `--test-isolation=none` |

Los 55 tests pasan también contra `pg-mem`, con una excepción: los 2 que dependen
de `ROLLBACK` se omiten con motivo, porque `pg-mem` acepta `BEGIN`/`COMMIT` pero
**ignora `ROLLBACK`**. Contra PostgreSQL real corren y pasan.

## Estructura

```
services/auth/
├── src/main.ts                      # bootstrap HTTP
├── test/health.test.ts              # fase 0
├── test/migrations.test.ts          # fase 1 (pg-mem)
├── migrations/*.up.sql|*.down.sql   # esquema users + refresh_tokens
├── scripts/migrate.mjs              # runner up/down, agnóstico de driver
├── docker-compose.yml               # PostgreSQL 16 (requiere docker con permisos)
├── .env.example
├── tsconfig.json
└── package.json
```

## Modos de autenticación (`AUTH_MODE`)

| Modo | Cliente | Transporte | CSRF | CSP |
|---|---|---|---|---|
| `bearer` | API móvil, servicios, CLI | `Authorization: Bearer <access>` | No aplica | No se envía |
| `cookie` | SPA en navegador | cookies `httpOnly` | **Obligatorio en POST** | Estricta |
| `both` | mixto / migración | encabezado si viene; si no, cookie | Solo cuando se usa cookie | Estricta |

```ts
createApp({ db, tokens, mode: "both", allowedOrigins: ["https://app.example"] });
```

### Cómo elige el cliente (modo `both`)

1. Si envía `Authorization: Bearer …`, se usa ese token y **no** se valida CSRF.
2. Si no lo envía, se buscan las cookies y **sí** se exige CSRF.

### Flujo CSRF (modos `cookie` y `both`)

1. `POST /auth/login` (o `/auth/refresh`) devuelve la cookie `csrf_token`, legible por JS (`httpOnly: false`) y `SameSite=Strict`.
2. La SPA copia ese valor al encabezado `X-CSRF-Token` en cada petición que cambie estado.
3. El servidor compara ambos con `timingSafeEqual`; si no coinciden → `403 {"error":"csrf_failed"}`.

El atacante cross-site puede provocar la petición, pero no leer la cookie ni fijar el encabezado: por eso el doble envío funciona.

### Cookies en modo `cookie`/`both`

| Cookie | httpOnly | Uso |
|---|---|---|
| `access_token` | sí | 15 min |
| `refresh_token` | sí | 30 días, rota en cada uso |
| `csrf_token` | **no** | legible por JS para el doble envío |

Todas con `Secure` y `SameSite=Strict`. `Secure` implica que en desarrollo sin HTTPS el navegador no las enviará: usa `bearer` en local o un proxy TLS.

### Headers de seguridad (los tres modos)

`X-Content-Type-Options: nosniff` · `X-Frame-Options: DENY` · `X-XSS-Protection: 0` · `Strict-Transport-Security` · `Referrer-Policy: no-referrer` · `Permissions-Policy`. CSP se añade en `cookie` y `both`.

## Segundo factor (MFA · TOTP)

```bash
# Requiere clave maestra de 32 bytes en base64
MFA_MASTER_KEY=$(openssl rand -base64 32)
```

| Endpoint | Autenticación | Qué hace |
|---|---|---|
| `POST /auth/mfa/setup` | access | Genera secreto, lo guarda cifrado y devuelve la URI `otpauth://` |
| `POST /auth/mfa/verify-setup` | access | Confirma con un código, devuelve 10 códigos de recuperación y un par de tokens nuevo |
| `POST /auth/mfa/verify` | — | Canjea `mfa_token` + código por una sesión |
| `POST /auth/mfa/recovery` | — | Canjea `mfa_token` + código de recuperación |
| `GET /auth/mfa/backup-codes` | access | Regenera los 10 códigos e invalida los anteriores |
| `POST /auth/mfa/disable` | access | Exige contraseña + código; borra secreto y códigos |

Con MFA activo, `POST /auth/login` responde `{ mfa_required: true, mfa_token }` y **no** emite sesión. El `mfa_token` dura 5 minutos y es de un solo uso (tabla `mfa_challenges`).

**TOTP**: implementación propia de RFC 6238 sobre `node:crypto`, validada contra los 5 vectores del Apéndice B en la suite. No se usa librería: `otplib@12` no acepta base32, ignora el tiempo por argumento y no reproduce los vectores publicados.

**Secretos**: AES-256-GCM con IV aleatorio por registro y `key_id` para rotación futura. Si se pierde `MFA_MASTER_KEY`, todos los secretos son irrecuperables.

## Decisiones de diseño ya fijadas

- Tokens de acceso **asimétricos** (EdDSA/RS256), 15 min, con `kid`.
- Refresh **opaco** (no JWT), 256 bits, almacenado como SHA-256.
- Rotación con familias y revocación ante reutilización.
- Web: cookie `httpOnly; Secure; SameSite=Strict`. API/móvil: `Authorization: Bearer`.
- `token_version` en `users` como interruptor de revocación global.
- **Cambio de contraseña** (`POST /auth/password`, autenticado): revoca **todas** las familias del usuario y sube `token_version`. Un refresh robado no sobrevive a la rotación de credenciales.
- **Rate limiting** en memoria, por ámbito: login y registro 5/min por IP · contraseña 3/min por usuario · refresh 10/min por familia. Respuesta 429 con `Retry-After`. El estado vive en el proceso: con varias instancias hay que moverlo a Redis.
- **Cambio de contraseña transaccional**: revocación de sesiones + nuevo hash van en `BEGIN/COMMIT`. Si el segundo paso falla, no quedan sesiones revocadas sin cambio de clave.
- Sin PII en el payload del JWT: es legible por cualquiera (JWT no cifra).

### Tests y drill contra PostgreSQL real

```bash
# Suite completa (55 tests, incluidos los 2 de rollback)
TEST_DATABASE_URL=postgres://auth:password@127.0.0.1:5432/auth \
  node --test --test-isolation=none "test/**/*.test.ts"

# Drill F7: down/up, migración fallida, concurrencia y BEGIN/ROLLBACK
DATABASE_URL=postgres://auth:password@127.0.0.1:5432/auth node scripts/f7-drill.mjs
```

Con `TEST_DATABASE_URL`, `test/support/fixtures.ts` usa PostgreSQL en vez de `pg-mem` (reinicia el esquema antes de cada test). Sin ella, los dos tests que dependen de `ROLLBACK` se **omiten** con motivo: `pg-mem` acepta `BEGIN`/`COMMIT` pero **ignora `ROLLBACK`**.
