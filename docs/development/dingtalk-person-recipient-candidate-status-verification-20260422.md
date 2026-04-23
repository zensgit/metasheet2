# DingTalk Person Recipient Candidate Status Verification - 2026-04-22

## Result

Passed local verification for the scoped frontend tests, frontend build, and diff hygiene.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-rule-editor.spec.ts --watch=false
```

Result: passed, 1 test file, 60 tests.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-automation-manager.spec.ts --watch=false
```

Result: passed, 1 test file, 71 tests.

```bash
pnpm --filter @metasheet/web build
```

Result: passed.

```bash
git diff --check
```

Result: passed.

## Observations

- Frontend Vitest printed `WebSocket server error: Port is already in use` during the manager test run; the test file still passed.
- Frontend build printed existing Vite warnings about a large chunk and `WorkflowDesigner.vue` being both dynamically and statically imported; build completed successfully.

## Coverage Added

- Advanced rule editor disables inactive user candidates in DingTalk person recipient search.
- Inline automation form disables inactive user candidates in DingTalk person recipient search.
- Both editors display candidate type and access level.
- Both editors hide unsupported role candidates from DingTalk person recipient search.
- Both editors still allow member-group candidates to populate `memberGroupIds`.
