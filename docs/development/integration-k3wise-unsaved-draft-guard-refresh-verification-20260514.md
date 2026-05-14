# K3 WISE Unsaved Draft Test Guard Refresh Verification - 2026-05-14

## Worktree

`/private/tmp/ms2-k3wise-unsaved-draft-guard-refresh-20260514`

Branch:

`codex/k3wise-unsaved-draft-guard-refresh-20260514`

Baseline:

`origin/main` at `32b12d815`.

## Validation Plan

```bash
node --test plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
pnpm --filter @metasheet/web type-check
git diff --check origin/main..HEAD
```

## Coverage

- WebAPI saved/draft fingerprints match immediately after loading a saved system.
- Pipeline-only edits do not block connection testing.
- WebAPI transport edits and credential replacement drafts, including authority-code
  replacement, block testing.
- SQL Server saved/draft fingerprints match immediately after loading a saved system.
- SQL channel edits and credential replacement drafts block testing.
- Loading/saving clears credential replacement fields.
- Missing selected saved systems are treated as stale.
- The saved-system-only backend route ignores request-body draft config and credentials.

## Results

Executed locally on 2026-05-14:

```bash
node --test plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result: pass.

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
tests 1, pass 1
```

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/k3WiseSetup.spec.ts
```

Result: pass.

```text
tests/k3WiseSetup.spec.ts: 34 passed
Test Files 1 passed
```

```bash
pnpm --filter @metasheet/web type-check
```

Result: pass.

```bash
git diff --check origin/main..HEAD
```

Result: pass.

Note: the temporary worktree initially had no `node_modules`, so a local
`pnpm install --frozen-lockfile` was required before running frontend gates.
Generated dependency link noise under `plugins/*/node_modules` and
`tools/cli/node_modules` was removed before committing.

## Not Covered

- Real K3 WISE connectivity.
- Real SQL Server connectivity.
- A future unsaved-draft connection-test endpoint.
