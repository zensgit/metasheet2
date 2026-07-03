# nodeEntryEpoch implementation — dev & verification (2026-07-03)

> Implements the ratified design-lock (#3501) — the **structural close** for the T2-4 threshold round-scoping
> bug family. Replaces the append-only cutoff heuristic (#3446/#3453/#3499) with a per-node-entry epoch
> recorded at *activation*. **Honest framing:** this is a **completeness-by-construction / heuristic-retirement**
> change, not a live-bug fix — the previously-feared condition/cc "4th vector" turns out **not** to be reachable
> (the executor transparently skips condition/cc nodes, so a forward re-entry still threads `nextNodeKey=X` and
> #3499's clause already scopes it). The epoch's value is that round-scoping stops depending on transition
> inference at all.

## What shipped

- **Migration** (`zzzz20260703120000_add_node_entry_epoch.ts`): `approval_instances.node_activation_seq
  INTEGER NOT NULL DEFAULT 0` + `approval_assignments.entry_epoch INTEGER` (nullable). Idempotent; reversible
  (up→2 cols, down→0, verified).
- **Helpers:** `bumpNodeActivationSeq` (`UPDATE … +1 RETURNING`) and `currentNodeEntryEpoch`
  (`SELECT DISTINCT entry_epoch … is_active=TRUE`; **fails closed** — 409 on empty, 500
  `APPROVAL_NODE_ENTRY_EPOCH_MIXED` on multiple distinct epochs). `insertAssignments` gains an explicit
  `entryEpoch: number|null` argument stamped on every inserted row.
- **9 `insertAssignments` call-sites classified** (§4 two-semantics split):

  | Site | class | epoch source |
  |---|---|---|
  | initial start (`created`) · admin `jump` · timeout-`jump` · `return` · forward advance (`resolveAfterApprove`) | **ACTIVATION** | `bumpNodeActivationSeq` (mint) |
  | admin `reassign`/handover · timeout `transfer` · manual `transfer` · `add_sign` | **MUTATION** | preserve current epoch (read before deactivate; never bump) |

  Admin reassign inserts **grouped-by-source-epoch** (strictly more correct for a multi-node parallel
  handover — never manufactures a mixed-epoch node).
- **Approve-record stamping:** the current node's epoch is resolved once at the top of the approve handler
  while the actor's assignment is still active, and stamped as `metadata.nodeEntryEpoch` on every current-node
  approve (partial / threshold / resolving). `insertAutoApprovalEvents` carries the activation epoch so a
  same-transaction requester-merge/auto-vote counts in-round.
- **Tally (§5/§6, dual-read):** resolve the current epoch from active assignments (fail-closed above); `null`
  (legacy pre-migration activation) → the **retained** cutoff heuristic (#3446/#3499/#3453 — not deleted);
  non-null → `COUNT(DISTINCT actor_id) … metadata->>'nodeKey'=X AND (metadata->>'nodeEntryEpoch')::int = epoch`.
  In-flight instances switch transparently to the epoch path on their next re-activation. No backfill.
- **No API leak:** the two columns are internal (read explicitly; DTO mappers use explicit camelCase fields,
  no raw-row spread) — verified they don't reach approval responses.

## Verification (independently re-run)

- **New suite `approval-node-entry-epoch.test.ts` — 5/5:** condition/cc-in-the-middle (forward-looking
  regression lock); mid-round **manual-transfer** epoch preservation; mid-round **admin-reassign** epoch
  preservation (both assert `node_activation_seq` unchanged across the mutation); **mixed-epoch fail-closed**
  (500, instance untouched); **migration dual-read** + re-activation takeover.
- **Existing `approval-nofm-threshold.test.ts` — 6/6** (incl. #3446 direct re-entry, #3499 through-X, #3453
  same-tx cascade) now pass **via the epoch tally** (instances are post-migration → epoch-stamped), proving
  the epoch mechanism correctly scopes every prior re-entry scenario.
- **Regression:** `approval-node-timeout-effects` 13/13 · `approval-node-sla-remind` 5/5 · modified mock-DB
  unit suites `approval-product-service` + `approval-admin-jump-service` 100/100. `tsc --noEmit` 0.

## Honest caveats

- **No RED-before for the condition/cc vector** — it is not a currently-reproducible bug (see framing above);
  the test is a green completeness lock, not a fail-first bug reproduction.
- **Two pre-existing, unrelated type errors** in excluded test files (`approval-admin-jump-service.test.ts:683`
  stray `version`; `approval-product-service.test.ts:2649` resolver-stub signature) surface only under a
  tests-included typecheck; they predate this change, are outside the diff, and are not CI-gated
  (`tsc --noEmit` excludes `**/*.test.ts`). Left as-is.

## What it retires

The cutoff heuristic (#3446/#3453/#3499) becomes a **dormant legacy fallback** for pre-migration in-flight
instances only. New/re-activated threshold rounds are scoped by the epoch — provably complete, no
transition-metadata inference. The cutoff code can be deleted after a deprecation window once no NULL-epoch
instances remain.
