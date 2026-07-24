#!/usr/bin/env bash
# doctor.sh — sanity-check harness installation
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
FAIL=0

ok() { echo "OK  $*"; }
bad() { echo "FAIL $*"; FAIL=1; }

need_file() {
  local p="$1"
  if [[ -f "$p" ]]; then ok "file ${p}"; else bad "missing file ${p}"; fi
}

need_exec() {
  local p="$1"
  if [[ -x "$p" ]]; then ok "exec ${p}"; else bad "not executable ${p}"; fi
}

need_dir() {
  local p="$1"
  if [[ -d "$p" ]]; then ok "dir ${p}"; else bad "missing dir ${p}"; fi
}

echo "doctor: checking harness at ${ROOT}"

need_file "AGENTS.md"
need_file "docs/README.md"
need_file "docs/HARNESS.md"
need_file "docs/WORKFLOW.md"
need_file "docs/ARCHITECTURE.md"
need_file "docs/team/STATUS.md"
need_file "docs/team/SKILL_MATRIX.md"
need_file "docs/templates/exec-plan.md"

for s in team-orchestrator product-management ui-design frontend-engineering backend-engineering quality-engineering onboard-repository audit-onboarding-proposal; do
  need_dir ".agents/skills/${s}"
  need_file ".agents/skills/${s}/SKILL.md"
done

need_file ".cursor/hooks.json"
need_file ".codex/config.toml"
need_file ".githooks/pre-commit"
need_file ".githooks/pre-push"
need_file ".env.example"
need_file ".gitignore"
need_file "README.md"

for s in guard-bash pre-commit-checks check-boundaries verify session-context doctor install-harness cursor-before-shell; do
  need_file "scripts/${s}.sh"
  need_exec "scripts/${s}.sh"
done

need_exec ".githooks/pre-commit"
need_exec ".githooks/pre-push"

# skill name consistency: no stock-learn leftovers in skills/agents/docs (exclude this script)
if command -v rg >/dev/null 2>&1; then
  HITS="$(rg -n 'stock-learn|Stock Learn' . \
    --glob '!.git/**' \
    --glob '!docs/superpowers/**' \
    --glob '!scripts/doctor.sh' \
    --glob '!scripts/install-harness.sh' \
    2>/dev/null || true)"
  if [[ -n "${HITS}" ]]; then
    bad "found stock-learn leftovers"
    printf '%s\n' "${HITS}"
  else
    ok "no stock-learn leftovers in active tree"
  fi
fi

# AGENTS.md marker
if grep -q 'team-orchestrator:start' AGENTS.md && grep -q 'team-orchestrator:end' AGENTS.md; then
  ok "AGENTS.md team-orchestrator markers"
else
  bad "AGENTS.md missing team-orchestrator markers"
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "doctor: FAILED"
  echo "Next: restore missing files from the harness template and chmod +x scripts/*.sh"
  exit 1
fi

echo "doctor: PASS"
exit 0
