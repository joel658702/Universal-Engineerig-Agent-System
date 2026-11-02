#!/usr/bin/env python3
"""Validador mínimo del sobre de evidencia UEAS.

Sin dependencias externas (el sandbox puede impedir instalar `jsonschema`).
Cubre el subconjunto de JSON Schema draft 2020-12 realmente usado en
`.ueas/EVIDENCE_SCHEMA.json`:

  type, required, properties, additionalProperties, items, enum, const,
  minLength, allOf, if/then, format (date-time, comprobación superficial)

Uso:
    python .ueas/tools/validate_evidence.py <archivo.json> [<archivo2.json> ...]

Salida: PASS/FAIL por archivo y código de salida 0/1.
Limitación declarada: NO es un validador completo de JSON Schema. Si se usan
constructos fuera de esta lista ($ref, oneOf, patternProperties, ...), el
validador debe extenderse o sustituirse por `jsonschema`.
"""

from __future__ import annotations

import json
import re
import sys

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def _type_name(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if value is None:
        return "null"
    return "unknown"


def _matches_type(value, expected):
    actual = _type_name(value)
    if expected == "number":
        return actual in ("number", "integer")
    if expected == "integer":
        return actual == "integer"
    return actual == expected


def validate(instance, schema, path="$"):
    """Devuelve una lista de errores (vacía si es válido)."""
    errors = []

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: debe ser constante {schema['const']!r}, se obtuvo {instance!r}")

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} no está en {schema['enum']}")

    expected_type = schema.get("type")
    if expected_type is not None:
        types = expected_type if isinstance(expected_type, list) else [expected_type]
        if not any(_matches_type(instance, t) for t in types):
            errors.append(f"{path}: se esperaba tipo {types}, se obtuvo {_type_name(instance)}")
            return errors

    if isinstance(instance, str) and "minLength" in schema:
        if len(instance) < schema["minLength"]:
            errors.append(f"{path}: longitud {len(instance)} < minLength {schema['minLength']}")

    if isinstance(instance, str) and schema.get("format") == "date-time":
        if not _DATE_RE.match(instance):
            errors.append(f"{path}: no parece date-time RFC 3339 ({instance!r})")

    if isinstance(instance, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: falta el campo obligatorio '{key}'")
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in props:
                    errors.append(f"{path}: propiedad no permitida '{key}'")
        for key, subschema in props.items():
            if key in instance:
                errors.extend(validate(instance[key], subschema, f"{path}.{key}"))

    if isinstance(instance, list) and "minItems" in schema:
        if len(instance) < schema["minItems"]:
            errors.append(f"{path}: {len(instance)} elementos < minItems {schema['minItems']}")

    if isinstance(instance, list) and "items" in schema:
        for i, item in enumerate(instance):
            errors.extend(validate(item, schema["items"], f"{path}[{i}]"))

    for clause in schema.get("allOf", []):
        errors.extend(validate(instance, clause, path))

    if "if" in schema:
        condition_holds = not validate(instance, schema["if"], path)
        if condition_holds and "then" in schema:
            errors.extend(validate(instance, schema["then"], path))
        if not condition_holds and "else" in schema:
            errors.extend(validate(instance, schema["else"], path))

    return errors


def load_schema(path=".ueas/EVIDENCE_SCHEMA.json"):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    schema = load_schema()
    failures = 0
    for target in argv[1:]:
        try:
            with open(target, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"FAIL {target}: no se pudo leer/parsear: {exc}")
            failures += 1
            continue
        errors = validate(payload, schema)
        if errors:
            failures += 1
            print(f"FAIL {target}:")
            for err in errors:
                print(f"  - {err}")
        else:
            print(f"PASS {target}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
