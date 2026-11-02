# CHANGELOG — corpus `.ueas/`

Formato: `## [versión] — fecha — estado` y entradas con propuesto-por / aprobado-por.
Una entrada sin `aprobado-por` humano no cambia el estado del corpus.

## [1.3] — 2026-11-02 — VIGENTE (aprobado)

**Origen:** decisión de cierre de TASK-001 (DE-003 y su revisión DE-003-bis).
**Registrado por:** agente BUILDER (transcripción y verificación; no aprueba — R1).

### Añadido
- `decisions/2026-11-02-DE-003-task001-closure.md` — cierre declarado; superado por la revisión.
- `decisions/2026-11-02-DE-003-bis-task001-closure.md` — versión vigente: corrige la procedencia de la ejecución («se rodeó, no se resolvió») y cierra EX-001.

### Cambiado
- `RISK_ENGINE.md` §10: `EX-001` pasa de **Vigente** a **Cerrada** (2026-11-02, con la tarea). El apartado deja de llamarse «Excepciones vigentes»: ahora aloja también las cerradas, para que el histórico sea visible.

### Nota
La excepción no se propaga: la próxima tarea L4 exige dos firmas (§6) o una dispensa nueva y explícita.

---

## [1.2] — 2026-11-01 — VIGENTE (aprobado)

**Propuesto y ejecutado por:** agente BUILDER.
**Aprobado por:** operador humano del workspace, 2026-11-01 («Aprobado en los tres puntos», punto 4).

### Añadido
- `PROPOSAL_SCHEMA.json` — contrato del plan previo: nivel con factores F1–F6, pasos con `verifiable_by`, archivos esperados, evidencia planeada, reversión y `state`.
- `VERDICT_SCHEMA.json` — contrato del veredicto: `checks_reproduced` con `match` booleano, `unverified_claims`, `reasons` y `self_verdict` como constante `false`.
- `proposals/TASK-001-F4.proposal.json` — primera propuesta real bajo el contrato nuevo (rotación de refresh, pendiente de aprobación).
- `verify_evidence_format.py` — valida los tres contratos y añade `--selftest` con 6 casos (3 válidos, 3 inválidos).

### Cambiado
- `tools/validate_evidence.py` — soporta `minItems`.
- `README.md` — filas de los dos esquemas nuevos.

---

## [1.1] — 2026-11-01 — VIGENTE (aprobado)

**Propuesto y ejecutado por:** agente BUILDER.
**Aprobado por:** operador humano del workspace, 2026-11-01 («Aprobado en los tres puntos»).
**Contexto:** el operador describió este cambio como ya existente (v1.1 con sección «EXCEPCIONES VIGENTES»); al verificar, el archivo seguía en v0.2 sin esa sección. Se materializa aquí, no antes.

### Añadido
- `RISK_ENGINE.md` §10 **Excepciones vigentes** — tabla con `EX-001` (TASK-001, L4, 1 firma, `DE-002`, aprobador humano, riesgo residual) y 6 reglas de uso: la excepción suspende la regla, no la deroga; no cambia el nivel; no sienta precedente; es revocable y debe reflejarse en la evidencia.
- Renumerada la sección de historial a §11, con nota de la v1.1.
- Se retira el término «inmutable»: el corpus es corregible y auditable según `CORE_RULES.md` §8.

---

## [0.3] — 2026-11-01 — VIGENTE (por instrucción del operador)

**Origen:** mensaje del operador «Aprobación de Plan, Threat Model y Resolución de Bloqueos R1/R2».
**Registrado por:** agente BUILDER (transcripción y verificación; no aprueba — R1).

### Añadido
- `scripts/verify_evidence_format.py` — valida todos los sobres y aplica R1/R5.
- `scripts/verify_security_policies.py` — secretos hardcodeados, `.gitignore`/`.env`.
- `decisions/2026-11-01-DE-001-TASK-001.md` — decisión humana sobre TASK-001 con anexo de verificación.
- `CORE_RULES.md` §4 — cross-ref obligatorio a `RISK_ENGINE.md`.
- `README.md` — filas de los nuevos artefactos.

### Discrepancias detectadas (registradas, no ocultadas)
- El mensaje declaraba creados los scripts y el cross-ref: **ninguno existía**. Se crean en esta entrada.
- El mensaje declaraba un `CODEOWNERS` con regla para `services/auth/`: **no existe** ni hay repositorio git; queda pendiente.
- El bloque de evidencia recibido usa `timestamp: 2026-11-02T10:00:00Z`, **posterior** a su recepción, y no conforma `EVIDENCE_SCHEMA.json`. No se ingirió como evidencia.
- **Sustitución `.sh` → `.py`**: `bash` (WSL) y Git Bash fallan en este entorno; scripts `.sh` serían `not_run` por definición. Pendiente de visto bueno.

### Estado
TASK-001 pasa a **autorización parcial: 1 de 2 firmas L4**. Código de autenticación sigue bloqueado.

### Actualización posterior (misma fecha)
- `decisions/2026-11-01-DE-002-task001-waiver.md` — dispensa de doble firma para TASK-001 (opción «2» elegida por el operador). Registrada como `override` con `residual_risk_accepted: true`; **no cambia el nivel L4** ni sienta precedente.
- Con la dispensa, TASK-001 queda autorizada a ejecutar fases 0–7 con una firma y controles L4 mantenidos.

