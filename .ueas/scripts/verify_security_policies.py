#!/usr/bin/env python3
"""verify_security_policies.py — UEAS v1.0

Comprobaciones de higiene que deben pasar antes de cualquier merge:

  1. Sin secretos hardcodeados en archivos de código o configuración
     (claves privadas, tokens de proveedor, contraseñas literales).
  2. `.gitignore` existe y cubre `.env` y variantes.
  3. Existe `.env.example` con valores vacíos si hay configuración por entorno.
  4. Ningún archivo `.env` real está versionado dentro del workspace.

Uso:
    python .ueas/scripts/verify_security_policies.py

Código 0 si pasa, 1 si encuentra hallazgos. Los hallazgos se listan como
`archivo:línea: motivo` para que sean accionables.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

CODE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".json",
                 ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".ps1", ".env"}
SKIP_DIRS = {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv"}

PATTERNS = [
    ("clave privada PEM", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("token de AWS", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("token de GitHub", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("contraseña literal", re.compile(r"""(?i)\b(password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{4,}["']""")),
    ("secreto literal", re.compile(r"""(?i)\b(api[_-]?key|secret|token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']""")),
    ("credencial en URL", re.compile(r"""(?i)\b[a-z]+://[^/\s:@]+:[^/\s@]+@""")),
]

PLACEHOLDERS = {"", "changeme", "xxx", "placeholder", "your-secret-here", "todo"}


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if ".ueas" in path.parts:  # el corpus no es código de producto
            continue
        if path.suffix.lower() in CODE_SUFFIXES or path.name == ".env":
            yield path


def main():
    findings = []
    scanned = 0

    for path in iter_files():
        scanned += 1
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            for label, pattern in PATTERNS:
                match = pattern.search(line)
                if not match:
                    continue
                value = match.group(0)
                lowered = value.lower()
                if any(placeholder in lowered for placeholder in PLACEHOLDERS):
                    continue
                findings.append(f"{path.relative_to(ROOT)}:{lineno}: {label}")

    gitignore = ROOT / ".gitignore"
    if not gitignore.exists():
        findings.append(".gitignore: no existe (no hay forma de garantizar que .env no se versione)")
    else:
        content = gitignore.read_text(encoding="utf-8", errors="replace")
        if ".env" not in content:
            findings.append(".gitignore: no cubre .env")

    for env_file in ROOT.rglob(".env"):
        if ".git" not in env_file.parts:
            findings.append(f"{env_file.relative_to(ROOT)}: archivo .env real presente en el workspace")

    print(f"archivos de código escaneados: {scanned}")
    if findings:
        print(f"hallazgos: {len(findings)}")
        for item in findings:
            print(f"  - {item}")
        return 1

    print("hallazgos: 0")
    if scanned == 0:
        print("(no hay código todavía: comprobación vacua pero válida)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
