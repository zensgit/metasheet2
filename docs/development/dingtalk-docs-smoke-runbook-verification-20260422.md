# DingTalk Docs Smoke Runbook Verification - 2026-04-22

## Branch

- `codex/dingtalk-docs-smoke-runbook-20260422`
- Base branch: `codex/dingtalk-person-delivery-skip-reasons-20260422`

## Verification Commands

```bash
rg -n "A0. Configure DingTalk directory accounts|Person delivery status meanings|Troubleshooting matrix|Manual admission from the synced account list|DingTalk User Workflow Guide|DingTalk Remote Smoke Checklist|Remote smoke checklist|DingTalk Admin Operations Guide|export-dingtalk-staging-evidence-packet" docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/dingtalk-synced-account-local-user-guide-20260420.md docs/dingtalk-user-workflow-guide-20260422.md docs/dingtalk-remote-smoke-checklist-20260422.md docs/development/dingtalk-feature-plan-and-todo-20260422.md scripts/ops/export-dingtalk-staging-evidence-packet.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result: passed. Matched the admin guide, synced-account guide, user workflow guide, remote smoke checklist, TODO file, and evidence packet script/test.

```bash
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result: passed. 4 tests passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-person-delivery-service.test.ts tests/unit/directory-sync-bind-account.test.ts --watch=false
```

Result: passed. 2 files passed, 10 tests passed.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-form-share-manager.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed. 3 files passed, 110 tests passed.

```bash
git diff --check -- docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/dingtalk-synced-account-local-user-guide-20260420.md docs/dingtalk-user-workflow-guide-20260422.md docs/dingtalk-remote-smoke-checklist-20260422.md docs/development/dingtalk-feature-plan-and-todo-20260422.md docs/development/dingtalk-docs-smoke-runbook-development-20260422.md docs/development/dingtalk-docs-smoke-runbook-verification-20260422.md scripts/ops/export-dingtalk-staging-evidence-packet.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result: passed.

## Covered Documentation Paths

- Admin guide covers DingTalk directory setup, no-email local user creation, group robots, delivery status, and troubleshooting.
- User guide covers table group binding, group/person automation, form access levels, allowlists, and end-user outcomes.
- Remote smoke checklist covers table/form creation, two group bindings, `dingtalk_granted`, authorized submit, unauthorized denial, delivery history, and no-email admission.
- Evidence packet exporter now includes the P4 user workflow guide, synced-account guide, remote smoke checklist, and current DingTalk TODO.
- Feature TODO marks completed P3 work and P4 documentation tasks while leaving actual remote smoke execution pending.

## Non-Blocking Observations

- The repository still has unrelated dirty `node_modules` files under plugins/tools. They are not part of this slice.
