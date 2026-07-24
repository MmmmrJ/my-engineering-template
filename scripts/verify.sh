#!/usr/bin/env bash
# verify.sh — completion gate before claiming done
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/scripts/project-checks.env"

echo "verify: running boundary checks..."
"${ROOT}/scripts/check-boundaries.sh"

echo "verify: running pre-commit checks..."
"${ROOT}/scripts/pre-commit-checks.sh"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  if [[ -n "${TEST_CMD:-}" ]]; then
    echo "verify: running TEST_CMD: ${TEST_CMD}"
    (cd "${ROOT}" && eval "${TEST_CMD}")
  else
    echo "verify: TEST_CMD not set; skip tests."
  fi
else
  echo "verify: no project-checks.env; skip tests."
fi

echo "verify: PASS"
exit 0
