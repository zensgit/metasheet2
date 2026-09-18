# Local-first archive storage verification

Status: local implementation evidence; Draft/HOLD. Not NAS, production startup, custody, or power-loss acceptance.

## Baseline and scope

- Exact implementation commit: 3130cd6d5a4db07213cd85329692dc789012896a.
- Implementation tree: fbd033cb8be738f738228045c058e921eef6ae7e.
- This report is a documentation-only child; code/test evidence binds that implementation commit, not future changes.
- Prior published candidate: ea50f542501ad608dd8c4d4d5be8f73bbf088a5b.
- Current-main replay: 2ceb2cf1730a12a14bd4d63c8280672fb71cf2d1; true merge of prior candidate and 38caaf17bfc8eeca23e23f6dfe796683d35ab525. Incoming main delta is four documentation files only.
- Product: new `packages/core-backend/src/multitable/recovery-archive-file-store.ts`.
- Test: new `packages/core-backend/tests/unit/multitable-recovery-archive-file-store.test.ts`.
- Contract: `timemachine-local-storage-design-lock-20260916.md`.
- Existing object-store module only exports its existing request parsers and local binding-mismatch subtype for reuse; existing test-only store behavior is unchanged. Runtime composition, crypto, flags, workflows and database schemas are unchanged.

## Executed local gates

Environment: macOS APFS; Node 25.9.0. No Node 18/20, Linux, NAS, Windows or physical power-loss result is claimed by these local runs.

`pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-recovery-archive-file-store.test.ts tests/unit/multitable-recovery-archive-object-store.test.ts tests/unit/multitable-recovery-archive-application.test.ts --reporter=dot`

Result: 3 files / 73 tests PASS (new file 21, existing object-store 19, application 33).

`pnpm --filter @metasheet/core-backend type-check`: PASS.

`pnpm --filter @metasheet/core-backend exec eslint src/multitable/recovery-archive-file-store.ts src/multitable/recovery-archive-object-store.ts`: PASS.

Official `computePackageProvenancePinSet`: frozen/live differenceCount=0; no pin edit.
Full `pnpm --filter plugin-integration-core test:sealed-export-s5`: PASS, all eleven scripts. First attempt could not resolve the already-installed mssql dependency from this worktree; rerun used temporary NODE_PATH pointing at the existing pnpm-store installation. No install, dependency edit, network SQL Server or database operation was involved.

Real-filesystem positives/negatives cover persisted bytes and immutable replay; exactly one create winner; pin vs delete contenders; durable pin/delete after new provider construction; fresh Node subprocess reading bytes/pin; interrupted unlink after delete marker and safe retry; failed directory flush refusing success with subsequent replay; future expiry/initial pin; wrong binding; corrupt bytes/metadata/retention; no missing-root creation; wrong root identity; root inode replacement; symlinks; transaction and unknown/network-filesystem rejection; object size/hash admission. Temporary roots are removed by afterEach.

Initial failed attempts were fixture defects: spying on a native module namespace, then matching a symlink-alias path instead of its real path. Both were repaired and the complete three-file command passed afterward. Those failed attempts are not product regressions or passing fault-injection evidence.

## CI and remaining gates

Plugin System Tests runs `pnpm --filter @metasheet/core-backend test` (Vitest default discovery). The new `.test.ts` is under `tests/unit`, not excluded, and the focused invocation uses that same repository config. Remote exact-head collection/result must still be read after publication; old ea50 CI is not evidence for this change. No shared selectors were deleted or rewritten.

The requested root device/inode guard mutation was rejected by the tool safety reviewer BEFORE editing. The guard remained intact; no bypass or alternative mutation execution was attempted. Therefore mutation acceptance is NOT COMPLETE. Fault-injection negatives and normal tests are evidence in their own right, not substitutes for a claimed successful mutation run.

Independent Sol high read-only review identified overlapping provider/result-wrapper responsibility and potentially lossy numeric inode/device binding. Follow-up confirmed raw-provider and bigint fixes, but retained a mismatch-error classification finding. Final correction shares the existing local binding-mismatch subtype and reconstructs a fresh values-free exception before the outer wrapper maps it. The repeated-put mismatch test now asserts the exact error code, not a broad prefix. Added adjacent-inode-above-MAX_SAFE_INTEGER and raw-provider invalid identity/hash negatives. Final 73-test execution is the implementation task's closure evidence; no final external 0/0/0 verdict is claimed. Reviewer session closed.

