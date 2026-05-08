# Multitable RC Public Form Smoke · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-public-form-smoke-development-20260507.md`

## Spec parses (Playwright list)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-public-form-smoke.spec.ts
```

Result:

```
Listing tests:
  multitable-public-form-smoke.spec.ts:105:7 › Multitable public form smoke › admin enables public form, anonymous submits, record persists
  multitable-public-form-smoke.spec.ts:136:7 › Multitable public form smoke › rejects anonymous submit when public form is disabled (regression guard)
  multitable-public-form-smoke.spec.ts:147:7 › Multitable public form smoke › rejects anonymous submit with stale token after regenerate (regression guard)
Total: 3 tests in 1 file
```

## TypeScript check (core-backend)

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed (no output / exit 0).

## Diff hygiene

```bash
git diff --check
```

Result: passed.

## Scoped diff

```
packages/core-backend/tests/e2e/multitable-public-form-smoke.spec.ts | +165 (new)
packages/core-backend/tests/e2e/README.md                            | +1 / -1
docs/development/multitable-rc-public-form-smoke-development-20260507.md | new
docs/development/multitable-rc-public-form-smoke-verification-20260507.md | new
```

`pnpm install --frozen-lockfile` in the fresh worktree caused incidental symlink rewrites under `plugins/*/node_modules/*` and `tools/cli/node_modules/*`; these are install artifacts and are NOT staged.

## Server reachability check parity

The spec checks **both** backend (`:7778`) and frontend (`:8899`) reachability in `beforeAll`, matching the pattern Codex added to `multitable-lifecycle-smoke.spec.ts` post-#1415-review (commit `8cccfc218`). Skipping when either is unreachable matches the dev MD's contract (no silent partial-skip).

## Live execution (deferred)

The spec was NOT executed end-to-end against a running stack in this PR's verification window. Same justification as `multitable-rc-lifecycle-smoke-verification-20260507.md`: no Yuantus-free dev-stack runner is provisioned in this worktree. The spec is structurally identical to the merged lifecycle spec and uses the same skip-when-unavailable contract.

To run end-to-end locally:

```bash
# Terminal 1: backend (no Yuantus needed for public form smoke)
cd packages/core-backend && npx tsx src/index.ts

# Terminal 2: frontend
cd apps/web && npx vite --host 127.0.0.1 --port 8899

# Terminal 3: browser binaries (one-time)
npx playwright install chromium

# Terminal 4: run
cd packages/core-backend
npx playwright test --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-public-form-smoke.spec.ts
```

Expected: 3 tests pass; total ~5–8s end-to-end (no browser navigation in this spec — pure HTTP).

## Pre-deployment checks

- [x] PR #1406 + #1412 + #1415 already merged on main; this branch is rebased onto `4d648f345`.
- [x] No DingTalk / public-form runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber / Gantt / Hierarchy code modified.
- [x] No migration / OpenAPI / schema change.

## Result

Spec parses, types clean, diff hygiene clean. Ready to merge as the second of six RC-smoke conversions; remaining four (`formula editor`, `Gantt rendering`, `Hierarchy rendering`, `automation send_email`) can fork this spec's pattern in subsequent PRs.

If three more smoke specs land sharing the `setupSheetWithStringField` and auth helper boilerplate, the recommended follow-up is to extract those into `packages/core-backend/tests/e2e/multitable-helpers.ts` to avoid drift across files.
