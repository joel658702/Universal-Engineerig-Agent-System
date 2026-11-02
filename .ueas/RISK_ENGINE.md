# RISK_ENGINE — Motor de clasificación de riesgo (v1.1)

> **Estado:** VIGENTE — v1.1 aprobada.
> **Aprobado por:** operador humano del workspace, 2026-11-01 («Aprobado en los tres puntos»).
> **Vigente desde:** 2026-11-01.
> **Autorizado para su redacción por:** operador humano, 2026-11-01 («Autorizo crear RISK_ENGINE.md (v0.2)»).
> **Relación con CORE_RULES:** refina operativamente la §4 y **prevalece desde su aprobación** en la frontera auth/cripto; el resto de la §4 sigue vigente.

---

## 1. Por qué existe

`CORE_RULES.md` §4 clasifica por ejemplos, y dos ejemplos se solapan: **L3** incluye «credenciales/auth/permisos» y **L4** incluye «núcleo criptográfico o de autenticación». Una misma tarea de autenticación puede leerse en ambos niveles, lo que hace la clasificación dependiente de la interpretación del agente.

Este documento sustituye la interpretación por un **cálculo reproducible sobre factores declarados**.

## 2. Factores

Cada tarea se evalúa en seis factores. El valor es el nivel que activa el factor más alto aplicable.

| ID | Factor | 1 | 2 | 3 | 4 |
|----|--------|---|---|---|---|
| **F1** | Sensibilidad del dato | Público | Interno | Datos personales (PII) | Secretos explotables: credenciales en claro, claves, material criptográfico |

**Cómo se puntúa F1.** No cuenta que el código *manipule* credenciales para entregarlas a un mecanismo existente —eso ocurre en todo login—. Cuenta si el cambio **almacena, expone, genera o transporta material que, filtrado, compromete cuentas**: contraseñas sin hash, claves de firma, tokens en claro, secretos en configuración. Sin esta precisión, F1=4 absorbe cualquier tarea de autenticación y la rama L3 de la §4 queda inalcanzable.
| **F2** | Alcance del despliegue | Workspace local | Repo compartido | Servicio desplegado (staging) | Producción |
| **F3** | Reversibilidad | Aditivo / trivial | Rollback probado | Rollback no probado | Irreversible |
| **F4** | Superficie de seguridad | No la toca | La toca sin cambiar mecanismo | Consume un mecanismo existente | Define o cambia el mecanismo (auth, cripto, permisos) |
| **F5** | Dependencias | Sin cambios | Internas | Tercero nuevo | Tercero con impacto de cadena de suministro |
| **F6** | Radio de impacto | Un usuario | Un equipo | Todos los usuarios | Terceros / regulatorio |

**Cómo se puntúa F2.** Mide el entorno al que llega el cambio **ejecutable**. Documentación, diagramas y artefactos que no se despliegan puntúan 1 aunque vivan en un repo compartido.

## 3. Cálculo

```
nivel = max(F1, F2, F3, F4, F5, F6)
```

Reglas del cálculo:

1. **No se promedia.** Un solo factor en 4 hace la tarea L4 aunque los otros cinco valgan 1.
2. **No se compensa.** Un rollback fácil (F3=1) no rebaja una F4=4.
3. **Duda en la frontera → el más alto.**
4. **Factor desconocido → se asume el valor más alto compatible con lo declarado**, y se marca como supuesto en la evidencia. Si el supuesto cambia el nivel, se pide reconocimiento antes de actuar.

## 4. Frontera auth y cripto (la desambiguación)

Pregunta única de decisión:

> **¿Este cambio define cómo se verifica la identidad, o solo consume un mecanismo ya definido y aprobado?**

| Resultado | Nivel | Casos típicos |
|---|---|---|
| **Define o cambia el mecanismo** | **L4** | Introducir autenticación donde no existía (greenfield). Cambiar algoritmo de firma, formato de token, hashing de contraseñas, gestión de claves o MFA. Cualquier cambio que afecte a **todas** las sesiones. |
| **Consume el mecanismo existente** | **L3** | Nuevo endpoint de auth sobre un framework ya establecido. Claims adicionales dentro del esquema vigente. Endurecer rate limiting. Política de contraseñas sin cambiar el hash. Nuevas rutas protegidas por el middleware existente. |

**Si el repositorio no permite determinar cuál es el caso, se clasifica L4** y se solicita reconocimiento (fase 0). El desconocimiento se resuelve mirando el código, no eligiendo el nivel más cómodo.

## 5. Override humano

Solo un humano puede fijar un nivel distinto al calculado.

Requisitos, todos obligatorios:

1. Aprobador nombrado.
2. Justificación escrita en la evidencia.
3. Riesgo residual aceptado explícitamente.
4. Registro en `CHANGELOG.md` y en `confirmation.granted_by`.

**Si el override contradice hechos declarados** —por ejemplo, afirmar «ya existe autenticación» sobre un repositorio vacío—, el agente debe marcarlo como `override_con_hecho_contradictorio`, señalar la contradicción y pedir confirmación explícita. No puede resolverla en silencio ni adoptar el nivel más bajo por conveniencia.

## 6. Aprobaciones exigidas

