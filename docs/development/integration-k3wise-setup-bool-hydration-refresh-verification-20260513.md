# K3 WISE Setup Boolean Hydration Refresh Verification - 2026-05-13

## Scope

Refresh of PR #1344 on top of current `main` to normalize saved K3 WISE
`autoSubmit` and `autoAudit` values when hydrating the setup form.

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check origin/main..HEAD
```

## Expected Coverage

- saved literal booleans hydrate correctly
- saved numeric `1` and `0` hydrate correctly
- saved English string variants hydrate correctly
- saved Chinese string variants hydrate correctly
- unknown values hydrate to unchecked, even when the previous form value was
  checked

## Local Results

### Targeted Vitest

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
```

Result: passed.

- Test Files: 1 passed
- Tests: 31 passed

### Frontend Type Check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: passed.

### Whitespace Check

```bash
git diff --cached --check
```

Result: passed, no whitespace errors.

## Notes

This verification is local and frontend-only. It does not call a live K3 WISE
instance.

The temporary worktree initially had no local dependency symlinks, so the first
Vitest and `vue-tsc` attempts could not resolve `vitest` and `vue-tsc`. Running
`pnpm install --frozen-lockfile --offline` created local links from the existing
store. The resulting generated `plugins/` and `tools/` symlink changes were
reverted before commit.
