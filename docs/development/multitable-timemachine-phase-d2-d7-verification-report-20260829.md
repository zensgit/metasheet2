# Time Machine Phase D2-D7 verification report

**Status:** MERGED FOUNDATION / LOCAL CLOSEOUT HOLD. PR #5305 is merged. The
post-merge hardening checkpoint is locally verified but not pushed or remotely
verified. No staging, flag, deployment, or production acceptance claim.

## 1. Verification subject

| Item | Value |
|---|---|
| source worktree | `/private/tmp/codex-tm-d55-runtime-api-20260828` |
| original current-main worktree | `/private/tmp/codex-tm-d2-d7-current-main-20260829` |
| merged PR | `#5305` |
| merged PR head | `beeff6b3765cff463f8887d58f6b3fb11b8a5a61` |
| merge commit | `fac252067ab1c22d910266ac2ba29016c2b5fe43` |
| D2-D6 head before D7 evidence | `d0fc5a5a2be412500604f70cba172536cb40f086` |
| D7 test + runbook evidence | `70b5e53f2144dc09a2aa46d7af94adffcbac7de8` |
| final source evidence head | `def68afe85d759f130656882c3bf5de2e98dbb8a` |
| refreshed `origin/main` | `c479e9b321fe772149e367b5d90cb01c21654766` |
| merge-base / PR base | `c479e9b321fe772149e367b5d90cb01c21654766` |
| current-main integration merge | `023f5e793305401fbfdbe05d81ac9db90b1b2838` |
| durable job rediscovery | `05d176c21d` |
| runtime implementation before first reports | `bb12c9264ab9948312826fdb56ffb30abbad8a9c` |
| final product-code head | `73d3187c8b6be375c710ce38a92c42468c74c458` |
| final product-code tree | `eb16faa33b49bcb4e7727bc5917a24a726d43254` |
| product-code remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure` |
| key-registry scratch-drain hardening | `e19b65041d9fd79a556bb58b0c40734b2066c874` |
| final code/test tree before report refresh | `6ac12d5efa2849faecdd4de32f4414574b90bb82` |
| post-merge closeout worktree | `/private/tmp/codex-tm-closeout-hardening-20260829` |
| post-merge closeout base | `3f30d8eb4f27f9972b640e2d69e2c3dab2837ae5` |
| post-merge closeout code head | `6cf88c0e848495787d8dfec1af6348ba22325762` |
| post-merge closeout code tree | `a6fe1e4d8a685dea8dd30563826ca4d3ecc76c64` |
| post-merge closeout remote CI | not run |
| flags | unchanged and OFF |
| production | not accessed |

The integration merge is a true two-parent merge of the final source evidence and
current `origin/main`; both are ancestors. Durable rediscovery, application
runtime wiring, exact-head CI fix-forwards, and closed job-list validation were
then added as bounded commits. PR #5305 was merged through `fac252067a`; that
merge still does not authorize runtime enablement.

### Current-main integration checks

- The three files changed by main's false-green entry-guard fix have the exact
  `origin/main` blobs in the candidate.
- `multitable-recovery-schema-containment.test.mjs`: **42/42 PASS**.
- `reset-acceptance-request-shape.test.ts`: **17/17 PASS**.
- D5-D7 core unit/route/runtime set: **18 files / 205 tests PASS / 0 skipped**.
- archive CI wiring and fail-not-skip: **6/6 + 1/1 PASS**.
- core typecheck: **PASS**.
- D6 client/modal and full-reload rediscovery: **2 files / 20 tests PASS**.
- final archive client serialization: **1 file / 31 tests PASS**.
- required web gate: **406 files / 5,150 tests / exit 0**.
- web typecheck: **PASS**.
- candidate diff check: **PASS**.
- a fresh, fully migrated candidate database ran the archive restore real-DB file
  at **1 file / 20 tests PASS / 0 skipped**; exact and prefix residue were zero
  after the database was dropped.
- Node 20 executed the complete archive roster at **14 files / 279 tests PASS /
  0 skipped** inside the full multitable real-DB step.
- shared full-schema cleanup regression set: **10 files / 182 tests PASS**;
  catalog **41/41**, lease/PIT focused **13/13**, and lease whole-file **10/10**.

### Post-merge local closeout checks

Checkpoint `6cf88c0e84` closes the two later review residuals without changing a
migration, workflow, flag, writer, archive format, or provider contract:

- pre-fix catalog test: **17 failures / 48 tests**, each malformed successful
  response resolved instead of rejecting; fixed client: **48/48 PASS**;
- pre-fix application test: **1 failure / 10 tests**, because a never-resolving
  in-flight worker had no ten-second failure; fixed application: **10/10 PASS**;
- client plus mounted modal neighbor: **2 files / 65 tests PASS**;
- worker, application, and server wiring neighbors: **3 files / 32 tests PASS**;
- Required Web: **406 files / 5,150 tests PASS**;
- Time Machine archive CI wiring: **6/6 PASS**;
- web and core-backend typecheck: **PASS**;
- core changed-source ESLint and diff-check: **PASS**;
- whole-file web client ESLint still reports the pre-existing unused
  `MultitableCommentReaction` import at line 40; origin/main blame predates this
  closeout and the unrelated import was not edited.

The discriminating evidence for this local closeout is the exact pre-fix
RED-to-fixed-GREEN run above. No temporary production-guard neutralization is
claimed: the local safety reviewer refused the attempted weakening, and it was
not bypassed.

### Draft PR exact-head progression

Remote verification was treated as evidence, not ceremony:

1. The first code-bearing matrix reached the complete Node 20 multitable
   real-DB roster and failed **9 files / 92 tests**, plus one unhandled `57P01`.
   The failures exposed three local-fixture defects: new D7 FK children were not
   in D2 cleanup, immutable token burns were still deleted, and one test directly
   terminated its own backend without owning the rejection.
2. `5c1184e173` replaced partial delete cleanup with the complete child `TRUNCATE`
   graph under test-only `SET LOCAL session_replication_role=replica`, and moved
   backend termination to the shared scratch drain/drop helper. The same focused
   full-schema set then passed **10 files / 182 tests** with zero DB residue.
3. Review of `1eaaee9869` found that a successful job-list envelope still admitted
   malformed elements. `4d3a50c627` closed the seven-field element shape. A Sol
   exact-delta review then found scalar values were only string-typed;
   `6e4a0ee4e7` aligned UUID, decimal, timestamp, terminal, and count invariants
   with the backend wire and DB checks. Its re-review found the DB admission
   threshold and numeric-primitive negatives still open; `6beed608f3` now
   requires `totalCount > 5000` and rejects numeric JSON primitives.
   `73d3187c8b` then removes overlapping-oracle ambiguity from both numeric
   timestamp negatives.
4. The final code-head remote matrix reached **48 SUCCESS / 1 intentional
   SKIPPED / 0 failure**. Node 20's full multitable step executed all 14 archive
   files and 279 tests with **0 skipped** in that archive roster.
5. A later report-only matrix passed all **259 files / 2,679 tests** in the same
   full multitable step, then failed on one unhandled `57P01` while the D2
   key-registry scratch database was being dropped. The suite still used an ad
   hoc terminate-and-drop path that could kill a pool connection during its
   close event. `e19b65041d` adopts the shared owned-pool termination handler and
   fail-closed drain/drop helper. Four consecutive targeted real-DB runs passed
   **10/10** each, every scratch drop was `CLEAN` with zero residual backends,
   and the final `tm_d2key_%` residue count was zero.

## 2. D7 local commands and results

### Core D5-D7 unit/route/runtime set

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-contract.test.ts \
  tests/unit/multitable-recovery-archive-async-plan.test.ts \
  tests/unit/multitable-recovery-archive-async-restore.test.ts \
  tests/unit/multitable-recovery-archive-preview.test.ts \
  tests/unit/multitable-recovery-archive-restore-owner-route.test.ts \
  tests/unit/multitable-recovery-archive-restore-jobs-list.test.ts \
  tests/unit/multitable-recovery-archive-restore-plan.test.ts \
  tests/unit/multitable-recovery-archive-restore-worker.test.ts \
  tests/unit/multitable-recovery-archive-sync-execute.test.ts \
  tests/unit/multitable-recovery-archive-sync-plan.test.ts \
  tests/unit/multitable-recovery-archive-sync-restore.test.ts \
  tests/unit/multitable-recovery-archive-writer-block.test.ts \
  tests/unit/multitable-recovery-archive-writer-closure-routes.test.ts \
  tests/unit/multitable-recovery-archive-crypto.test.ts \
  tests/unit/connection-pool-transaction-depth.test.ts \
  tests/unit/metasheet-recovery-archive-wiring.test.ts \
  tests/unit/multitable-recovery-archive-application.test.ts \
  tests/unit/univer-meta-recovery-archive-database-wiring.test.ts
```

