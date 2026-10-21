# Managed CI exact-count reconciliation — 2026-10-21

Source: `ae6efd908848e60e836adea6524af20f09789297`; this verification document is a separate closeout commit. Product/image source remains `ed7b2945542346f52a1fc25b265b3f064b657aba`.

## Failure and minimal change

[Draft #6472](https://github.com/zensgit/metasheet2/pull/6472) at `bf1e708020fab48a8d2dbf4645c9942d4603fc17` ran the managed backend cohort successfully: 194 passed, no failed/pending/todo cases, success true. Its [consumer job](https://github.com/zensgit/metasheet2/actions/runs/39567543417/job/119113363234) then rejected the report because the workflow still required exactly 175. The unchanged report checker reported only `passed` and `total` mismatches.

Grok4.7(xhigh) repaired two numbers in the existing workflow; Codex independently inspected the diff and checked the actual report. The backend expectation is now 194. The five-file Discussion-frame cohort gained six Visual-view cases and actually passes 61; its old expectation 55 is now 61. The unchanged PostgreSQL 52-case and other web 198-case cohorts remain unchanged. No test, product source, report checker, failure/skip rule, capacity threshold or timeout changed.

## Validation

Run the affected web cohort from `apps/web` using Node20.20.2 and existing dependencies:

```sh
node node_modules/vitest/vitest.mjs run --no-cache --watch=false \
  tests/plm-managed-discussion.spec.ts tests/plm-managed-discussion-view.spec.ts \
  tests/plm-embed-discussion-panel.spec.ts tests/plm-embed-read-token.spec.ts \
  tests/plm-embed-write-token.spec.ts --reporter=json \
  --outputFile=/tmp/plm6472-count-frame.json
```

Actual individual assertions: 61 passed, zero skipped/failed. Per-file counts were 5, 13, 10, 17 and 16 respectively. Codex checked the file set and individual statuses, then independently ran the unchanged checker from the repository root:

```sh
node scripts/verification/plm-managed-companion-ci/assert-report.mjs /tmp/plm6472-count-frame.json 55
# Expected rejection: exit 1, passed/total mismatch.
node scripts/verification/plm-managed-companion-ci/assert-report.mjs /tmp/plm6472-count-frame.json 61
# Accepted: exit 0.
actionlint .github/workflows/plm-managed-companion-consumer.yml
git diff --check
```

Actionlint and diff checks passed. The already-passing 194-case backend execution was not redundantly rerun locally. A Grok shell pipeline used stdin for both a pipe and a heredoc during diff inspection; its inspection command failed, then the final two-line diff and lock removal were checked independently. That did not invalidate the actual test report or change source outside the workflow. The Grok session is closed and its exclusive lock released.

Private evidence manifest SHA256: `3e83b200dedeae1f93bc78e8c51e7658a61374f1327064d4ac173b42ac0af79c`. The raw CI failure, actual web report and root verification receipt are retained.

## Remaining boundaries

Preserve active current-head jobs and push only after they terminate. Exact final-head CI remains required; local verification is not CI success. The independent Discussion/PostgreSQL job still cannot check out the private Native repository without the dedicated `PLM_NATIVE_READ_TOKEN`; that previously reported requirement has no shared-token fallback. Both PRs remain Draft; no merge, deployment, production enablement or business notification. The full master goal remains incomplete.
