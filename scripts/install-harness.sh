#!/usr/bin/env bash
# install-harness.sh — copy/merge this harness into a target project
# Usage:
#   ./scripts/install-harness.sh [--dry-run] [--merge|--override] [TARGET_DIR]
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
MODE="merge"
DRY_RUN=0
TARGET=""

usage() {
  cat <<'EOF'
Usage: install-harness.sh [--dry-run] [--merge|--override] [TARGET_DIR]

  --merge      Default. Copy missing files; for AGENTS.md only merge
               <!-- team-orchestrator:start/end --> block.
  --override   Replace managed harness files (still backs up AGENTS.md).
  --dry-run    Print actions without writing.
  TARGET_DIR   Defaults to current directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --merge) MODE="merge"; shift ;;
    --override) MODE="override"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ -z "${TARGET}" ]]; then TARGET="$1"; shift; else echo "Unknown arg: $1"; usage; exit 1; fi
      ;;
  esac
done

TARGET="${TARGET:-.}"
mkdir -p "${TARGET}"
TARGET="$(cd "${TARGET}" && pwd)"

act() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "DRY: $*"
  else
    echo "DO:  $*"
  fi
}

copy_file() {
  local rel="$1"
  local src="${SRC}/${rel}"
  local dst="${TARGET}/${rel}"
  if [[ ! -f "${src}" ]]; then
    echo "skip missing source: ${rel}"
    return 0
  fi
  if [[ -f "${dst}" && "${MODE}" == "merge" ]]; then
    act "keep existing ${rel}"
    return 0
  fi
  act "copy ${rel}"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    mkdir -p "$(dirname "${dst}")"
    cp "${src}" "${dst}"
  fi
}

copy_dir_files() {
  local rel="$1"
  local src="${SRC}/${rel}"
  [[ -d "${src}" ]] || return 0
  while IFS= read -r -d '' f; do
    local r="${f#"${SRC}/"}"
    copy_file "${r}"
  done < <(find "${src}" -type f -print0)
}

merge_agents_block() {
  local src="${SRC}/AGENTS.md"
  local dst="${TARGET}/AGENTS.md"
  local start='<!-- team-orchestrator:start -->'
  local end='<!-- team-orchestrator:end -->'

  if [[ ! -f "${dst}" ]]; then
    act "copy AGENTS.md (new)"
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      cp "${src}" "${dst}"
    fi
    return 0
  fi

  if [[ "${MODE}" == "override" ]]; then
    act "backup+override AGENTS.md"
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      cp "${dst}" "${dst}.bak.$(date +%Y%m%d%H%M%S)"
      cp "${src}" "${dst}"
    fi
    return 0
  fi

  # merge: replace or append orchestrator block
  act "merge team-orchestrator block into AGENTS.md"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    return 0
  fi

  local bfile tfile
  bfile="$(mktemp)"
  tfile="$(mktemp)"
  awk -v s="${start}" -v e="${end}" '
    $0 ~ s {p=1}
    p {print}
    $0 ~ e {p=0}
  ' "${src}" > "${bfile}"

  if grep -q "${start}" "${dst}"; then
    awk -v s="${start}" -v e="${end}" -v bfile="${bfile}" '
      BEGIN {
        while ((getline line < bfile) > 0) { block = block line ORS }
        close(bfile)
      }
      $0 ~ s {
        printf "%s", block
        skip=1
        next
      }
      skip && $0 ~ e { skip=0; next }
      skip { next }
      { print }
    ' "${dst}" > "${tfile}"
    mv "${tfile}" "${dst}"
  else
    {
      printf '\n'
      cat "${bfile}"
    } >> "${dst}"
    rm -f "${tfile}"
  fi
  rm -f "${bfile}"
}

echo "install-harness: src=${SRC}"
echo "install-harness: target=${TARGET}"
echo "install-harness: mode=${MODE} dry_run=${DRY_RUN}"

# Core docs skeleton
copy_file "docs/README.md"
copy_file "docs/HARNESS.md"
copy_file "docs/WORKFLOW.md"
copy_file "docs/ARCHITECTURE.md"
copy_file "docs/templates/exec-plan.md"
copy_file "docs/team/STATUS.md"
copy_file "docs/team/SKILL_MATRIX.md"
copy_file "docs/product/.gitkeep"
copy_file "docs/design/.gitkeep"
copy_file "docs/plans/active/.gitkeep"
copy_file "docs/plans/completed/.gitkeep"
copy_file "docs/decisions/.gitkeep"

# Skills + agents
copy_dir_files ".agents/skills"
copy_dir_files ".codex/agents"
copy_file ".codex/config.toml"
copy_dir_files ".cursor/agents"
copy_file ".cursor/hooks.json"

# Scripts + hooks
copy_dir_files "scripts"
copy_file ".githooks/pre-commit"
copy_file ".githooks/pre-push"
copy_file ".env.example"
copy_file ".gitignore"
copy_file "README.md"

merge_agents_block

if [[ "${DRY_RUN}" -eq 0 ]]; then
  chmod +x "${TARGET}/scripts/"*.sh 2>/dev/null || true
  chmod +x "${TARGET}/.githooks/"* 2>/dev/null || true
  echo ""
  echo "Next:"
  echo "  1) cd ${TARGET} && git config core.hooksPath .githooks"
  echo "  2) cp scripts/project-checks.env.example scripts/project-checks.env  # fill commands"
  echo "  3) Codex: trust hooks via /hooks if prompted"
  echo "  4) ./scripts/doctor.sh"
  echo "  5) For brownfield mapping: ask agent to use \$onboard-repository"
  if [[ -x "${TARGET}/scripts/doctor.sh" ]]; then
    (cd "${TARGET}" && ./scripts/doctor.sh) || true
  fi
else
  echo "DRY-RUN complete (no files written)."
fi
