# W7-3 lock-order census (#4556)

**Status: build-time census for the W7-3 context-source transition writer.** This is a required
deliverable of the slice, not an argument in its PR body: the writer is a port that takes locks and
is wired into a tree where other writers already hold locks — the `#4899` shape.

A census is **head-scoped like any other verdict.** It was taken at
`origin/main = 4711a9c417780991b3b6c6d95233e629474744f4`. Whoever rebases this slice must re-run the
greps below at the eventual base rather than inheriting this document.

---

## 1. What the W7-3 writer takes, in order

`transitionAttendanceW7ContextSourceV1`
(`packages/core-backend/src/attendance/w7-context-source-transition.ts`):

| # | Lock | Scope | When |
|---|---|---|---|
| 1 | W7 context-source advisory key, **exclusive** | **SESSION** (`pg_advisory_lock`) | its own standalone statement, strictly **before** `BEGIN ISOLATION LEVEL SERIALIZABLE`, after `assertConnectionIsIdleV1` |
| 2 | W4 class-`00` org rollout advisory key, **shared** | transaction (`pg_advisory_xact_lock_shared`) | inside the transaction, immediately before `resolveSegmentCalculationPosture` |
| 3 | `attendance_calculation_context_source_state` row | row (`FOR UPDATE`) | after 2 |
| 4 | `attendance_import_jobs` rows | row (`FOR UPDATE`) | via `countIncompleteOperationsV1` |
| 5 | `attendance_records` rows | row (`FOR UPDATE`) | via `countUnresolvedIngressReviewsV1` |
| 6 | `attendance_requests` rows | row (`FOR UPDATE`) | via `readAttendanceRequestSnapshotDefectReportV1` |

`planAttendanceW7ContextSourceTransitionV1` takes **none of 1**; it opens its own SERIALIZABLE
transaction, may take 2 and 4–6 through the same reused helpers, and unconditionally `ROLLBACK`s.

### Why 4 → 5 → 6 is in that order and not another

It is the **identical relative order** the W4 transition boundary takes the same three families in
(`w4c3a-rollout-control.ts:1544-1553`: `countIncompleteOperations`, then
`countUnresolvedIngressReviews`, then `classifyAttendanceRequestSnapshotDefectsV1`). Two writers
taking the same row families in the same relative order cannot deadlock on them. Reversing the
order inside W7 would have created exactly the reverse-order writer this census exists to rule out —
so the ordering is a constraint on the implementation, not an accident of it.

---

## 2. The new two-family edge, and why it closes no cycle

W7-3 introduces one composition that has never existed on `main`: **W7 context-source key → W4
rollout key.**

The question a census must answer is not "is our order sensible" but **"does any site take these
two families in the opposite order"**. Answer, derived rather than asserted:

- **The W7 context-source advisory keyspace is new in this slice.** Its preimage prefix
  (`metasheet2:attendance:context-source:v1`) and its builder
  (`buildAttendanceW7ContextSourceAdvisoryKeyV1`) exist in exactly one module. Reproduce with:

  ```
  git grep -n "buildAttendanceW7ContextSourceAdvisoryKeyV1\|metasheet2:attendance:context-source" -- packages plugins scripts apps
  ```

  Every production hit is inside `w7-context-source-transition.ts` itself. **Zero other sites take
  the W7 key at all**, so no site can take it *after* the W4 key.
- **The W4 rollout key's holders never take the W7 key.** `acquireAttendanceCalculationRolloutLock`
  and `acquireAttendanceCalculationRolloutLockSessionExclusiveV1` have many callers
  (`w4c0-operation-registry.ts:597`, `w4c3b-request-snapshots.ts:656`,
  `w4c3c-record-operation-boundary.ts:340`, `w4c2-scheduled-run.ts:601/752/1069/1336`,
  `w4c3a-rollout-control.ts:1411/1461`), and none of them imports or names anything from the W7
  transition module — which the landed inertness sweep now proves mechanically as a standing leg
  ("the W7-3 transition writer is itself unreachable: zero production importers, zero call sites").