No DB, customer storage, credentials, activation, deployment, or recovery operation was used. Runtime composition remains unconnected; key custody and NAS acceptance remain explicit next steps.

## Cross-process retention follow-up

Test-only local commit: `78bbd18134030c504040a27b2c390be223418e53`,
parent published candidate `2de92ac69ed1936abe5428c9f16f4e284b977dbb`.
Production provider bytes are unchanged. Two independently launched Node processes
attempt pin and expired deletion for the same synthetic object. Only pinned/retained
or refused/deleted outcomes are accepted; a fresh provider then proves the persisted
winner and rejects deletion or resurrection as appropriate. This is concurrent process
launch coverage, not a deterministic barrier at the filesystem publication instruction,
physical power-loss evidence, or NAS acceptance.

The same three-file focused command passed 74/74 (22 file-store, 19 object-store,
33 application). `git diff --check` passed. No guard-removal mutation was attempted.
The original 73-test result above remains bound to its original implementation commit.
At this follow-up, published-head Node18/20 integration jobs were still running with
their core-backend test steps successful; no remote result is claimed for this local
test-only child. The separate local-custody proposal remains PROPOSED/NOT RATIFIED.

## Published-head Node18 collection evidence

Published SHA: `2de92ac69ed1936abe5428c9f16f4e284b977dbb`.
Plugin System Tests run `35045855879`, Node18 job `104635395222`, terminal SUCCESS.
Downloaded job log contains exactly 21 successful test-case entries for
`tests/unit/multitable-recovery-archive-file-store.test.ts`, including separate-process
read, immutable retention, directory-flush failure/replay, and bigint root identity.
This verifies actual remote collection rather than inferring it from an aggregate
green check. Node20 remained in progress at this evidence checkpoint. The newer
22nd test in local commit `78bbd18134030c504040a27b2c390be223418e53` was not part of
this remote SHA and is not covered by this job.

### Terminal published-head matrix

The same published SHA subsequently reached 35 completed checks: 34 SUCCESS,
1 expected SKIPPED, zero pending/failure. Node20 job `104635395152` and coverage
job `104642273699` completed successfully. The Node20 log independently contains
21 successful file-store test-case entries, with no failing entry for that file.
Remote main remained `38caaf17bfc8eeca23e23f6dfe796683d35ab525` and the PR branch
remained the exact published SHA before preparing the follow-up push. These results
do not cover the newer 22nd test, local custody, NAS, physical power loss or deployment.
The local 74-test follow-up also passed core-backend `type-check` before publication.

## Follow-up terminal matrix and docs-only main replay

Published follow-up `c7842136b99b288020bae1162765a9e8e6c1c0fe` reached 34 SUCCESS,
1 expected SKIPPED, zero pending/failure. Run `35048705215` Node18 job
`104644174509` and Node20 job `104644174685` each logged 22 successful file-store
cases, explicitly including separate-process pin/delete arbitration. Coverage job
`104650293622` also succeeded. Sol high read-only review at that exact head returned
0 P1 / 0 P2 / 0 P3 within the local-store contract; it ran no tests and did not
claim NAS, custody, startup, power-loss or mutation acceptance. Session closed;
the verdict is also recorded in PR #5744 comment 5691261776.

Final-main recheck found docs-only #5789. True merge
`1f0a4ed720360896c29db0bdfb7716730eced3c7`, tree
`a70644fbe60a0ff25faeaff5665fc9811d782b4e`, has ordered parents
`c7842136b99b288020bae1162765a9e8e6c1c0fe` and
`857e29dd392cc6ff05619b8549f9ea83ead941c3`. No conflict/manual resolution.
Its sole first-parent delta is the incoming frontline-role permission-plan MD;
all runtime/test/provider/workflow bytes are unchanged. Focused three-file tests
pass 74/74 again. The successor needs its own published-head checks; the prior
matrix is not relabeled as successor CI.
