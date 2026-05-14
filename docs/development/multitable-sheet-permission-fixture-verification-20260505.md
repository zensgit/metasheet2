# Multitable Sheet Permission Fixture Refresh Verification

Date: 2026-05-05
Branch: `codex/multitable-permission-fixture-20260505`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts --reporter=dot
```

## Results

Targeted backend integration suite:

```text
Test Files  1 passed (1)
Tests       39 passed (39)
```

The suite initially exposed missing fixture handlers for the current runtime SQL
surface. After the fixture refresh, the same command passed without changing
runtime code or loosening assertions.

## Cleanup

`pnpm install --frozen-lockfile` updated local workspace symlinks under several
plugin/tool `node_modules` directories in the temporary worktree. Those were
restored before staging so the PR contains only the fixture refresh and these
development notes.

## Risk

Low. The patch is test-only and preserves existing assertions for:

- Sheet-scoped capabilities.
- Row-level actions.
- Write-own create, form submit, patch, direct patch, and delete behavior.
- Permission candidate filtering.
- Form-share DingTalk binding/grant status.

Remaining CI expectation: normal repository checks should pass because no
production code or generated contract artifacts changed.

## Current-Main Refresh - 2026-05-14

After rebasing the PR diff onto `origin/main@b128936c`, the targeted integration
suite exposed one additional fixture gap from the later AutoNumber rollout:

```text
Unhandled SQL in test: SELECT pg_advisory_xact_lock(hashtext($1))
```

The fixture now treats the advisory lock as a no-op acknowledgement in the mock
pool. This preserves production behavior and keeps the patch test-only.

Commands rerun after the refresh:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts --reporter=dot
git diff --check origin/main..HEAD
```

Current-main rerun result:

```text
Test Files  1 passed (1)
Tests       39 passed (39)
```
