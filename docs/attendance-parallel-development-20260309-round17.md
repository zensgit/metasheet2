# Attendance Parallel Development Report (Round17, 2026-03-09)

## Scope

This round focused on production-gate reliability and async import regression hardening under active parallel delivery:

1. close async `commit-async` regression gap for large in-memory payload retries.
2. harden `attendance-post-merge-verify.sh` against workflow dispatch schema skew (`Unexpected inputs provided`).
3. eliminate stale run metadata leakage on dispatch failure paths.
4. apply the same dispatch compatibility guard to generic workflow dispatcher used by ops scripts.
5. add a local fast parallel regression entrypoint to cut validation loop time.
6. record full evidence (local + GA run IDs) into production handoff documents.

## Design Decisions

### A. Async import idempotency regression hardening

- Add one integration case to lock behavior where:
  - first `commit-async` request carries large `entries` payload + `commitToken`,
  - retry request uses same `idempotencyKey` but omits `commitToken`,
  - service must return same async job and complete successfully.
- Increase polling ceiling in async integration path to reduce CI false negatives under slow runners.

### B. Backward-compatible workflow dispatch

- `attendance-post-merge-verify.sh` now parses `gh workflow run` errors for unsupported inputs and retries dispatch after removing unsupported `-f key=value` pairs.
- This keeps the verifier usable when script-side inputs evolve faster than target branch workflow schemas.

### C. Run metadata correctness

- Reset `RUN_ID/RUN_URL/RUN_CONCLUSION/RUN_ARTIFACTS` at each gate trigger start.
- Prevent stale run IDs from previous gates being reused when dispatch fails early.

### D. Shared dispatcher hardening

- Extend `attendance-run-workflow-dispatch.sh` with unsupported-input fallback, so any ops script using this helper can survive temporary workflow input drift.
- Add deterministic node tests with mocked `gh` to verify:
  - fallback retry removes rejected inputs only,
  - normal dispatch path stays single-shot.

## Implementation

### Code

- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - polling ceiling update for async commit integration case.
  - new test: `keeps large entries payload for commit-async jobs when csv payload is absent`.

- `scripts/ops/attendance-post-merge-verify.sh`
  - unsupported-input fallback retry for workflow dispatch.
  - per-gate run metadata reset before dispatch.

- `scripts/ops/attendance-run-workflow-dispatch.sh`
  - unsupported-input fallback retry for workflow dispatch.

- `scripts/ops/attendance-run-workflow-dispatch.test.mjs`
  - added regression tests for fallback and normal dispatch flows.

- `scripts/ops/attendance-run-gate-contract-case.sh`
  - strict contract case now executes dispatcher regression tests, so dispatcher compatibility is protected in the existing gate contract matrix path.

- `scripts/ops/attendance-fast-parallel-regression.sh` (new)
  - runs key ops tests + strict/dashboard contract cases in parallel.
  - emits unified `summary.md` / `summary.json` under `output/playwright/attendance-fast-parallel-regression/<timestamp>/`.
  - supports `PROFILE=full|ops|contracts` and `MAX_PARALLEL=<n>` to target specific lanes.
  - default output root now uses `timestamp + pid` to avoid same-second collisions during concurrent runs.
  - emits structured summary metadata (`profile`, `maxParallel`, `runContractCases`) in `summary.json`.
- `scripts/ops/attendance-fast-parallel-regression.test.mjs` (new)
  - validates profile and max-parallel input guards.
  - validates default check selection:
    - `PROFILE=ops` => ops checks only.
    - `PROFILE=contracts` => contract checks only.
- `package.json`
  - adds npm shortcuts:
    - `pnpm verify:attendance-regression-fast`
    - `pnpm verify:attendance-regression-fast:test`
    - `pnpm verify:attendance-regression-fast:ops`
    - `pnpm verify:attendance-regression-fast:contracts`
- `scripts/ops/attendance-regression-local.sh`
  - fixes command execution context to always run from repo root (`bash -c "cd <root> && ..."`), preventing login-shell cwd drift.

### Documentation Updates

