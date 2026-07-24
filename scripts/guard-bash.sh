#!/usr/bin/env bash
# guard-bash.sh — block dangerous shell commands before they run.
# Usage: guard-bash.sh "<command string>"
# Exit 0 = allow, non-zero = block.

set -euo pipefail

CMD="${1:-}"
if [[ -z "${CMD}" ]]; then
  # Cursor/Codex may pass JSON on stdin; try to extract a command field.
  if [[ ! -t 0 ]]; then
    INPUT="$(cat || true)"
    if [[ -n "${INPUT}" ]]; then
      CMD="$(printf '%s' "${INPUT}" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
      if [[ -z "${CMD}" ]]; then
        CMD="$(printf '%s' "${INPUT}" | sed -n 's/.*"cmd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
      fi
      # Unescape common JSON escapes
      CMD="${CMD//\\n/ }"
      CMD="${CMD//\\\"/\"}"
    fi
  fi
fi

if [[ -z "${CMD}" ]]; then
  echo "guard-bash: no command provided; allowing (nothing to check)."
  exit 0
fi

deny() {
  local reason="$1"
  echo "BLOCKED by scripts/guard-bash.sh: ${reason}"
  echo "Command: ${CMD}"
  echo "Next: rewrite the command without the forbidden pattern, or ask a human for an explicit exception process."
  exit 2
}

# Normalize for matching
LOWER="$(printf '%s' "${CMD}" | tr '[:upper:]' '[:lower:]')"

# rm -rf of filesystem roots or destructive broad deletes
if echo "${LOWER}" | grep -Eq '(^|[[:space:];|&])rm[[:space:]]+(-[a-z]*r[a-z]*f|-rf|-fr)([[:space:]]|$)'; then
  if echo "${LOWER}" | grep -Eq 'rm[[:space:]]+(-[a-z]*r[a-z]*f|-rf|-fr)[[:space:]]+(/|/\*|~(/|$)|\.\./|/users|/home|/var|/etc|/usr|/bin|/sbin)'; then
    deny "dangerous recursive delete targeting a broad path"
  fi
fi

# force push (allow --force-with-lease)
if echo "${LOWER}" | grep -Eq 'git[[:space:]]+push'; then
  if echo "${LOWER}" | grep -Eq -- '--force-with-lease'; then
    :
  elif echo "${LOWER}" | grep -Eq -- '--force([[:space:]]|$)|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+[A-Za-z0-9._/-]+:'; then
    deny "git force-push is blocked (use --force-with-lease only with human approval outside this guard)"
  fi
fi

# skip hooks
if echo "${LOWER}" | grep -Eq -- '--no-verify|--no-gpg-sign'; then
  deny "skipping git hooks / gpg (--no-verify / --no-gpg-sign) is blocked"
fi

# pipe to shell
if echo "${LOWER}" | grep -Eq '(curl|wget|fetch)[^|;]*\|[[:space:]]*(ba)?sh'; then
  deny "pipe-to-shell download pattern is blocked"
fi

# privilege escalation / world-writable
if echo "${LOWER}" | grep -Eq '(^|[[:space:];|&])sudo([[:space:]]|$)' || echo "${LOWER}" | grep -Eq 'chmod[[:space:]]+777'; then
  deny "sudo / chmod 777 is blocked"
fi

# never-touch writes / staging
NEVER_PATTERNS=('.env' '.env.local' '.env.production' '.env.development')
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTRA_FILE="${REPO_ROOT}/docs/ARCHITECTURE.md"
if [[ -f "${EXTRA_FILE}" ]]; then
  while IFS= read -r line; do
    [[ "${line}" =~ ^# ]] && continue
    [[ -z "${line// /}" ]] && continue
    if [[ "${line}" == NEVER_TOUCH_EXTRA* ]]; then
      continue
    fi
    # lines under NEVER_TOUCH_EXTRA section collected loosely: paths ending without spaces starting after comment block
  done < /dev/null
fi

# Simple never-touch: any git add / redirect write involving .env
if echo "${LOWER}" | grep -Eq 'git[[:space:]]+add[^;&|]*\.env($|[[:space:]]|\*)'; then
  deny "staging .env files is blocked"
fi
if echo "${CMD}" | grep -Eq '(^|[>&[:space:]])\.env([./][^[:space:]]*)?[[:space:]]*>|cat[[:space:]]*>[[:space:]]*\.env|>[[:space:]]*\.env'; then
  deny "writing .env files is blocked"
fi
if echo "${LOWER}" | grep -Eq '(^|[[:space:];|&])(rm|mv|cp|truncate)[[:space:]]+[^-][^;&|]*\.env'; then
  deny "mutating .env files is blocked"
fi

exit 0
