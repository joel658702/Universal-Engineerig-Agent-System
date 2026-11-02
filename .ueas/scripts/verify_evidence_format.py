#!/usr/bin/env python3
"""verify_evidence_format.py — UEAS v1.0

Valida los tres contratos de comunicación del sistema:

  * `.ueas/evidence/*.json`  → EVIDENCE_SCHEMA.json   (entrega del BUILDER)
  * `.ueas/proposals/*.json` → PROPOSAL_SCHEMA.json   (plan previo a ejecutar)
  * `.ueas/verdicts/*.json`  → VERDICT_SCHEMA.json    (veredicto del VERIFIER)

Además del esquema, aplica invariantes que un JSON Schema no puede expresar:

  R1  un BUILDER no puede escribir `approvals.decision = "approved"`;
  R1  un verificador no puede ser el propio agente (ni llamarse BUILDER/SELF);
  R5  `self_approved` y `self_verdict` deben ser false;
  R5  no se puede aprobar con `match: false` ni con afirmaciones sin reproducir;
  R3  un plan L3/L4 en estado APROBADA exige `granted_by` humano.

Uso:
    python .ueas/scripts/verify_evidence_format.py
    python .ueas/scripts/verify_evidence_format.py --selftest

Código 0 si todo pasa, 1 si hay fallos.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

UEAS = pathlib.Path(__file__).resolve().parents[1]
ROOT = UEAS.parent
VALIDATOR_PATH = UEAS / "tools" / "validate_evidence.py"

KINDS = {
    "evidence": (UEAS / "evidence", UEAS / "EVIDENCE_SCHEMA.json"),
    "proposal": (UEAS / "proposals", UEAS / "PROPOSAL_SCHEMA.json"),
    "verdict": (UEAS / "verdicts", UEAS / "VERDICT_SCHEMA.json"),
}


def load_validator():
    spec = importlib.util.spec_from_file_location("ueas_validator", VALIDATOR_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def proposal_problems(payload: dict) -> list[str]:
    problems = []
    risk = payload.get("risk", {})
    confirmation = payload.get("confirmation", {})
    level = risk.get("level")
    if level in ("L3", "L4"):
        if confirmation.get("status") == "granted" and not confirmation.get("granted_by"):
            problems.append("R3: un plan L3/L4 aprobado exige granted_by con identidad humana")
        if payload.get("state") == "APROBADA" and confirmation.get("status") != "granted":
            problems.append("R3: state=APROBADA requiere confirmation.status='granted'")
    return problems


def verdict_problems(payload: dict) -> list[str]:
    problems = []
    verifier = str(payload.get("verifier", "")).strip().upper()
    if verifier in ("BUILDER", "SELF", "AGENT", "AUTOR"):
        problems.append("R1: el verificador no puede ser el propio autor")

    decision = payload.get("decision")
    checks = payload.get("checks_reproduced", [])
    mismatches = [c.get("check") for c in checks if c.get("match") is False]
    unverified = payload.get("unverified_claims", []) or []

    if decision == "approved":
        if mismatches:
            problems.append(f"R5: aprobado con comprobaciones que no coinciden: {mismatches}")
        if unverified:
            problems.append(f"R5: aprobado con afirmaciones sin reproducir: {unverified}")
    if decision == "rejected" and not payload.get("reasons"):
        problems.append("R5: un rechazo debe explicar el motivo en 'reasons'")
    return problems


EXTRA = {"proposal": proposal_problems, "verdict": verdict_problems, "evidence": lambda _p: []}


def check_payload(kind: str, payload: dict, schema: dict, validator) -> list[str]:
    problems = list(validator.validate(payload, schema))
    problems.extend(EXTRA[kind](payload))

    if kind == "evidence":
        if payload.get("self_approved") is not False:
            problems.append("R5: self_approved debe ser false")
        decision = payload.get("approvals", {}).get("decision")
        if payload.get("agent") == "BUILDER" and decision == "approved":
            problems.append("R1: un BUILDER no puede escribir approvals.decision='approved'")
    return problems


def run_selftest(validator) -> int:
    """Casos embebidos: 1 válido + 2 inválidos por contrato."""
    proposals = json.loads((UEAS / "PROPOSAL_SCHEMA.json").read_text(encoding="utf-8"))
    verdicts = json.loads((UEAS / "VERDICT_SCHEMA.json").read_text(encoding="utf-8"))

    good_plan = {
        "task_id": "SELFTEST-1",
        "agent": "BUILDER",
        "requirement": "Comprobar el contrato de propuesta",
        "risk": {"level": "L2", "justification": "Cambio reversible en repo compartido"},
        "confirmation": {"required": True, "status": "granted", "granted_by": "humano"},
        "plan": [{"step": 1, "description": "hacer algo", "verifiable_by": "un test"}],
        "files_expected": [{"path": "a.txt", "action": "create"}],
        "evidence_planned": ["salida del test"],
        "rollback": "borrar a.txt",
        "state": "APROBADA",
    }

    good_verdict = {
        "task_id": "SELFTEST-1",
        "verifier": "security-lead",
        "decision": "approved",
        "checks_reproduced": [
            {"check": "suite en verde", "expected": "exit 0", "observed": "exit 0", "match": True}
        ],
        "reasons": ["reproducido"],
        "decided_at": "2026-11-01T12:00:00-05:00",
        "self_verdict": False,
    }

    cases = [
        ("proposal_valido", "proposal", good_plan, True),
        ("proposal_sin_plan", "proposal", {k: v for k, v in good_plan.items() if k != "plan"}, False),
        (
            "proposal_L4_aprobada_sin_firmante",
            "proposal",
            {**good_plan, "risk": {"level": "L4", "justification": "núcleo de autenticación"},
             "confirmation": {"required": True, "status": "granted", "granted_by": None}},
            False,
        ),
        ("verdict_valido", "verdict", good_verdict, True),
        (
            "verdict_aprueba_con_fallo",
            "verdict",
            {**good_verdict, "checks_reproduced": [
                {"check": "suite en verde", "expected": "exit 0", "observed": "exit 1", "match": False}]},
            False,
        ),
        ("verdict_emitido_por_el_autor", "verdict", {**good_verdict, "verifier": "BUILDER"}, False),
    ]

    failures = 0
    for name, kind, payload, should_pass in cases:
        schema = proposals if kind == "proposal" else verdicts
        problems = check_payload(kind, payload, schema, validator)
        ok = (not problems) == should_pass
        if not ok:
            failures += 1
        print(f"{'OK ' if ok else 'FALLO'} selftest.{name:38} esperado={'PASS' if should_pass else 'FAIL'}")
        if problems and should_pass:
            for p in problems:
                print(f"      inesperado: {p}")

    print(f"\n{len(cases)} casos · {failures} fallos")
    return 0 if failures == 0 else 1


def main(argv: list[str]) -> int:
    validator = load_validator()

    if "--selftest" in argv:
        return run_selftest(validator)

    quiet = "--quiet" in argv
    total = 0
    failures = 0

    for kind, (folder, schema_path) in KINDS.items():
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        files = sorted(folder.glob("*.json")) if folder.exists() else []
        if not files:
            if not quiet:
                print(f"(sin {kind}: {folder.name}/ vacío o inexistente)")
            continue
        for path in files:
            total += 1
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                failures += 1
                print(f"FAIL {kind}/{path.name}: JSON inválido: {exc}")
                continue
            problems = check_payload(kind, payload, schema, validator)
            if problems:
                failures += 1
                print(f"FAIL {kind}/{path.name}")
                for problem in problems:
                    print(f"  - {problem}")
            elif not quiet:
                print(f"PASS {kind}/{path.name}")

    print(f"\n{total} artefactos · {failures} con fallos")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
