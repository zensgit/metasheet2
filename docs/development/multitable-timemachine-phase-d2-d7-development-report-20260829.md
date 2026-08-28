# Time Machine Phase D2-D7 development report

**Status:** DRAFT / HOLD. Published for review as Draft PR #5305. The final
code-bearing exact head passed its remote matrix; the report-only refresh still
requires its own exact-head checks. The PR is not merge-ready, not deployed, no
flag is enabled, and production was not accessed.

**Design authority:**
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.

## 1. Exact topology

| Item | Exact value |
|---|---|
| Draft PR | `#5305` (`feat(multitable): integrate Time Machine archive recovery D2-D7`) |
| base / refreshed `origin/main` | `c479e9b321fe772149e367b5d90cb01c21654766` |
| branch merge-base | `c479e9b321fe772149e367b5d90cb01c21654766` |
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
| final code-bearing head before report refresh | `73d3187c8b6be375c710ce38a92c42468c74c458` |
| final code-bearing tree | `eb16faa33b49bcb4e7727bc5917a24a726d43254` |
| code-head remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure` |

The integration merge is a true two-parent merge of the final source evidence
head and refreshed `origin/main`; both are ancestors. Later commits close durable
job rediscovery, provider-neutral application wiring, exact-head CI failures, and
malformed job-list handling on that tree. Draft PR #5305 is the review carrier;
Draft publication is not merge authorization, flag authorization, or deployment
evidence.

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
| worker-stop rejection branch is not exercised by the canonical loop | the loop contains tick failures; bounding a genuinely stuck in-flight stop remains a disclosed follow-up |
| catalog-list malformed `2xx` still maps to an empty read-only catalog | unlike durable job discovery, this older display path remains fail-open and must not be cited as absence evidence |
| sheet ID discovery comparison overlaps stronger generation/job guards | defense remains, but removing that comparison alone is not mutation-discriminating |
| Draft PR code-head remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure`; report-only head still requires its own checks |

The provider rows cannot be closed by choosing an adapter implicitly. D1 leaves
KMS/key custody and the production object backend as explicit owner decisions.
Staging may use local storage, but that does not choose or prove the production
failure domain.

## 5. Coordination status

- Approval/automation remains a separate HOLD queue. Phase D did not edit its
  implementation branches or merge any approval PR.
- Approval FWB and automation writes continue to use the shared writer-block
  entry; D5 did not create a second authority table or lock order.
- Cloud Classroom used explicitly serialized shared/DB windows, returned both
  with clean residue, and remains in separate worktrees. None of its product or
  shared-union bytes are mixed into this Time Machine candidate.

## 6. Change discipline

- The branch was pushed and Draft PR #5305 was opened for exact-head review.
- No Ready transition, merge, deployment, dispatch, staging action, or production
  access was performed.
- No flag was enabled or changed.
- D7 adds only the bounded durable-list and application-runtime slices described
  above plus their focused tests. It does not select a KMS/object-store provider.
- Isolated local databases were used for source-head and current-main D7
  verification and dropped after each run; exact and prefix residue counts
  returned zero.

## 7. Next gated work

1. Obtain the explicit owner choices for KMS/key custody and the staging/production
   object backend; do not infer them from another product surface.
2. Finish independent review and require the complete exact-head remote check
   set, including the Node 20 full-schema real-DB lane at zero skipped; Draft
   status remains until the owner separately authorizes landing.
3. Obtain a new owner staging-only authorization and execute the D7 runbook,
   including a true process restart and provider/KMS fault legs.
4. Keep production and all Time Machine flags unchanged until a later, separate
   enablement decision.
