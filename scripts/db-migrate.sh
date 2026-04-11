#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL must be set before running migrations." >&2
  exit 1
fi

SCHEMA_PATH="apps/api/src/db/schema.sql"

if [[ ! -f "${SCHEMA_PATH}" ]]; then
  echo "Schema file not found at ${SCHEMA_PATH}. Task 4 must create it before db:migrate can run." >&2
  exit 1
fi

psql "${DATABASE_URL}" -f "${SCHEMA_PATH}"
