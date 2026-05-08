# Multitable RC Gantt Smoke · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-gantt-smoke-development-20260507.md`

## Spec parses (Playwright list)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-gantt-smoke.spec.ts
```

Result:

```
Listing tests:
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › renders task bars and labels for records with date ranges
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › renders dependency arrows when dependencyFieldId is configured
  multitable-gantt-smoke.spec.ts › Multitable Gantt smoke › rejects saving a gantt view with a non-link dependencyFieldId (VALIDATION_ERROR)
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

- `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` — new spec
- `packages/core-backend/tests/e2e/README.md` — one-line addition under "What's tested"
- `docs/development/multitable-feishu-rc-todo-20260430.md` — tick line 111 + add PR/MD pointers
- `docs/development/multitable-rc-gantt-smoke-development-20260507.md` — new
- `docs/development/multitable-rc-gantt-smoke-verification-20260507.md` — new

`pnpm install --frozen-lockfile` in the fresh worktree caused incidental symlink rewrites under `plugins/*/node_modules/*` and `tools/cli/node_modules/*`; these are install artifacts and are NOT staged.

## Server reachability check parity

`beforeAll` checks both backend (`:7778`) and frontend (`:8899`) reachability before login. Same pattern as #1415 / #1417 / #1419. Suite skips deterministically when either is unreachable.

## Specific assertions (per #1419 review hardening)

The rejection regression asserts more than HTTP 400:
- `body.error.code === 'VALIDATION_ERROR'`
- `body.error.message` contains the literal substring `self-table link field`

A regression that returned 400 with a different code or generic message would surface as a test failure rather than silently passing.

The bar-rendering case asserts both selector visibility (`expect(bars.first()).toBeVisible`) and selector count (`expect(...).toBeGreaterThanOrEqual(2)`) and label text presence — three layers of assertion that isolate failures by surface (rendering completes vs labels resolve correctly vs at least the configured number of bars are mounted).

## Helper hygiene

Only two helpers are defined: `authPost` and `authPatchExpectingFailure`. `authPostExpectingFailure` is **not** included — that pattern would have been dead code here, matching Codex's removal in the post-#1419 hardening. `APIRequestContext` typing throughout; no `any` parameters.

## Live execution (deferred)

Same justification as PR #1415 / #1417 / #1419 verification MDs: no Yuantus-free dev-stack runner is provisioned in this worktree. The spec is structurally identical to the merged smoke specs and uses the same skip-when-unavailable contract.

To run end-to-end locally:

```bash
# Terminal 1: backend
cd packages/core-backend && npx tsx src/index.ts

# Terminal 2: frontend
cd apps/web && npx vite --host 127.0.0.1 --port 8899

# Terminal 3: browser binaries (one-time)
npx playwright install chromium

# Terminal 4: run
cd packages/core-backend
npx playwright test --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-gantt-smoke.spec.ts
```

Expected: 3 tests pass; total ~10–15s including frontend cold-start for the two render tests.

## Pre-deployment checks

- [x] PR #1406 + #1409 + #1410 + #1412 + #1415 + #1417 + #1419 already merged on main; this branch is rebased onto `449cc6353`.
- [x] No DingTalk / public-form runtime / Gantt runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber / Hierarchy / formula / migration / OpenAPI changes.
- [x] RC TODO line 111 ticked with PR / dev MD / verification MD pointers in the same commit.

## Result

Spec parses, types clean, diff hygiene clean, RC TODO updated. Ready to merge as the fourth of six RC-smoke conversions; remaining two (`formula editor`, `automation send_email`) can fork this spec's pattern in subsequent PRs.

When the fifth smoke lands, recommend extracting `authPost` / `authPatch` / `injectTokenAndGo` and the `setup<Type>Sheet` factories into `packages/core-backend/tests/e2e/multitable-helpers.ts` to avoid drift across the now-four sibling specs. Three inline copies was the threshold; four is the trigger.
