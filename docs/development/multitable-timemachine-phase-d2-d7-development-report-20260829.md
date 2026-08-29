# Time Machine Phase D2-D7 development report

**Status:** MERGED FOUNDATION / LOCAL CLOSEOUT CANDIDATE HOLD. PR #5305 merged
through `fac252067ab1c22d910266ac2ba29016c2b5fe43` on 2026-08-29. The local
closeout code/test candidate `9c5c082a53a26e4ae55f02b1724b99826e9abb95`
and its report carrier `b8893e6b860d09b2b5518adbdbffbadb74073d8d`
are replayed by true merge onto then-current main
`9d29e7a7d339be5ce4fb276c2e96b1a2ae67e17c` at
`0464d551d829ac020a6504e49c54f64a8d17c03a`. The code/test candidate closes the
disclosed malformed catalog/job-list/preview/execute/job success responses,
bounds a stuck restore-worker drain at ten seconds, makes every concurrent stop
caller observe the same result, and makes a failed signal shutdown exit
non-zero. The candidate is local only: it has not
been pushed, reviewed by remote CI, staged, or deployed. No Time Machine flag is
enabled and production was not accessed.

**Design authority:**
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.

## 1. Exact topology

| Item | Exact value |
|---|---|
| merged PR | `#5305` (`feat(multitable): integrate Time Machine archive recovery D2-D7`) |
| #5305 original base / merge-base | `c479e9b321fe772149e367b5d90cb01c21654766` |
| merged PR head | `beeff6b3765cff463f8887d58f6b3fb11b8a5a61` |
| merge commit | `fac252067ab1c22d910266ac2ba29016c2b5fe43` |
| D2-D6 local head before D7 evidence | `d0fc5a5a2be412500604f70cba172536cb40f086` |
| D7 test + runbook evidence | `70b5e53f2144dc09a2aa46d7af94adffcbac7de8` |
| final source evidence head | `def68afe85d759f130656882c3bf5de2e98dbb8a` |
| current-main integration merge | `023f5e793305401fbfdbe05d81ac9db90b1b2838` |
| durable job rediscovery | `05d176c21d` |
| runtime composition | `bb12c9264ab9948312826fdb56ffb30abbad8a9c` |
| first report checkpoint | `a55ffabbcb` |
| sealed-export provenance refresh | `70efefc0b5` |
| post-publish behavior hardening | `1eaaee9869` |
| full-schema real-DB cleanup hardening | `5c1184e173` |
| closed job-list entry shape | `4d3a50c627` |
| backend-aligned job-list scalar semantics | `6e4a0ee4e7` |
| final job-list wire semantics | `6beed608f3` |
| timestamp-type mutation discrimination | `73d3187c8b` |
| final product-code head | `73d3187c8b6be375c710ce38a92c42468c74c458` |
| final product-code tree | `eb16faa33b49bcb4e7727bc5917a24a726d43254` |
| product-code remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure` |
| key-registry scratch-drain hardening | `e19b65041d9fd79a556bb58b0c40734b2066c874` |
| final code/test tree before report refresh | `6ac12d5efa2849faecdd4de32f4414574b90bb82` |
| post-merge closeout original base | `3f30d8eb4f27f9972b640e2d69e2c3dab2837ae5` |
| then-current main replay parent | `5eb83055937ebecc9be690bcf721a8cc89ca27d0` |
| local true-merge replay | `c1863ea288f4a23a0736b6984c51d8dfa867b714` |
| empty catalog response hardening | `0d5fd1adf51f0447722d9d23fb675797f108da3f` |
| empty job-list response hardening | `0767a3781e2452c8693a33c6197a2c7bef6d9490` |
| first operation-response and shutdown fix-forward | `a9835b0efa1af52408b5a8848af2247f05715e4d` |
| exact response-shape and stop-replay hardening | `7fcc57d9ec31e5d8735105a3cccabdec181db06d` |
| exact response-shape mutation lock | `9c5c082a53a26e4ae55f02b1724b99826e9abb95` |
| post-merge closeout code/test tree | `3831f7c62a13e296715dbfb1f18becfacba82fb2` |
| prior report-only carriers | `886a24da5d1f4533a40b5310ec0dd2510523b105`, `6f468e3f211713483c02d0ab8a7cb747fc7078a7`, `332b13efd87e3352250c6ffa39be0a95ef01b5c4` |
| final local report carrier before latest replay | `b8893e6b860d09b2b5518adbdbffbadb74073d8d` |
| latest then-current main replay parent | `9d29e7a7d339be5ce4fb276c2e96b1a2ae67e17c` |
| latest local true-merge replay | `0464d551d829ac020a6504e49c54f64a8d17c03a` |
| latest local replay tree | `c8574f916171d50f0fc8fe9e9426bc3f41aa29b1` |
| post-merge closeout remote matrix | not run; local checkpoint only |

The integration merge is a true two-parent merge of the final source evidence
head and refreshed `origin/main`; both are ancestors. Later commits close durable
job rediscovery, provider-neutral application wiring, exact-head CI failures, and
malformed job-list handling on that tree. PR #5305 subsequently landed as the
true merge above. Merge is implementation history only; it is not flag
authorization, staging evidence, or deployment evidence.

Main commit `c479e9b321` fixes false-green entry guards in the recovery containment
workflow and reset-acceptance harness. The candidate preserves all three affected
file blobs byte-for-byte from `origin/main`, and the resulting containment and
reset guards were rerun. The other main-only commit remains isolated to the
stock-preparation sandbox.

## 2. Delivered implementation

### D2 archive substrate

- Closed archive/catalog/manifest/coverage contracts and exact section order.
- Section-causality and operation-bound evidence, including bootstrap/snapshot
  authority and coverage bindings.
- Writer-block ownership, source-writer/deleter fencing, attachment source pins,
  object references, key/nonce reservation, AEAD/MAC, source vector, staging
  object-store boundary, and fail-closed lifecycle primitives.
- Default-off, exact-literal archive flag registered without enabling it.

The last D2 claim-anchor checkpoint in this stack is
`21bf5b9166917884e378c7c6f9ccef53fdff39fb`.

### D3 catalog lifecycle and legal hold

- Current-head generation/catalog read authority.
- Legal-hold placement/release and lifecycle claim pins.
- Expiry/delete/key-retirement authority remains receipt- and fence-bound.

The D3 restacked head is
`fe6737f9ad0136714fb172baa3b8f0f099154215`.

### D4 authenticated reconstruction

- One authenticated archive reader/reconstructor consumes the D2/D3 section
  authority and floor-aware record replay seam.
- Exact generation/root/source-vector and section integrity remain bound.

The D4 head is `af84583d04bc3c95d5164bfd355bd2947c761966`.

### D5 restore planner and durable async execution

- Owner-safe catalog/list/read/preview/execute/status/resume/cancel routes.
- Preview-first signed identity with closed whole-sheet/selected-record/
  selected-field scopes.
- Sync execution below the effective-write ceiling through the existing L8
  authority/apply kernel.
- Async admission above the ceiling, immutable plans/chunks, distinct immutable
  block fence and renewable worker fence, deterministic chunk receipts, bounded
  worker loop, aggregate terminal operation, cancellation, and resume.
- Job handles remain sheet-scoped in the client; stale responses cannot overwrite
  a newer sheet context.
- An owner/current-actor scoped, newest-first keyset list route now rediscovers a
  durable job after the modal component has been recreated. Discovery is
  fail-closed and suppresses catalog actions until it resolves.

Key D5 checkpoints:

| SHA | Delivery |
|---|---|
| `a19f232e5e` | durable restore job schema and authority |
| `3b9020cf6d` | immutable async plans |
| `048037e711` | chunk state/receipt binding |
| `7982d8666d` | production-code async chunk facade |
| `cb501cecb0` | bounded worker and lease ownership |
| `51699e62e8` | owner cancellation route |

### D6 owner UI

Commit `d0fc5a5a2b` adds:

- catalog generation selection;
- whole-sheet, selected-record, and selected-field scopes;
- preview-first diff/count presentation;
- sync result and async job progress;
- resume/cancel/re-poll behavior;
- responsive desktop/mobile layout;
- values-free failure presentation.

The execute action remains unavailable when preview/runtime authority fails. The
UI does not infer flag state from a client-visible flag.

### D7 evidence and runtime closeout

D7 closes the remaining local implementation seams without choosing a production
provider:

1. A real encrypted 5,001-record archive restore now proves a simulated worker
   disappearance after committed chunk 0, DB-clock lease expiry, immutable
   block-fence preservation, worker-fence increment, stale-claim refusal,
   exact-once restore evidence for all 5,001 records, aggregate finalization, and
   writer-block release. A true process restart remains a staging runbook gate.
2. A route-level flag-OFF parity test pins a historical SHA-256 over complete
   response text plus every normalized SQL statement and parameter, then compares
   unset, `false`, `TRUE`, whitespace, and `1` archive flag values.
3. The server captures one canonical main-pool database runtime: transaction,
   autocommit query, and AsyncLocalStorage transaction-depth probe. Both
   multitable router mounts receive the same frozen runtime identity.
4. Exact archive + writer-fence `true` is required before provider composition,
   worker construction, or timer creation. Non-exact and OFF paths remain
   byte-inert with respect to archive provider/database probes.
5. The application constructs the canonical restore worker directly, starts it
   only after the listener is active, and waits for its in-flight loop before
   later shutdown tasks. Injected composition may provide business dependencies
   and provider custody only; it cannot replace the worker or database authority.
6. Direct entry with exact-ON flags but no owner-supplied composition factory
   refuses startup. That is the intended fail-closed boundary until KMS/key
   custody and object-store choices are ratified.
7. This staging runbook and the paired development/verification reports keep the
   remaining provider, staging, and remote-CI gates explicit.

### Review and CI fix-forwards

Publishing the Draft exposed three defects that local source-head evidence did
not reveal. They were fixed on the same branch before closeout:

1. `1eaaee9869` makes malformed successful job-list envelopes fail closed,
   invalidates late job discovery when the modal closes, prevents pool closure
   after an asserted worker-drain failure, and updates the frozen attendance
   source census for the new application wiring.
2. The first full Node 20 real-DB matrix reached D2-D5 tests that shared a fully
   migrated schema. It found incomplete child cleanup, immutable token-burn rows,
   and an unowned direct backend termination. `5c1184e173` closes the full child
   graph with test-only transaction-local trigger bypass and uses the shared
   scratch-database drain/drop helper.
3. `4d3a50c627`, `6e4a0ee4e7`, and `6beed608f3` validate every successful job-list entry as the
   exact public seven-field shape: UUID job ID, closed state, valid decimal
   counts/version, valid timestamps, terminal/count invariants, and no internal
   plan or worker fields. The final delta also enforces the database admission
   boundary `totalCount > 5000` and rejects numeric JSON primitives instead of
   coercing them. `73d3187c8b` makes both numeric timestamp negatives independently
   mutation-discriminating. Malformed entries can no longer become false absence.
4. The first report-only matrix ran all 2,679 multitable tests successfully but
   exited non-zero on one unhandled PostgreSQL `57P01` during scratch teardown.
   The error was traced to the D2 key-registry test's ad hoc immediate backend
   termination, not a failed product assertion. `e19b65041d` moves that suite to
   the existing owned-pool termination handler and fail-closed scratch drain/drop
   helper. The exact file then passed four consecutive real-DB runs at **10/10**,
   every drop reported `scratchDrain=CLEAN residualBackends=0`, and the final
   database-prefix residue was zero.
5. Post-merge checkpoint `6cf88c0e84` validates the read-only archive catalog as
   the exact public seven-field shape instead of manufacturing an empty list from
   malformed success data. It also gives the canonical worker loop a ten-second
   drain bound; timeout maps to the existing values-free stop error, and the
   server preserves the existing rule that the database pool stays open when the
   worker has not definitely drained.
6. The current-main replay at `c1863ea288` preserves that product delta while
   incorporating `5eb8305593` as the exact second parent. `0d5fd1adf5` and
   `0767a3781e` then normalize successful 204/empty-body responses for both the
   archive catalog and durable job list to their fixed values-free domain errors.
   A truthy primitive catalog body is also rejected as malformed.
7. Opus 5 found two remaining closeout defects. `a9835b0efa` makes preview,
   execute, accept, read, resume, and cancel reject 204/empty successful bodies
   instead of resolving `undefined`. It also propagates a worker-drain failure
   through `server.stop()` and maps a failed SIGTERM/SIGINT shutdown to exit 1,
   while preserving the rule that the database pool stays open until the worker
   has definitely drained.
8. Opus 5's re-review found three remaining discrimination gaps. `7fcc57d9ec`
   validates the exact preview and execute wire shapes, so successful envelopes
   with `data: null`, missing `data`, 204, or an empty body all fail closed. The
   same job-snapshot validator is exercised independently by accept, read,
   resume, and cancel. Server shutdown now memoizes one stop promise, so a second
   SIGTERM/SIGINT caller observes the original failure instead of resolving, and
   the runtime registration source is pinned to the non-zero failure mapper.
9. Sol's final review found the exact preview/execute branches were not yet
   mutation-locked. `9c5c082a53` adds 11 non-null malformed preview objects and
   eight non-null malformed execute objects covering missing/extra keys, closed
   enums, UUID/decimal/identity/count shapes, summary rows, and executable-state
   coherence. Five guard-category mutations each turned the matching cases red;
   the restored exact head passed **78/78** client tests and **95/95** with the
   modal neighbor. Sol's follow-up verdict is **0 P1 / 0 P2 / 0 P3**.

## 3. Architecture boundaries preserved

- No second destructive apply kernel was introduced; D5 delegates live writes
  to the existing exact-anchor/L8 authority path.
- Provider/object-store/KMS calls are outside database transactions by contract
  and instrumentation.
- The immutable job block fence is separate from worker lease ownership.
- Archive source pins and durable archive-object references are distinct.
- Live permission grants are not restored.
- System sheets, cross-sheet atomic restore, wall-clock destructive restore,
  permission restore, and unproved resurrection remain out of scope.
- All ordinary errors/evidence are values-free.

## 4. Explicitly unfinished

These are real residuals, not documentation polish:

| Residual | Consequence |
|---|---|
| no production object-store/KMS runtime factory | local/test providers are not production durability evidence |
| direct-entry exact-ON has no owner-selected composition factory | startup deliberately refuses instead of silently using an unratified provider |
| no executed staging fault/storage/KMS window | D7 cannot claim staging acceptance yet |
| no true OS-process restart exercise | the 5,001-record test proves same-process lease takeover, not host/process recovery |
| fixed ten-second worker-stop bound | the bound is fail-closed but is not composition-configurable; changing it is a separate runtime policy decision |
| sheet ID discovery comparison overlaps stronger generation/job guards | defense remains, but removing that comparison alone is not mutation-discriminating |
| post-merge closeout candidate is local only | code/test checkpoint `9c5c082a53` is carried by true-merge replay `0464d551d8` onto main `9d29e7a7d3`, with local gates plus Opus 5, Sol, and Luna review evidence, but no push, PR, or remote matrix |

The provider rows cannot be closed by choosing an adapter implicitly. D1 leaves
KMS/key custody and the production object backend as explicit owner decisions.
Staging may use local storage, but that does not choose or prove the production
failure domain.

## 5. Coordination status

- Approval/automation remains a separate replay queue. Phase D did not edit its
  implementation branches or merge any approval PR.
- Approval FWB and automation writes continue to use the shared writer-block
  entry; D5 did not create a second authority table or lock order.
- Cloud Classroom remains in a separate product-only hardening worktree. None of
  its product or shared-union bytes are mixed into this Time Machine candidate.

## 6. Change discipline

- PR #5305 was merged through `fac252067a`; this report now records that result
  rather than preserving the obsolete Draft claim.
- The post-merge closeout branch remains local. Code replay `0464d551d8` and
  report head `771d7b38ee` were not pushed, and no closeout PR was opened.
- No deployment, dispatch, staging action, or production access was performed.
- No flag was enabled or changed.
- D7 adds only the bounded durable-list and application-runtime slices described
  above plus their focused tests. It does not select a KMS/object-store provider.
- Isolated local databases were used for source-head and current-main D7
  verification and dropped after each run; exact and prefix residue counts
  returned zero.

## 7. Next gated work

1. Obtain the explicit owner choices for KMS/key custody and the staging/production
   object backend; do not infer them from another product surface.
2. Recheck `origin/main` before any push. The current true-merge replay
   `0464d551d8` is bound to main `9d29e7a7d3`; if main moves again, replay first.
   Then require complete exact-head remote checks and another bounded
   replay-delta review before a separate landing decision. Local green evidence
   is not that decision.
3. Obtain a new owner staging-only authorization and execute the D7 runbook,
   including a true process restart and provider/KMS fault legs.
4. Keep production and all Time Machine flags unchanged until a later, separate
   enablement decision.
