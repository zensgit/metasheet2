# DingTalk Person Dynamic Recipients Verification

Date: 2026-04-20
Branch: `codex/dingtalk-person-dynamic-recipients-20260420`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Backend unit tests: `99 passed`
- Frontend tests: `40 passed`
- Backend build: passed
- Frontend build: passed
- `git diff --check`: passed

## Coverage Focus

- `send_dingtalk_person_message` succeeds with dynamic recipients from `record.assigneeUserIds`
- `send_dingtalk_person_message` fails clearly when a configured path resolves no recipients
- inline automation manager can save a person-message rule with only `userIdFieldPath`
- rule editor can save the same payload shape
- edit flows map `userIdFieldPath` back into the authoring form

## Notes

- Frontend Vitest may still print the existing `WebSocket server error: Port is already in use` warning in this repository; it did not block the test run.
- Web build still shows the existing Vite chunk-size warning; no new build regressions were introduced by this slice.
