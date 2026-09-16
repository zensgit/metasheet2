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
