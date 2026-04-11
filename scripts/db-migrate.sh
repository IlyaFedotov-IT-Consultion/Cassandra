#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_PATH="${ROOT_DIR}/apps/api/src/db/schema.sql"
EVALUATION_SCHEMA_PATH="${ROOT_DIR}/apps/api/src/db/evaluation_schema.sql"
EXISTING_DATABASE_URL="${DATABASE_URL-}"
EXISTING_POSTGRES_USER="${POSTGRES_USER-}"
EXISTING_POSTGRES_DB="${POSTGRES_DB-}"

if [ -f "${ROOT_DIR}/.env" ]; then
  # shellcheck disable=SC1091
  . "${ROOT_DIR}/.env"
elif [ -f "${ROOT_DIR}/.env.example" ]; then
  # shellcheck disable=SC1091
  . "${ROOT_DIR}/.env.example"
fi

if [ -n "${EXISTING_DATABASE_URL}" ]; then
  DATABASE_URL="${EXISTING_DATABASE_URL}"
fi

if [ -n "${EXISTING_POSTGRES_USER}" ]; then
  POSTGRES_USER="${EXISTING_POSTGRES_USER}"
fi

if [ -n "${EXISTING_POSTGRES_DB}" ]; then
  POSTGRES_DB="${EXISTING_POSTGRES_DB}"
fi

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/cassandra}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-cassandra}"

if [ ! -f "${SCHEMA_PATH}" ]; then
  echo "Schema file not found at ${SCHEMA_PATH}." >&2
  exit 1
fi

if [ ! -f "${EVALUATION_SCHEMA_PATH}" ]; then
  echo "Evaluation schema file not found at ${EVALUATION_SCHEMA_PATH}." >&2
  exit 1
fi

run_local_psql_migrations() {
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SCHEMA_PATH}" &&
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${EVALUATION_SCHEMA_PATH}"
}

run_compose_psql_migrations() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${SCHEMA_PATH}"
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "${EVALUATION_SCHEMA_PATH}"
}

start_compose_postgres() {
  docker compose up -d postgres >/dev/null
}

wait_for_compose_postgres() {
  attempts=30
  attempt=1

  while [ "${attempt}" -le "${attempts}" ]; do
    if docker compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
    attempt=$((attempt + 1))
  done

  return 1
}

if command -v psql >/dev/null 2>&1; then
  if run_local_psql_migrations; then
    exit 0
  fi

  echo "Local psql connection failed for ${DATABASE_URL}; attempting docker compose postgres fallback." >&2
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if ! start_compose_postgres; then
    echo "Unable to start docker compose postgres service." >&2
    exit 1
  fi

  if ! wait_for_compose_postgres; then
    echo "Docker compose postgres service did not become ready in time." >&2
    exit 1
  fi

  run_compose_psql_migrations
  exit 0
fi

echo "Neither a reachable local Postgres instance nor docker compose postgres fallback is available for migrations." >&2
exit 1