- `docs/attendance-production-ga-daily-gates-20260209.md`
- `docs/attendance-production-go-no-go-20260211.md`

Both documents now include:

- nightly chain replay evidence (`#22842467070`),
- fallback compatibility replay evidence,
- full-chain replay evidence with strict retry and perf fallback dispatch.

## Verification

### Local / Script Validation

1. `bash -n scripts/ops/attendance-post-merge-verify.sh` -> PASS
2. `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports async import commit jobs \\(commit-async \\+ job polling\\)"` -> PASS
3. `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "keeps large entries payload for commit-async jobs when csv payload is absent"` -> PASS
4. `SKIP_BRANCH_POLICY=true SKIP_STRICT=true SKIP_LOCALE_ZH=true SKIP_DASHBOARD=true PERF_BASELINE_PROFILE=high-scale bash scripts/ops/attendance-post-merge-verify.sh` -> PASS
5. `node --test scripts/ops/attendance-run-workflow-dispatch.test.mjs` -> PASS
6. `bash -n scripts/ops/attendance-run-workflow-dispatch.sh` -> PASS
7. `./scripts/ops/attendance-run-gate-contract-case.sh strict /tmp/attendance-gate-contract-check-round17-dispatch` -> PASS
8. `scripts/ops/attendance-fast-parallel-regression.sh` -> PASS
9. `pnpm verify:attendance-regression-fast` -> PASS
10. `pnpm verify:attendance-regression-fast:ops` -> PASS
11. `pnpm verify:attendance-regression-fast:contracts` -> PASS
12. `pnpm verify:attendance-regression-fast:test` -> PASS

Fast parallel evidence:

- `output/playwright/attendance-fast-parallel-regression/20260309-170637/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-170637/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260309-170846/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-170846/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260309-171117/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-171117/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260309-172147-94804/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-172147-94804/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260309-172147-94807/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-172147-94807/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260309-172332-1671/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260309-172332-1671/summary.json`
- `output/playwright/attendance-fast-parallel-regression/20260310-075225-24644/summary.md`
- `output/playwright/attendance-fast-parallel-regression/20260310-075225-24644/summary.json`

Evidence:

- `output/playwright/attendance-post-merge-verify/20260309-153802/summary.md`
- `output/playwright/attendance-post-merge-verify/20260309-155917/summary.md`

### Full-chain Replays

- nightly chain: run `#22842467070` PASS
- full-chain compatibility replay:
  - output root: `output/playwright/attendance-post-merge-verify/20260309-154253`
  - strict first run `#22843329945` (rate limited), retry `#22843491398` PASS
  - perf baseline fallback dispatch run `#22843641249` PASS
  - daily dashboard run `#22843663627` PASS

## PR Status

- PR: `https://github.com/zensgit/metasheet2/pull/396`
- Head: latest `codex/attendance-parallel-round17` commit on PR #396
- Required checks: PASS
- Remaining blocker: repository policy requires at least 1 approving review with write access.

## Commits (this round)

1. `14694eb0` test(attendance-import): harden async commit integration coverage
2. `840a96dd` docs(attendance): record nightly chain rerun and async payload guard evidence
3. `e0fbe671` fix(ops): retry post-merge dispatch without unsupported inputs
4. `62798a19` docs(attendance): add full-chain compatibility fallback evidence
5. `aace2dd1` fix(ops): reset post-merge gate run metadata on dispatch
6. `203120c0` docs(attendance): add round17 parallel development report
7. `fb1e66e3` test(ops): harden shared workflow dispatcher input-fallback
8. `8a0f4b97` test(contracts): include dispatcher fallback regressions in strict case
9. `7d6b7151` feat(ops): add fast parallel attendance regression entrypoint
10. `e3bcf950` chore(attendance): add fast regression pnpm entry and evidence
11. `2696fa0b` feat(ops): add lane profiles for fast attendance regression
12. `d54051ca` test(ops): cover fast attendance regression lane profiles
13. `4077520b` docs(attendance): update round17 commit log and profile evidence
14. `02a9855b` feat(ops): export fast regression profile metadata in summaries
