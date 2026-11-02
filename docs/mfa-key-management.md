# Gestión de la clave maestra de MFA

> Ámbito: `services/auth` · Vigente desde 2026-11-02 · Dueño: operación del servicio
> Referencias: `UEAS-020` (implementación), `TASK-005` (este procedimiento), `RISK_ENGINE.md` §6

---

## 1. Propósito y alcance

`MFA_MASTER_KEY` es la clave AES-256-GCM con la que se cifran todos los secretos TOTP de los usuarios. Este documento define quién la custodia, cómo se rota y qué se hace si se pierde o se compromete.

**Dentro del alcance:** rotación, recuperación por pérdida, respuesta a compromiso, registro de operaciones.
**Fuera del alcance:** enrolamiento de usuarios, política de contraseñas, y el procedimiento de soporte al usuario final.

## 2. Modelo de amenaza

| Activo | Si se filtra | Si se pierde |
|---|---|---|
| `MFA_MASTER_KEY` | Un atacante descifra **todos** los secretos TOTP: puede generar códigos válidos de cualquier usuario | Nadie puede validar TOTP: todos los usuarios con MFA quedan fuera |
| Secretos TOTP (cifrados) | Inútiles sin la clave | Recuperables solo con la clave correcta |
| Códigos de recuperación | Ya están hasheados; no se descifran | — |

La clave es, por tanto, el punto único de fallo del segundo factor. Su custodia no es un trámite: es el control.

## 3. Custodia

1. Vive **solo** en el gestor de secretos del entorno (variable `MFA_MASTER_KEY`, 32 bytes en base64).
2. **Nunca** en el repositorio, ni en `.env` versionado, ni en un ticket, ni en un chat.
3. Se separa por entorno: producción y staging **no comparten** clave.
4. Backup: dos copias selladas, en medios distintos, accesibles solo con doble autorización. Se revisan cada 6 meses.
5. Acceso: mínimo privilegio; el equipo de aplicación no la necesita para desplegar, solo el procedimiento de rotación la requiere.

## 4. Formato del secreto cifrado

```
user_mfa_secrets
  secret_ciphertext  base64(AES-256-GCM(secreto))
  iv                 base64(12 bytes aleatorios por registro)
  auth_tag           base64(16 bytes del tag GCM)
  key_id             'v1', 'v2', … identifica qué clave lo cifró
```

`key_id` es lo que hace posible una rotación sin adivinar: cada fila declara con qué clave se escribió.

## 5. Procedimiento de rotación

**Pre-requisitos:** ventana de mantenimiento acordada · backup verificado de la clave actual · `DATABASE_URL` de producción · dos claves en el entorno de ejecución.

```bash
# 1. Ensayo: contar cuántos secretos se rotarían (no escribe)
MFA_MASTER_KEY_CURRENT=<actual> MFA_MASTER_KEY_NEW=<nueva> \
  DATABASE_URL=... node scripts/rotate-mfa-key.mjs --dry-run --key-id v2

# 2. Rotación real (una transacción)
MFA_MASTER_KEY_CURRENT=<actual> MFA_MASTER_KEY_NEW=<nueva> \
  DATABASE_URL=... node scripts/rotate-mfa-key.mjs --key-id v2

# 3. Verificar
psql "$DATABASE_URL" -c "select key_id, count(*) from user_mfa_secrets group by key_id;"
# Esperado: una sola fila, con el key_id nuevo
```

**Qué garantiza:** una sola transacción, verificación de descifrado con la clave nueva antes del `COMMIT`, `ROLLBACK` completo ante cualquier fallo. No existe estado mixto.

**Rollback:** si la transacción falla, nada cambió y el servicio sigue con la clave actual. Si el `COMMIT` tuvo éxito pero el servicio aún no conoce la clave nueva, **el servicio falla al descifrar**: por eso el orden es *desplegar la clave nueva en el servicio primero*, y solo después rotar en base de datos.

**Limitación declarada:** bloquea la tabla `user_mfa_secrets` durante la operación. Con más de ~100k filas hay que pasar al patrón keyring (dos claves aceptadas a la vez, rotación por lotes y reanudable).

## 6. Procedimiento de recuperación por pérdida

Un usuario perdió el dispositivo **y** los códigos de recuperación. Es la única vía legítima para saltarse el segundo factor, y por eso exige control humano.

```bash
OPERATOR="ana" DATABASE_URL=... node scripts/recover-mfa-loss.mjs \
  --user usuario@example.com \
  --confirm usuario@example.com \
  --reason "ticket #4321, verificado por teléfono"
```

**Controles:** confirmación redundante (`--confirm` debe repetir el identificador), motivo obligatorio, operador identificado, auditoría en tabla. Sin los tres argumentos el script **no hace nada** y sale con código 2.

**Efectos:** borra secreto y códigos, sube `token_version` (mata todas las sesiones) e inserta fila en `mfa_recovery_audit`.

**Irreversible por diseño:** el usuario debe volver a enrolarse. No se conserva copia del secreto.

## 7. Runbook: clave comprometida

1. **Declarar incidente** y abrir registro con hora y responsable.
2. Generar clave nueva y **desplegarla en el servicio** (que acepte ambas temporalmente, o en ventana de mantenimiento).
3. Rotar con el script del §5.
4. **Invalidar todas las sesiones**: `update users set token_version = token_version + 1;` en una transacción, o el procedimiento equivalente.
5. Notificar a los usuarios con MFA: deben re-enrolarse si se sospecha uso de secretos.
6. Rotar también los códigos de recuperación (`GET /auth/mfa/backup-codes`) de las cuentas sensibles.
7. Revisar `mfa_recovery_audit` por si hubo recuperaciones anómalas.

## 8. Checklist de verificación

- [ ] `MFA_MASTER_KEY` de 32 bytes, fuera del repositorio
- [ ] Backup de la clave probado (restaurar y descifrar una fila de prueba)
- [ ] `dry-run` ejecutado y su conteo coincide con el esperado
- [ ] Tras rotar, `select key_id, count(*)` muestra un solo `key_id`
- [ ] Un login con MFA funciona después de la rotación
- [ ] Fila en `mfa_recovery_audit` para cada recuperación
- [ ] Ningún secreto ni código aparece en logs del script

## 9. Registro de rotaciones

| Fecha | `key_id` origen | `key_id` destino | Operador | Filas | Incidente |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

> Se rellena en cada rotación. Una rotación sin fila aquí es una rotación no registrada.
