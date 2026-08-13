# #4446 whole-sheet resurrect — reference design extraction (pre-supersede preservation)

**Status: HISTORICAL REFERENCE DESIGN, not a deployable implementation.** Extracted 2026-08-12 ahead of Time
Machine closeout PR [#4654](https://github.com/zensgit/metasheet2/pull/4654) superseding PR
[#4446](https://github.com/zensgit/metasheet2/pull/4446) (`W0 L8 — exact-anchor destructive apply: one txn,
all-or-nothing (DRAFT, stacked)`, branch `claude/w0-l8-exact-anchor-apply-20260717`, head
`f2cf22c272e6487562e3a1902b438d617b57734c`). Retrieval path once the PR closes and its branch is deleted:
`git fetch origin refs/pull/4446/head` (refs remain fetchable after PR closure and branch deletion; only the
PR body/comments are editable, per this repo's disclosure-containment doctrine — irrelevant here since #4446
carries no vulnerability, but the retrieval mechanic is the same).

All source citations below are `path:line @ f2cf22c27` unless stated otherwise; line numbers are frozen to
that commit and will drift if read against any other point in the branch's history.

## ① Purpose and status

#4654's landed design (the `bridge.bounded_read.v2` / grok stack) **intentionally fail-closes whole-sheet
resurrection**: any exact-anchor recovery plan carrying `resurrectIds` is whole-refused at PREVIEW time as
`INBOUND_UNPROVABLE`, before an execute token can ever be minted
(`packages/core-backend/src/multitable/exact-anchor-recovery-route.ts:494-499,696-701` on
`origin/codex/tm-closeout-integration-20260728`, the #4654 branch). #4446 is the **only implementation in this
repo's history that took the opposite path** — it let a resurrect proceed and got most of the surrounding
mechanics right. Once #4654 merges and the seven-Draft supersede lands, #4446 closes and its branch is
eligible for deletion; without this extraction, the one worked example of "resurrect done carefully" would be
gone except via `refs/pull/4446/head`.

**Why it is reference-only, not deployable** — two independent reasons, both load-bearing:

1. **Never wired.** #4446's own diff (`git diff 37fd6b3c35..f2cf22c27`, its 5-commit PR stack) touches only
   `exact-anchor-recovery-execute.ts`, its realdb test, a `meta_recovery_token_burns` migration, and one CI
   workflow line. No route ever calls `applyExactAnchorRecovery`. The route-wiring commits that later existed
   for a sibling design (`f1f17f7440`, `174eb3b4d5`, `7c3d143707`, `67edb98443`, …) are confirmed **not**
   ancestors of `f2cf22c27` (`git merge-base --is-ancestor <c> f2cf22c27` → `no` for all four). The destructive
   apply sits behind the pre-existing default-OFF `MULTITABLE_ENABLE_SHEET_REVERT` /
   `MULTITABLE_ENABLE_PIT_RESET` flags and is unreachable from any default-on path.
2. **At-anchor inbound link authority was never built** — see §④. This is the actual, verified reason #4446's
   resurrect can't be lifted into #4654 as-is, and it is the same reason #4654 fail-closes.

**Correction to prior framing:** the resurrect line of work that requested this extraction described #4446 as
additionally "based on an untrustworthy wall-clock anchor." That does not hold for the code at `f2cf22c27` —
checked directly against source. `RecoveryAnchorRequest` (`exact-anchor-recovery.ts:48-57` on the L6-b base
commit `93f00a8225`, part of #4446's dependency chain though not its own diff — see the attribution note in
§②) is a discriminated union whose `{kind:'wall-clock'; asOf}` arm (`:57`) is refused `exact-anchor-required`
**before any DB access** (`exact-anchor-recovery.ts:35-39`, "WALL-CLOCK REFUSAL"), and the module docstring
cites its own design authority as "§0/P2-B (why a wall-clock `T` / a mutable `MAX(seq)` is NOT a trustworthy
anchor)" (`exact-anchor-recovery.ts:15-16`). The apply's `anchorSeq` is the immutable `endpoint_seq` of a sealed operation,
never a live `MAX(seq)` and never a client timestamp (`exact-anchor-recovery-execute.ts:187-196`). The
wall-clock characterization most likely describes the **legacy PIT reset path** (`MULTITABLE_ENABLE_PIT_RESET`,
`reconstructRecordsAtT`) that this exact-anchor lane was explicitly built to replace — not #4446 itself. Treat
this document's §① reason (1) (never wired) plus §④ (inbound authority) as the two verified, load-bearing
reasons; drop the wall-clock claim from any future description of #4446.

## ② What the resurrect apply got right

**Attribution note:** #4446's own PR diff is exactly `exact-anchor-recovery-execute.ts` +
`multitable-exact-anchor-apply-realdb.test.ts` + the token-burns migration + one CI line (confirmed via
`git diff 37fd6b3c35..f2cf22c27 --stat`, where `37fd6b3c35` is the L7 branch tip #4446 stacks on). The items
below that live in `exact-anchor-recovery-execute.ts` are #4446's own contribution. Items in
`exact-anchor-recovery.ts` / `exact-anchor-recovery-plan.ts` / `record-reconstructor.ts` are **base-chain**
files from the stacked L6-b/L7 PRs (#4446 imports and depends on them but did not author them) — cited here
because the resurrect behavior can't be understood without them, but they should not be described as #4446's
own work.

### (a) Trash-row mutual exclusion — lock, insert, delete, all in one txn

The resurrect branch locks the trash vintage(s) `FOR UPDATE`, inserts the live row, then deletes the trash
row(s) for that id — all inside the same all-or-nothing transaction as everything else in the apply
(`exact-anchor-recovery-execute.ts:265-341`):

```ts
// :291 — lock the trash vintage(s) first; a concurrent restoreRecord on the same id serializes here.
await query('SELECT id FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2 FOR UPDATE', [s.recordId, input.sheetId])

// :296-298 — new generation: version resets to 1 (the MULTI-GEN delete→recreate convention).
await query(
  'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
  [s.recordId, input.sheetId, JSON.stringify(s.snapshot), input.actorId],
)
// … outbound link rebuild (see (c)) and revision emission happen here …

// :339 — the live/trash mutual-exclusion invariant.
await query('DELETE FROM meta_records_trash WHERE record_id = $1 AND sheet_id = $2', [s.recordId, input.sheetId])
```

Without the final DELETE, a resurrected record is live **and** still shown in the recycle bin; a later
`restoreRecord` of the same id then 23505-conflicts on the id, and the lingering `delete_revision_id` mis-pins
tombstone/retention. This exact failure mode — and the fix — is §③ below.

The `FOR UPDATE` lock's own coverage is stated honestly rather than claimed: it is **defense-in-depth beneath
the canonical writer fence**, not independently golden-covered. The apply only ever runs with the fence ON
(`fenceWriterEntry` is a no-op when the flag is off — `canonical-sheet-fence.ts:185`), and that fence already
serializes apply-vs-apply, so neutering the lock leaves the suite green. What it adds is protection against a
**non-fenced** concurrent writer of the same trash row (today: `restoreRecord`) — documented in-code as
deliberately deferred coverage, not claimed (`exact-anchor-recovery-execute.ts:279-290`; gate finding "F1" in
the closing commit `f2cf22c27`'s message).

### (b) At-anchor snapshot as the resurrect value source — not the trash row's vintage, not a heuristic

The resurrect's `snapshot` comes from `plan.resurrects`, which `classifyExactAnchorRecoveryPlan` builds from
the **at-anchor reconstruction** (`exact-anchor-recovery-plan.ts:151-152`, base-chain L7 file): "existed at the
anchor, gone now ⇒ deleted AFTER the anchor ⇒ resurrectable to its at-anchor state." Two independent sources
feed that at-anchor state, and both are exercised by goldens:

- **Revision-chain replay**, when the record is above the retention/replay horizon — golden
  `multitable-exact-anchor-apply-realdb.test.ts:422-467` ("G2 RESURRECT-VS-TRASH"). The fixture is
  deliberately adversarial: the record is created at-anchor with `g2-at-anchor`, then edited to
  `g2-terminal` and deleted *after* the anchor, so the `meta_records_trash` row (and the delete revision's
  own snapshot) both carry the **wrong, terminal** vintage. The assertion (`:459`,
  `expect((await liveRow(R_G2))?.data).toEqual({ [F_STR]: 'g2-at-anchor' })`) only passes if the resurrect
  read from the revision chain and never touched the trash row's data — genuinely discriminating, not a
  tautology.
- **Checkpoint-baseline composition**, when the record falls below the replay horizon (its revisions were
  retention-pruned) — golden `multitable-exact-anchor-apply-realdb.test.ts:273-297` ("BASELINE composition").
  `composeBaselineOverlay` (`exact-anchor-recovery.ts:126-147`, base-chain L6-b file) merges
  `meta_history_baselines` rows into the replay map only where the replay map has no entry (`:137`,
  `if (composed.has(recordId)) continue // replay map wins — it is at-anchor-exact`), and maps
  `is_trashed` at the checkpoint into `exists:false`. The golden seeds one baseline-only record as
  non-trashed and one as trashed, and asserts the apply resurrects the first from baseline data
  (`from-baseline`) while the second stays deleted — the same at-anchor-snapshot discipline holds across
  both value sources, not just the revision-chain one.

### (c) Outbound link rebuild, idempotent by construction

`loadLinkValuesByRecord` reads `meta_links`, not `data` — so a resurrect that only re-inserts the record row
leaves its link cells silently empty. The apply rebuilds WRITABLE outbound edges from the at-anchor snapshot
(`exact-anchor-recovery-execute.ts:299-320`), mirror-side fields skipped via `isFieldAlwaysReadOnly` (a mirror
row would break the twoWay spine invariant):

```ts
// :311-317
await query(
  `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
   SELECT $1, $2, $3, $4
    WHERE NOT EXISTS (
      SELECT 1 FROM meta_links ml
       WHERE ml.field_id = $2 AND ml.record_id = $3 AND ml.foreign_record_id = $4
    )`,
  [`lnk_${randomUUID()}`.slice(0, 50), fieldId, s.recordId, foreignId],
)
```

The idempotence discipline is deliberate: `meta_links` has **no unique constraint on the edge triple**, only
`meta_links_pkey` on the synthetic `id` — so an `ON CONFLICT DO NOTHING` with a freshly-minted uuid could never
fire (it would read as a guard while guaranteeing nothing). `NOT EXISTS` is used instead, the same discipline
4c-3's inbound-link replay carries (`inbound-link-replay.ts` ~:154, cited in-code). Golden coverage: G2c
(`multitable-exact-anchor-apply-realdb.test.ts:472-500`) asserts the writable edge is rebuilt and the mirror
side is skipped. **Honestly scoped, not overclaimed:** G2c's own comment (`:490-499`) states there is
*deliberately no assertion* for the `NOT EXISTS` guard's idempotence itself — an earlier draft re-executed a
hand-written copy of the INSERT in the test body and asserted the count stayed 1, which proves a Postgres
property, not the production path (no production mutation could red it). `f2cf22c27` — the commit this
extraction pins to — removed that tautological assertion; the guard is **defense-in-depth verified by code
reading**, not golden-covered, because it is genuinely unreachable end-to-end today:
`meta_links_record_id_fkey ON DELETE CASCADE` drops a record's outbound rows when it's deleted, so a resurrect
always starts from zero and cannot construct a duplicate without first breaking that FK.

### (d) All-or-nothing: the trash deletion rolls back with everything else

Golden G2b (`multitable-exact-anchor-apply-realdb.test.ts:510-542`, "RESURRECT-TRASH-ROLLBACK") injects a
Postgres trigger that raises on the seal step — the LAST write in the apply, after the resurrect's INSERT,
link rebuild, revision, and trash DELETE. The assertion set proves the whole resurrect (not just the record
row) rolls back together: no live row, **the trash row survives** (`:532`), zero create-revisions, zero burns.
This is what makes the trash-cleanup discipline safe to add at all — a mid-apply failure can't leave the
live/trash invariant half-fixed.

## ③ The owner-caught fix

There is **one** commit in #4446's ancestry explicitly tagged as an owner-caught defect (not a self-review
finding, not a from-the-start design ruling): `a5a154f17a`, `fix(multitable): L8 resurrect must clean
meta_records_trash — live/trash mutual exclusion (owner P1 2026-07-17)`. Its own message: *"The gate + prior
review missed it; owner caught it."* It bundles three sub-fixes landed together, all described in §②(a)/(c)
above:

1. lock the trash vintage(s) `FOR UPDATE` before touching them (concurrency discipline for the resurrect);
2. rebuild the WRITABLE outbound `meta_links` from the at-anchor snapshot (so link cells don't silently read
   empty on a resurrected record);
3. `DELETE FROM meta_records_trash` for the id — the fix's namesake: without it, the record is live **and**
   still shown in the recycle bin, a later `restoreRecord` of the same id 23505-conflicts, and the lingering
   `delete_revision_id` mis-pins tombstone/retention.

**On "two P1s":** the request that produced this extraction described the source material as containing "two
owner-caught P1 fixes." Only one such commit exists in #4446's ancestry. The adjacent candidates, checked and
ruled out:

- `a13ac8f8e3` (`NOT EXISTS` idempotence replacing the never-fires `ON CONFLICT`, §②(c)) is explicitly
  self-rated in its own commit message: *"Severity is P3, not P1… Self-review finding while the independent
  re-gate was blocked."* Not owner-caught, not P1.
- `P1-1` (destructive apply's mode comes from the verified token's claims, never a request input) and `P1-2`
  (in-fence full-read re-adjudication is REQUIRED, plus schema-drift ⇒ whole-apply-reject) are real owner
  rulings dated the same day (2026-07-17, `exact-anchor-recovery.ts:70,76`), but they are **design decisions
  baked into the initial commit** (`5824c4cb18`) from the start, not post-hoc bug catches, and they are not
  resurrect-specific — they govern the whole apply (reverts, resurrects, and resets alike).

Likely origin of the "two" framing: the extraction request's own bullet list separately named "trash 行互斥"
and "链接重建幂等" as two things to verify — those are §②(a) and §②(c) above, both real, but both are part of
the **same** `a5a154f17a` commit, not two independent P1 fixes.

## ④ What #4446 did not solve: at-anchor inbound link authority

The resurrect apply rebuilds **outbound** links only (§②(c)). It explicitly, deliberately does **not** replay
**inbound** edges from the trash row's tombstones, and says so in the same commit that does the trash cleanup
(`exact-anchor-recovery-execute.ts:334-338`):

```ts
// :334-338
// Trash cleanup — the live/trash mutual-exclusion invariant. Removing the trash row(s) for this id
// also drops the `delete_revision_id` anchor that was mis-pinning tombstone/retention. (Inbound-edge
// REPLAY from those terminal-vintage tombstones is deliberately NOT done here: this apply reconstructs
// the AT-ANCHOR state, a different vintage than the terminal delete the tombstones belong to — a naive
// replay would restore edges from the wrong vintage. That is a route-wiring / future-mode concern.)
```

The reasoning is sound and matches the file's own `g2-at-anchor` vs `g2-terminal` discriminator in §②(b): a
tombstone recorded at the record's *terminal* delete vintage is not proof of what pointed at it *at the
anchor* — the outbound side has an authoritative source (the at-anchor snapshot itself), but the inbound side
would need someone else's at-anchor state, and nothing in #4446 (or its L6-b/L7 base chain) reconstructs that.
It was left as "a route-wiring / future-mode concern" and never built.

This is exactly the gap #4654 fail-closes on. On #4654's branch (`origin/codex/tm-closeout-integration-20260728`,
not yet merged as of this writing), any plan with `resurrectIds.length > 0` is refused **at preview**, before
an execute token can be minted (`exact-anchor-recovery-route.ts:494-499`):

