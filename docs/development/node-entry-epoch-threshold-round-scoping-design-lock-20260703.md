# nodeEntryEpoch — durable T2-4 threshold round-scoping · DESIGN-LOCK (PROPOSED) · 2026-07-03

> **Status: PROPOSED design-lock — awaiting owner ratification.** Owner-directed 2026-07-03: after the 3rd
> cutoff-heuristic patch (#3446 name-X · #3453 same-version cascade · #3499 through-X) plus an open condition/cc
> 4th-vector verify-item, promote the register's **Option B (`nodeEntryEpoch`)** to the next design-lock — the
> structural fix that retires this bug family. **No runtime is written until this is voted GO.**
>
> **Rev 2 (review response):** §4 now splits the two `insertAssignments` semantics — **activation** (mint a new
> epoch) vs **same-round mutation** (add-sign / reduce-sign / manual transfer / timeout transfer / admin
> reassign-handover — preserve the epoch, never bump) — because `insertAssignments` is shared (P1). §5 resolves
> the current epoch from **active** assignments and **fails closed on a mixed/multiple epoch** instead of
> `MAX()`-collapsing (P2). §7/§9 add the mid-round-mutation and mixed-epoch cases.

## 1. Problem — the cutoff heuristic is inherently incomplete

The threshold (门槛会签) quorum tally counts DISTINCT approver ids among append-only approve records at node X.
Because X can be re-entered (return/jump to X, or return to an ancestor then forward into X), prior-round
approves get re-counted → a single fresh vote re-satisfies an N-of-M. Every fix so far reconstructs "which
round am I in" by pattern-matching `nextNodeKey`/`targetNodeKey`/`toNodeKey` across records (the `cutoff`):

- **#3446** — scope by MAX(`to_version`) of return/jump records **naming X**.
- **#3453** — `>= cutoff` (not `>`) so a same-transaction auto-approval cascade at X counts.
- **#3499** — broaden cutoff to the **entry transition** (`nextNodeKey=X AND nodeKey<>X`), catching re-entry
  *through* X from an upstream return target.
- **OPEN verify-item** — a condition/cc node between the upstream target and X may make the upstream approve's
  `nextNodeKey` the *condition* node, not X → cutoff NULL → the bypass could survive.

This is whack-a-mole: the tally infers rounds from transition metadata instead of recording them.

## 2. Recommended mechanism

Stop inferring the round from transition metadata; **record it at the source**. Each time a node is
(re)activated, mint a fresh **node-entry epoch** and stamp it on that activation's assignment rows; copy the
epoch onto every approve record written for that node; tally only the approves whose epoch equals the node's
**current** epoch. The epoch keys off *activation*, not off how the flow reached the node — so it is complete
for every entry vector (direct return/jump, forward re-entry, timeout-jump, and condition/cc-in-the-middle)
**by construction**, with no metadata pattern-matching.

## 3. Epoch source + storage

- **Source:** a per-instance monotonic **activation sequence**. A new column
  `approval_instances.node_activation_seq INTEGER NOT NULL DEFAULT 0` is incremented by 1 **each time a node is
  activated** (initial activation, forward advance, return, jump, timeout-jump). The value after the increment
  is that activation's epoch.
- **Carried on assignments:** a new column `approval_assignments.entry_epoch INTEGER` (nullable for legacy),
  stamped = the instance's post-increment `node_activation_seq` when the activation's assignment rows are
  inserted. All assignments created in one activation share the epoch.
- **Carried on approve records:** `metadata.nodeEntryEpoch` = the `entry_epoch` of the assignment being
  approved (for a manual approve) or of the just-created assignments (for a same-transaction auto-approval
  cascade at entry).

Rationale for both a column and metadata: the **current** epoch is read cheaply off the node's active
assignments (authoritative, transactional), while the approve records carry a self-contained epoch so the
tally is a plain indexed filter with no join to a mutable table.

## 4. Stamping sites — two distinct assignment-insert semantics (CRITICAL, review P1)

`insertAssignments` (`ApprovalProductService.ts:~5309`) is **shared** by both node activations AND same-round
assignee mutations, so the epoch must be decided by the **caller**, not by "an insert happened". A naive
"insert → bump seq" rule would (a) split one round across two epochs on a transfer/reassign, or (b) leave the
transferred-in / reassigned-to assignee's approve at a NULL/foreign epoch → uncounted under the epoch tally.
Both silently corrupt the quorum. Split the call sites into two classes:

**(A) Activation assignment insert → MINT a new epoch.** The paths that land the instance on a (re)activated
current node: initial start, forward advance (`resolveAfterApprove`), `return`, admin/`jump`, and timeout-jump.
Bump `node_activation_seq` by 1 and stamp the new rows' `entry_epoch` = the bumped value.

**(B) Same-round assignment mutation → PRESERVE the current node epoch, NEVER bump.** The paths that change
who is assigned at the CURRENT node within the SAME round: **add-sign**, **reduce-sign**, **manual transfer**,
**timeout transfer** (T1-1 slice-2), and **admin scoped reassign / handover** (T2-1+2). Read the current node's
epoch off its active assignments and stamp any newly-inserted row with THAT epoch (reduce-sign inserts nothing
→ no change). These MUST NOT bump `node_activation_seq`.

> **Implementation contract:** `insertAssignments` takes the epoch as an **explicit argument** (or splits into
> `insertActivationAssignments` vs a same-round variant) — activation call-sites pass the freshly-bumped seq;
> mutation call-sites pass the preserved current epoch. This split is the load-bearing part of the design; the
> matrix in §7 is the authoritative per-path mapping and every call-site of `insertAssignments` must be
> classified against it during implementation.

**`insertApprovalRecord`** (`~5466`) for an approve at node X: set `metadata.nodeEntryEpoch` = the approving
assignment's `entry_epoch` — so a transferred-in / reassigned-to / add-signed approver carries the SAME
current-round epoch and is counted. The auto-approval cascade (`insertAutoApprovalEvents`) stamps the same
epoch as the assignments it created in that transaction.

## 5. The new tally

The threshold dispatch (`~4738-4790`) replaces the cutoff query + `to_version` filter. Resolve the current
epoch from the node's **ACTIVE** assignments (the authoritative current round) and **fail closed on any
inconsistency** rather than letting `MAX()` paper over it (review P2):

```sql
-- current epoch of node X = the DISTINCT epoch of its ACTIVE assignments
SELECT DISTINCT entry_epoch
  FROM approval_assignments
 WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE;
```

Interpret the result set:
- **A single NULL row** (all active rows NULL) → a legacy pre-migration activation → **cutoff-heuristic
  fallback** (§6).
- **Exactly one non-NULL epoch** → that is the current epoch → run the tally below.
- **Mixed NULL/non-NULL, or more than one distinct non-NULL epoch** → a STRUCTURAL invariant violation (a
  single round must never span epochs; §4's two-semantics split is what guarantees this) → **fail closed**:
  block resolution and log a structural error. Do **not** `MAX()`-collapse it — silently taking the highest
  could under- or over-count the quorum. (A defensive belt against a mis-classified `insertAssignments`
  call-site, so such a bug surfaces loudly instead of as a wrong vote count.)

```sql
-- quorum tally, scoped to the current round
SELECT COUNT(DISTINCT actor_id) AS count
  FROM approval_records
 WHERE instance_id = $1
   AND action = 'approve'
   AND metadata->>'nodeKey' = $2
   AND (metadata->>'nodeEntryEpoch')::int = $3;   -- $3 = the single current epoch
```

`distinctApproverCount = priorDistinctApprovers + 1` (the current actor's assignment is still active) is
unchanged. No `to_version`, no `nextNodeKey`/`targetNodeKey` inference.

## 6. Migration / in-flight handling (the hard part)

The columns are additive (`node_activation_seq DEFAULT 0`, `entry_epoch` NULL for pre-migration rows). The
risk is a threshold instance **pending mid-round at deploy**: its active assignments have `entry_epoch = NULL`
and its round's approve records have no `metadata.nodeEntryEpoch`.

**Recommended: dual-read fallback (no risky backfill).** At tally time, read the current node's active-
assignment epoch (§5). If it is **NULL** (a legacy pre-migration activation), fall back to the existing
**cutoff heuristic** (#3446/#3499 logic, retained as the legacy path) for that instance. If it is **non-NULL**
(activated post-migration), use the epoch tally. An in-flight instance therefore keeps its current (correct)
cutoff behavior until its node next re-activates — at which point the fresh activation stamps an epoch and the
instance transparently switches to the epoch path. No record is ever mis-counted, and no round has to be
reconstructed. The cutoff code is deleted only after a deprecation window when no legacy-epoch instances remain
(or never — it is a cheap dormant fallback).

## 7. Edge matrix — each round event → same / new epoch

| Event | Epoch effect |
|---|---|
| Initial activation of X | **new** (seq→1) |
| Forward advance into X (incl. through a condition/cc node) | **new** (seq++) — activation-keyed, entry vector irrelevant |
| return/jump **to** X | **new** (seq++) |
| timeout-jump into X | **new** (seq++) |
| same-transaction auto-approval cascade **at** X's entry | **same** as X's just-stamped epoch (must count) |
| partial approval at X | **same** (no activation) |
| **add-sign** at X | **same** as X's current epoch (adds to the round; seq NOT bumped) |
| **reduce-sign** at X | no change (no insert) |
| **manual transfer** at X | **same** as X's current epoch (assignee change within the round; seq NOT bumped) |
| **timeout transfer** at X (T1-1 s2) | **same** as X's current epoch (seq NOT bumped) |
| **admin reassign / handover** at X (T2-1+2) | **same** as X's current epoch (seq NOT bumped) |
| X decided → advances away | X's epoch frozen; next node gets a new epoch |

The bottom block (transfer/reassign/add-sign) is the review-P1 correction: these reuse `insertAssignments`
but are **class (B)** same-round mutations — they preserve X's epoch so the new assignee's approve counts in
the same round. Only the top block (activation) mints a new epoch.

The condition/cc-in-the-middle 4th vector is closed: X's epoch is minted when X is *activated*, so it does not
matter that the upstream approve's `nextNodeKey` named the condition node rather than X.

## 8. Open owner decisions

1. **Storage shape:** instance `node_activation_seq` + assignment `entry_epoch` + approve `metadata.nodeEntryEpoch`
   (recommended, self-contained tally) vs a leaner variant (e.g. epoch only in approve metadata, current epoch
   derived differently). Recommend the full triple.
2. **Migration:** dual-read fallback (recommended — zero backfill risk) vs a backfill that stamps epochs on
   existing active assignments + their round's approves.
3. **Cutoff retirement:** keep the cutoff code as a dormant legacy fallback indefinitely, vs delete after a
   deprecation window once no NULL-epoch instances remain.
4. **Index:** add `(instance_id, node_key)` partial index on `approval_records` for the epoch filter, or rely
   on the existing indexes (perf only).

## 9. Verification plan (fail-first)

- **Provable-completeness set (all must stay green under the epoch tally):** the #3446 direct return-to-X test,
  the #3499 through-X-from-upstream test, and the #3453 same-version-cascade `>=` case — re-expressed against
  the epoch (the cascade approve carries the entry epoch).
- **NEW — the condition/cc-in-the-middle vector** (the cutoff's open 4th vector): `N1 → condition → X(2-of-3)
  → N3`; A+B approve X → advance; return to N1; forward through the condition into X; a single fresh vote must
  NOT re-resolve. RED-before under the cutoff (if the upstream approve names the condition node), green under
  the epoch.
- **NEW — mid-round-deploy migration test:** seed a threshold instance pending mid-round with legacy
  (epoch-less) assignments + approves; assert the dual-read fallback scopes it correctly; then re-activate the
  node and assert the epoch path takes over and excludes the legacy round.
- **add-sign within a round** counts toward the same round (same epoch); **reduce-sign** unaffected.
- **NEW — mid-round assignee mutation preserves the epoch (review P1):** on a threshold node mid-round,
  (i) a **manual transfer**, (ii) a **timeout transfer**, and (iii) an **admin reassign / handover** each hand
  the seat to a new assignee; the new assignee's approval MUST count under the SAME `nodeEntryEpoch` (i.e. it
  still contributes toward the current round's quorum, and does NOT reset the count). One test per path; assert
  `node_activation_seq` did not change across the mutation.
- **NEW — mixed-epoch fail-closed (review P2):** force a threshold node whose active assignments carry two
  different non-NULL epochs (a deliberately mis-classified insert) and assert resolution **fails closed** with a
  structural error rather than silently `MAX()`-resolving.
- Regression: the normal single-entry 2-of-3 resolves on the 2nd distinct approval; N>M fail-closed unchanged.

## 10. What it retires

The whole cutoff heuristic (#3446 / #3453 / #3499) + the condition/cc verify-item — replaced by a provably
complete per-node-entry epoch. Round-scoping stops depending on transition-metadata inference.

## 11. Status / next step

Design-lock PROPOSED. On owner ratification → implement in **Lane B** (`ApprovalProductService.ts` threshold
dispatch + a migration), fail-first + real-DB (including the condition/cc vector and the migration test),
PR-for-review. Until then, the cutoff fixes (#3446/#3453/#3499) remain the in-place guard.
