# Time Machine Phase D2-D7 development report

**Status:** DRAFT / HOLD. Local implementation checkpoint only. Not merge-ready,
not deployed, no flag enabled, and no production access.

**Design authority:**
`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`.

## 1. Exact topology

| Item | Exact value |
|---|---|
| refreshed `origin/main` | `c479e9b321fe772149e367b5d90cb01c21654766` |
| branch merge-base | `e0956fd5c13b5500ae68c2425b97706d8a761043` |
| D2-D6 local head before D7 evidence | `d0fc5a5a2be412500604f70cba172536cb40f086` |
| D7 test + runbook evidence | `70b5e53f2144dc09a2aa46d7af94adffcbac7de8` |
| branch relation at D7 drafting | 2 commits behind / 91 commits ahead of `origin/main` |

The branch therefore requires a then-current-main replay/range-diff and complete
exact-head CI before any merge decision. This report does not treat old-head
green checks as merge-state evidence.

One of the two main-only commits, `c479e9b321`, fixes false-green entry guards in
the recovery containment workflow and reset-acceptance harness. A future replay
must preserve that fix and rerun the resulting union; the two-commit drift is not
mere metadata. The other main-only commit is isolated to the stock-preparation
sandbox.

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

### D7 evidence additions

D7 adds tests and documents only:

1. A real encrypted 5,001-record archive restore now proves a simulated worker
   disappearance after committed chunk 0, DB-clock lease expiry, immutable
   block-fence preservation, worker-fence increment, stale-claim refusal,
   exact-once restore evidence for all 5,001 records, aggregate finalization, and
   writer-block release. A true process restart remains a staging runbook gate.
2. A route-level flag-OFF parity test pins a historical SHA-256 over complete
   response text plus every normalized SQL statement and parameter, then compares
   unset, `false`, `TRUE`, whitespace, and `1` archive flag values.
3. This staging runbook and the paired development/verification reports make the
   remaining runtime and enablement gaps explicit.

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
| application startup mounts `univerMetaRouter()` without `recoveryArchiveRuntime` | archive preview/execute/accept remains unavailable in the shipped server composition |
| no application caller for `bootRecoveryArchiveRestoreWorker` | durable async jobs will not advance in a real server process |
| no production object-store/KMS runtime factory | local/test providers are not production durability evidence |
| no executed staging fault/storage/KMS window | D7 cannot claim staging acceptance yet |
| no list-jobs endpoint | a full browser reload cannot rediscover an unknown job id; in-workbench sheet switching is covered |
| branch is behind current main | replay/range-diff and exact-head CI are still mandatory |

## 5. Coordination status

- Approval/automation remains a separate HOLD queue. Phase D did not edit its
  implementation branches or merge any approval PR.
- Approval FWB and automation writes continue to use the shared writer-block
  entry; D5 did not create a second authority table or lock order.
- The cloud-classroom authority integration candidate remains frozen in its own
  worktree. Its pending shared CI-union changes are not mixed into this Time
  Machine D7 checkpoint.

## 6. Change discipline

- No push, PR, Ready transition, merge, deployment, dispatch, or production
  access was performed for D7.
- No flag was enabled or changed.
- The only D7 code-tree edits are tests; runtime implementation bytes remain at
  the D6 checkpoint.
- One isolated local database was used for D7 and was dropped after verification;
  exact and prefix residue counts both returned zero.

## 7. Next gated work

1. Independent review and local D7 evidence commit.
2. Replay onto then-current main, preserve every workflow/test union, and rerun
   exact-head required CI with the real-DB lane at zero skipped.
3. Implement and review the application runtime/worker/provider composition.
4. Obtain a new owner staging-only authorization and execute the D7 runbook.
5. Keep production and all Time Machine flags unchanged until a later, separate
   enablement decision.
