# Multitable RC Hierarchy Smoke · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-hierarchy-smoke-development-20260507.md`

## Spec parses (Playwright list)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-hierarchy-smoke.spec.ts
```

Result:

```
Listing tests:
  multitable-hierarchy-smoke.spec.ts:120:7 › Multitable Hierarchy smoke › renders parent and child records in the hierarchy workbench
  multitable-hierarchy-smoke.spec.ts:147:7 › Multitable Hierarchy smoke › rejects setting a record as its own parent (HIERARCHY_CYCLE)
  multitable-hierarchy-smoke.spec.ts:163:7 › Multitable Hierarchy smoke › rejects setting a descendant as the parent (HIERARCHY_CYCLE through chain)
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
packages/core-backend/tests/e2e/multitable-hierarchy-smoke.spec.ts | new
packages/core-backend/tests/e2e/README.md                          | +1 / -1
docs/development/multitable-feishu-rc-todo-20260430.md             | +5 / -1 (tick line 112 + PR/MD pointers)
docs/development/multitable-rc-hierarchy-smoke-development-20260507.md | new
docs/development/multitable-rc-hierarchy-smoke-verification-20260507.md | new
```

`pnpm install --frozen-lockfile` in the fresh worktree caused incidental symlink rewrites under `plugins/*/node_modules/*` and `tools/cli/node_modules/*`; these are install artifacts and are NOT staged.

## Server reachability check parity

The `beforeAll` checks **both** backend (`:7778`) and frontend (`:8899`) reachability before login. Same parity Codex added to the lifecycle smoke (commit `8cccfc218`) and that I baked into the public-form smoke (PR #1417). Suite skips deterministically when either is unreachable; no silent partial-skip drift between doc claim and runtime.

## Specific assertions (per #1417 review hardening pattern)

The cycle regression guards do NOT just assert HTTP 400 — they additionally assert `body.error.code === 'HIERARCHY_CYCLE'`, matching the wire contract precisely. A regression that returned 400 with a generic `VALIDATION_ERROR` code would surface as a test failure rather than silently passing.

The descendant-chain test additionally asserts that a non-cycle reparent on the same chain SUCCEEDS, ensuring "all hierarchy patches reject" regressions cannot pass.

## Live execution (deferred)

Same justification as PR #1415 / #1417 verification MDs: no Yuantus-free dev-stack runner is provisioned in this worktree, the spec is structurally identical to the merged smoke specs, and `beforeAll` skip-when-unavailable handles the absent-stack case gracefully.

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
  tests/e2e/multitable-hierarchy-smoke.spec.ts
```

Expected: 3 tests pass; total ~6–10s including frontend cold-start for the render test.

## Pre-deployment checks

- [x] PR #1406 + #1412 + #1415 + #1417 already merged on main; this branch is rebased onto `22c04bd0f`.
- [x] No DingTalk / public-form runtime / Hierarchy runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber / Gantt / formula / migration / OpenAPI changes.
- [x] RC TODO line 112 ticked with PR / dev MD / verification MD pointers in the same commit.

## Result

Spec parses, types clean, diff hygiene clean, RC TODO updated. Ready to merge as the third of six RC-smoke conversions; remaining three (`formula editor`, `Gantt rendering`, `automation send_email`) can fork this spec's pattern in subsequent PRs.

If a fourth smoke spec lands sharing the `setupHierarchySheet`-style scaffolding with the lifecycle/public-form helpers, recommend extracting `authPost` / `authPatch` / `authGet` / `injectTokenAndGo` into `packages/core-backend/tests/e2e/multitable-helpers.ts` to avoid drift across files. Postponing the extraction until 4 callers exist follows the "rule of three" — three slightly-divergent inline copies is the trigger, not the discipline.