Result: **18 files / 205 tests PASS / 0 skipped**.

The new HTTP parity case alone ran in the same file's **20/20** pass. It pins a
historical SHA-256 over complete response status/text plus every normalized SQL
statement and parameter, then compares archive flag unset, `false`, `TRUE`,
whitespace, and `1`.

The added runtime cases prove:

- OFF and non-exact flag values return before provider composition, database
  resolution, worker construction, or timer creation;
- both multitable router mounts receive the same frozen canonical main-pool
  transaction/query/depth identity;
- route operations use that injected database runtime instead of resolving a
  later pool;
- runtime and database transaction-depth probes must agree;
- the worker starts after the listener and shutdown waits for in-flight work;
- exact ON without an owner-supplied provider composition fails closed; and
- actor-scoped keyset listing plus modal recreation rediscovers the newest
  durable job without exposing raw plan contents.

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
- the new connection-pool and application-composition modules pass targeted
  ESLint;
- diff check: **PASS**.

The real-DB file is present in all three required places: the workflow whole-file
argument, the no-DB Vitest exclusion, and the mechanical roster/fail-not-skip
guards.

One first migration invocation omitted `DATABASE_URL` and failed against the
driver default before touching the isolated database. It was rejected as
evidence. The explicit-DSN full migration and real-DB command above then passed.
The final implementation candidate also ran a same-DSN migration replay before
the 20/20 suite.

