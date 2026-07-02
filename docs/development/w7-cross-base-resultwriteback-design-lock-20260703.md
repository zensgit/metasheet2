# T3-5 — W7 cross-base resultWriteback · DESIGN-LOCK (PROPOSED) · 2026-07-03

> **Status: PROPOSED design-lock — awaiting the T3-5 per-rung votes in
> `approval-automation-second-batch-ballot-20260702.md`.** Per the owner steer (2026-07-02) T3-5 runs
> **design-lock-first as its own slice** — its permission/lock/audit surface is heavy, so it is NOT part of
> the fast demo layer. This doc turns the register's Q1–Q5 + reviewer notes into a buildable contract so the
> rung is one ratification from implementation. **No runtime is written until the ballot rung is voted GO.**

## 1. What ships today vs the gap

W7 `resultWriteback` (backend #3384, non-approved extension #3474) writes the approval outcome
(`statusField` / `approverField` / `completedAtField`, plus `onNonApproved` opt-in) back onto the **source
record only** — `writeApprovalResultBack` (automation-service.ts) resolves fields against the trigger sheet and
writes through `ensureRecordNotLocked(event.actor?.id)` with NO cross-base authority check. Record-mutating
automation actions (`update_record` etc.) already cross bases through the executor's ratified gate
`evaluateCrossBaseWrite` (automation-executor.ts:1819): an explicit `targetBaseId` must equal the target
sheet's real `base_id`, the **effective (trigger) actor** must pass `resolveBaseWritable(actorId, …)`
(fail-closed on no userId — no fallback to the rule owner), and a per-target-base quota is consumed.

**Gap:** `resultWriteback` cannot target another base. T3-5 extends it to a **literal cross-base target**,
reusing the same gate — not a new write path.

## 2. Locked decisions (register Q1–Q5, defaults adopted unless the ballot overrides)

- **Q1 — effective actor:** the **trigger actor** read from `bridge.triggerEvent`, matching the executor
  cross-base gate's ratified "effective actor = trigger actor". Null/system approvals (`event.actor` null) and
  null-actor triggers **fail closed** for cross-base backwrite (`resolveBaseWritable` is fail-closed on no
  userId). The same actor governs the **target-record lock** check. *(Stated limitation, not a bug:
  auto/system approvals cannot cross-base backwrite.)*
- **Q2 — target addressing:** **literal triple only** — `resultWriteback.targetBaseId` +
  `targetSheetId` + `targetRecordId`. No expression templating (W7-1 was gated to avoid it). Dynamic
  single-link-field target resolution is a **named follow-up**, not v1.
- **Q3 — audit/provenance:** no new audit table in v1. Extend the `start_approval` step output with the
  target base/sheet/record ids; **omit actor from the target-base realtime fan-out** (cross-base privacy
  posture, matching the executor's cross-base emit).
- **Q4 — save validation:** if ANY target id is present, require the **full triple** at save. Defer target
  field-type/read validation to runtime; do **not** block save on the author's target-base write authority
  (runtime re-checks the trigger actor's authority every run).
- **Q5 — quota:** share the **singleton per-target-base cross-base write quota** with update/create/delete/
  lock. A blocked/not-found attempt still consumes a slot (matches existing executor posture).

## 3. Build contract (reviewer-note must-fixes — fold in at implementation)

1. **Anti-misroute:** the same-base source record is **not** mutated when a cross-base target is configured
   (the write goes to the target, not the trigger record). Real-DB test asserts the source row is unchanged.
2. **Authority fail-closed** test uses the real DB and the **trigger actor** (not the request actor, not the
   approval/resume actor which collapses to `event.actor?.id ?? event.requester.id`). A trigger actor lacking
   target-base write → skip + observable `backwriteSkipped`, source untouched, no partial write.
3. **Non-merge into tail context:** the cross-base patch is **NOT** merged into the source `recordData` that
   the resume tail actions see (unlike the same-base W7-1a merge). Add a test asserting the tail context does
   not see the cross-base patch.
4. **Gate reuse, re-pinned:** extract/reuse the executor's cross-base gate helper (its call signature is
   `(queryFn, actorId, triggerSheetId, …)`, not `(context)`), and **re-run the existing cross-base
   write-gate suites** against the new shape so they stay pinned.
5. **Resume-retry quota note:** document that quota may be re-consumed on a resume retry unless a separate
   idempotent cross-base-backwrite ledger is introduced (out of v1 scope; note it).

## 4. Verification plan (fail-first, real-DB)

- **RED-before:** a cross-base `resultWriteback` target is ignored / errors before the change.
- **Green-after:** authorized trigger actor → target record row carries status/approver/completedAt;
  source row untouched; quota decremented; step output carries the target triple.
- **Fail-closed:** unauthorized trigger actor / null-actor system approval → skip + `backwriteSkipped`,
  target and source both unchanged.
- **Save gate:** partial target triple rejected at rule save; full triple accepted; same-base path unchanged.
- **Regression:** the 12/12 same-base W7 backwrite suite + the executor cross-base write-gate suites stay green.

## 5. Status / next step

Design-lock **PROPOSED**. On the owner voting the T3-5 rung GO (ballot), implement on the above contract in
**Lane C** (`automation-service.ts` — sequential with other automation-runtime work), fail-first + real-DB,
PR-for-review. Until then, no runtime.
