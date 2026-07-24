#!/usr/bin/env bash
# check-boundaries.sh — optional forbidden-import checks from docs/ARCHITECTURE.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${ROOT}/docs/ARCHITECTURE.md"

if [[ ! -f "${ARCH}" ]]; then
  echo "check-boundaries: docs/ARCHITECTURE.md missing; skip."
  exit 0
fi

RULES="$(awk '
  /^```text$/ { inblock=1; next }
  /^```$/ { inblock=0; next }
  inblock && /must-not-import/ { print }
' "${ARCH}")"

if [[ -z "${RULES}" ]]; then
  echo "check-boundaries: no must-not-import rules configured; skip (fill docs/ARCHITECTURE.md)."
  exit 0
fi

FAIL=0
while IFS= read -r rule; do
  [[ -z "${rule}" || "${rule}" =~ ^# ]] && continue
  from="$(echo "${rule}" | awk '{print $1}')"
  to="$(echo "${rule}" | awk '{print $3}')"
  if [[ -z "${from}" || -z "${to}" ]]; then
    continue
  fi
  # Best-effort: search for the to-pattern under matched from paths via rg if available
  if command -v rg >/dev/null 2>&1; then
    if rg -n --glob "${from}" "${to}" "${ROOT}" >/dev/null 2>&1; then
      echo "BOUNDARY VIOLATION: ${rule}"
      rg -n --glob "${from}" "${to}" "${ROOT}" || true
      FAIL=1
    fi
  else
    echo "check-boundaries: ripgrep (rg) not found; cannot enforce: ${rule}"
  fi
done <<< "${RULES}"

if [[ "${FAIL}" -ne 0 ]]; then
  echo "Next: fix imports to respect docs/ARCHITECTURE.md dependency direction."
  exit 1
fi

echo "check-boundaries: ok."
exit 0
