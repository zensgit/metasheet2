# Time Machine Phase D2-D7 verification report

**Status:** DRAFT / HOLD. Local exact-worktree verification. No staging or
production acceptance claim.

## 1. Verification subject

| Item | Value |
|---|---|
| worktree | `/private/tmp/codex-tm-d55-runtime-api-20260828` |
| D2-D6 head before D7 evidence | `d0fc5a5a2be412500604f70cba172536cb40f086` |
| D7 test + runbook evidence | `70b5e53f2144dc09a2aa46d7af94adffcbac7de8` |
| refreshed `origin/main` | `c479e9b321fe772149e367b5d90cb01c21654766` |
| merge-base | `e0956fd5c13b5500ae68c2425b97706d8a761043` |
| flags | unchanged and OFF |
| production | not accessed |

The final D7 evidence/report commit is recorded after independent review. Until
then, this file is an in-worktree evidence record, not an exact-head CI claim.

## 2. D7 local commands and results

### Core D5-D7 unit/route set

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-contract.test.ts \
  tests/unit/multitable-recovery-archive-async-plan.test.ts \
  tests/unit/multitable-recovery-archive-async-restore.test.ts \
  tests/unit/multitable-recovery-archive-preview.test.ts \
  tests/unit/multitable-recovery-archive-restore-owner-route.test.ts \
  tests/unit/multitable-recovery-archive-restore-plan.test.ts \
  tests/unit/multitable-recovery-archive-restore-worker.test.ts \
  tests/unit/multitable-recovery-archive-sync-execute.test.ts \
  tests/unit/multitable-recovery-archive-sync-plan.test.ts \
  tests/unit/multitable-recovery-archive-sync-restore.test.ts \
  tests/unit/multitable-recovery-archive-writer-block.test.ts \
  tests/unit/multitable-recovery-archive-writer-closure-routes.test.ts