| Nivel | Aprobadores | Requisitos adicionales |
|---|---|---|
| **L1** | Ninguno | Reporte posterior; auditable |
| **L2** | 1 humano con responsabilidad sobre el repo | Plan con evidencia prevista |
| **L3** | 1 humano con responsabilidad sobre el sistema afectado | Plan de reversión + revisión de seguridad |
| **L4** | **2 humanos**, uno de ellos de seguridad | Plan de reversión **probado** + threat model |

## 7. Evidencia mínima por nivel

- **L1**: salida de comando reproducible.
- **L2**: lo anterior + suite de tests en verde.
- **L3**: lo anterior + **casos negativos** + revisión de seguridad registrada.
- **L4**: lo anterior + threat model + **prueba de rollback ejecutada** + doble aprobación registrada en la evidencia.

## 8. Ejemplos resueltos

| Caso | Factores | Nivel |
|---|---|---|
| JWT desde cero en proyecto nuevo (no hay mecanismo previo) | F1=3, F2=2, F3=3, **F4=4**, F5=3, F6=3 | **L4** |
| Añadir `GET /auth/me` a un auth existente | F1=3, F2=3, F3=1, F4=3, F5=1, F6=3 | **L3** |
| Migrar bcrypt → argon2id | F1=4, F2=3, F3=3, **F4=4**, F5=3, F6=3 | **L4** |
| Rate limiting en login | F1=3, F2=3, F3=1, F4=3, F5=1, F6=3 | **L3** |
| Guardar refresh tokens sin hash en BD | F1=4, F4=3 | **L4** (F1) |
| Log de auditoría de login sin PII | F1=1, F2=3, F3=1, F4=1, F5=1, F6=2 | **L3** |
| Documentación de la API de auth | F1=1, F2=1, F3=1, F4=1, F5=1, F6=1 | **L1** |

## 9. Registro de la decisión

Toda clasificación se emite así, y este bloque viaja en la evidencia:

```json
{
  "risk_id": "RISK-TASK-001",
  "factors": { "F1": 3, "F2": 2, "F3": 3, "F4": 4, "F5": 3, "F6": 3 },
  "computed_level": "L4",
  "final_level": "L4",
  "override": null,
  "assumptions": ["Repositorio greenfield: no existe mecanismo de auth previo."],
  "contradictions": []
}
```

Con override humano:

```json
{
  "computed_level": "L4",
  "final_level": "L3",
  "override": {
    "by": "<aprobador>",
    "justification": "<por qué>",
    "contradicts_declared_facts": false
  }
}
```

## 10. Excepciones

Una excepción **no deroga la regla: la suspende para un caso concreto**, con nombre, fecha y responsable. Se registran aquí y **no se heredan** a otras tareas. Al cerrarse la tarea, la excepción pasa a histórica: **no se archiva fuera del documento**, para que quede visible que existió.

| ID | Tarea | Excepción | Decisión | Aprobador | Estado | Riesgo residual |
|----|-------|-----------|----------|-----------|--------|-----------------|
| **EX-001** | `RISK-TASK-001` (L4) | Ejecutar con **1 firma** en lugar de 2 (§6) | `DE-002` | Operador humano (rol declarado) | **Cerrada** el 2026-11-02 con la tarea — `DE-003-bis` | Sin revisión de seguridad independiente |

### Reglas de una excepción

1. Cita siempre su decisión (`DE-00X`) y el humano que la concedió. Sin ambos, no existe.
2. **No modifica el nivel calculado.** TASK-001 sigue siendo L4 aunque avance con una firma.
3. No sienta precedente ni se extiende a otras tareas, ni siquiera del mismo tipo.
4. Se revoca al designarse el segundo aprobador o al cerrarse la tarea; la revocación se anota con fecha.
5. Mientras esté vigente, **la evidencia lo refleja** en `approvals.notes` y el sobre no puede declararse `complete` si algún control de L4 quedó sin ejecutar.
6. Una excepción no puede usarse para rebajar la clasificación de una tarea nueva: eso es blanqueo de riesgo (§3).

---

## 11. Historial de cambios del documento
Documento nuevo: no existía. Creado a petición de TASK-001, que lo citaba como fuente de clasificación sin que estuviera presente en el corpus.

### v1.1 — 2026-11-01
- **Añadida §10 «Excepciones vigentes»** con `EX-001` (DE-002, dispensa de doble firma en TASK-001). Motivo: la regla general de §6 (L4 = 2 aprobadores) y la dispensa concedida se contradecían al leerlas juntas; ahora la excepción está registrada, acotada y revocable.
- Renumerada la sección de historial a §11.
- Se descarta el término «inmutable» para el corpus: todo cambio sigue `CORE_RULES.md` §8.

### Corrección durante la propia redacción
La primera versión puntuaba F1=4 para cualquier tarea que tratase credenciales. Al aplicarla a TASK-001 se comprobó que **toda** tarea de autenticación salía L4 —incluso las que la §4 clasifica explícitamente como L3—, dejando la rama L3 inalcanzable. Se redefinió F1 como *material explotable* (no mera manipulación) y se añadió una nota de puntuación. Verificado con los 7 ejemplos de la §8.