---

## [0.2] — 2026-11-01 — VIGENTE (aprobado)

**Propuesto por:** agente BUILDER, a petición del operador humano.
**Autorizado por:** operador humano, 2026-11-01 («Autorizo crear RISK_ENGINE.md (v0.2)»).
**Aprobado por:** operador humano del workspace, 2026-11-01 («Apruebo v0.2 tal cual»).
**Efecto:** F1–F6 son la fuente operativa de clasificación. `CORE_RULES.md` §4 queda como marco general; en la frontera auth/cripto prevalece este documento.
**Motivo:** TASK-001 citaba `.ueas/RISK_ENGINE.md`, que no existía; además `CORE_RULES.md` §4 solapaba L3 («credenciales/auth/permisos») y L4 («núcleo criptográfico o de autenticación») para la misma tarea.

### Añadido
- `RISK_ENGINE.md` — cálculo de riesgo por 6 factores (F1–F6) con `max()` y sin promedio; frontera auth/cripto resuelta con una pregunta única; override humano con requisito de señalar contradicciones; matriz de aprobadores; evidencia mínima por nivel; 6 ejemplos resueltos; formato de registro `risk_id`.

### Corregido antes de publicar
- **F1 absorbía toda la autenticación.** Con «credenciales» = 4, cualquier tarea de auth salía L4 y la rama L3 de `CORE_RULES.md` §4 quedaba inalcanzable. F1 se redefinió como *material explotable* (no mera manipulación de credenciales) y se añadió una nota de puntuación. Los 7 ejemplos de la §8 se validaron con un script que comprueba `max(F) == nivel declarado`.

### Derivados
- `README.md`: fila del nuevo documento en el índice.
- **Pendiente de autorización:** añadir en `CORE_RULES.md` §4 una línea que remita a `RISK_ENGINE.md`. No se hizo para no exceder lo autorizado.

---

## [0.1] — 2026-11-01 — VIGENTE (aprobado)

**Aprobado por:** operador humano del workspace, 2026-11-01, mensaje «aprobado» (GUI de DeepSeek Harness).
**Alcance de la aprobación:** global, sobre el corpus v0.1 completo — `CORE_RULES.md`, `AGENT_SPECIFICATIONS.md`, `EVIDENCE_SCHEMA.json`, `README.md` y `tools/validate_evidence.py`. **No consta revisión línea por línea.**
**Efecto:** los documentos pasan de BORRADOR a VIGENTES. R1–R8 son exigibles desde esta fecha.
**Registrado por:** agente BUILDER — la aprobación es del humano, no del agente (R1).

### Cambios de estado en esta entrada
- Cabeceras de `CORE_RULES.md`, `AGENT_SPECIFICATIONS.md` y `README.md`: BORRADOR → VIGENTE.
- `CORE_RULES.md` §preámbulo: se declara explícitamente que la aprobación fue global y sin revisión línea por línea.
- `README.md` checklist: aprobación marcada; se añade la revisión detallada como pendiente recomendada.

---

## [0.1] — 2026-11-01 — BORRADOR (histórico)

**Propuesto por:** agente BUILDER (DeepSeek Harness), a petición del operador humano.
**Aprobado por:** — (pendiente).
**Alcance:** creación inicial del andamiaje normativo.

### Añadido
- `CORE_RULES.md` — jerarquía normativa, reglas inquebrantables R1–R8, matriz de riesgo L1–L4, flujo obligatorio de 6 pasos, criterios de evidencia, condiciones de STOP, procedimiento de enmienda.
- `AGENT_SPECIFICATIONS.md` — modelo de agentes con separación de funciones, contrato común, especificación completa de BUILDER (flujo, prohibiciones, plantilla de plan, DoD, formato de entrega), mínimos de VERIFIER y ORCHESTRATOR, protocolo de handoff.
- `EVIDENCE_SCHEMA.json` — JSON Schema 2020-12 del sobre de evidencia; `self_approved` fijado como `const false`.
- `README.md` — índice y guía de uso.
- `tools/validate_evidence.py` — validador sin dependencias del subconjunto de JSON Schema usado.

### Corregido durante la verificación inicial
- **Agujero en `EVIDENCE_SCHEMA.json`**: la cláusula `then: { required: ["output_excerpt"] }` aceptaba `output_excerpt: null` (la clave existe y el tipo admitía `null`), de modo que una verificación `pass` sin salida real validaba. Detectado por el caso negativo `pass_sin_output`; corregido exigiendo `type: string` con `minLength: 1` en `output_excerpt` y `not_run_reason`. Suite de 8 casos: 8/8 tras el arreglo.

### Notas de diseño
- La regla de autoaprobación se hace cumplir en el esquema (`self_approved: const false`) y no solo por convención.
- Las verificaciones no ejecutadas deben declararse `not_run` con motivo; `evidence_completeness` baja a `partial`.
- El riesgo se redondea siempre hacia arriba en caso de duda.

### Pendiente para 1.0
- Revisión y aprobación humana de cada documento.
- Nombrar un VERIFIER independiente.
- Añadir `VALIDATION.md` o script de validación del esquema de evidencia.
