# UEAS-013 — Plan de swap a PostgreSQL real

> **Tarea:** TASK-001, fase 4 del plan del operador (swap a PostgreSQL real)
> **Riesgo:** L4 · **Excepción vigente:** `EX-001` (DE-002)
> **Estado:** PLAN — **no se ha ejecutado nada**. Requiere aprobación explícita.
> **Autor del plan:** agente BUILDER (no puede aprobarlo — R1)

---

## 1. Situación de partida (verificada)

| Hecho | Evidencia |
|---|---|
| Suite actual: 52/52 en verde | `node --test --test-isolation=none "test/**/*.test.ts"` |
| PostgreSQL **no** arranca en el sandbox | `postgres.exe` → `could not bind IPv4 address "127.0.0.1": Permission denied` |
| `pg_ctl` falla antes de arrancar | `no se pudo crear el token restringido: código de error 87` |
| Docker no es opción | `permission denied` sobre `npipe:////./pipe/dockerDesktopLinuxEngine` |
| **Node sí puede abrir sockets en 127.0.0.1** | los 52 tests levantan servidores HTTP reales |
| El paquete `@embedded-postgres/windows-x64` fue **desinstalado** en UEAS-006 | `package.json` sin esa dependencia |

**Lectura:** la denegación no es «el sandbox prohíbe escuchar», porque Node escucha sin problema. Es específica de `postgres.exe`. Por eso tiene sentido un intento con escalado; si fuera una política global de sockets, ni siquiera los tests funcionarían.

---

## 2. Permisos que necesito

| Permiso | Para qué | Alcance | Duración |
|---|---|---|---|
| `danger-full-access` | Lanzar `postgres.exe` (abrir puerto 55432) | **Un solo comando** de arranque | Solo ese comando; no persiste |

No pido permiso global para el resto del trabajo: el sandbox actual sigue aplicando a todo lo demás. El escalado es por invocación, no un cambio de configuración permanente, así que **no hay nada que revertir** en permisos: basta con dejar de invocarlo.

---

## 3. Cambios que requieren autorización aparte

Dos modificaciones al proyecto que el plan necesita y que **no hago sin tu visto bueno**:

**(a) Reinstalar los binarios de PostgreSQL** (`@embedded-postgres/windows-x64`, `devDependencies`). Se desinstaló en UEAS-006 precisamente porque no funcionaba. Si el intento falla, se vuelve a desinstalar.

**(b) Adaptar `test/support/fixtures.ts`** para que, si existe `TEST_DATABASE_URL`, use PostgreSQL real en lugar de `pg-mem`, con limpieza entre tests (`TRUNCATE ... CASCADE`). Sin esto no puedo «ejecutar TODOS los tests existentes» contra el motor real, que es tu condición 3. Es un cambio de ~30 líneas en un archivo de test.

**(c) Opcional, solo si autorizas:** envolver en transacción la secuencia `revokeAllUserRefreshTokens` + `updatePasswordHash` (riesgo abierto en UEAS-010). Es la única forma de que F7(d) pruebe transacciones de verdad y no un `BEGIN` decorativo.

---

## 4. Comandos exactos, paso a paso

Ningún paso se ejecuta en batch: cada uno se lanza, se lee su salida y se reporta antes del siguiente.

### Paso 1 — Reinstalar binarios (sin escalado)

```powershell
cd "C:\Users\joe\Universal Engineering Agent System\services\auth"
npm install --save-dev --ignore-scripts --cache "..\..\.npm-cache" "@embedded-postgres/windows-x64@18.6.0-beta.19"
Test-Path "node_modules\@embedded-postgres\windows-x64\native\bin\postgres.exe"
```

- **Espero:** `added N packages` y `True`.
- **Si falla:** detengo. Sin binarios no hay paso 2. TASK-001 sigue `partial`.

### Paso 2 — Inicializar el clúster (sin escalado; ya funcionó antes)

```powershell
$bin = "node_modules\@embedded-postgres\windows-x64\native\bin"
& "$bin\initdb.exe" -D .pgdata -U auth --auth=trust --encoding=UTF8 --no-locale
```

- **Espero:** `initdb_exit=0` y el mensaje «Completado».
- **Si falla:** borro `.pgdata` y detengo.

### Paso 3 — Arrancar PostgreSQL **con escalado** ← el paso crítico

```powershell
Start-Process -FilePath "$bin\postgres.exe" `
  -ArgumentList @("-D", ".pgdata", "-p", "55432", "-c", "listen_addresses=127.0.0.1") `
  -RedirectStandardOutput ".pgdata\stdout.log" -RedirectStandardError ".pgdata\stderr.log" `
  -PassThru -WindowStyle Hidden
