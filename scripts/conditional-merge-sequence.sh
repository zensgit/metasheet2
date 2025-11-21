#!/usr/bin/env bash
set -euo pipefail

# Sprint 2 Conditional Merge Orchestrator
# 用于 >48h 无 staging 凭证时执行“局部验证合并”并打标签、更新 PR。
# 不执行任何敏感操作；需要 gh CLI 已登录，且本地验证已 PASS。

PR_NUMBER=${1:-}
if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: $0 <PR_NUMBER>" >&2; exit 2
fi

branch=$(git branch --show-current)
if [[ "$branch" != "feature/sprint2-snapshot-protection" ]]; then
  echo "❌ Must run on feature/sprint2-snapshot-protection (current: $branch)" >&2; exit 2
fi

echo "[conditional-merge] Secret scan..."
if ! bash scripts/secret-scan.sh >/tmp/cond_merge_secret_scan 2>&1; then
  cat /tmp/cond_merge_secret_scan >&2
  echo "❌ Secret scan failed; aborting conditional merge." >&2
  exit 3
fi
cat /tmp/cond_merge_secret_scan > docs/sprint2/secret-scan-conditional-merge.md

echo "[conditional-merge] Ensuring PR draft body refreshed..."
if command -v pnpm >/dev/null 2>&1; then
  pnpm run staging:pr-body || true
fi

echo "[conditional-merge] Adding labels..."
gh pr edit "$PR_NUMBER" --add-label local-validation-only || true
gh pr edit "$PR_NUMBER" --add-label needs-staging-validation || true

echo "[conditional-merge] Commenting rationale..."
gh pr comment "$PR_NUMBER" --body "⚠️ Conditional merge sequence initiated (>48h without staging credentials). Local validation PASS; staging validation will run post-merge when BASE_URL + JWT arrive." || true

echo "[conditional-merge] Marking PR ready (if still draft)..."
gh pr ready "$PR_NUMBER" || true

echo "[conditional-merge] Done. Review labels & body before merging.";

