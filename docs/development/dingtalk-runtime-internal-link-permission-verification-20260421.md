# DingTalk Runtime Internal Link Permission Verification

- Date: 2026-04-21
- Branch: `codex/dingtalk-runtime-internal-link-permission-20260421`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
rg -n "处理权限|describeDingTalkInternalViewRuntimeLines" packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests/unit/automation-v1.test.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-runtime-internal-link-permission-*.md
git diff --check
```

## Expected Coverage

- Group robot messages include the internal processing link permission text.
- Person work notifications include the same internal processing link permission text.
- Existing public-form runtime access/audience text remains covered in the same automation suite.
- Backend build verifies TypeScript integration.

## Results

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false`: passed, 1 file and 119 tests.
- `pnpm --filter @metasheet/core-backend build`: passed.
- `rg -n "处理权限|describeDingTalkInternalViewRuntimeLines" ...`: passed, expected runtime/test/doc references found.
- `git diff --check`: passed.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.116 (Claude Code)`
- Claude Code CLI was not allowed to edit files in this slice; implementation was done locally to keep the diff controlled.

## Rebase Verification - 2026-04-22

Rebased `codex/dingtalk-runtime-internal-link-permission-20260421` onto
`origin/main@88c5c91cb` after PR #1033 was squash-merged.

```bash
git rebase --onto origin/main origin/codex/dingtalk-runtime-internal-link-permission-base-20260421 HEAD
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
rg -n "处理权限|describeDingTalkInternalViewRuntimeLines" packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests/unit/automation-v1.test.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-runtime-internal-link-permission-*.md
git diff --check
pnpm --filter @metasheet/core-backend build
git checkout -- plugins/ tools/
```

Results:

- Rebase completed cleanly; replayed only the internal-link permission hint commit on top of main.
- `tests/unit/automation-v1.test.ts`: passed, 119 tests.
- `rg` runtime/test/doc check: passed.
- `git diff --check`: passed.
- `pnpm --filter @metasheet/core-backend build`: passed.
- PNPM install recreated tracked plugin/tool `node_modules` symlink noise; it was cleaned with `git checkout -- plugins/ tools/` before pushing.
