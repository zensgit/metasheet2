# DingTalk P4 Smoke Evidence Runner Verification - 2026-04-22

## Branch

- `codex/dingtalk-p4-smoke-evidence-runner-20260422`
- Base branch: `codex/dingtalk-docs-smoke-runbook-20260422`

## Verification Commands

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
```

Result: passed.

```bash
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
```

Result: passed. 4 tests passed.

```bash
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

Result: passed. 4 tests passed.

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false
```

Result: passed. 1 file passed, 19 tests passed.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts tests/multitable-form-share-manager.spec.ts tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed. 3 files passed, 110 tests passed.

```bash
rg -n "compile-dingtalk-p4-smoke-evidence|P4 remote-smoke evidence compiler|Unknown allowed member groups|Remote smoke: create a table and form view" docs/dingtalk-remote-smoke-checklist-20260422.md docs/development/dingtalk-feature-plan-and-todo-20260422.md docs/development/dingtalk-p4-smoke-evidence-runner-development-20260422.md scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs scripts/ops/export-dingtalk-staging-evidence-packet.mjs packages/core-backend/tests/integration/public-form-flow.test.ts
```

Result: passed.

```bash
git diff --check -- scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs docs/dingtalk-remote-smoke-checklist-20260422.md docs/development/dingtalk-feature-plan-and-todo-20260422.md docs/development/dingtalk-p4-smoke-evidence-runner-development-20260422.md docs/development/dingtalk-p4-smoke-evidence-runner-verification-20260422.md packages/core-backend/tests/integration/public-form-flow.test.ts
```

Result: passed.

## Notes

- Actual P4 remote smoke execution remains pending and is intentionally left unchecked in the TODO.
- The repository still has unrelated dirty `node_modules` files under plugins/tools. They are not part of this slice.
