#!/usr/bin/env bash
# cursor-before-shell.sh — Cursor beforeShellExecution adapter
# Reads JSON from stdin, gates via guard-bash.sh, prints Cursor permission JSON.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT="$(cat || true)"
CMD=""

if command -v python3 >/dev/null 2>&1; then
  CMD="$(printf '%s' "${INPUT}" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get("command") or "")
except Exception:
  print("")
' 2>/dev/null || true)"
else
  CMD="$(printf '%s' "${INPUT}" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

if [[ -z "${CMD}" ]]; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

if OUT="$("${ROOT}/scripts/guard-bash.sh" "${CMD}" 2>&1)"; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
else
  # Escape for JSON
  MSG="$(printf '%s' "${OUT}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"blocked"')"
  printf '{"permission":"deny","userMessage":%s,"agentMessage":%s}\n' "${MSG}" "${MSG}"
  exit 0
fi