```
// A resurrect-bearing preview is presentation-only and can never mint an execute token: L8 whole-refuses
// it as INBOUND_UNPROVABLE.
```

with the surfaced reason text (`exact-anchor-recovery-route.ts:696-701`):

> "Exact-anchor undelete/resurrection is refused: at-anchor inbound link state cannot be proven. Until an
> at-anchor inbound reconstruction authority exists, resurrection stays fail-closed (absence of terminal
> tombstones is not proof)."

In other words: #4446 solved the *outbound* half of resurrect link integrity carefully (§②(c)) and was honest
that it left the *inbound* half undone (§④, above); #4654 generalizes that same honesty into a policy — refuse
resurrection entirely rather than ship a plausible-looking but unproven inbound state. The two are consistent,
not contradictory: #4446 never claimed to have solved inbound authority, and no evidence in its diff or commit
history suggests otherwise.

## ⑤ If resurrect capability is restarted: reusable vs. must-redo

**Reusable, regardless of how at-anchor inbound authority eventually gets built** (these don't depend on the
open gap):

- The trash mutual-exclusion **sequence**: `SELECT … FOR UPDATE` the trash vintage(s) → `INSERT` the live row
  → `DELETE` the trash row(s), all in one all-or-nothing transaction (§②(a)/(d), `:291,296-298,339`). This is
  the concrete fix for the exact failure class the owner caught (§③) and is independent of link semantics.
