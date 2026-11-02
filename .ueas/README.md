# .ueas/ — Universal Engineering Agent System

> **Estado del corpus:** VIGENTE — v0.1 aprobada el 2026-11-01.
> Aprobación registrada en [`CHANGELOG.md`](CHANGELOG.md). Todo cambio posterior sigue `CORE_RULES.md` §8.

## Documentos

| Archivo | Contenido | Autoridad |
|---------|-----------|-----------|
| [`CORE_RULES.md`](CORE_RULES.md) | Constitución: jerarquía normativa, reglas R1–R8, clasificación de riesgo L1–L4, flujo obligatorio, qué cuenta como evidencia, condiciones de STOP. | Máxima (tras la instrucción humana). |
| [`AGENT_SPECIFICATIONS.md`](AGENT_SPECIFICATIONS.md) | Roles y contratos: BUILDER (completo), VERIFIER y ORCHESTRATOR (mínimos), handoff y estados de tarea. | Subordinada a `CORE_RULES.md`. |
| [`RISK_ENGINE.md`](RISK_ENGINE.md) | **v0.2 vigente**: cálculo de riesgo por 6 factores, frontera auth/cripto, override humano y evidencia mínima por nivel. | Subordinada a `CORE_RULES.md`; prevalece en la frontera auth/cripto. |
| [`EVIDENCE_SCHEMA.json`](EVIDENCE_SCHEMA.json) | JSON Schema (2020-12) del sobre de evidencia que toda entrega debe cumplir. | Operativa. |
| [`PROPOSAL_SCHEMA.json`](PROPOSAL_SCHEMA.json) | Contrato del plan **previo** a ejecutar: riesgo con factores, pasos verificables, archivos previstos y reversión. | Operativa. |
| [`VERDICT_SCHEMA.json`](VERDICT_SCHEMA.json) | Contrato del veredicto del VERIFIER: comprobaciones reproducidas, coincidencias y motivos. | Operativa. |
| [`CHANGELOG.md`](CHANGELOG.md) | Historial de cambios del corpus, con aprobador humano. | Registro. |
| [`tools/validate_evidence.py`](tools/validate_evidence.py) | Validador del sobre de evidencia. Sin dependencias; cubre el subconjunto de JSON Schema usado. | Operativa. |
| [`scripts/verify_evidence_format.py`](scripts/verify_evidence_format.py) | Valida **todos** los sobres de `.ueas/evidence/` y aplica R1 (nadie aprueba lo propio) y R5 (`self_approved: false`). | Operativa. |
| [`scripts/verify_security_policies.py`](scripts/verify_security_policies.py) | Higiene: secretos hardcodeados, `.gitignore` cubre `.env`, ausencia de `.env` reales. | Operativa. |
| [`decisions/`](decisions/) | Registro de decisiones humanas (aprobaciones, dispensas, overrides) con su verificación anexa. | Registro. |

Validación de una entrega:

```
python .ueas/tools/validate_evidence.py ruta/a/evidencia.json
```

Limitación conocida: **no** es un validador completo de JSON Schema. Si el esquema incorpora `$ref`, `oneOf`, `patternProperties` u otros constructos, debe extenderse o sustituirse por `jsonschema`.

## Uso mínimo

1. El agente lee `CORE_RULES.md` y su sección en `AGENT_SPECIFICATIONS.md` **antes** de planificar.
2. Propone plan + clasificación de riesgo (plantilla en `AGENT_SPECIFICATIONS.md` §3.5).
3. L1 ejecuta; L2+ espera confirmación humana; L3/L4 solo clasifica.
4. Entrega el JSON de evidencia validado contra `EVIDENCE_SCHEMA.json`, con `self_approved: false` y `approvals.decision: "pending"`.
5. Un VERIFIER distinto re-ejecuta y decide.

## Invariantes

- **R1** Nadie aprueba su propio trabajo.
- **R2** `.ueas/` solo se modifica con autorización humana explícita.
- **R3** Riesgo L3/L4 detiene la ejecución.
- **R4** Sin evidencia reproducible no hay entrega.
- **R5** Prohibido fabricar resultados.

## Estado

- [x] Andamiaje base redactado (v0.1).
- [x] Aprobación humana global del corpus v0.1 (2026-11-01). No consta revisión línea por línea.
- [ ] Revisión detallada documento por documento (recomendada: el BUILDER redactó las reglas que lo gobiernan).
- [ ] Definido el VERIFIER operativo (persona o agente independiente).
