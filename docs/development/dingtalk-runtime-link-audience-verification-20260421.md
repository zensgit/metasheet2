# DingTalk Runtime Link Audience Verification

- Date: 2026-04-21
- Branch: `codex/dingtalk-runtime-link-audience-20260421`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
rg -n "表单访问|允许范围|describeDingTalkPublicFormRuntimeLines|allowedUserIds|allowedMemberGroupIds" packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests/unit/automation-v1.test.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-runtime-link-audience-*.md
git diff --check
```

## Expected Coverage

- Group robot messages include public-form access text for fully public links.
- Group robot messages include DingTalk-bound access text and no-allowlist audience text.
- Person work notifications include DingTalk-authorized access text and local allowlist counts.
- Existing save/runtime link validation tests still pass.
- Backend build verifies TypeScript integration.

## Results

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`: passed, 2 files and 131 tests.
- `pnpm --filter @metasheet/core-backend build`: passed.
- `rg -n "表单访问|允许范围|describeDingTalkPublicFormRuntimeLines|allowedUserIds|allowedMemberGroupIds" ...`: passed, expected runtime/test/doc references found.
- `git diff --check`: passed.

## Claude Code CLI

- Local CLI exists at `/Users/chouhua/.local/bin/claude`.
- Version checked: `2.1.116 (Claude Code)`.
- A read-only `claude -p` attempt was made with a strict `--max-budget-usd 0.05`; it exited before producing analysis because the budget was too low. No files were modified by Claude Code CLI.