- `NOT EXISTS`-based edge-insert idempotence over `ON CONFLICT DO NOTHING` wherever the target table has no
  unique constraint on the logical key (§②(c), `:311-317`) — a reusable pattern, not resurrect-specific.
- At-anchor-snapshot-over-trash-vintage as the resurrect value source, composed from **two** feeder paths
  (revision-chain replay above the horizon, checkpoint baseline below it) via one shared
  `composeBaselineOverlay` (§②(b)) — the two-source design is reusable even if the concrete implementation is
  rewritten.
- The **test shapes** as fixtures to reuse or adapt: G2's "trash carries the wrong vintage, snapshot must not"
  discriminator (`:422-467`), the checkpoint-baseline discriminator (`:273-297`), and especially G2b's
  injected-seal-failure rollback proof (`:510-542`) — that shape (fail at the LAST write, assert every earlier
  write in the same resurrect rolled back together) is the reusable regression-test pattern for "is this
  resurrect really all-or-nothing," independent of what the eventual link-authority mechanism looks like.
- The honesty discipline itself: stating a guard's coverage boundary in-code rather than claiming golden
  coverage it doesn't have (the `FOR UPDATE` lock, §②(a); the `NOT EXISTS` guard, §②(c)) is a pattern worth
  carrying forward, not just the code.

