#!/usr/bin/env bash
# session-context.sh — re-inject durable pointers after session start / compaction
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo "=== harness session context ==="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "branch: $(git branch --show-current 2>/dev/null || echo unknown)"
  echo "head: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
else
  echo "branch: (not a git repo)"
fi

echo "status file: docs/team/STATUS.md"
if [[ -f docs/team/STATUS.md ]]; then
  # print current demand line if present
  awk '/^## 当前需求$/,/^## / { if ($0 !~ /^## / || $0 ~ /^## 当前需求/) print }' docs/team/STATUS.md | head -n 20
fi

echo "active plans:"
if compgen -G "docs/plans/active/*.md" >/dev/null; then
  ls -1 docs/plans/active/*.md
else
  echo "  (none)"
fi

echo "read next: docs/README.md → docs/WORKFLOW.md"
echo "=== end session context ==="
