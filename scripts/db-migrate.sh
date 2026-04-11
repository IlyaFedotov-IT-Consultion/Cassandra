#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_PATH="${ROOT_DIR}/apps/api/src/db/schema.sql"
EVALUATION_SCHEMA_PATH="${ROOT_DIR}/apps/api/src/db/evaluation_schema.sql"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
elif [[ -f "${ROOT_DIR}/.env.example" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env.example"
fi

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/cassandra}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-cassandra}"

if [[ ! -f "${SCHEMA_PATH}" ]]; then
  echo "Schema file not found at ${SCHEMA_PATH}. Task 4 must create it before db:migrate can run." >&2
  exit 1
fi

if [[ ! -f "${EVALUATION_SCHEMA_PATH}" ]]; then
  echo "Evaluation schema file not found at ${EVALUATION_SCHEMA_PATH}." >&2
  exit 1
fi

if command -v psql >/dev/null 2>&1; then
  psql "${DATABASE_URL}" -f "${SCHEMA_PATH}"
  psql "${DATABASE_URL}" -f "${EVALUATION_SCHEMA_PATH}"
  exit 0
fi

if docker compose ps postgres >/dev/null 2>&1; then
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${SCHEMA_PATH}"
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${EVALUATION_SCHEMA_PATH}"
  exit 0
fi

echo "Neither local psql nor a running docker compose postgres service is available for migrations." >&2
exit 1