**Must be redone, not reused:**

- **At-anchor inbound link authority** (§④) — the actual open problem. Nothing in #4446 constitutes a partial
  solution here; the outbound rebuild is not adaptable to the inbound direction (the "wrong vintage" argument
  in `:334-338` applies to inbound tombstones exactly as much as it did before #4446 was written). A real
  design is needed for "what pointed at record R at anchor seq S," independent of trash tombstones which only
  carry the terminal vintage.
- **Authorization to run resurrect at all.** #4654 refuses resurrect-bearing plans unconditionally at preview
  (`INBOUND_UNPROVABLE`, §④). Restarting resurrect means adding a new gate *upstream* of where #4446's apply
  logic would run — #4446's module has no opinion on "should this be allowed," only "how to do it once
  allowed," so the gate has to be designed fresh, not adapted from anything in this file.
- **Wiring.** #4446 was never connected to a route (§①); any restart needs new route wiring, new flag
  discipline, and a fresh authorization/preview path — none of that exists in #4446's diff to inherit.

## Files referenced (all `@ f2cf22c27` unless noted)

- `packages/core-backend/src/multitable/exact-anchor-recovery-execute.ts` — #4446's own contribution (the
  apply, including the resurrect branch, §②(a)(c)(d), §③, §④).
- `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts` — #4446's own
  contribution (goldens G2/G2b/G2c/BASELINE cited above).