So the lock graph gains one directed edge (W7 → W4) into a node that has no edge back. A cycle is
impossible **by the shape of the graph**, not by anyone's discipline.

**Evidence is a real two-connection reverse-contention test, not this paragraph.** The DB suite
constructs the hypothetical reverse-order writer by hand (connection B takes W4-then-W7 while
connection A takes W7-then-W4) and asserts PostgreSQL's own detector returns `40P01`. That is the
standing proof that a future site adding the reverse order fails **deterministically and loudly**,
rather than rarely and silently.

---

## 3. Does the transition writer compose with the ruled W7 composite lock order?

Ruling 8 fixes `membership timeline → schedule facts` for the first path that combines those two
families (`w7-resolver/w7-composite-lock-order.ts`). **The transition writer does not compose with
them at all**, and this is proven rather than asserted:

```
git grep -n "acquireAttendanceW7CompositeFactsLocksV1\|attendance-calc-timeline\|attendance-schedule:" -- packages/core-backend/src/attendance/w7-context-source-transition.ts
```

returns nothing. The writer touches posture rows and the W4 rollout/predicate families; it never
touches membership timelines or schedule facts. The two orderings are therefore independent, and
this slice does not extend or reinterpret ruling 8.

---

## 4. The carry-forward this slice must answer: canonical vs raw org spelling

`w7-composite-lock-order.ts:68-87` records an open alignment item: that helper is called with the
**canonicalized** `orgKey`, while the production writers of the two fact families key off the
**raw** org id, so a mixed-case spelling would produce two different advisory keys and no mutual
exclusion. It names the obligation: *"whichever slice first makes a group-authoritative org take
these locks for real must either canonicalize at the writers or narrow this header's serialization
claim."*

**W7-3 is not that slice, and it does not inherit the obligation.** Two independent reasons:

1. The transition writer never takes either of those two families (§3), so it cannot be the code
   path that first makes an org take them for real.
2. `group_authoritative` is **unreachable** at this head: its producer is declared undelivered
   (`w7-context-source-delivery.ts`), so the promotion into it is refused by the machine.

W7-3's own keys have no such ambiguity: `buildAttendanceW7ContextSourceAdvisoryKeyV1`
canonicalizes through `parseCanonicalAttendanceRolloutOrgKeyV1` **inside the builder**, so a
mixed-case caller and a lower-case caller derive the identical key. There is a leg asserting exactly
that (`the key derivation canonicalizes: an upper-cased org yields the SAME key`).

---

## 5. Narrowing that belongs in the census, not only in the PR body

The `W4_POSTURE_COHERENT` predicate takes the W4 rollout **shared** lock inside the SERIALIZABLE
transaction, which is how **every** caller of `resolveSegmentCalculationPosture` in the tree takes
it, and which satisfies that function's documented precondition (`w4c0-identity.ts:442-443`).

It does **not** make the coherence verdict snapshot-fresh. PostgreSQL fixes a SERIALIZABLE
transaction's snapshot at its first statement, so a W4 transition that commits while this
transaction waits on the shared lock is invisible to the read that follows. The honest claim is:

> the W4 posture read is mutually exclusive with concurrent W4 transitions **going forward**, and is
> **not** proof that no W4 transition committed during the wait.

This is the pre-existing posture-read discipline of the whole W4C arc, not a defect introduced here,
and it is recorded in the predicate's own doc comment as well as here so that neither a reader of
the code nor a reader of this census can come away with the stronger claim.

Acquiring the W4 key at **session** level before `BEGIN` (as the W4 transition boundary does for its
own key) would close that window. It was not done because it would make every W7 transition contend
exclusively with every W4 shared reader for the org, which is a materially wider blast radius than
an inert slice should introduce. If a later slice needs a snapshot-fresh coherence verdict, that is
the change to make, and it is a change to this census.