# sandbox_permissions: danger-full-access  ← autorización solicitada
Start-Sleep 3; Test-NetConnection 127.0.0.1 -Port 55432
```

- **Espero:** `TcpTestSucceeded : True` y en `stderr.log` la línea `database system is ready to accept connections`.
- **Si falla con `Permission denied` otra vez:** el escalado no cubre este caso. Detengo, borro `.pgdata`, desinstalo el paquete y reporto. **No intento rodeos** (crear un usuario distinto, mover el binario, etc.): sería eludir el control que acabo de pedir.
- **Si arranca y luego muere:** leo `stderr.log` completo antes de decidir.

### Paso 4 — Crear la base y aplicar migraciones

```powershell
$env:TEST_DATABASE_URL = "postgres://auth@127.0.0.1:55432/auth"
node -e "…create database auth si no existe…"     # vía pg, sin psql (no está instalado)
$env:DATABASE_URL = $env:TEST_DATABASE_URL
node scripts/migrate.mjs up
```

- **Espero:** `aplicada: 001_users.up.sql`, `aplicada: 002_refresh_tokens.up.sql`.
- **Si falla:** es el hallazgo más valioso del ejercicio — significaría que `pg-mem` aceptó algo que PostgreSQL rechaza. Detengo, copio el error literal a la evidencia y **no** «arreglo» la migración sin autorización.

### Paso 5 — Suite completa contra PostgreSQL real

```powershell
$env:TEST_DATABASE_URL = "postgres://auth@127.0.0.1:55432/auth"
node --test --test-isolation=none "test/**/*.test.ts"
```

- **Espero:** 52/52, igual que con `pg-mem`.
- **Si hay diferencias:** las documento una a una (test, esperado, obtenido) y **detengo** antes de tocar nada.

### Paso 6 — F7: rollback drill

| Prueba | Cómo |
|---|---|
| (a) Fallo durante migración | Añado temporalmente una sentencia inválida a una copia de la migración, aplico y verifico que la transacción deja el esquema intacto |
| (b) Rollback restaura el estado | `migrate down` → verifico que `users` y `refresh_tokens` desaparecen y que reaplicar funciona |
| (c) Concurrencia | Dos `POST /auth/register` simultáneos con el mismo correo → exactamente un 201 y un 409; dos `POST /auth/refresh` con el mismo token → un 200 y un 401 |
| (d) Transacciones | `BEGIN/ROLLBACK` verificando que un insert no persiste; y la secuencia de cambio de contraseña dentro de transacción (si autorizas el cambio (c)) |

- **Espero:** cada caso con su salida. La concurrencia es lo que `pg-mem` no podía probar: si aquí falla, es un fallo real del código, no del entorno.

---

## 5. Reversión

| Cambio | Cómo se revierte | Verificación |
|---|---|---|
| Proceso PostgreSQL | `Stop-Process -Id <pid>` y confirmar puerto cerrado | `Test-NetConnection` → `False` |
| Datos | `Remove-Item .pgdata -Recurse -Force` | ruta inexistente |
| `package.json` | `npm uninstall @embedded-postgres/windows-x64` | dependencia ausente |
| `fixtures.ts` | copia `.bak` previa, restaurada | `diff` vacío + suite 52/52 con `pg-mem` |
| Permisos | **nada que revertir**: el escalado es por comando | — |

Al final, en cualquier escenario, dejo el repo en el estado previo salvo lo que se me autorice conservar.

---

## 6. Criterios de parada

Detengo y reporto si:

1. El puerto sigue denegado con escalado → TASK-001 queda `partial` (tu condición 5).
2. `initdb` o las migraciones fallan → `partial`, con el error literal.
3. Algún test difiere de `pg-mem` → `partial`, con la tabla de diferencias.
4. Cualquier comando pide permisos distintos de los declarados en §2.
5. Aparece un archivo modificado que no esté en §3.

## 7. Resultado esperado

- **Éxito completo** → `UEAS-013` (swap) + `UEAS-014` (F7) y TASK-001 pasa a `complete`.
- **Fallo en cualquier punto** → TASK-001 `partial`, con la explicación concreta de qué falta y qué se intentó.

En ningún caso marco TASK-001 como `complete` por mi cuenta: eso lo decide el verificador, y el estado final lo confirmas tú.

---

## 8. Resultado de la ejecución (2026-11-01, ~14:48)

| Paso | Resultado |
|---|---|
| 1 · Reinstalar binarios | **OK** — `added 1 package`; `postgres (PostgreSQL) 18.6` |
| 2 · `initdb` | **OK** — clúster creado con `-U auth --auth=trust` |
| 3 · Arranque con `danger-full-access` | **FALLÓ** — `could not bind IPv4 address "127.0.0.1": Permission denied` |
| 4–6 · Migraciones, suite, F7 | **NO EJECUTADOS** (parada por §6.1) |

Salida literal del paso 3:

```
LOG:  starting PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
LOG:  could not bind IPv4 address "127.0.0.1": Permission denied
WARNING:  could not create listen socket for "127.0.0.1"
FATAL:  could not create any TCP/IP sockets
```

**Conclusión:** el escalado de permisos **no** cubre este caso. La denegación de `bind()` sobrevive a `danger-full-access`, lo que apunta a una restricción fuera del alcance del sandbox de DSH (política de red del host o del propio proceso empaquetado). No es la red —npm y `initdb` funcionan— ni los sockets en general —Node escucha sin problema en 127.0.0.1—: es específicamente `postgres.exe` abriendo un puerto.

**Reversión ejecutada:** proceso detenido (`postgres.exe vivos: 0`), puerto cerrado (`False`), `.pgdata` eliminado, dependencia desinstalada. Suite de nuevo **52/52** con `pg-mem`. Ningún archivo del proyecto quedó modificado.

**Estado de TASK-001:** `partial` — como estaba previsto en §6.1 y en la condición 5 del operador. F7 no se ejecutó: sin el motor real, el drill de transacciones y concurrencia sería teatro.