- `packages/core-backend/src/multitable/exact-anchor-recovery.ts` — base-chain (L6-b, commit `93f00a8225`,
  not #4446's own diff): `composeBaselineOverlay`, `resolveExactAnchor`, the wall-clock-refusal design (§①
  correction).
- `packages/core-backend/src/multitable/exact-anchor-recovery-plan.ts` — base-chain (L7, commit `37fd6b3c35`,
  not #4446's own diff): `classifyExactAnchorRecoveryPlan`'s resurrect classification (§②(b)).
- `packages/core-backend/src/multitable/exact-anchor-recovery-route.ts` — from #4654's branch
  (`origin/codex/tm-closeout-integration-20260728`, NOT #4446; cited only in §④ to document the
  `INBOUND_UNPROVABLE` fail-close that #4446's gap led to).

Commit-level attribution within #4446's own 5-commit stack (`37fd6b3c35..f2cf22c27`): `5824c4cb18` (initial
apply + P1-1/P1-2), `a5a154f17a` (owner P1, §③), `e390e3193e` (G2 multi-vintage/sheet-scoping hardening),
`a13ac8f8e3` (P3 self-review, `NOT EXISTS` fix), `f2cf22c27` (gate follow-ups: removed the tautological
idempotence assertion, made sheet-scoping load-bearing, stated the `FOR UPDATE` coverage boundary honestly).
