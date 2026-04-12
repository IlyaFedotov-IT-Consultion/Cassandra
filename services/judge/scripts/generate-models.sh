#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVICE_ROOT}/../.." && pwd)"
SCHEMA_PATH="${REPO_ROOT}/packages/shared/dist/schemas.json"
OUTPUT_PATH="${1:-${SERVICE_ROOT}/app/models_generated.py}"

if [[ ! -f "${SCHEMA_PATH}" ]]; then
  echo "Shared schema not found at ${SCHEMA_PATH}. Run 'pnpm --filter @cassandra/shared build' first." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"

export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$(mktemp -d)}"

cd "${SERVICE_ROOT}"

uv run --group dev datamodel-codegen \
  --input "${SCHEMA_PATH}" \
  --input-file-type jsonschema \
  --output "${OUTPUT_PATH}" \
  --disable-timestamp \
  --output-model-type pydantic_v2.BaseModel \
  --use-standard-collections \
  --target-python-version 3.12