```

Result: **12 files / 127 tests PASS / 0 skipped**.

The new HTTP parity case alone ran in the same file's **20/20** pass. It pins a
historical SHA-256 over complete response status/text plus every normalized SQL
statement and parameter, then compares archive flag unset, `false`, `TRUE`,
whitespace, and `1`.

### Real PostgreSQL D7 gate

The exact test file ran against a fully migrated isolated PostgreSQL database:

```bash
METASHEET_REAL_DB_TEST_STEP=1 \
DATABASE_URL='<ISOLATED_D7_DATABASE_URL>' \
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/multitable-recovery-archive-restore-jobs-realdb.test.ts
```

Result: **1 file / 20 tests PASS / 0 skipped**.

The 5,001-record revert leg proves:

- chunk 0 committed before the simulated worker disappearance (same process;
  a true process restart remains a staging gate);
- lease expiry is determined by the database clock;
- a second worker preserves `blockFence` and increments `workerFence`;
- the stale claim's binding read and actual chunk-facade call both fail with
  `RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST`, while completed count, committed
  chunks, and restore events remain at one;
- chunk 1 commits the remaining 5,000 records;
- all 5,001 expected records have exactly one restore revision and the sheet has
  exactly 5,001 restore events;
- terminal state is `done`, completed count is 5,001, aggregate member count is
  two, and the writer block is released.

The reset leg remains the post-anchor-delete first-chunk positive control.

### CI selection and type gates

```bash
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs
node --test scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff --check
```

Results:

- archive CI wiring: **6/6 PASS**;
- missing-DB fail-not-skip: **1/1 PASS**;
- core TypeScript: **PASS**;
- diff check: **PASS**.

The real-DB file is present in all three required places: the workflow whole-file
argument, the no-DB Vitest exclusion, and the mechanical roster/fail-not-skip
guards.

One first migration invocation omitted `DATABASE_URL` and failed against the
driver default before touching the isolated database. It was rejected as
evidence. The explicit-DSN full migration and real-DB command above then passed.

### D6 web evidence retained on the same stack

- target client/modal: **2 files / 14 tests PASS**;
- required web gate: **406 files / 5,150 tests / exit 0**;
- web typecheck: **PASS**;
- SFC/workbench source lint: **PASS**;
- desktop preview and mobile job-state screenshots were inspected locally.

The whole-file `client.ts` lint still reports one pre-existing unused import
outside this change. It was not edited or misreported as fixed.

## 3. Mutation evidence

| Mutation | Discriminating result |
|---|---|
| remove reclaimability of an expired `applying` job | crash/resume revert leg RED at missing resumed candidate; reset control remained green |
| remove daily worker lease ownership via stale claim | existing worker/real-DB lease tests refuse the stale writer |
| remove D6 per-sheet job map | sheet-switch lifecycle tests RED |
| stop re-poll after resume/cancel/read failure | matching modal lifecycle tests RED |
| remove preview/execute stale-response identity guard | client/modal tests RED |
| relax exact-literal archive/worker flags | contract and worker boot tests RED |

The lease-reclaim mutation was restored with `apply_patch`; the same two focused
real-DB legs then passed **2/2**. Runtime source is byte-restored; only tests and
documents remain modified for D7.

One first mutation command was invalid because its test filter selected no test;
it was rejected as evidence and not counted. The valid mutation run selected the
revert and reset cases explicitly.

## 4. Acceptance matrix

`PASS` means implementation/local evidence exists. `PARTIAL` means only part of
the design row has current local proof. `HOLD` means the required environment or
owner action has not occurred.

| Design row | Status | Evidence / remaining boundary |
|---|---|---|
| Migration | PASS (local) | fully migrated scratch DB; existing fresh/replay/down guards and CI roster; production rollback remains flag-only |
| Real-DB | PASS (local) | D2-D5 real-DB roster plus D7 restore-jobs 20/20; no production backend claim |
| Mutation | PASS (local) | crypto/coverage/lifecycle existing gates plus new reclaim mutation and flag exactness |
| Bootstrap / coverage | PASS (implementation) | dedicated real-DB bootstrap/coverage suites are CI-wired |
| Burn lifecycle | PASS (implementation) | sync/async closed shapes and job binding covered by existing D5 gates |
| Crypto uniqueness | PASS (implementation) | durable nonce/DEK identity tests and fail-before-upload mutations exist |
| Fault | PARTIAL | committed-chunk crash/reclaim/exact-once is now real-DB proven; live staging builder/provider/KMS/hold/deletion faults remain unexecuted |
| Scale | PASS (local) | 5,001 effective writes take async chunks and complete 1 + 5,000 without truncation |
| Storage domain | HOLD | local FS is test evidence only; no independently durable staging/production proof |
| Attachments | PASS (implementation) | source pin, immutable version/hash, archive-object reference, and deletion authority suites are wired |
| Links/config/tombstones | PASS (implementation) | section causality, operation binding, reconstruction, and link authority are present |
| Permissions | PASS (implementation) | preview/execute fresh authority and zero-write refusal tests pass; staging UAT remains HOLD |
| Values-free | PASS (local) | route/worker/crypto/provider errors use closed codes; ordinary evidence contains no raw identities |

## 5. Database cleanup

Each D7 scratch database was uniquely named for its run. The post-review database
was recreated from empty after the strengthened 5,001-record and stale-worker
assertions; the final whole-file result remained 20/20. Before each deletion the
exact database had zero active backends. Cleanup disabled new connections,
terminated only that database's sessions, dropped the exact name, and read back:

```text
exact=0
prefix=0
```

No unrelated database was modified.

## 6. Independent review

Independent D6 review on `d0fc5a5a2b` returned **0 P1 / 0 P2 / 0 P3**.

Two independent D7 first-pass reviews found overlapping evidence-strength issues:

- the flag-OFF comparison used a current-code unset baseline and a filtered SQL
  log, so a common-mode response/query change could false-green;
- the stale worker was denied only through a binding read, not an actual chunk
  call;
- exact-once evidence sampled only the two boundary records;
- the report wording could be read as a real process restart.

The delta was fix-forwarded before freeze:

- a historical digest now binds all response status/text and every normalized
  SQL statement plus parameter;
- the stale claim calls the real chunk facade and the test proves no progress,
  chunk, or revision change;
- every one of the 5,001 expected records must have one restore event and the
  total restore-event count must also be 5,001;
- reports explicitly say same-process simulated disappearance and retain true
  process restart as a staging gate.

Both reviewers re-read the fixed delta independently and returned
**0 P1 / 0 P2 / 0 P3**. One reviewer independently reran the focused parity file
at 20/20; both reviewed the strengthened real-DB assertions and made no edits.
The true OS-process restart remains a disclosed staging gate, not a local-test
claim.

## 7. Final verdict

**LOCAL D2-D7 IMPLEMENTATION EVIDENCE: PASS WITH OPERATIONAL HOLD.**

The new D7 fault/scale evidence is real and CI-selected, but it does not close the
runtime composition or staging/production proof:

- production-like object/KMS runtime factory: missing;
- server startup injection: missing;
- worker startup caller: missing;
- staging fault/storage/KMS runbook execution: not performed;
- current-main replay and exact-head CI: not performed;
- flags: OFF;
- production: untouched.

Therefore no statement in this report authorizes merge, deployment, staging flag
enablement, or production recovery.
