# Manual checkpoint acceptance caller repair — 2026-10-07

This bounded acceptance-only change adapts the existing synthetic checkpoint script to the ratified owned manual-generation contract at parent `40844691562b861662f6f878dc099f82824c49e7`. It adds no capability or production default. The observed ordinary-CI failure is the selected command refusing a missing owned native pool and explicit capture limits before claiming a generation.

## Scope locked before implementation

Only `packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts` may change after this lock. Production, fixtures, workflows, configuration, flags and provenance pins remain byte-identical to the parent. The new design-lock and ignored evidence are the only other writes. The earlier guard-proof worktree is read-only and remains frozen.

All positive direct commands receive the already verified owned database native pool. Both router runtimes expose their own existing native pool with an explicit connection acquisition timeout. Direct, router and optional full-application callers share an explicit synthetic policy of `maxBytes: 64 * 1024 * 1024` and `timeoutMs: 60000`; pool connection acquisition is bounded at 5000 ms. These are acceptance inputs, never production fallback values. The direct attachment binder receives the existing storage service bounded reader. Router/application use the production bounded reader wiring.

Keep the missing-policy negative and add a distinct valid-policy/missing-owned negative with exact `RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID`, no generation/request/pin/nonce/receipt side effects. Keep both selected flags enabled for positive capture. Keep all existing OFF/authentication/conflict/expiry/reader/migration negatives.

A handled synthetic PUT failure must return the closed owned refusal, leave exactly its generation building/abandoned/incomplete, release exactly its writer block, and retain prepared ciphertext and permanent nonce rows. An identical request through both the failing and healthy command reads the same incomplete status without another PUT or any persisted prepared/nonce changes. No claim/capture authority is recreated. This replaces only the old high-level pending-to-recoverable expectation. Existing lower-level new-connection, fresh-custody, binary and attachment prepared-upload continuation/refusal assertions remain unchanged. No owned crash continuation is claimed.

The unavailable-source HTTP negative retains exact 503 and retained source pins/no objects/independent completed-archive read assertions, and adds abandoned status plus exact own writer-block release. No successor clearing is introduced or claimed by this sequential acceptance scenario.

## Verification and handoff

Save parent inputs, original script, lock hash, call-site and assertion census before editing. Static checks must prove the positive caller wiring and unchanged lower-level assertion regions; retain every original negative except the explicitly superseded high-level handled-PUT continuation expectation. Run TypeScript parse and the existing acceptance script TypeScript config, plus complete relevant pure unit files (owned claim/capture/composer/history and source guards as appropriate). Do not execute the acceptance script, DB/native/provider/key/service/volume operations, CI, network, commit or push in this task. Retain first failures, true process exits and per-case results.

Root independently reviews the script, executes genuine isolated acceptance with newly owned resources, and updates exact workflow provenance pins later. Unit/static green alone does not close native acceptance or downstream CI. Any concrete production defect stops this test-only repair for owner review; production guards must not be relaxed.

## Root verification — 2026-10-07

Root independently read the complete surgical delta and owned caller contracts before execution. The acceptance script remains SHA-256 `6097371847b6dee08c6d01ca56781d430323a72856fbb5eee27601b278f26a54`; the pre-implementation contract and original 13,285-input census are retained in ignored evidence.

- `TM_TEST_PG_BIN=/opt/homebrew/opt/postgresql@15/bin node scripts/ops/run-recovery-manual-checkpoint.mjs`: actual exit 0, 273.57 seconds. Both complete default scripts ran: manual checkpoint, then attachment staging. The nine real-DB neighbor files report 47 + 59 + 127 = 233 passed cases, with no skipped summary cases. The script reports 52 exact PASS statements including owned handled-failure retention/status-only behavior and real HTTP attachment capture/download authority; all four expected owned DB/storage/cluster cleanup markers are present. This existing runner deletes only its newly owned resources; the outer controller retains complete raw output and true process exit. It is separate from the retained same-archive APFS drill.
- Seven relevant whole unit files: 317 passed, zero failed/skipped/todo; original assertion census and all three unchanged lower-level resume regions were independently frozen. The original CI failure at parent is retained, not rerun or relabeled.
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`, `pnpm --filter @metasheet/core-backend exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json`, `pnpm validate:all`, `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`, and `git diff --check`: each actual exit 0. `validate:all` covers the repository's configured plugin/lint/type scripts, not every workspace test.
- Workflow, package manifests, test-chain rosters, production, fixture and flag bytes remain unchanged. This acceptance script is outside the package provenance pinned input roster; the existing verifier passes without repinning. All four existing 22-file recovery archive integration rosters are preserved.

Evidence: `artifacts/tm-manual-acceptance-ci-repair-20261007/handoff-freeze.json`, `root-independent-source-review-before-native.json`, `review/root-execution-planning-20261007.json`, `official-isolated-acceptance-01/outer-process-receipt.json`, `official-isolated-acceptance-01/root-native-acceptance-qualification.json`, and `root-configured-gates/gates-receipt.json`. Raw process output and actual case census accompany those receipts.

| Gate | Current scope |
| --- | --- |
| Caller wiring, unchanged existing negatives and lower-level resume regions | PASS |
| Whole relevant unit files and TypeScript/configured checks | PASS |
| Official default isolated manual checkpoint + attachment-stage | PASS |
| Ordinary CI on the new exact committed head and downstream native whole-file collection | OPEN until independently qualified |
| Optional browser/full-application acceptance | Not executed by this default command |
| Owned interrupted-process continuation, integration/staging and whole TM completion | OPEN; this repair does not close those gates |

Publication stays Draft/HOLD. No merge, feature enablement, deployment, customer data or external writes are authorized by these component results.