The broader four-source ESLint command is not claimed green: it exits on the
pre-existing `no-extra-semi` at `univer-meta.ts:12923` (blamed to `e0defbe26d`)
and reports the file's existing warnings. This slice did not edit that statement.

### D6 web evidence retained on the same stack

- target client/modal: **2 files / 20 tests PASS**;
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
| ignore the injected canonical route database and re-resolve the pool | route wiring test RED at `recovery route re-resolved the main pool` |
| remove per-entry job-list validation | client spec RED at 4 malformed successful entries becoming accepted |
| reduce timestamp validation to string-only | client spec RED at invalid resume deadline becoming accepted |
| reduce positive-decimal validation to string-only | client spec RED at malformed total-count error shape and zero row version acceptance |
| omit restore-plan child from full-schema cleanup | catalog real-DB suite RED at FK-protected cleanup; **40 tests RED** in the selected file |
| omit test-only trigger bypass for immutable token burns | lease suite RED at immutable burn cleanup; **6 tests RED** |

The lease-reclaim mutation was restored with `apply_patch`; the same two focused
real-DB legs then passed **2/2**. Runtime source is byte-restored; only tests and
documents remain modified for D7.

One first mutation command was invalid because its test filter selected no test;
it was rejected as evidence and not counted. The valid mutation run selected the
revert and reset cases explicitly.

The full-reload rediscovery behavior is covered by direct actor/sheet/list-order
and component-recreation tests. No separate mutation run is claimed for that UI
slice.

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
| Runtime composition | PASS (implementation) | canonical main-pool transaction/query/depth, route identity, exact-OFF gates, worker start, normal drain, and bounded stop failure pass; production provider selection remains HOLD |
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

The full-schema cleanup fix-forward used another fully migrated dedicated
database. Five scratch database drops reported `CLEAN`, residual backends were
zero, and the exact/prefix residue query returned zero after the focused
**182-test** set and both cleanup mutations were restored.

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

The runtime slice then received a separate refute-first review. It identified the
exact-ON no-factory refusal, a possible route pool re-resolution, and a shutdown
failure question. The no-factory refusal is the deliberate owner/provider HOLD.
The route concern was closed structurally by injecting the canonical database
runtime and by the RED/restore mutation above. That review returned
**0 P1 / 0 P2 / 0 P3** for its bounded delta.

A later Kimi read-only review of the published hardening returned **0 P1 / 0 P2**
and three P3 observations at that exact review head: the sheet-ID comparison
overlaps stronger stale response guards; the canonical worker loop contains tick
failures, so the mocked drain-rejection branch was not production-discriminating
and a genuinely stuck stop remained unbounded; and the older read-only catalog
list mapped malformed successful data to an empty catalog. Those findings were
not evidence for flag enablement.

Post-merge checkpoint `6cf88c0e84` closes the latter two observations with
pre-fix RED evidence and the local gates listed above. The overlapping sheet-ID
comparison remains the disclosed P3; no external-model verdict is claimed for
this new local delta.

The same review cycle exposed malformed job-list elements and led to
`4d3a50c627`. Sol then reviewed that exact two-file delta, ran the focused spec at
**10/10** plus web typecheck, and found one P2: UUID/decimal/timestamp values were
still string-only and several validator branches lacked discrimination. The
fix-forwards at `6e4a0ee4e7` and `6beed608f3` expand the exact spec to
**31/31** and add RED/restore mutations for timestamp, decimal, admission
threshold, and JSON primitive guards. `73d3187c8b` makes the timestamp mutation
produce exactly two failures rather than relying on parse or terminal-shape
rejection. Final Sol re-review at exact head `73d3187c8b` reran the focused spec
and web typecheck and returned **0 P1 / 0 P2 / 0 P3**.

## 7. Final verdict

**MERGED D2-D7 FOUNDATION + LOCAL CLOSEOUT: PASS WITH PROVIDER / STAGING HOLD.**

The D7 fault/scale evidence, durable job rediscovery, and provider-neutral runtime
composition are implemented and locally verified. They do not close the
owner/provider or staging/production proof:

- production-like object/KMS runtime factory: missing;
- canonical server startup injection and worker lifecycle: locally implemented;
- exact-ON direct entry without an owner-supplied factory: intentionally refuses;
- staging fault/storage/KMS runbook execution: not performed;
- true OS-process restart: not performed;
- current-main local integration and exact-worktree gates: passed;
- PR #5305 merged at `fac252067a`; its product-code matrix reached `48 SUCCESS /
  1 intentional SKIPPED / 0 failure` at `73d3187c8b` before the report carrier;
- local closeout `6cf88c0e84` has no remote matrix or landing authorization;
- flags: OFF;
- production: untouched.

D1 explicitly leaves KMS/key custody and the production object backend to the
owner. Reusing the approval attachment S3 implementation or inventing a KMS
choice would therefore be a new product decision, not mechanical runtime wiring.

Therefore no statement in this report authorizes the local closeout landing,
deployment, staging flag enablement, or production recovery.
