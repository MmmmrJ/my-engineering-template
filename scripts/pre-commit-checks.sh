#!/usr/bin/env bash
# pre-commit-checks.sh — fast checks from project-checks.env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/scripts/project-checks.env"
EXAMPLE="${ROOT}/scripts/project-checks.env.example"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "pre-commit-checks: no scripts/project-checks.env (see ${EXAMPLE}); skipping."
  exit 0
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

run_if_set() {
  local name="$1"
  local cmd="$2"
  if [[ -z "${cmd}" ]]; then
    echo "pre-commit-checks: ${name} not set; skip."
    return 0
  fi
  echo "pre-commit-checks: running ${name}: ${cmd}"
  (cd "${ROOT}" && eval "${cmd}")
}

run_if_set "PRECOMMIT_CMD" "${PRECOMMIT_CMD:-}"
run_if_set "TYPECHECK_CMD" "${TYPECHECK_CMD:-}"
run_if_set "LINT_CMD" "${LINT_CMD:-}"

echo "pre-commit-checks: done."
exit 0
