# Multitable Post-Commit Hooks Verification - 2026-04-24

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-write-service.test.ts \
  tests/unit/record-service.test.ts \
  tests/unit/yjs-rest-invalidation.test.ts \
  --reporter=dot
```

Result: passed.

- Test files: 3 passed.
- Tests: 48 passed.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: passed.

## Integration Check

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/integration/multitable-record-patch.api.test.ts \
  --reporter=dot
```

Result: passed.

- Test files: 1 passed.
- Tests: 6 passed.

## Coverage Notes

The unit coverage verifies:

- REST/default writes call the Yjs invalidation hook.
- `source === 'yjs-bridge'` skips invalidation.
- Hook replacement after construction works.
- Hook failures do not fail the write.
- Later hooks still run when an earlier hook throws.
- `RecordWriteService` runs hooks immediately after the DB transaction, before
  post-transaction recompute helpers.
- Hooks still run when later recompute helpers fail after the transaction has
  already committed.
- Route wiring still installs a post-commit Yjs invalidation hook.

## Risk Assessment

Risk is low. This is a seam refactor, not a write semantics change. The compatibility shim keeps old callers working, while app boot and route construction have moved to the new hook API.

## Rebase Verification - 2026-04-26

PR #1137 was rebased onto `origin/main` after the integration-core and K3 WISE
preflight work landed. The rebase completed without conflicts.

Commands run after the rebase:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/record-write-service.test.ts \
  tests/unit/record-service.test.ts \
  tests/unit/yjs-rest-invalidation.test.ts \
  tests/integration/multitable-record-patch.api.test.ts \
  --reporter=dot
```

Result: passed.

- Test files: 4 passed.
- Tests: 54 passed.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: passed.
