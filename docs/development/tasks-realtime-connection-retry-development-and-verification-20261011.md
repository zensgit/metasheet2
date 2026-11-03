# Tasks realtime connection retry: development and verification (2026-10-11)

## Scope and design

Base: `906840c74cab5120aac73132644372e678f6b334`. This repair follows the existing [tasks M4 frontend contract](task-m4-frontend-design-20261007.md), section 8.2. It preserves the optional socket, token and teardown guards, socket reuse, explicit disconnect/reconnect behavior, and 60-second HTTP poll. No API, flag, schema, dependency, or CI workflow changes are proposed.

`io` is a synchronous factory. The previous async IIFE cleared `connectionPromise` in its synchronous `finally`, before the outer assignment stored the IIFE's result. A synchronous URL-resolution or factory failure therefore left a rejected promise cached. Every later reconnect reused that rejection. Automatic mounting also discarded the rejection without handling it.

The repair removes the ineffective promise cache. Successful construction stores the socket before the next call, so ordinary concurrent calls still reuse it. Failed construction stores no attempt and allows another call to retry. Automatic mounting consumes construction rejection without logging error values; an explicit `reconnect()` still returns a rejected promise when that attempt fails. The design document's in-flight-promise wording describes the previous implementation; this repair preserves its reuse/recovery behavior using the actual synchronous factory.

## Implementation and independent review

Grok 4.7 identified the cached-rejection failure during the release audit. Luna implemented the bounded repair with medium effort. Sol6.1 independently reviewed it with medium effort. The parent reviewer corrected the new test's reconnect type to `ReturnType<typeof useTasksCountsRealtime>['reconnect']`, updated the lifecycle comment, and ran the mutation and restored-code checks below.

The proposal changes only this note, `apps/web/src/tasks/useTasksCountsRealtime.ts`, and the existing `apps/web/tests/tasks-counts-realtime.spec.ts`. The existing spec remains wired into the tasks web guard and required web runner. No new spec or test-chain changes are needed.

## Verification

Private JSON reports and command logs are retained with the release audit rather than linked to nonexistent repository files.

| Check | Result |
| --- | --- |
| Replace only the composable with the original base implementation; run the full realtime spec against the new assertions | Exit 1: 38 passed, exactly 2 intended assertions failed, 0 pending |
| Restore the saved repaired bytes; run realtime, both badge specs, and all four range-fill specs | Exit 0: 446 passed, 0 failed, 0 pending |
| Final realtime spec after simplifying the mount fixture | Exit 0: 40 passed, 0 failed, 0 pending |
| Independent review corrections | Reconnect type, lifecycle comment, and portable evidence description corrected |
| `git diff --check` | Passed |
| `pnpm validate:all` | Passed: plugin validation, required lint command, and workspace type checks |

The two discriminating assertions cover retry after a synchronous factory exception and handling automatic-mount rejection while the 60-second poll recovers the badge. The retry test also checks reuse after success and construction after explicit disconnect. Neighbor tests retain token absence, teardown, payload validation, badge invalidation, and range-fill behavior.

Mutation evidence: `parent-mutation-red.json`. Restored-code evidence: `parent-restore-green.json`. The mutation script restores saved implementation bytes in `finally`; it does not reset the implementation through Git. Source and spec hashes are recorded in `parent-repair-source-hashes.json`.

Portable equivalents of the restored-code and quality commands, from the repository root:

```sh
MS2_RETRY_EVIDENCE="$PWD/artifacts/tasks-realtime-retry"
mkdir -p "$MS2_RETRY_EVIDENCE"
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/tasks-counts-realtime.spec.ts \
  tests/tasks-badge-m4.spec.ts tests/tasks-badge.spec.ts \
  tests/multitable-range-fill-flag.spec.ts \
  tests/multitable-range-fill-writer.spec.ts \
  tests/multitable-range-fill-interaction.spec.ts \
  tests/multitable-range-fill-planner.spec.ts \
  --maxWorkers=2 --minWorkers=1 --reporter=json \
  --outputFile="$MS2_RETRY_EVIDENCE/restore-green.json"
NODE_OPTIONS=--max-old-space-size=4096 pnpm validate:all
git diff --check
```

Actual runs use the dedicated remote wrapper with Node 20.20.2 and pnpm 10.16.1, preserving the same command arguments and absolute JSON output paths. The first quality attempt passed plugin validation but stopped because its copied dependency environment lacked a root resolver link to the already installed, locked `vue-eslint-parser@9.4.3`; no dependency manifest, lockfile, or source workaround was changed. The successful retry is recorded in `parent-validate-all-retry.json`. The repository quality command checks application types and selected lint surfaces, and does not type-check every test file.

A supplementary direct lint run of the composable and spec reports zero errors and eight warnings: seven existing fixture warnings and one multiple-component warning for the new isolated mount fixture. The composable has no lint warning. The final fixture uses `createApp` directly, and the full realtime spec was rerun. Direct lint without a zero-warning threshold passed; a stricter supplementary `--max-warnings=0` run failed. No lint rule was disabled or unrelated fixture rewritten. This supplementary check does not replace the required repository lint command, which passed.

## Release boundary

These are isolated automated checks, not live socket, deployment, database restore, or business-acceptance evidence. Commit, PR head, and subsequent CI results belong in the closeout receipt. This repair does not authorize a merge, deployment, migration, external write, or feature-flag change. The broader candidate audit retains separate approval group-CC downgrade, migration, immutable-image, and live-acceptance gates.
