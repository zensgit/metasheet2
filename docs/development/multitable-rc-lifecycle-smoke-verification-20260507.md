# Multitable RC Lifecycle Smoke · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-lifecycle-smoke-development-20260507.md`

## Spec parses (Playwright list)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-lifecycle-smoke.spec.ts
```

Result:

```
Listing tests:
  multitable-lifecycle-smoke.spec.ts:79:7 › Multitable lifecycle smoke › creates base, sheet, field, view, record and renders in workbench
  multitable-lifecycle-smoke.spec.ts:137:7 › Multitable lifecycle smoke › rejects client-supplied autoNumber values during record create (regression guard)
Total: 2 tests in 1 file
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
packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts | new
packages/core-backend/tests/e2e/README.md                          | +1 / -0
docs/development/multitable-feishu-rc-todo-20260430.md              | lifecycle smoke marked complete
docs/development/multitable-rc-lifecycle-smoke-development-20260507.md | new
docs/development/multitable-rc-lifecycle-smoke-verification-20260507.md | new
```

`pnpm install --frozen-lockfile` in the fresh worktree caused incidental symlink rewrites under `plugins/*/node_modules/*` and `tools/cli/node_modules/*`; these are install artifacts and are NOT staged.

## Live execution (deferred)

The spec was NOT executed end-to-end against a running stack in this PR's verification window because the worktree does not currently host a Yuantus-free multitable dev stack. The spec is structurally identical to `handoff-journey.spec.ts` (which IS exercised against the local stack manually) and its server-availability `beforeAll` health check yields the same `test.skip` behavior when servers are absent.

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
  tests/e2e/multitable-lifecycle-smoke.spec.ts
```

Expected: 2 tests pass; lifecycle test takes ~10–15s including frontend cold-start.

## CI considerations

The default GitHub Actions matrix does not currently start a multitable dev stack for the e2e directory; the suite skip-passes. Promoting this smoke to a hard gate requires a CI step that provisions the backend + frontend, which is tracked as a follow-up rather than a Lane PW-1 deliverable.

## Pre-deployment checks

- [x] PR #1406 autoNumber hardening + PR #1412 self-table dependency tightening already merged on main; this branch is rebased onto `d291bc4d1`.
- [x] Reviewer hardening: frontend availability is now checked before the suite runs, matching the documented skip contract.
- [x] Reviewer hardening: autoNumber raw-write now asserts exact `403 FIELD_READONLY` response instead of any generic `4xx`.
- [x] No DingTalk / public-form / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber-related code modified (the regression guard hits already-shipped behavior).
- [x] No migration / OpenAPI / schema change.

## Result

Spec parses, types clean, diff hygiene clean. The master RC TODO now points at this PR and preserves the live-stack execution caveat. Ready to merge as the first of six RC-smoke conversions; remaining five (`formula editor`, `Gantt rendering`, `Hierarchy rendering`, `public form submit`, `automation send_email`) can fork this spec's pattern in subsequent PRs.
