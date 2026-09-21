# H-2 verification — `EXPECT_DB` arming on the approval real-DB step

Companion to `plugin-tests-expect-db-arming-design-20260922.md`. All commands below were run
locally against a git worktree of `origin/main` created for this task; the branch head SHA and PR
number are recorded in this session's final report, not duplicated here to avoid drift between
this file and the actual head as commits are amended.

## What WAS run (local)

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Baseline s6a pin, before any edit | `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | GREEN |
| 2 | Census: sentinel files repo-wide | `grep -rl "itIfExpectDb = process.env.EXPECT_DB" packages/core-backend/tests` | 46 files |
| 3 | Census: which are in `plugin-tests.yml` | basename cross-reference | 3 files, all in one step |
| 4 | Shared step-shape contract, before edit | `node -e "…requireExecutableRealDbStep(…)…"` | step found, 4 pins hold |
| 5 | DB provisioning | `createdb -U ms2testbed -O ms2testbed metasheet2_h2_20260922`; `psql -U ms2testbed -d metasheet2_h2_20260922 -c "SELECT current_database(), current_user"` | `metasheet2_h2_20260922 \| ms2testbed` |
| 6 | Migrations, CI's exclusion list | `DATABASE_URL=… MIGRATION_EXCLUDE=… pnpm exec tsx src/db/migrate.ts` (in `packages/core-backend`) | exit 0, all migrations applied |
| 7 | 2×2 cell (i): DB present + `EXPECT_DB=1` | `DATABASE_URL=… EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run <3 files>` | exit 0, `3 passed` files, `124 passed` tests |
| 8 | 2×2 cell (ii): DB absent + `EXPECT_DB=1` | `env -u DATABASE_URL EXPECT_DB=1 npx vitest …` | exit 1, `3 failed` files, `AssertionError: expected undefined to be truthy` ×3 |
| 9 | 2×2 cell (iii): DB absent, no `EXPECT_DB` (pre-fix baseline) | `env -u DATABASE_URL -u EXPECT_DB npx vitest …` | exit 0 (skip-green), `1 passed \| 2 skipped` files, `22 passed \| 102 skipped` tests |
| 10 | 2×2 cell (iv): DB present, no `EXPECT_DB` | `env -u EXPECT_DB DATABASE_URL=… npx vitest …` | exit 0, `3 passed` files, `121 passed \| 3 skipped` tests |
| 11 | Full-step extraction via real YAML parser | `python3 -c "import yaml; … doc['jobs']['test']['steps'] …"` → `/tmp/extracted-run.sh` | env + run text extracted, not hand-copied |
| 12 | Full-step reproduction, prod shell flags, `DATABASE_URL` unset | `env -u DATABASE_URL bash --noprofile --norc -eo pipefail /tmp/extracted-run.sh` | exit 1 at line 1 (`:?` guard), independent of `EXPECT_DB`, both before and after the fix |
| 13 | The fix | inserted `EXPECT_DB: '1'` + comment into the one step's `env:` block | 1 step touched, diff reviewed |
| 14 | YAML still valid + contract still holds, after edit | `python3 -c "yaml.safe_load(...)"`; `node -e "…requireExecutableRealDbStep(…)…"` | parses; step env now `{DATABASE_URL, EXPECT_DB}`; contract still passes |
| 15 | s6a pin, after edit, before recompute | `node …/sealed-export-package-provenance.test.cjs` | RED — `SEALED_EXPORT_INTERNAL_ERROR`, matches documented signature |
| 16 | s6a recompute | `computePackageProvenancePinSet(repoRoot)` → write only `evidenceFiles.pluginTestsWorkflow` | `diff` shows exactly 1 line changed |
| 17 | s6a pin, after recompute | same command as #1 | GREEN |
| 18 | Sibling CI-wiring guards that reference this step's id | `node --test scripts/ops/t2gate-collision-mechanism-ci-wiring.test.mjs` | 40/40 passed |
| 19 | Attendance corpus/DML census guards (unaffected-by-construction, verified not just assumed) | `node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs`; `node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` | 262/262, 60/60 passed |
| 20 | Attendance W7 classification guard | `npx vitest run tests/unit/attendance-w7-w6r5-preservation-guard.test.ts` | 13/13 passed |
| 21 | Approval W6/W7 enumeration census | `npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts` | 342/342 passed |
| 22 | New guard, in isolation, post-fix | `npx vitest run tests/unit/plugin-tests-workflow-approval-realdb-expect-db-arming.test.ts` | 6/6 passed |
| 23 | New guard, reversal proof: real pre-fix file swapped in | `cp` pre-fix `plugin-tests.yml` over the fixed one; re-run #22 | 2 failed / 4 passed — GUARD test and its own sanity assertion both correctly red |
| 24 | Restore + byte-compare | `cp` fixed file back; `cmp` | no output — byte-identical to the pre-restore fixed version |
| 25 | New guard, green again post-restore | re-run #22 | 6/6 passed |
| 26 | `tsc` | `pnpm run type-check` (in `packages/core-backend`; `tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json`) | exit 0, no output |
| 27 | Full `CI=true` no-DB unit lane (the actual `pnpm --filter @metasheet/core-backend test` CI runs) | `CI=true pnpm test -- --reporter=dot` (in `packages/core-backend`) | exit 0. `980 passed \| 175 skipped` files (1155), `15897 passed \| 1615 skipped` tests (17512), **0 failed**; new guard file confirmed present in the output |

## What was NOT run (honest gap list)

- **Real GitHub Actions CI** on the pushed branch/PR (`test (18.x)`, `test (20.x)`, the "Run
  approval real-DB integration" step itself under `postgres:16` in the actual runner, the
  Sealed-export S5 lanes, `integration-guard`) — NOT RUN. Everything above is a local
  reproduction; the draft PR's own CI run is the first real-infrastructure execution and is the
  actual gate, not this document.
- **`merge_group` trigger behavior** for the sibling `approval-realdb-*.yml` dedicated lanes — not
  exercised; only `plugin-tests.yml`'s own required `test` job was in scope for this slice.
- **PG16 vs. PG15 behavioral parity** — the 2×2 matrix ran against a local Postgres 15.17
  (`ms2testbed`-owned throwaway DB); CI's dedicated `approval-realdb-comments.yml` lane and the
  `plugin-tests.yml` job both use `postgres:16`. No PG15/PG16-specific behavior was expected or
  observed in the 3 files under test, but this was not independently confirmed against 16 locally.
- **The full 77-file run-list** of the `approval-real-db-integration` step was not executed
  end-to-end locally (only the 3 sentinel-bearing files, per the advisor-directed scope-down to
  avoid drowning cell (i)/(iv) in unrelated failures from files this change does not touch); CI's
  own run of the full step is unexercised by this document.
- **Whether the s6a pin recompute in this PR collides with a concurrent PR** touching
  `.github/workflows/plugin-tests.yml` — not checked (no open-PR scan performed); flagged in the
  PR body per `feedback_s6a_pin_is_a_merge_bottleneck`'s standing guidance, resolution left to
  whoever merges.
- **Owner ratification** of this slice as a whole — this document and the design doc are the
  candidate; nothing here should be read as an owner decision.
