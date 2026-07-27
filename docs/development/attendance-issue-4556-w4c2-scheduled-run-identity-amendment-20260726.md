# Attendance Issue #4556 W4C-2 Scheduled-Run Identity Amendment (section 7.1a)

> Status: **PROPOSED** — requires owner RATIFY of the exact merged SHA before
> any runtime code is written.
>
> Date: 2026-07-26
>
> Governing lock:
> `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
> at merged commit `d6ac495b947c0b42ed7bee66d9531fbe25a486ca`
> (file blob `528c6521d152f84bc067247b5f1c134cfb1183d3`, identical on
> `origin/main` `9fdf68fa5c34d2224fbe6bd0d71b14ca78263502` (refreshed this
> addendum; `git rev-parse origin/main` re-run, `git rev-parse
> origin/main:<lock path>` re-confirms the same blob) and on the held
> W4C-2 head `b5db447ae18700f023d8915353f2aee109121eb4`).
> `OD-W4C-1..42` were RATIFIED at `a3e5765727ca608e8c49c7a44a025e6e4aae5d40`.
>
> Companion amendment:
> `attendance-issue-4556-w4c0-identity-proof-amendment-20260725.md`,
> RATIFIED at `3fa1ae3421744fcec9a18c4f87153281c59ec6b2`, `OD-W4C-43=(a)`.
>
> Scope: the section 7.1a outbox **identity model**, the `scheduled`
> entrypoint's **durable run identity**, the reserved class-`01` advisory
> class, and the section 12.3 scheduled gates. Section 1's supersession list
> is the complete accounting of what **this amendment's own schema**
> touches. Section 3's decision table (`OD-W4C-44..53`) is what must be
> RATIFIED before implementation, and includes five items (`O-1..O-5`, i.e.
> `OD-W4C-49..53`) that this draft states in full but does **not** resolve —
> implementation (section 4 step 3) does not start until all of
> `OD-W4C-44..53` are ratified, not just `44..48`. `O-5`/`OD-W4C-53`
> (section 3.2) is bundled into this table purely so the owner can rule on
> all five two-reading points in one pass; unlike `O-1..O-4` it does **not**
> concern this amendment's run-identity schema — it concerns the governing
> lock's section 8.2 step 7, raised against PR #4612 (a separate,
> still-Draft/HOLD branch), and is therefore outside section 1's
> supersession list.
>
> **Revision note (this pass).** An independent gate review of this
> document (bound to head `ea10a66fd91c30e191f566d07689a910fc1c9c98`)
> found 5 P1 and 4 P2 defects, all addressed in this revision: two false
> claims about which existing triggers protect the new identity columns
> (sections 1.1, 1.4), a migration step that edited an already-applied
> migration file to no effect (section 1.10), an incomplete supersession
> list against four lock clauses this draft actually crosses (section 1),
> a finalization-reachability gap this draft did not close or disclose
> (section 0.5, 1.1.1, 1.7.1), a non-deterministic ordering dependency
> (sections 1.2, 1.3), and four smaller issues (sections 1.7, 1.8, 1.9,
> 1.2.1, 2). Author-fixable items are corrected in place; four items that
> require an owner reading are stated as pending decisions
> (`O-1..O-4`/`OD-W4C-49..52`, section 3) rather than resolved unilaterally.
>
> **Addendum (this pass).** `O-5`/`OD-W4C-53` (section 3.2) is added
> afterward to bundle a fifth pending owner decision — the governing lock's
> section 8.2 step 7 "source-definition fingerprint equality" clause, raised
> against PR #4612 commit `64ea17d1931c142a080aeab9dabe2e8c1098c2cd`, not
> against any text in this document — so the owner can rule on all five
> two-reading points in one pass. It is not part of, and not counted
> against, the 5 P1 / 4 P2 gate review above.
>
> Owner authorization basis: PR #4595 `c-5082275704` (restricted resumption:
> "W4C-2 修复 + 新 exact-head 独立门审" only) and PR #4612 `c-5082785641`
> (owner ruling **G-2 = (b2)**, which overturned `c-5082614287` = the
> `(c)-plus` classification exemption).
>
> **Retraction (this pass).** A round-3 gate review found the previous
> revision's `O-5`/section 3.2 `(ii-narrow)` cell claimed, unconditionally,
> that excluding an operation's own just-written row from the resolver's
> `openPreviousMatches` match "has now been verified semantically safe, in
> general" and was "confirmed semantically safe." **Both claims are
> retracted**, along with every downstream sentence in section 3.2 that
> restated or relied on them (the "Consequences," "Gate shape," and
> "Recommendation" text for `(ii-narrow)`, and the `O-5` ballot row in
> section 3.1). An executed counterexample (section 3.2) shows the
> mechanism as specified flips both the resolved `workDate` and `shiftId`,
> not only `reasonCode`, when this operation's write touches — rather than
> creates — a pre-existing open record on the resolved previous workDate.
> `OD-W4C-53`/`O-5` remains a **three-token** ballot: `(i)` and `(ii-wide)`
> are unconditional tokens, and `(ii-narrow)` is now a **conditional**
> token — castable as a direction decision, but void as an implementation
> authorization until section 3.2's four preconditions are supplied and
> gated — see section 3.2 for the corrected scope and the preconditions a
> follow-up round would need to supply.
>
> **Consistency fix (this pass).** A final-gate review (bound to head
> `a2cd9ab7c83d85495acda911a08d2f6be4bf29f9`) found this scope note and
> section 3.2's own text (the sentence immediately preceding the
> retraction above, and the opening of the `(ii)` cell) stated the ballot's
> cardinality two different ways: this note previously said "two-token"
> and "`(ii-narrow)` is … not offered as a ratifiable token this pass",
> while section 3.1's row said three tokens, two unconditional and one
> conditional. The two-token wording above and at section 3.2's `(ii)`
> opening are corrected in this pass to match the row. The same review
> also raised, and this pass separately fixes, section 3.2's precondition
> (1) wording (aligned to section 4 step 3's phrasing), precondition (4)
> (an explicit acceptance bar added), and one overbroad "every argument …
> analyses only appearance" sentence (narrowed to name its exception) —
> none of those three touch the ballot's token count or shape, which is
> what this note documents. Section 3.1's ballot row itself is unchanged.
> The PR body was updated in the same pass to stop asserting the
> retracted safety claim above the retraction's own text. *(This
> paragraph originally also claimed "the rest of section 3.2" — beyond
> the two sites named above — uniformly said three tokens; that claim was
> false and is corrected by the paragraph below.)*
>
> **Consistency fix, continued (this pass).** A subsequent gate review
> (bound to head `3122264352d1e114fa3c67a8fa11031d9d1ac3cd`) found that
> the sweep described in the paragraph above was itself incomplete: it
> searched only the hyphenated forms "two-token" and "two ratifiable",
> and missed section 3.2's Recommendation-intro sentence (the paragraph
> beginning "Recommendation, not a decision"), which used the
> unhyphenated wording "restricted to the two tokens this document can
> currently offer" — an unconditional two-token count, eleven lines
> before this same section's `(ii-narrow)` cell reopens the third token
> as conditional-but-live. It is corrected in this pass to read
> "restricted to the two unconditional tokens," matching section 3.1's
> row's own "(i) over (ii-wide) among the two unconditional tokens"
> construction. This paragraph does not itself claim the resulting sweep
> is now exhaustive, and — correcting a further overclaim caught by the
> readiness review — neither does the census it points at. That census is
> **vocabulary-scoped, not exhaustive**: it is word-pattern-based rather
> than hyphenation-specific, which is broader than the fourth pass's
> sweep, but its adjacency patterns are still defeated by a qualifier
> inserted between the count word and `tokens`. At least four cardinality
> statements are therefore absent from it — those the readiness review
> identified, which is itself a vocabulary-scoped result and not a proof
> that no fifth exists: section 3.1's ballot row
> (`Two unconditional tokens, one conditional token`), section 3.2's
> `(i)`/`(ii-wide)` summary, section 4's per-token restatement, and the
> retraction marker — precisely because each says `two unconditional
> tokens` rather than `two tokens`. All four state the three-token
> cardinality correctly, so the defect is in the census's claim to
> completeness, not in the ballot: a reader re-running it must widen the
> pattern past simple adjacency rather than treat its output as a closed
> set. The census itself is carried in the PR body's revision record,
> not restated here.
>
> This pass also tightens section 3.1's ballot row: its precondition (1)
> reference said only "corrected, gated mechanism spec," looser than
> section 3.2 precondition (1) and section 4 step 3's explicit
> `matching.length === 1`-gating requirement, and this document's own
> revision banner names section 3.1's row the sole authoritative ballot
> text — so a reader who reads only that row would learn a softer bar
> than the document actually requires. The row now reads "corrected,
> `matching.length === 1`-gated mechanism spec" in that one place. The
> "Section 3.1's ballot row itself is unchanged" sentence in the paragraph
> two above describes only the diff bound to head
> `a2cd9ab7c83d85495acda911a08d2f6be4bf29f9` (round 4's own pass); it does
> not describe the document's current state after this pass's edit.
>
> **Round 6 correction (this pass).** An independent gate review of the PR
> (bound to head `9ce0467e131a5911abaa0627461ce6a0f93e6fb1`) found 3 P1 and
> 1 P2, all addressed in this revision: (P1-A) section 1.1.1 option (a) put
> the new per-target terminal-outcome columns directly on
> `attendance_scheduled_run_targets`, which section 1.2 declares fully
> immutable — unimplementable as drafted. Corrected to a separate,
> append-only side table, `attendance_scheduled_run_target_outcomes`, with
> a deferred cross-table constraint trigger in place of the cross-table
> `CHECK` the retracted version implied; sections 1.7 step 4 and 1.8 steps
> 4-5 are rewritten as an explicit `O-3` fork rather than left silently
> assuming `completed`-only. (P1-B) section 1.4.1 stated the run witness
> is minted "only by rehydration from the committed, locked run row," which
> the zero-`generate`-target case (section 1.9) cannot satisfy, since its
> run-creation transaction enqueues before its own `INSERT`'s commit.
> Corrected by naming and specifying a second, module-private-only
> constructor (`mintAttendanceScheduledRunIdentityFromInsertedRowV1`) for
> exactly that case, an equivalence argument correcting the "committed"
> framing (which was already imprecise for the mainline path — section
> 1.8 steps 7-8 enqueue before step 9's commit too), and a new gate 22
> proving the constructor's exclusivity at the compiled-module boundary,
> not by source grep. (P1-C) `OD-W4C-44(a)` and `OD-W4C-45(a)` named other
> items' default answers (`abandoned`, class `01`) inside their own option
> text without flagging the coupling; new section 3.3 states the full
> dependency matrix, the two structural exclusions found (`44=b`/`44=c`
> foreclosed on their own terms; `46=a` with `49=b`; `48=b` with `50=b`),
> one cost interaction (`50=b` with `52=a`, added to section 1.7.1), and
> the decision rule + 16-bundle count for "legal and needs no follow-up
> round" — including confirming the externally-suggested bundle
> `44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)` is one of the 16, without
> ruling on it. (P2) section 1.1.1's `abandoned` state had no write-path
> specification; new section 1.1.2 states authorization (capability +
> posture, evaluated before any lock), org anchor, lock order (identical
> to finalization's, introducing no new lock-order shape), audit (a new
> closed `abandoned_by_actor_posture` column, write-once by construction
> of the existing state machine, not a new mechanism), concurrency, and
> idempotency (both reusing section 1.8 step 3's losing-racer branch), plus
> gate 23. **Self-correction within this same pass** (found before any
> external re-review, per a pre-commit self-scan): the O-3 fork applied to
> section 1.7 step 4 had not been propagated to the recovery sweep's own
> two branches (same section, "No stuck absorbing state"), which would
> otherwise have fired both branches at once for a `failed` target under
> `O-3=(a)`; section 1.1.2 as first drafted had no `blocked`/`suspended`
> branch, letting `abandoned` convert a paused run into the terminal
> outcome `W4C-R43` separates from suspension — both are fixed in place,
> and section 0.5 gained the cross-reference its own "confined to" claim
> already asserted but the first draft of this paragraph had not yet made
> true. A second pass of the same self-scan then found section 1's own
> supersession-list preamble was itself understated by the P2 addition —
> its "one new, strictly non-source finalization transaction shape"
> bullet did not count `abandoned` as a second such shape, and its section
> 7.1 bullet did not name the `O-3=(a)` outcome rows — fixed in the same
> place, together with section 5's matching "finalization is a new
> transaction shape" residual and section 1.9's `suspended` row. This
> round's diff is confined to section 1's supersession-list preamble, 0.5,
> 1.1, 1.1.1 (new 1.1.2), 1.2, 1.4.1, 1.7 (step 4 and the recovery-sweep
> branches), 1.7.1, 1.8 steps 4-5, 1.9, 1.10, section 2 (gates 11's
> cross-reference, 20, 22, 23, 2.1), section 3 (`OD-W4C-44`/`45` rows), 3.1
> (`OD-W4C-50` row), new 3.3, section 4 step 3, and section 5 — it does not
> touch section 3.2/`O-5`'s ballot text, which this round did not review
> and does not alter.
>
> Runtime posture: PR #4612 stays **Draft** under
> **OWNER-AUTHORIZATION-HOLD**. This amendment contains **no runtime code**
> and authorizes **no** implementation, ready-for-review transition, arming,
> merge, flag enablement, org enablement, deployment, staging soak, or
> issue closure. The `(c)-plus` landing was already reverted on that branch
> by `ad55410277443603d073040a67fe36de2a965c62`.

## 0. Why this amendment exists

### 0.1 The finding and the rejected shortcut

The W4C-2 exact-head gate review raised **P1-2**: the `scheduled` entrypoint
reaches `emitEvent` with two run-level events that are neither in the
section 7.1a closed event-kind set nor durably enqueued, while section 7.1a
(lock line 1317ff) makes W4C-2 responsible for the live/scheduled event
cutover and section 12.3 (lock line 2672ff) separately requires
"live/**scheduled** outbox rows are inserted before operation seal".

This lane then proposed `(c)-plus` — classify the two run-level events as
non-operation lifecycle signals and exempt them. The owner **rejected** it
for three reasons, all of which this lane accepts without argument:

1. **The RATIFIED lock is not ambiguous.** Both anchors above were already
   quoted by the gate finding itself. `(c)-plus` was therefore a **contract
   downgrade**, not a classification erratum.
2. **A W4C-0 closed-set omission does not prove the lock wrong.**
   `packages/core-backend/src/attendance/w4c0-operation-contract.ts:92`
   omits `attendance.absence.generated`; that is evidence of an **inventory
   defect in W4C-0**, not evidence that the event was meant to be excluded.
3. **`(c)-plus` missed the second run-level event.** The scheduled path emits
   **two** events — `plugins/plugin-attendance/index.cjs:21243`
   (`attendance.absence.generated`) and
   `plugins/plugin-attendance/index.cjs:21249`
   (`attendance.work_date.review_required`). The second carries
   pending-human-review information and must not be demoted to best-effort
   without proof about its consumers and durable state. This lane never
   examined it — a substantive omission.

Option `(a)` (turn one run into N per-user events) was also rejected: it
changes `total` semantics, consumer trigger counts, and alerting meaning, so
it is a public wire-semantics break.

### 0.2 Verified current state at `9fdf68fa5c34d2224fbe6bd0d71b14ca78263502`

**Refreshed this addendum.** The prior SHA cited here
(`97cf6203397b958c78c646f09176b93b00d279aa`) had fallen five commits behind
`origin/main`. Re-run: `git diff --stat
97cf6203397b958c78c646f09176b93b00d279aa origin/main --
plugins/plugin-attendance/index.cjs
plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs
packages/core-backend/src/attendance/w4c0-operation-contract.ts
packages/core-backend/src/attendance/w4c1-fingerprints.ts
packages/core-backend/src/attendance/__tests__/w4c0-identity.test.ts
packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`
— empty output for all six files this section and section 3.2 cite line
numbers against. Every reference below therefore still holds on current
`origin/main`, and the SHA is updated to the one actually verified.

- `plugins/plugin-attendance/index.cjs:21242-21256`: after
  `generateAbsenceRecords(...)`, `emit('attendance.absence.generated', {orgId,
  workDate, total: rows.length})` is unconditional, and
  `emit('attendance.work_date.review_required', {orgId, workDate, total,
  reasons})` fires only when `reviewRequired.length > 0`. Both are
  synchronous best-effort; a crash between commit and emit loses them.
- `packages/core-backend/src/attendance/w4c0-operation-contract.ts:92-99`:
  the closed kind set is exactly `attendance.punched`,
  `attendance.requested`, `attendance.request.updated`,
  `attendance.request.cancelled`, `attendance.resolved`,
  `attendance.outdoorPunch.requested` — neither run-level kind is present.
- `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:210-216`
  holds a **second, byte-identical copy** of that list (the TS file's comment
  at line 85-90 already warns that both copies must be reconciled).
- Same migration, lines 578-600: `attendance_result_event_outbox` has
  `operation_id uuid NOT NULL` with **no** foreign key to
  `attendance_result_operations`, and one unique key
  `uq_areo_identity (org_id, entrypoint, operation_id, event_kind)`. Nothing
  mechanically stops a caller from writing a **run** UUID into
  `operation_id`.
- The held W4C-2 branch's scheduled path
  (`packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts`,
  head `b5db447ae18700f023d8915353f2aee109121eb4`) already runs **one durable
  per-user operation per target user** with `identity_source_kind='scheduled'`
  derived from `(runId, userId, workDate)`. That part is correct and this
  amendment does not change it. What is missing is any durable **run**
  object: `runId` is a pure in-process derivation
  (`deriveAttendanceScheduledRunIdV1`) with no row, no counters, no terminal
  state, and no enqueue site.
- In-repo subscribers to either event: none found in runtime code at this
  SHA; only
  `packages/core-backend/tests/integration/attendance-work-date-resolver-w2.db.test.ts:271,332`
  assert emission. The events are published on the public plugin event bus,
  so external subscribers **cannot be enumerated from this repository** —
  which is precisely why they may not be demoted.

### 0.3 A second, independent defect this amendment closes

Even ignoring durability, the held branch's scheduled path folds its public
`total` from an **in-memory** array that deliberately excludes replayed users
(`if (outcome.inserted && outcome.mode !== 'replay') insertedRows.push(...)`).
A run interrupted after some users committed and then resumed would therefore
emit a **smaller** `total` than the same run would have emitted uninterrupted.
Under `(b2)` the counts come from durable, immutable per-user evidence, so a
resumed run emits the same bytes an uninterrupted run would have emitted.

### 0.4 What `(b2)` is

`(b2)` **completes** the durability contract: it adds the run-level identity
that section 7.1a's `(org_id, entrypoint, operation_id, event_kind)` shape
could not express, so that a run-level event can be delivered exactly once,
durably, with unchanged payload bytes and unchanged "one run, one event"
external semantics. It weakens nothing **for the parts this draft fully
specifies**. Section 0.5 discloses the one respect in which this draft, as
written, does not yet complete that contract, and names the two owner
decisions (`O-3`, `O-4`) required to close it.

### 0.5 A defect this amendment does not yet close (pending `O-3`/`O-4`)

Two structurally distinct triggers can make the finalization transaction
(section 1.8) permanently inadmissible for a `running` run even though
every per-user operation that *can* complete already has:

1. **Mid-run posture promotion.** Section 1.8 step 1 requires equality
   between the run's frozen `accepted_write_posture` and the *currently
   resolved* posture. The governing lock's shadow/eligible promotion-block
   predicate (lock lines 2689-2690, 2250) blocks promotion only while an
   *operation* row is frozen in another posture; a `running` scheduled run
   is not an operation row, and by lock lines 1124-1129's
   *transaction-scoped* `claimed` state, an incomplete per-user target
   simply has no row yet — there is nothing for the predicate to see.
   Promotion is therefore free to proceed while a run is mid-flight, after
   which the run's frozen posture can never again equal the resolved
   posture, and finalization never admits.
2. **A per-target permanent failure.** Section 1.1's `chk_asr_terminal_shape`
   only recognizes `completed_user_count = expected_user_count` as the
   successful terminal shape. This amendment, as drafted, defines no
   outcome for a `generate` target whose per-user operation transaction
   fails **deterministically** (fail-closed, not transient) — a shape the
   governing lock's own W4-covered posture matrix produces routinely. That
   single target can never reach `completed`, so the run can never reach
   `completed` either.

In both cases the only exit is the explicit `abandoned` transition
(section 1.1), which by design writes **no** outbox row. The run's other,
unaffected users already have durably committed absence records; the two
run-level events reporting on them are lost, not delayed. This is the same
failure shape red line `W4C-R27` (governing lock line 199) exists to
forbid, reintroduced at the run level by conditioning run-level durability
on finalization reachability instead of on commit.

Sections 1.1.1, 1.7.1, and 1.8 below state the two provisional fixes in
full and name the owner decisions — `O-3` = `OD-W4C-50`, `O-4` =
`OD-W4C-52` — that must be ratified, alongside `OD-W4C-44..48` and `O-1`
(`OD-W4C-49`) and `O-2` (`OD-W4C-51`), before implementation (section 3,
section 4 step 2). This draft does not pick between the options it states.
Section 1.1.2's `abandoned` transition remains, regardless of which side
either decision takes, the general-purpose escape hatch for a `running`
run this section's two named triggers are not the only possible cause
of — see section 1.1.2 for its own authorization/lock-order/audit
contract, not restated here.
(A fifth, unrelated pending decision, `O-5`/`OD-W4C-53`, is bundled into
the same one-pass ratification by section 3.2; it does not bear on the
gap this section discloses.)

## 1. Locked correction

This amendment supersedes these parts of the governing lock:

- section 7.1a's single-shape outbox identity
  `(org_id, entrypoint, operation_id, event_kind)`, its closed event-kind
  set, and its "each W4-covered **source operation** ... stores one closed
  event row in the same transaction as its operation seal" as the *only*
  enqueue shape;
- section 7.1a's "in the same transaction as its operation seal" durability
  guarantee (lock lines 1319-1326) and red line **W4C-R27** (lock line 199),
  **for the two run-level events only**: durability becomes conditioned on
  the run reaching finalization (section 1.8) rather than on the
  run-creation commit. **This conditioning is not yet fully closed by this
  draft** — see section 0.5 and the pending decisions `O-3`/`O-4`
  (`OD-W4C-50`, `OD-W4C-52`) below. Per-user event durability (the six
  existing kinds) is unchanged and remains commit-conditioned only, per
  `W4C-R27` as written;
- section 7.1's sentence "Scheduled absence gains a durable
  scheduled-run/user/date source row", which is refined into a durable run
  row plus immutable target rows plus the unchanged per-user operations
  (plus, **if `O-3`/`OD-W4C-50` ratifies `(a)`**, the append-only
  per-target outcome rows section 1.1.1 specifies — an addition to this
  refinement, not a further change to the per-user operations themselves);
- section 8.2's lock order and step 14, by inserting the reserved class-`01`
  run lock and by adding **two** new, strictly non-source transaction
  shapes: the **finalization transaction** (section 1.8) and the
  **`abandoned` transition** (section 1.1.2) — same lock order (class-`00`
  shared, then class-`01`, then `FOR UPDATE`) as finalization, but a
  distinct shape (it updates the run row to a different terminal state,
  inserts no outbox row, and folds no `generated_count`), which is why
  section 1.1.2 states its own gate (23) rather than reusing finalization's
  (15) wholesale;
- `OD-W4C-40`'s "class `01` is reserved", which this amendment assigns —
  **subject to `O-1`/`OD-W4C-49` ratifying the red-line rewrite immediately
  below**;
- red line **W4C-R42** (lock line 214, "`01` is forbidden", including its
  "crossing a rollout/operation/target class ... fails independently"
  clause), lock lines **2049-2050** ("Prefix `01` is reserved and forbidden
  in W4"), **2126-2130** (the digest-seam gate: "admitting reserved class
  `01` ... makes an exact gate fail"), and **2570** ("production
  construction cannot inject it and class `01` is never acquired") — all
  four are proposed to be superseded together, **pending `O-1`/`OD-W4C-49`**
  (section 3). Until ratified, class `01` remains forbidden as written and
  this amendment authorizes no implementation that acquires it;
- the governing lock's shadow/eligible promotion-block predicate (lock
  lines 2689-2690, 2250) — **only if `O-4`/`OD-W4C-52` selects option (a)**,
  extending it to cover a `running` `attendance_scheduled_runs` row (section
  1.7.1). If `O-4` selects option (b), this predicate is **not** superseded,
  and the gap in section 0.5 is instead closed by the finalization mechanism
  described in section 1.7.1(b)/1.8;
- lock line **2670** ("durable scheduled-run replay survives process
  restart and `skipDedup` cannot bypass it") — refined by this amendment's
  stronger replay guarantee (section 1.7); see the residual noted in
  section 5;
- the section 12.3 scheduled gates affected by the above.

**Not superseded**, and binding on this amendment's own design: red line
**W4C-R43** (lock line 215, suspended stays retryable and distinct from a
terminal remediation outcome) governs section 1.8 step 1's suspended branch
(corrected below).

Everything else — advisory hash bytes, the class-`00`/`10`/`11` formulas and
tuples (outside the four red-line clauses above, pending `O-1`), the W4C-0
verified-identity factory and its source matrix, the three UUIDv5
namespaces, per-user scheduled operation derivation, posture normalization,
batch limits, and every unrelated gate — remains **unchanged**.

### 1.1 Durable scheduled-run row

Create `attendance_scheduled_runs`. Draft shape (column names and constraint
names are part of this lock; types are PostgreSQL):

```sql
CREATE TABLE attendance_scheduled_runs (
  run_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 text NOT NULL,
  entrypoint             text NOT NULL,      -- fixed 'scheduled'
  initiator              text NOT NULL,      -- closed: 'cron' | 'admin_run'
  work_date              date NOT NULL,
  generation             integer NOT NULL,   -- 1-based per (org,initiator,work_date)
  accepted_write_posture text NOT NULL,      -- closed: 'shadow' | 'authoritative'
  target_set_fingerprint text NOT NULL,      -- lowercase sha-256 (section 1.3)
  expected_user_count    integer NOT NULL,   -- frozen at creation
  review_count           integer NOT NULL,   -- frozen at creation
  state                  text NOT NULL DEFAULT 'running',
  completed_user_count   integer,            -- written only at finalization
  generated_count        integer,            -- written only at finalization
  abandon_reason_code    text,
  abandoned_by_actor_posture text,           -- closed: 'platform_admin' | 'attendance_admin'; section 1.1.2
  created_at             timestamptz NOT NULL DEFAULT now(),
  finalized_at           timestamptz,
  CONSTRAINT uq_asr_run_org       UNIQUE (run_id, org_id),
  CONSTRAINT uq_asr_run_org_date  UNIQUE (run_id, org_id, work_date),
  CONSTRAINT uq_asr_generation    UNIQUE (org_id, initiator, work_date, generation),
  CONSTRAINT chk_asr_entrypoint   CHECK (entrypoint = 'scheduled'),
  CONSTRAINT chk_asr_initiator    CHECK (initiator IN ('cron','admin_run')),
  CONSTRAINT chk_asr_posture      CHECK (accepted_write_posture IN ('shadow','authoritative')),
  CONSTRAINT chk_asr_state        CHECK (state IN ('running','completed','abandoned')),
  CONSTRAINT chk_asr_fingerprint  CHECK (target_set_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_asr_counts       CHECK (generation >= 1
                                     AND expected_user_count >= 0
                                     AND review_count >= 0),
  CONSTRAINT chk_asr_terminal_shape CHECK (
       (state = 'running'   AND completed_user_count IS NULL
                            AND generated_count IS NULL
                            AND finalized_at IS NULL
                            AND abandon_reason_code IS NULL
                            AND abandoned_by_actor_posture IS NULL)
    OR (state = 'completed' AND completed_user_count = expected_user_count
                            AND generated_count IS NOT NULL
                            AND generated_count <= expected_user_count
                            AND finalized_at IS NOT NULL
                            AND abandon_reason_code IS NULL
                            AND abandoned_by_actor_posture IS NULL)
    OR (state = 'abandoned' AND completed_user_count IS NOT NULL
                            AND generated_count IS NULL
                            AND finalized_at IS NOT NULL
                            AND abandon_reason_code IS NOT NULL
                            AND abandoned_by_actor_posture IS NOT NULL)
  ),
  CONSTRAINT chk_asr_abandon_reason CHECK (
    abandon_reason_code IS NULL
    OR abandon_reason_code IN ('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
  ),
  CONSTRAINT chk_asr_abandoned_by_posture CHECK (
    abandoned_by_actor_posture IS NULL
    OR abandoned_by_actor_posture IN ('platform_admin','attendance_admin')
  )
);

CREATE UNIQUE INDEX uq_asr_one_running
  ON attendance_scheduled_runs (org_id, initiator, work_date)
  WHERE state = 'running';
```

`chk_asr_terminal_shape`'s `completed` branch above (the equality
`completed_user_count = expected_user_count`) is the **`O-3`/`OD-W4C-50 = (b)`**
form — the current-draft, all-or-nothing shape. If `O-3` instead ratifies `(a)`,
this branch is narrowed to `completed_user_count IS NOT NULL AND
completed_user_count <= expected_user_count` (dropping the equality, since a
`failed` target is real, permanent, and not counted in `completed_user_count`);
section 1.1.1 states this override in full, together with the new table and
deferred trigger it requires. The two forms are not both in force at once —
whichever `O-3` ratifies is the one actually migrated (section 1.10).

Rules:

- `run_id` is a **server-minted** UUID. It is durable identity, not a
  derivation; the held branch's `deriveAttendanceScheduledRunIdV1` derivation
  is superseded and must not survive implementation. A restarted process
  **reads** the running run instead of re-deriving an ID.
- At most one `running` run per `(org_id, initiator, work_date)` — enforced by
  the partial unique index as a corruption backstop, with the class-`01`
  advisory lock (section 1.6) as the expected serialization path. Raw `23505`
  is never a control path.
- `generation` is allocated under that advisory lock as
  `1 + max(generation)` for the key. A fresh invocation after a terminal run
  starts generation `n+1`; this preserves today's behavior that a repeated
  `skipDedup` invocation produces another run and another event.
- `accepted_write_posture` is **frozen at creation** and immutable, exactly
  like the P07 job's field. Resuming a run under a different resolved posture
  is fail-closed remediation, never a silent rebase.
  `legacy_projection_only` and `suspended` create **no** run row (sections
  1.9).
- States are closed to `running|completed|abandoned`; only
  `running->completed` and `running->abandoned` are legal. `running` is the
  only non-terminal state and is always recoverable (section 1.7), so there is
  no stuck absorbing state.
- `abandoned` is an explicit operator remediation terminal state. It writes
  **no** outbox row and no source DML. It exists so a run whose targets can
  never complete cannot pin the partial unique index forever. Its full
  write path — authorization, org anchor, lock order, audit, concurrency,
  and idempotency — is specified in section 1.1.2, not restated here.
- Rows reject `DELETE`/`TRUNCATE`. An `UPDATE` guard trigger is implemented
  as a **generic allowlist**, not a column-by-column freeze list: it
  compares `to_jsonb(NEW)` and `to_jsonb(OLD)` with the mutable keys
  (`state`, `completed_user_count`, `generated_count`, `abandon_reason_code`,
  `abandoned_by_actor_posture`, `finalized_at`) removed from both sides via
  the jsonb `-` operator, and raises unless the two remaining objects are
  equal. Every column not in that mutable set is therefore frozen **by
  construction**, including any column a future migration adds without also
  adding it to this trigger's mutable set — the safe default is frozen, not
  mutable. The legal out-of-`running`-transition check is a **separate**
  condition evaluated by the same trigger, in addition to (not instead of)
  the jsonb-equality check. **Being in the mutable set does not by itself
  mean a column can be rewritten more than once**: `abandoned_by_actor_posture`
  is in the set (it must be settable by the one `UPDATE` that performs the
  `running -> abandoned` transition, alongside `state` itself), but because
  the same trigger's legal-transition check already forbids every `UPDATE`
  out of `abandoned` (there is no `abandoned -> anything` transition), and
  the only `UPDATE` that ever sets a non-`NULL`
  `abandoned_by_actor_posture` is that one transition, there is no second
  legal `UPDATE` that could ever reach it again. This is a consequence of
  the state machine, not a separate mechanism, and gate 23 (section 2) is
  the leg that proves it rather than assumes it — the general
  "in the mutable set" argument alone does not establish write-once-ness on
  its own, since a future column added to the mutable set without an
  equivalent state-machine closure would not get this property for free.
- `expected_user_count` equals the number of `target_kind='generate'` target
  rows; `review_count` equals the number of `target_kind='review'` target
  rows. Both are frozen at creation because both are fully known then. They
  are also constrained to match the actual target rows by a deferred
  commit-time constraint trigger, so an implementation cannot commit a run
  whose frozen counts disagree with its target rows.

#### 1.1.1 Pending `O-3`/`OD-W4C-50`: per-`generate`-target permanent failure

`chk_asr_terminal_shape` above encodes only the all-or-nothing shape:
`completed` requires `completed_user_count = expected_user_count`. As
drafted, this amendment defines **no** outcome for a `generate` target
whose per-user operation transaction fails **deterministically** (a
fail-closed rejection, not a transient error) — see section 0.5. Two
options; this draft does not choose between them.

**A prior revision of option (a) put the new columns directly on
`attendance_scheduled_run_targets`; that is retracted as unimplementable
and is not restated below.** Section 1.2 declares target rows fully
immutable (`UPDATE`/`DELETE`/`TRUNCATE` all refused by triggers — "the
run's frozen plan"), and a column whose value is unknown at the row's
insert time and is set later, by a different transaction, requires exactly
the `UPDATE` that immutability forbids. The corrected form below leaves
target rows untouched and adds a **separate, append-only side table**
instead — this is the only change from the retracted version; the
decision this section states (whether to add the outcome concept at all)
is unchanged.

- **(a) Add a durable per-target terminal-outcome side table, never a
  column on the immutable target row.**

  ```sql
  CREATE TABLE attendance_scheduled_run_target_outcomes (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               text NOT NULL,
    run_id               uuid NOT NULL,
    target_id            uuid NOT NULL,
    terminal_outcome     text NOT NULL,        -- closed: 'completed' | 'failed'
    failure_reason_code  text,                 -- non-null iff terminal_outcome = 'failed'
    recorded_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_asrto_target         UNIQUE (org_id, target_id),
    CONSTRAINT fk_asrto_target         FOREIGN KEY (target_id, org_id, run_id)
      REFERENCES attendance_scheduled_run_targets (id, org_id, run_id),
    CONSTRAINT chk_asrto_outcome       CHECK (terminal_outcome IN ('completed','failed')),
    CONSTRAINT chk_asrto_reason_pair   CHECK ((terminal_outcome = 'failed') = (failure_reason_code IS NOT NULL)),
    CONSTRAINT chk_asrto_reason_closed CHECK (
      failure_reason_code IS NULL
      OR failure_reason_code IN ('ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED')
    )
  );
  ```

  This table is **append-only**: exactly one row is ever inserted per
  target (`uq_asrto_target` enforces this), and — like the target rows
  themselves — every row refuses `UPDATE`/`DELETE`/`TRUNCATE` once
  inserted. Rows accumulate one at a time, as each `generate` target's
  per-user operation reaches its own terminal state over the run's
  lifetime; the table as a whole is never rewritten, only appended to.

  The FK requires section 1.2's target table to expose a matching unique
  key over `(id, org_id, run_id)` — a composite unique constraint over a
  superset of the existing primary key `id` (legal in PostgreSQL: `id`
  alone already guarantees the triple is unique, the composite constraint
  just makes it FK-referenceable). This option adds
  `CONSTRAINT uq_asrt_id_org_run UNIQUE (id, org_id, run_id)` to section
  1.2's `attendance_scheduled_run_targets`, in the same migration as this
  table (section 1.10). Section 1.2's own SQL block, its immutability
  triggers, and every existing constraint are otherwise **untouched** —
  this is one additive constraint, not a mutability change, and if `O-3`
  ratifies `(b)` instead, `uq_asrt_id_org_run` is never added and section
  1.2 is exactly as originally drafted.

  **Write path.** Exactly one row is inserted per `generate` target, by
  the **same** per-user canonical operation transaction (section 1.7,
  "Per-user execution") that seals that target's own
  `attendance_result_operations` row — in the same transaction, after that
  row's `claimed -> completed|canceled` transition, before commit. A
  per-user operation that completes its calculation normally seals
  `state='completed'` and inserts `terminal_outcome='completed'`. A
  per-user operation that determines a **deterministic, fail-closed
  rejection** (not a transient error — a transient error rolls the whole
  transaction back, leaving neither an operation row nor an outcome row,
  exactly as today, and is retried) seals `state='canceled'` — already one
  of `attendance_result_operations`' two legal terminal states
  (`OPERATION_STATES = ['claimed', 'completed', 'canceled']`,
  `w4c0-operation-contract.ts`; there is **no** third, "failed",
  operation-level state, and this option does not add one) — and inserts
  `terminal_outcome='failed'` with a closed `failure_reason_code`.

  **Authorization and exclusivity.** The only writer is a dedicated typed
  helper, `recordAttendanceScheduledRunTargetOutcomeV1(trx,
  operationWitness, outcome)`, gated on the **verified per-user operation
  identity** (the same witness shape W4C-0 already requires to seal the
  operation row itself) for the exact target it writes — a caller cannot
  forge an outcome for a target whose operation it does not already hold a
  verified witness for, and the helper is called from nowhere except the
  per-user operation transaction's own seal step (section 1.7).

  **Cross-table integrity is a deferred constraint trigger, not a
  `CHECK`.** A `CHECK` constraint cannot reference another table, so
  `chk_asr_terminal_shape` (section 1.1) cannot itself require "every
  `generate` target has a recorded outcome" — an earlier version of this
  option said otherwise and is wrong for the same reason the
  target-row-column version was wrong: it named a cross-table condition a
  single-row constraint cannot express. The corrected mechanism is a
  **second** `DEFERRABLE INITIALLY DEFERRED` constraint trigger (the same
  technique section 1.1's last bullet already uses to tie frozen
  `expected_user_count`/`review_count` to target rows), fired
  `AFTER UPDATE ON attendance_scheduled_runs FOR EACH ROW WHEN
  (NEW.state = 'completed' AND OLD.state = 'running')`: at commit, it
  requires every `target_kind='generate'` target row for `NEW.run_id` to
  have exactly one row in `attendance_scheduled_run_target_outcomes`
  (`uq_asrto_target` alone only enforces "at most one per target"; this
  trigger enforces "at least one, for every target"), and
  `NEW.completed_user_count` to equal the count of those rows with
  `terminal_outcome = 'completed'`. It additionally requires, for every
  outcome row it examines, that the corresponding per-user operation row's
  `state` agrees (`'completed'` iff `terminal_outcome = 'completed'`,
  `'canceled'` iff `terminal_outcome = 'failed'`) — nothing else in this
  schema mechanically binds an outcome row's label to the operation row it
  describes, so without this leg a caller could, through a bug rather than
  through the typed writer above, insert a mismatched pair that no CHECK
  would catch.

  `chk_asr_terminal_shape`'s `completed` branch (section 1.1) is
  **row-local** under this option — it does not, and structurally cannot,
  encode "every target has an outcome" itself; that is the deferred
  trigger's job, above. It changes from `completed_user_count =
  expected_user_count` to `completed_user_count IS NOT NULL AND
  completed_user_count <= expected_user_count` (dropping the equality,
  since a `failed` target is real and permanent but is not counted in
  `completed_user_count`). `generated_count` is unaffected (unchanged: it
  already only counts `inserted = true` rows among the `completed` ones).
  **Wire compatibility is preserved**: `attendance.absence.generated`'s
  `total` is `generated_count` — a target that never inserted a row was
  never counted by today's `generateAbsenceRecords`/`rows.length` either
  (`plugins/plugin-attendance/index.cjs:21238`), so a failed target changes
  nothing observable in that payload.

  Section 1.7 step 4 and section 1.8 steps 4-5 are written as a fork on
  this same decision directly in their own text, not restated here: under
  `(a)`, "terminal" for a `generate` target means "has a row in
  `attendance_scheduled_run_target_outcomes`"; under `(b)`, it means "has a
  `completed` operation row," exactly as originally drafted. This option
  needs gate 20 (section 2, extended): a run with one
  deterministically-failed `generate` target and all others `completed`
  reaches `state='completed'` and emits both run-level events with correct
  counts; a target with no row in the outcome table still blocks
  finalization (the deferred trigger raises); the outcome table itself is
  proven append-only, non-forgeable, and label-consistent with its
  operation row (gate 20's new legs, section 2).
- **(b) Keep the all-or-nothing shape** exactly as drafted, and accept as
  an explicitly declared residual (section 5) that one user's
  deterministic, permanent failure on a `generate` target withholds both
  run-level events for the **entire** org's `work_date` until an operator
  issues the explicit `abandoned` transition (section 1.1.2) — at which
  point both events are permanently lost for that run, not merely delayed,
  for every user including the ones who succeeded.
  `attendance_scheduled_run_target_outcomes` is never created under this
  option, and section 1.10's base migration is exactly as drafted (no
  outcome table, no `uq_asrt_id_org_run`).

Section 1.8 and section 2 are written above assuming whichever option is
chosen; no gate in this draft yet exercises the `failed` outcome, because
it does not exist until `O-3` selects (a).

#### 1.1.2 The `abandoned` transition: authorization, lock order, audit, concurrency, idempotency

Section 1.1's rules name `abandoned` as "an explicit operator remediation
terminal state" and its `chk_asr_abandon_reason`/`chk_asr_abandoned_by_posture`
constraints close its values, but section 1.1's rules do not by themselves
specify *how* a `running` run is transitioned to `abandoned` — who may do
it, under what lock, with what audit trail, or what happens if two callers
race or one caller retries. This subsection is that specification; it
governs regardless of which side `O-3`/`OD-W4C-50` (section 1.1.1) or
`O-4`/`OD-W4C-52` (section 1.7.1) selects, since `abandoned` remains a legal
target of the `running` state under either option combination that keeps
`OD-W4C-48=(a)` (section 3.3 lists the one combination — `48=(b)` — where
this subsection does not apply because the state does not exist).

**Entry point.** `abandonAttendanceScheduledRunV1(trx, callerIdentity, key:
{orgId, runId}, reasonCode)` is the **sole intended, module-encapsulated**
writer of the `running -> abandoned` transition — the same exclusivity
claim shape this document makes elsewhere for typed helpers
(`enqueueAttendanceScheduledRunEventOutboxV1` and its siblings), enforced
by TypeScript module encapsulation, not by a DB-level mechanism that could
stop an arbitrary raw `UPDATE` with a superficially valid
`abandoned_by_actor_posture`/`abandon_reason_code` pair from performing
the same transition outside this function. **This is a residual, disclosed
rather than closed**, of the same kind as section 5's "`run_id` FK
direction" entry: unlike gate 22's minting-factory exclusivity leg (which
asserts the symbol is absent from the compiled module surface), this
pass does not add an equivalent module-export-absence leg for
`abandonAttendanceScheduledRunV1` itself — doing so is straightforward by
the same technique and is left as a gate 23 follow-up, not specified here
in full. It is a new, administrator-initiated surface this amendment
adds — distinct from, and not routed through, any of the six existing
W4-covered command entrypoints (`live_punch`, `request_create`,
`request_pending_edit`, `request_decision`, `request_cancel`,
`import_batch`/`integration_batch`, `manual_edit`, `recompute`,
`import_rollback`, `ops_retirement`) and distinct from `scheduled` itself:
it performs no source DML and is not a "command" in that closed sense, so
it does not need, and does not get, an entry in `COMMAND_ENTRYPOINTS`.

**Authorization**, evaluated **before** any lock is acquired (fail-closed,
zero DML, zero lock contention on rejection):
- required capability: `retirement` — the existing closed `CAPABILITIES`
  member already used for the closest existing precedent,
  `ops_retirement`-class command entrypoints, since abandoning a run is,
  like retirement, an irreversible, admin-only, non-source-mutating
  remediation action of comparable blast radius. This document does not
  add a new capability for this action;
- required actor posture: closed to `{platform_admin, attendance_admin}` —
  never `self`, `scheduler`, `approval_system`, `delegated_import`, or the
  existing `operator` posture (extending `operator`'s meaning to this
  action is a separate decision this run-identity-focused document does
  not make; it is out of scope here, not silently assumed).

**Org anchor.** `callerIdentity` carries a verified org identity whose
`org_id` is compared, in every statement this function issues, against the
target run's own `org_id` — never against a caller-supplied `org_id`
alone. Combined with the class-00 acquisition below (itself org-scoped), a
caller authorized for org A can never lock, read-for-update, or transition
org B's run. This is covered by gate 13 (cross-org isolation, extended
below), not a new gate.

**Lock order — identical to section 1.8's finalization order, introducing
no fourth lock-order shape:**

1. acquire class-00 org rollout **shared** for the caller's org; resolve
   posture. **If the resolved posture is `blocked` (the org is
   `suspended`)**, the transition is **refused, deferred, not executed**:
   return the closed, values-free, **retryable** outcome
   `ATTENDANCE_SCHEDULED_RUN_ABANDON_DEFERRED` with **zero DML** — the run
   (if `running`) stays `running`; a later call, once the org is no longer
   `blocked`, may retry. This mirrors section 1.8 step 1's own first
   branch exactly, and is required by the same red line that branch
   already honors: `W4C-R43` (section 1, "not superseded, binding on this
   amendment's own design") states suspended stays retryable and
   **distinct from a terminal remediation outcome** — `abandoned` is
   precisely a terminal remediation outcome, so executing it while an org
   is `blocked` would convert a paused run into the very thing `W4C-R43`
   separates from suspension. If the resolved posture is `shadow` or
   `authoritative`, continue to step 2 — **unlike section 1.8 step 1**,
   there is no further posture-mismatch branch here: `abandoned` writes no
   source DML and its `completed_user_count` fold (step 4 below) is a
   point-in-time snapshot of already-durable evidence, not something a
   frozen `accepted_write_posture` comparison governs, so `O-4`/`OD-W4C-52`
   (section 1.7.1) does not fork this step the way it forks finalization's;
2. acquire the class-01 run key lock for `(org_id, initiator, work_date)`;
3. `SELECT ... FOR UPDATE` the run row. If it is **not** `running`
   (already `completed` or already `abandoned`), return the recorded
   outcome with **zero DML** — this is not an error. A second operator's
   concurrent or later abandon call, and the same caller re-issuing the
   same call after it already succeeded, both take this branch: this is
   this transition's **concurrency and idempotency** answer, and it is the
   same branch shape as section 1.8 step 3's losing-racer path, not a
   separate mechanism;
4. compute `completed_user_count` from currently-recorded evidence exactly
   as finalization's step 5 does — the count of `generate` targets whose
   per-user operation has reached a terminal state as of this instant
   (under `O-3=(b)`, a `completed` operation row; under `O-3=(a)`, a
   `terminal_outcome='completed'` row in
   `attendance_scheduled_run_target_outcomes`, section 1.1.1) — never from
   an in-memory count;
5. `UPDATE` the run row: `state='abandoned'`, `completed_user_count` = step
   4's value, `abandon_reason_code` = the caller-supplied, closed code
   (`chk_asr_abandon_reason`'s single member today), `abandoned_by_actor_posture`
   = the caller's verified posture, `finalized_at = now()`. No outbox row,
   no source DML, no calculation write, and no class-`11` acquisition —
   the same restriction section 1.8's finalization transaction states for
   itself, stated here explicitly because this is a different transaction
   shape and gate 15 was written against finalization, not this path (see
   gate 23 below);
6. commit.

**Audit.** `abandoned_by_actor_posture` (section 1.1) is the durable,
values-free record of *what kind* of actor performed the transition —
closed to the same two-member set the authorization check enforces, never
a raw user identifier or any other user-supplied value, consistent with
this line's values-free audit standard. This document does not define, and
does not need to define, a separate general-purpose audit-log table for
this action: the run row's own `abandoned_by_actor_posture` +
`abandon_reason_code` + `finalized_at` triple is the durable fact this
schema is responsible for, and full request-level identity/audit trail is
whatever mechanism already covers other admin-capability actions in this
codebase — a mechanism this run-identity-focused document has not audited
and does not redefine (see the residual note in section 5).

Section 2 gate 23 is this subsection's required-gate leg list.

### 1.2 Immutable run target rows

```sql
CREATE TABLE attendance_scheduled_run_targets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             text NOT NULL,
  run_id             uuid NOT NULL,
  work_date          date NOT NULL,
  ordinal            integer NOT NULL,     -- canonical emission order, 0-based
  user_id            uuid NOT NULL,
  target_kind        text NOT NULL,        -- closed: 'generate' | 'review'
  review_reason_code text,                 -- non-null iff target_kind='review'
  operation_id       uuid,                 -- non-null iff target_kind='generate'
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_asrt_ordinal UNIQUE (org_id, run_id, ordinal),
  CONSTRAINT uq_asrt_user    UNIQUE (org_id, run_id, user_id),
  CONSTRAINT fk_asrt_run FOREIGN KEY (run_id, org_id, work_date)
    REFERENCES attendance_scheduled_runs (run_id, org_id, work_date),
  CONSTRAINT chk_asrt_ordinal     CHECK (ordinal >= 0),
  CONSTRAINT chk_asrt_kind        CHECK (target_kind IN ('generate','review')),
  CONSTRAINT chk_asrt_review_pair CHECK ((target_kind = 'review')   = (review_reason_code IS NOT NULL)),
  CONSTRAINT chk_asrt_op_pair     CHECK ((target_kind = 'generate') = (operation_id IS NOT NULL)),
  CONSTRAINT chk_asrt_reason_closed CHECK (
    review_reason_code IS NULL OR review_reason_code IN (/* closed list, section 1.2.1 */)
  ),
  CONSTRAINT chk_asrt_derived_operation CHECK (
    target_kind <> 'generate'
    OR operation_id = attendance_w4_uuidv5(
         'e4363171-f53f-47d7-a074-607ef3fad391'::uuid,
         attendance_w4_scheduled_name_bytes(run_id, user_id, work_date))
  )
);
```

- Target rows are fully immutable: `UPDATE`, `DELETE`, and `TRUNCATE` are all
  refused by triggers. They are the run's frozen plan.
- `chk_asrt_derived_operation` reuses the **already RATIFIED** W4C-0 SQL
  UUIDv5 function and scheduled name-bytes helper
  (migration `zzzz20260725120000_...:241`, `:283`, `:545`) and the same namespace
  `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1`. No new derivation is
  invented, and the per-user operation row's own
  `chk_aro_derived_identity` continues to bind the same tuple, so plan and
  execution cannot disagree.
- The FK deliberately carries `work_date` so the derived-identity CHECK can be
  purely declarative without trusting a denormalized copy.
- `ordinal` freezes, at row-insert time, whatever order the run-creation
  transaction observed while resolving membership; once frozen it never
  changes, so the `reasons` array of `attendance.work_date.review_required`
  is reconstructed byte-stably at finalization regardless of restarts —
  finalization (section 1.8 step 6) always reads `ordinal` from these
  frozen rows, never re-resolves membership. **What is not yet decided is
  whether that per-run frozen order is itself required to be a canonical,
  deterministic function of membership** (so a byte-identical resume
  recomputation, section 1.7 step 3, is achievable) **or is allowed to
  remain whatever the membership query happens to return** (today's
  behavior, order-undefined). This is pending decision `O-2`/`OD-W4C-51` —
  see section 1.3 and section 3. The membership query this amendment
  resolves against
  (`plugins/plugin-attendance/index.cjs:21177-21185`, a `user_orgs`/`users`
  join) carries **no** `ORDER BY` today, so its result order is not
  guaranteed stable even for an unchanged membership set (PostgreSQL row
  order is unspecified absent an explicit sort, and is empirically
  affected by HOT updates, autovacuum, and plan shape). This draft does
  not change that query.
- **Conditional addition, not part of this table's base shape.** If `O-3`
  (section 1.1.1) ratifies `(a)`, this table gains one further constraint,
  `uq_asrt_id_org_run UNIQUE (id, org_id, run_id)`, added in the same
  migration as section 1.1.1's new outcome table — an additive unique
  constraint, not a change to any existing column, trigger, or the
  immutability guarantee above. If `O-3` ratifies `(b)`, this table is
  exactly as drafted in the SQL block above and gains nothing.

#### 1.2.1 Closed review reason codes

`review_reason_code` is closed to exactly the union of

- the **`// unresolved`-segment** members of the frozen `REASON` map
  exported by `plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs:28`
  (`NO_MATCHING_SHIFT`, `FREE_TIME_NO_SHIFT`, `UNSCHEDULED_NO_SHIFT`,
  `EXPLICIT_IMPORT_REQUIRES_SHIFT`, `EXPLICIT_SHIFT_MISMATCH`,
  `MALFORMED_CROSS_ORG_REFERENCE`, `MALFORMED_CROSS_USER_REFERENCE`,
  `MALFORMED_CANDIDATE_SHAPE`, `MALFORMED_CANDIDATE_SOURCE`,
  `INVALID_INPUT`, `NO_PUBLISHED_CANDIDATE`), and
- the three literals the scheduled loop supplies itself:
  `WORK_DATE_ATTRIBUTION_MISMATCH`, `WORK_DATE_ATTRIBUTION_AMBIGUOUS`,
  `WORK_DATE_ATTRIBUTION_UNRESOLVED`.

The full `REASON` map has **20** members across three `//`-commented
segments: 7 `resolved`, 2 `ambiguous`, 11 `unresolved`. Both non-`unresolved`
segments (9 codes total) are intentionally **excluded**, confirmed by direct
read of the scheduled loop's branches, not merely by the map's own comments:
the scheduled loop (`plugins/plugin-attendance/index.cjs:21207-21216`) never
surfaces a `kind === 'resolved'` result's `reasonCode` as a review reason —
a resolved result either matches today's `workDate` (goes to `targetUsers`,
no review row at all) or is demoted to the literal
`WORK_DATE_ATTRIBUTION_MISMATCH`, never to its own `resolved`-segment code;
and `kind === 'ambiguous'` (`index.cjs:21218-21223`) always pushes the
literal `WORK_DATE_ATTRIBUTION_AMBIGUOUS`, never
`scheduledResolution.reasonCode`, so the `ambiguous`-segment codes
(`OVERLAPPING_SHIFT_WINDOWS`, `MULTIPLE_PUBLISHED_CANDIDATES`) are equally
unreachable. Closing the DB constraint over the full 20-member map instead
of this **14-member** reachable subset (11 `unresolved` codes + 3 literals)
would admit 9 values the running system can never produce, silently
weakening the negative gate section 1.5 requires ("an unlisted reason code
is rejected at the DB boundary") by making it impossible to distinguish
"this code is unreachable and correctly rejected" from "this code merely
hasn't occurred in a test run yet".

This creates a **third dual-copy** (resolver module + migration CHECK). The
implementation must add the same kind of parity gate required in section 1.5
and a negative gate proving an unlisted reason code is rejected at the DB
boundary rather than silently stored or coerced.

### 1.3 Target-set fingerprint

`target_set_fingerprint` is the lowercase hex SHA-256 of the canonical
NUL-separated byte string

```text
"metasheet2:attendance:scheduled-run-target-set:v1\0"
  + orgId + "\0" + initiator + "\0" + workDate
  + for each target in ascending ordinal:
      "\0" + ordinal(decimal, no padding)
      + "\0" + userId
      + "\0" + targetKind
      + "\0" + (reviewReasonCode ?? "")
```

Properties this lock requires:

- **Deterministic and order-sensitive.** It pins both membership and the
  emission order that the `reasons` array will reproduce.
- **Computed once**, from the exact frozen target rows, inside the run-creation
  transaction; never recomputed from mutable membership afterwards except for
  the resume equality check.
- **Resume guard, not a run key.** Its only enforcement role is section 1.7's
  resume check: a resumed `running` run whose recomputed target set differs in
  any byte is fail-closed remediation. It is *not* an input to `run_id`,
  because a roster change between two separate invocations is normal and must
  produce a new generation rather than a conflict.
- Ordinal is included explicitly so that two runs with the same membership but
  different resolution order are distinguishable.

**Pending `O-2`/`OD-W4C-51`.** Section 1.7 step 3's resume guard requires
byte-equality between a freshly recomputed `target_set_fingerprint` and the
frozen one — and because the fingerprint is order-sensitive (above), that
equality is only reliably reproducible across a restart if the membership
query's result order is itself deterministic, which it is not today
(section 1.2). Two options close this; this draft does not choose:

- **(a) Pin a canonical order.** Change the membership query to `ORDER BY
  user_id` (or another explicit, total, deterministic key) so `ordinal` is a
  pure function of membership and a resume recomputation is byte-identical
  by construction. **Consequence:** the `reasons` array's observable order
  changes once, from today's undefined order to the canonical one. Gate 4
  (section 2) currently requires payload bytes "identical to the
  pre-amendment synchronous emit for the same inputs" — that claim must be
  narrowed to key-set/value-set equivalence plus the new canonical order,
  since today's order was never pinned and a byte-for-byte match against an
  arbitrary legacy order is not achievable once the order is pinned to
  something else.
- **(b) Keep the resolved order undefined**, and change section 1.7 step 3's
  resume guard from an ordered byte-comparison to an **order-insensitive**
  comparison: a second fingerprint computed over the sorted tuple set
  `{(userId, targetKind, reviewReasonCode)}` (no `ordinal` term), so
  membership drift is still caught but a benign reordering across a resume
  is not. `ordinal` itself is retained on each target row purely for output
  stability (section 1.2's cross-restart guarantee holds either way, since
  finalization never re-resolves membership). **Consequence:** gate 10
  (section 2) currently requires "a resume whose recomputed target set
  differs by one user, one reason code, **or one ordinal**, is fail-closed
  remediation" — the "or one ordinal" clause must be withdrawn under (b),
  since an ordinal-only difference across a resume becomes expected and
  benign, not a defect. This is a gate rollback the owner is choosing, not
  a simplification the author is entitled to make alone.

Precedent for carrying two fingerprints (one ordered, one not) for exactly
this reason exists in the governing lock's batch-registry design (lock
lines 1077-1084: `item_sequence_fingerprint` **and** `item_set_fingerprint`,
computed together); either option above may adopt that shape once `O-2` is
decided.

### 1.4 Outbox identity becomes an explicit discriminated union

`attendance_result_event_outbox` gains an explicit discriminant and a second,
mutually exclusive identity column:

```sql
ALTER TABLE attendance_result_event_outbox
  ADD COLUMN identity_kind    text,      -- closed: 'operation' | 'scheduled_run'
  ADD COLUMN scheduled_run_id uuid,
  ALTER COLUMN operation_id DROP NOT NULL;

-- after backfill (section 1.10):
ALTER TABLE attendance_result_event_outbox
  ALTER COLUMN identity_kind SET NOT NULL,
  ADD CONSTRAINT chk_areo_identity_kind
    CHECK (identity_kind IN ('operation','scheduled_run')),
  ADD CONSTRAINT chk_areo_identity_operation
    CHECK ((identity_kind = 'operation')      = (operation_id IS NOT NULL)),
  ADD CONSTRAINT chk_areo_identity_run
    CHECK ((identity_kind = 'scheduled_run')  = (scheduled_run_id IS NOT NULL)),
  ADD CONSTRAINT chk_areo_identity_exclusive
    CHECK ((operation_id IS NULL) <> (scheduled_run_id IS NULL)),
  ADD CONSTRAINT fk_areo_operation
    FOREIGN KEY (org_id, entrypoint, operation_id)
      REFERENCES attendance_result_operations (org_id, entrypoint, operation_id),
  ADD CONSTRAINT fk_areo_scheduled_run
    FOREIGN KEY (scheduled_run_id, org_id)
      REFERENCES attendance_scheduled_runs (run_id, org_id),
  ADD CONSTRAINT chk_areo_kind_identity_map CHECK (
    CASE event_kind
      WHEN 'attendance.absence.generated'          THEN identity_kind = 'scheduled_run'
      WHEN 'attendance.work_date.review_required'  THEN identity_kind = 'scheduled_run'
      ELSE identity_kind = 'operation'
    END
  ),
  ADD CONSTRAINT chk_areo_run_entrypoint
    CHECK (identity_kind <> 'scheduled_run' OR entrypoint = 'scheduled');

-- uq_areo_identity is a table CONSTRAINT, dropped only after the
-- replacement partial unique index below exists:
--   ALTER TABLE attendance_result_event_outbox
--     DROP CONSTRAINT uq_areo_identity;
CREATE UNIQUE INDEX uq_areo_operation_identity
  ON attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind)
  WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX uq_areo_run_identity
  ON attendance_result_event_outbox (org_id, entrypoint, scheduled_run_id, event_kind)
  WHERE scheduled_run_id IS NOT NULL;
```

**A run ID may never masquerade as a per-user operation ID.** Six
mechanical blocks, each separately mutation-provable (blocks 1-5 are
independent of each other; block 6 is not a further independent block but
a guard *for* blocks 3-4 — see block 6's own text — closing the
NULL-discriminant hole that would otherwise let SQL three-valued logic
defeat them):

1. **Referential.** `fk_areo_operation` did not exist before. A run UUID
   written into `operation_id` has no matching
   `attendance_result_operations` row and is rejected by the database.
   Symmetrically `fk_areo_scheduled_run` rejects a per-user operation UUID
   written into `scheduled_run_id`.
2. **Namespace.** A scheduled per-user operation ID is UUIDv5 over
   `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1` and is verified by the
   existing `chk_aro_derived_identity`; a run ID is a random v4 with no
   derivation. Neither can satisfy the other's constraint.
3. **Kind map.** `chk_areo_kind_identity_map` forbids the two run-level kinds
   from ever carrying an `operation_id`, and forbids the six per-user kinds
   from ever carrying a `scheduled_run_id`.
4. **Entrypoint binding.** `chk_areo_run_entrypoint` additionally ties
   `identity_kind='scheduled_run'` to `entrypoint='scheduled'`, closing a
   corruption-backstop gap: without it, the DB alone does not prevent a
   `(run, kind)` tuple existing twice under two different `entrypoint`
   values, since `uq_areo_run_identity` (below) includes `entrypoint` in
   its key. No known code path can construct this today — the single typed
   producer's `entrypoint` field is fixed to `'scheduled'` — but the CHECK
   is one line and free.
5. **Type-level.** The TypeScript enqueue surface splits into two functions
   with **disjoint opaque witnesses** (section 1.4.1). A run witness is not
   accepted by the operation enqueue and vice versa; a bare UUID string is
   accepted by neither.
6. **Non-null discriminant.** `identity_kind` is `NOT NULL` (section 1.10
   step 4, added **after** the backfill, per the same ordering constraint as
   the CHECK constraints in that step). Without it, an insert with
   `identity_kind IS NULL` defeats blocks 3 and 4 above via SQL three-valued
   logic: `CASE 'attendance.absence.generated' WHEN identity_kind =
   'scheduled_run' ...` and `identity_kind <> 'scheduled_run' OR entrypoint =
   'scheduled'` both evaluate to `UNKNOWN` (not `FALSE`) when `identity_kind`
   is `NULL`, and a CHECK constraint **passes** on `UNKNOWN` — it only fails
   on `FALSE`. A `NULL`-discriminant row (e.g. `identity_kind=NULL,
   operation_id=<real per-user operation>, event_kind='attendance.absence.generated',
   entrypoint='live_punch'`) would satisfy `chk_areo_identity_operation` (also
   `UNKNOWN` on `NULL = TRUE`), `chk_areo_identity_run`, and
   `chk_areo_identity_exclusive` (a strict boolean, unaffected by
   `identity_kind`), landing a run-level event kind on a per-user identity
   with an arbitrary `entrypoint`, undetected by blocks 3-4. Dropping the
   `NOT NULL` constraint (leaving `identity_kind` nullable, as an
   implementation that follows section 1.10's numbered steps literally
   without this addition would) must make only this leg fail; blocks 1-5 and
   every other gate 1 leg must remain green under that same mutation, since
   none of them independently reaches a `NULL`-discriminant row.

`chk_areo_delivered_pair`, the `pending|delivered` state machine, the
`attempts`/`next_attempt_at` fields, and the `DELETE`/`TRUNCATE` refusals
are unchanged and apply identically to run-level rows.

**The immutability trigger is not unchanged and must be extended in this
migration.** `attendance_w4_outbox_update_guard()` (migration
`zzzz20260725120000_...:1493-1518`) is implemented as a column-by-column
freeze list — `id`, `org_id`, `entrypoint`, `operation_id`, `event_kind`,
`payload`, `payload_schema_version`, `business_key_fingerprint`,
`created_at` — that predates this amendment's two new columns
(`identity_kind`, `scheduled_run_id`). Left as-is, neither new column is
protected: a `pending` run-level row's `scheduled_run_id` could be
`UPDATE`d to point at a different run of the same org without tripping any
existing check, letting one run's outbox row be delivered under another
run's identity. This amendment requires the same generic-allowlist rewrite
as section 1.1's run-row trigger: `CREATE OR REPLACE FUNCTION
attendance_w4_outbox_update_guard()` compares `to_jsonb(NEW)` and
`to_jsonb(OLD)` with the mutable keys (`delivery_state`, `attempts`,
`next_attempt_at`, `delivered_at`) removed from both sides, keeping its
existing `delivery_state`-terminality and `attempts`-non-decreasing checks
unchanged. This is a required code change, made in the **same** migration
as section 1.10's other steps, not a no-op — see gate 1's added legs in
section 2.

**New write-order dependency.** `fk_areo_operation` (added here; W4C-0
deliberately omitted it, section 0.2) means a per-user enqueue call must
occur **after** its operation row's `INSERT`, not before — this is
compatible with `claimed` already existing at that point (lock line 2672ff's
"before operation seal" ordering is about the outbox row preceding the
operation's own **seal**, not its **creation**), but it is a call-order
requirement on the existing W4C-0 enqueue interface that section 0.2's
dual-copy description did not carry. Section 2 gate 1 gains a leg:
enqueuing before the operation row exists is rejected by the FK.

#### 1.4.1 TypeScript surface

```ts
type VerifiedAttendanceScheduledRunIdentityV1 = Opaque<Readonly<{
  runId: CanonicalAttendanceScheduledRunIdV1
  org: VerifiedAttendanceOrgIdentityV1
  entrypoint: 'scheduled'
  initiator: 'cron' | 'admin_run'
  workDate: CanonicalAttendanceWorkDateV1
  generation: number
  targetSetFingerprint: string
}>>

rehydrateVerifiedAttendanceScheduledRunIdentityV1(durableRow):
  VerifiedAttendanceScheduledRunIdentityV1

// module-private — not exported from this file; see the exclusivity note below
mintAttendanceScheduledRunIdentityFromInsertedRowV1(insertedRow):
  VerifiedAttendanceScheduledRunIdentityV1

buildAttendanceScheduledRunAdvisoryKey(
  key: CanonicalAttendanceScheduledRunKeyV1,   // (org, initiator, workDate)
): bigint

acquireAttendanceScheduledRunLock(
  trx,
  key: CanonicalAttendanceScheduledRunKeyV1,
): Promise<void>

enqueueAttendanceScheduledRunEventOutboxV1(
  trx,
  identity: VerifiedAttendanceScheduledRunIdentityV1,
  events: readonly AttendanceOutboxEventInputV1[],
): Promise<void>
```

- The run identity is minted only from a row this module itself just wrote
  or read under the class-`01` lock — **never** from caller-supplied
  fields. There are exactly **two** constructors, and both are defined in,
  and neither is exported outside, the module that also defines the
  run-creation, resume, and finalization transactions — the module that
  supersedes `w4c2-live-scheduled-boundary.ts`'s
  `deriveAttendanceScheduledRunIdV1` (section 1.1's "must not survive
  implementation" rule) — so there is no import path to either constructor
  from outside that module, not merely an absent name on a re-exporting
  barrel file:
  - `rehydrateVerifiedAttendanceScheduledRunIdentityV1(durableRow)` — used
    by the resume protocol (section 1.7) and by the finalization
    transaction's step 3 `SELECT ... FOR UPDATE` re-read (section 1.8),
    always over a row read under the class-`01` lock, whether or not that
    read is in the same transaction that originally inserted the row;
  - `mintAttendanceScheduledRunIdentityFromInsertedRowV1(insertedRow)` —
    used **only** by section 1.7 step 5-6's run-creation transaction, over
    the exact row its own `INSERT ... RETURNING` produced, still holding
    the class-`01` lock acquired at step 2. This is the constructor the
    zero-`generate`-target case (section 1.9) uses, since that case's
    run-creation transaction is itself the finalization transaction and
    therefore must enqueue before its own transaction's `COMMIT` — there
    is no separately-committed row to re-read, so
    `rehydrateVerifiedAttendanceScheduledRunIdentityV1` does not apply to
    it.

  Both constructors validate the same shape (every field
  `VerifiedAttendanceScheduledRunIdentityV1`'s own type requires) and apply
  the same defensive rejection of a row that fails any of the table's own
  CHECK/FK invariants — this equalizes their trust level rather than
  special-casing the second one.

  **Equivalence argument, corrected from a prior overstatement.** A row
  produced by this transaction's own `INSERT ... RETURNING`, while
  class-`01` is held for the run key and no other transaction can
  concurrently start or complete a run for the same `(org_id, initiator,
  work_date)` (section 1.1's serialization guarantee), carries exactly the
  same guaranteed-valid shape a later re-read under `FOR UPDATE` would
  see — the only difference is which side of this transaction's own
  `COMMIT` the read happens on. The retired wording above this correction
  said the identity is minted "only by rehydration from the **committed**,
  locked run row" — that was already imprecise for the **mainline**
  (non-zero-target) path too: section 1.8 steps 7-8 already enqueue the
  finalization transaction's own outbox rows **before** that same
  transaction's `COMMIT` (step 9), over a row read at step 3, which is
  itself not yet committed at the point of enqueue. What actually holds,
  for both constructors, is narrower and true of both: **read under the
  class-`01` lock, within the transaction that owns it, after the row's
  own `INSERT`/`SELECT` has satisfied every table `CHECK`/`FK`** — not
  "after commit." The zero-target case is not a carved-out exception to a
  committed-row rule; it is the same rule, applied to the `INSERT`
  statement's own `RETURNING` clause instead of a subsequent `SELECT`.
- **Exclusivity.** `mintAttendanceScheduledRunIdentityFromInsertedRowV1` is
  not exported from its defining module at all — not from a barrel file,
  not from the module itself. No other call site (not the resume
  protocol, not the recovery sweep, not the finalization transaction, not
  test code outside the module) can reach it; gate 22 (section 2) proves
  this at the compiled-module boundary, not by source-text grep, per this
  document's own standing rule against source-text-only assertions.
- `enqueueAttendanceResultEventOutboxV1` keeps its current signature and its
  `requireVerifiedAttendanceOperationIdentityV1` strictness
  (`w4c0-operation-registry.ts:820-856`); it additionally sets
  `identity_kind='operation'` and rejects the two run-level kinds.
- `enqueueAttendanceScheduledRunEventOutboxV1` rejects everything except the
  two run-level kinds and fail-closes on `legacy_projection_only` exactly as
  the operation enqueue does today (`W4C0_OUTBOX_LEGACY_FORBIDDEN`).
- JSON clones, spreads, prototype lookalikes, and plain objects are rejected
  by both `rehydrateVerifiedAttendanceScheduledRunIdentityV1` and
  `mintAttendanceScheduledRunIdentityFromInsertedRowV1`, per the W4C-0
  amendment's witness doctrine — neither constructor accepts a caller-built
  object shaped like a real row.

### 1.5 Closed event-kind set extension and the two copies

`ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1` gains exactly two members:

```text
attendance.absence.generated
attendance.work_date.review_required
```

The list exists **twice** —
`packages/core-backend/src/attendance/w4c0-operation-contract.ts:92` and
`.../migrations/zzzz20260725120000_...:210` (`OUTBOX_EVENT_KINDS`, consumed by
`chk_areo_event_kind`) — and the TS file's own comment at lines 85-90 already
warns that both must be reconciled. This amendment requires:

- both copies changed in the same commit;
- **the TS file's comment at lines 85-90 rewritten in the same commit.** As
  written on `origin/main`, that comment asserts the (today six-member) TS
  list is "byte-identical to the Stage A migration's `OUTBOX_EVENT_KINDS`"
  and directs the reconciler to check "BOTH copies" against each other.
  Section 1.10 step 6 deliberately makes that assertion false once this
  migration lands: the already-applied Stage A migration's `OUTBOX_EVENT_KINDS`
  constant is permanently excluded from parity once this migration lands,
  and the TS copy's new parity partner is **this new migration's own local
  eight-member literal** (section 1.10 step 6), not Stage A's. Leaving the
  comment as-is would point the next maintainer, or Stage D's generated
  reachable-event inventory reconciliation, at the wrong object — exactly
  the "inventory defect must not recur silently" failure section 0.1 reason
  2 names. The comment must be rewritten to name the new migration's local
  literal as the parity partner, and gate 9's parity assertion (section 2)
  must read the same object the rewritten comment names, not the old one;
- a **parity gate** that fails when the two lists differ in membership or
  order, executed in a CI-gated suite (a source-text regex over one file is
  not acceptable evidence);
- a negative gate proving an unlisted kind is rejected at the DB boundary;
- W4C-0's generated reachable-event inventory reconciled against both copies,
  since section 0.1 reason 2 classifies the current omission as an inventory
  defect that must not recur silently.

Payloads stay byte-identical to today:

- `attendance.absence.generated` — closed key set exactly
  `{orgId, workDate, total}`, `total` = the run's `generated_count`;
- `attendance.work_date.review_required` — closed key set exactly
  `{orgId, workDate, total, reasons}`, `total` = the run's `review_count`,
  `reasons` = the ordered array of `{userId, reasonCode}` rebuilt from the
  `target_kind='review'` target rows in ascending `ordinal`.

`business_key_fingerprint` for both is the lowercase SHA-256 over
`"metasheet2:attendance:scheduled-run-event:v1\0" + eventKind + "\0" + orgId
+ "\0" + workDate + "\0" + runId`. `payload_schema_version` is `1`.

The `reasons` array is a per-user vector and is the single exception to
"no per-user data in a run-level payload"; it is admitted because it is the
**existing public payload** and removing it would be the wire break `(b2)`
exists to avoid. It is a closed shape (`userId`, `reasonCode` only, with
`reasonCode` from section 1.2.1's closed list) and is never a free-form
snapshot.

### 1.6 Advisory class `01` and lock order

> **Pending `O-1`/`OD-W4C-49`.** This section describes the assignment this
> amendment proposes. It supersedes red line `W4C-R42` and the three
> digest-seam/gate clauses named in section 1's supersession list, none of
> which this amendment is authorized to rewrite on its own — see section 3.
> Until `O-1` is ratified, no implementation may acquire class `01`.

`OD-W4C-40` reserved class `01`. This amendment assigns it to the scheduled
run key:

```text
buildAttendanceScheduledRunAdvisoryKey =
  BigInt.asIntN(64,
    (u64(SHA-256("metasheet2:attendance:scheduled-run:v1\0"
                 + orgId + "\0" + initiator + "\0" + workDate)) & LOW_62_MASK)
    | 0x4000000000000000n)
```

- Same construction discipline as the three existing builders in
  `w4c0-identity.ts:866-960`: first eight digest bytes, big-endian, low 62
  bits, two-bit class prefix, signed two's complement.
- The key is over the **run key tuple**, not `run_id`, because it must also
  serialize two concurrent *starts* that do not yet have an ID.
- Canonical order becomes `00` rollout → `01` scheduled run → `10` operation
  identities → operation/batch/item rows → `11` targets. Class `01` sits where
  it does because a run is strictly coarser than the per-user operations it
  contains.
- **Cross-class upgrade stays forbidden.** A scheduled-run key is never
  derived from an operation identity and never passed to
  `acquireAttendanceResultOperationLocks`; an operation identity is never
  passed to `acquireAttendanceScheduledRunLock`. The classes remain disjoint
  by construction and each helper re-validates its own witness type.
- The run helper uses the same helper-wide monotonic deadline protocol as the
  operation/target helpers and maps its own typed budget/acquisition timeout
  (including its own `55P03`) to values-free
  `503 ATTENDANCE_SCHEDULED_RUN_BUSY`. No other `55P03`/`57014` is relabeled;
  no retry, no compatibility fallback, no partial DML.
- Only the scheduled entrypoint acquires class `01`. Live, import,
  integration, request, and approval paths acquire it never.
- The existing builder-disjointness test
  (`w4c0-identity.test.ts:740`, currently titled "keeps the two-bit classes
  disjoint: 00 rollout, 10 operation, 11 target, 01 never") asserts
  disjointness only over the three builders that existed before this
  amendment; as written, adding this section's fourth builder does **not**
  make it fail, because it never iterates the module's builder surface —
  it names three builders by hand. This amendment requires that test
  rewritten to (a) enumerate every builder the module **exports** (not a
  hand-written list, so a future fifth builder cannot repeat this gap),
  (b) assert the run builder's key lands in `[2^62, 2^63)` and every other
  builder's key does not, and (c) fail if any exported builder has no
  class assignment at all. See gate 16, section 2.

### 1.7 Start, per-user execution, restart resume

**Run-creation transaction** (one transaction, no per-user source DML):

1. begin `SERIALIZABLE`; acquire class-`00` org rollout **shared** and resolve
   posture. `suspended` returns the closed operational outcome with zero DML;
   `legacy_projection_only` leaves the transaction and takes section 1.9's
   legacy path with zero W4 rows;
2. acquire the class-`01` run key lock;
3. re-read `attendance_scheduled_runs` for the key. If a `running` row exists,
   this is a **resume**, not a start: go to the resume protocol below;
4. resolve membership and per-user work-date attribution exactly as today,
   producing the ordered target vector;
5. allocate `generation`, compute `target_set_fingerprint`, insert the run row
   (`state='running'`, frozen posture and counts) and all target rows;
6. commit. For a run with at least one `target_kind='generate'` target, no
   absence row, calculation, operation row, or outbox row is written by
   this transaction — per-user work and finalization happen in later,
   separate transactions (below, section 1.8). A run with **zero**
   `generate` targets has no later per-user work to wait for; section 1.9
   specifies that case, where this transaction **is** the finalization
   transaction (section 1.8's steps 5-9 execute inline, in the same
   `SERIALIZABLE` transaction, after step 5 above and before commit).

**Per-user execution** is unchanged from the held branch: for each
`target_kind='generate'` target, one canonical operation transaction with the
W4C-0 `scheduled` identity derived from `(run_id, user_id, work_date)`,
acquiring class-`00` shared, then class-`10`, then class-`11`. A per-user
transaction **must not** update the run row, so per-user work never contends
on it.

Fail-closed rule: a scheduled per-user operation whose `source_root_id` has no
committed `attendance_scheduled_runs` row, or whose run is not `running`, is
rejected **before** source DML.

**Resume protocol** (restart, crash recovery, or duplicate invocation):

1. under class-`00` shared and class-`01`, read the `running` run row
   `FOR UPDATE` and its target rows;
2. require the frozen `accepted_write_posture` to equal the currently resolved
   posture; a mismatch is fail-closed remediation (no silent rebase);
3. recompute the target set from current membership and require byte equality
   with `target_set_fingerprint`. Any difference is fail-closed remediation;
   the run is never silently re-planned;
4. the set of users still to do is exactly the `target_kind='generate'`
   targets that are not yet **terminal** — under `O-3=(b)` (as originally
   drafted), terminal means an operation row exists at exact key
   `(org_id,'scheduled',operation_id)` with `state='completed'`; under
   `O-3=(a)` (section 1.1.1), terminal means a row exists in
   `attendance_scheduled_run_target_outcomes` for that target — never by an
   in-memory cursor, a process-local set, or a count. A terminal target is
   replayed with zero DML by the existing preflight (a `completed`
   operation row under either option; under `O-3=(a)`, a `failed` outcome
   is never retried — retrying a deterministic rejection would reproduce
   the same rejection, so the zero-DML replay applies to it too, just
   without re-attempting the calculation write);
5. after the last outstanding user completes, attempt finalization
   (section 1.8).

Because step 3 compares against the frozen fingerprint rather than mutating
the plan, `skipDedup` and the process-local `lastAutoAbsenceKey` can neither
duplicate nor bypass durable state: a second invocation while a run is
`running` resumes it; a second invocation after it is terminal creates
generation `n+1`.

**No stuck absorbing state — recovery sweep, fully specified.** A `running`
run whose targets are all terminal (per section 1.7's per-target check) but
which was never finalized is finalized by a **registered, module-private**
recovery sweep (matching the private-processor doctrine of governing lock
lines 1159-1163) — never by request body, lease token, or process identity.
The sweep is not a new concept invented here; it is the same mechanism this
lock already requires to resume `running` runs, given a second
responsibility, fully specified as follows:

- **Trigger and period.** Runs on the existing scheduled-entrypoint
  processor's tick — no new cron surface. Each tick scans; it does not wait
  for an external caller.
- **Scan predicate — must be cross-`workDate`.** `state = 'running'`, **not**
  scoped to today's `work_date`. Section 1.6's class-`01` key and this run
  row's own key both include `work_date`, so a run stranded on a prior
  calendar day is invisible to any predicate scoped to the current day and
  would never be swept. The scan is bounded (a `LIMIT`/batch cap per tick),
  not unbounded, so sweep cost is proportional to the number of stranded
  runs, not to total run history.
- **Locking.** For each candidate run: acquire class-`00` org rollout
  **shared**, then the class-`01` run key lock, then re-check `state =
  'running'` under that lock before doing anything — the same order as the
  resume protocol and section 1.8's finalization, so the sweep introduces
  no new lock-order leg.
- **Two branches per candidate, both already fully specified elsewhere in
  this section** — the sweep introduces no third transaction shape, and
  uses the **same** terminal-evidence definition step 4 above forks on
  `O-3` (not the pre-`O-3` "absent or not `completed`" test — using that
  test unmodified here would, under `O-3=(a)`, make a `failed` target both
  "not `completed`" and "terminal" at once, so both branches below would
  fire for the same candidate and the resume branch would retry a target
  section 1.1.1 already specifies as never retried):
  - if any `target_kind='generate'` target is **not yet terminal** by step
    4's definition (under `O-3=(b)`, its operation row is absent or not
    `completed`; under `O-3=(a)`, it has no row in
    `attendance_scheduled_run_target_outcomes`), the sweep resumes the run
    exactly as the resume protocol above describes (this is the "restart"
    case with no process to restart);
  - if every `generate` target **is** terminal by that same definition, the
    sweep attempts finalization exactly as section 1.8 describes, including
    its posture handling (below).
- **Authorization.** The sweep is the scheduled entrypoint's own registered
  processor acting under its existing service identity; it accepts no
  caller-supplied run ID scope beyond what its own scan produces, and no
  request-supplied posture, org, or identity input can widen or narrow
  which rows it is allowed to touch.
- **Closes the window this draft would otherwise leave open:** the last
  per-user commit succeeding and the finalization attempt never running
  (process death between the two) leaves a run with all targets terminal
  but `state='running'` forever, absent this sweep. Section 2 gate 18 lists
  the required mutation legs, including a positive control (kill the
  process, prove the sweep alone finalizes within the bounded scan window)
  and a negative control (disable the sweep, prove only that leg fails).
- **`dedup` early return does not, and must not, block the sweep.** The
  scheduled entry point's in-process `lastAutoAbsenceKey` dedup early
  return (`plugins/plugin-attendance/index.cjs:21173-21176`) is a
  **process-local** variable set only after a successful synchronous
  completion; it does not survive a process restart and therefore cannot
  mask the crash-recovery case gate 18 exercises. It can mask only a
  same-process, immediate-retry race (per-user work finishes,
  `lastAutoAbsenceKey` is set, finalization fails transiently, the next
  same-process invocation hits the dedup early return before reaching step
  3's resume check). This amendment requires the dedup early return to be
  positioned **after** acquiring the class-`01` run key lock and re-reading
  run state — never before — so a `running` run with terminal targets is
  always visible to the resume/finalize decision regardless of
  `lastAutoAbsenceKey`.

A run that cannot progress (section 1.1.1) is closed by the explicit
`abandoned` transition.

#### 1.7.1 Pending `O-4`/`OD-W4C-52`: does a `running` run block shadow/eligible promotion?

Section 0.5 names the mid-run-promotion trigger: the governing lock's
shadow/eligible promotion-block predicate (lock lines 2689-2690, 2250)
blocks promotion only while an *operation* row is frozen in another
posture; a `running` `attendance_scheduled_runs` row is invisible to it,
because an incomplete per-user target has no row yet (lock lines
1124-1129: `claimed` is transaction-scoped). Once promotion proceeds while
a run is mid-flight, section 1.8 step 1's posture handling (below) is what
determines whether finalization can still happen. Two options; this draft
does not choose:

- **(a) Extend the promotion-block predicate.** The lock-2689-2690 /
  lock-2250 predicate, and the matching migration contract, are extended to
  also treat any `attendance_scheduled_runs` row with `state='running'` as
  a blocking object — the same treatment an incomplete operation already
  gets. Promotion is refused (fail-closed, values-free) while any run is in
  flight for that org. Section 1.8 step 1's `shadow`-vs-`authoritative`
  mismatch branch (below) becomes practically unreachable, but is **not**
  removed from the spec — it remains the fail-closed backstop if the
  predicate extension is ever bypassed. **Operational consequence, which
  the owner must weigh, not the author:** a rollout's shadow-to-
  authoritative promotion window must avoid colliding with an in-flight
  scheduled run, changing today's promotion-timing assumptions. **This
  consequence is materially worse, not merely additive, if `O-3`/`OD-W4C-50`
  is also `(b)` (section 1.1.1)**: under `50=(b)`, a single `generate`
  target's deterministic, permanent failure leaves the run `running`
  indefinitely until an operator explicitly abandons it (section 1.1.2) —
  and under `52=(a)`, a `running` run blocks the org's entire
  shadow-to-authoritative promotion. The two together mean one user's
  unrelated failure can block an org-wide rollout promotion pending manual
  operator intervention, not just a short, self-resolving collision window.
  This is not an exclusion (`abandoned` is still a working exit, so no run
  is stuck-forever), but section 3.3 lists it as an owner-relevant cost
  **interaction**, not merely two independent tradeoffs to weigh
  separately.
- **(b) Do not block promotion.** Section 1.8 step 1's `shadow`-vs-
  `authoritative` mismatch branch instead becomes the **primary** path (not
  a backstop): finalization is redefined to execute **under the run's own
  frozen `accepted_write_posture`**, folding counts and emitting events as
  if that posture were still current, rather than failing on a mismatch
  with the currently resolved posture at all. This is a **narrower**
  version of the lock's already-completed-operation replay teaching (lock
  lines 1109-1111) — finalization contains no source DML, so nothing it
  does is actually posture-sensitive in the way a fresh source write would
  be. **This directly reads on this amendment's own section 1.9 stance**
  ("a posture flip ... is remediation, never a rebase") — option (b) is a
  considered reversal of that stance for the finalization step
  specifically, which is why it is an owner decision and not an
  author-level simplification.

Either option needs its own gate: (a) a "promotion blocked while a
scheduled run is running" mutation leg; (b) a "run created under `shadow`,
org promotes to `authoritative` mid-run, run still finalizes once under its
frozen posture" mutation leg. Section 2 gate 21 is written to accept
whichever is selected; neither leg exists in this draft until `O-4` picks.

### 1.8 Finalization transaction

Exactly one transaction, containing **no** source DML, **no** calculation
write, and **no** class-`11` target lock:

1. begin `SERIALIZABLE`; acquire class-`00` org rollout **shared**; resolve
   posture.
   - If the resolved posture is `blocked` (an org `suspended`; see
     `w4c0-identity.ts:417-418,536`), finalization takes no further action:
     return the closed, values-free, **retryable** outcome
     `ATTENDANCE_SCHEDULED_RUN_FINALIZATION_DEFERRED` with **zero DML**;
     the run stays `running`; a later attempt (a per-user completion
     retry, or the recovery sweep, section 1.7) tries again. This is
     compliance with red line `W4C-R43` (governing lock line 215): a
     suspended org's in-flight run is **paused**, not remediated, exactly
     as an in-flight operation already is elsewhere in this lock;
   - if the resolved posture is `shadow` or `authoritative` and **equals**
     the run's frozen `accepted_write_posture`, continue to step 2;
   - if the resolved posture is `shadow` or `authoritative` and **differs**
     from the run's frozen `accepted_write_posture` (the run was created
     under one and the org has since promoted/demoted to the other), the
     behavior of this branch is **pending `O-4`/`OD-W4C-52`** — see
     section 0.5 and section 1.7.1. Option (a) makes this branch
     unreachable in ordinary operation (promotion is blocked while the run
     is `running`), and it remains fail-closed remediation as a backstop;
     option (b) makes this branch the primary path and requires
     finalization to proceed under the run's own frozen posture instead of
     failing here. This draft does not pick between them;
2. acquire the class-`01` run key lock;
3. `SELECT ... FOR UPDATE` the run row. If it is already `completed`, return
   its recorded outcome with **zero DML** (this is the losing racer's path,
   and it is a normal, expected outcome, not an error);
4. re-read all target rows and, for each `target_kind='generate'` target,
   its terminal evidence — under `O-3=(b)`, its corresponding operation row
   at exact key; under `O-3=(a)` (section 1.1.1), its row (if any) in
   `attendance_scheduled_run_target_outcomes`. Require every
   `target_kind='generate'` target to be terminal — under `O-3=(b)`, its
   operation row exists and is `completed`; under `O-3=(a)`, it has a
   recorded outcome row (`completed` or `failed`). If any target is
   missing its terminal evidence, or (under `O-3=(b)`) has an operation row
   present but not `completed`, finalization is not admitted and the
   transaction ends with zero DML;
5. fold the counts from that immutable evidence: `completed_user_count` =
   number of `generate`-targets whose terminal evidence is `completed`
   (under `O-3=(b)`, the step-4 predicate makes this equal
   `expected_user_count`; under `O-3=(a)`, it may be strictly less, since a
   `failed` target is terminal but not counted here —
   `chk_asr_terminal_shape`'s row-local form under `O-3=(a)`, section 1.1,
   is written to allow this); `generated_count` = number of those whose
   sealed `response_snapshot` records `inserted = true` (unchanged under
   either option — a `failed` target was never sealed `completed` and so
   is never counted here either);
6. rebuild both payloads (section 1.5), including the `reasons` array in
   ascending target `ordinal`;
7. insert the run-level outbox rows: always
   `attendance.absence.generated`; and `attendance.work_date.review_required`
   **only when `review_count > 0`** — the non-empty condition owner point 7
   requires, matching today's `if (reviewRequired.length > 0)`;
8. update the run row to `state='completed'` with the folded counts and
   `finalized_at`;
9. commit.

Steps 7 and 8 are in the **same** transaction, so a run is never marked
completed without its events and never emits events without being completed.

Concurrency: the class-`01` lock plus `FOR UPDATE` plus the
`state='running'` predicate serializes competing finalizers; the two partial
unique indexes on the outbox are the corruption backstop, not the control
path, and raw `23505` never escapes. A finalizer that loses the race takes
step 3's zero-DML path.

Delivery: the existing W4C-2 dispatcher claims run-level rows with
`FOR UPDATE SKIP LOCKED` and emits `emit(event_kind, payload)` with the exact
stored bytes, so external consumers observe the same event names, the same
payload keys, and one event per run.

### 1.9 Posture matrix

| Effective posture | Run row | Target rows | Per-user operations | Outbox | Emit |
| --- | --- | --- | --- | --- | --- |
| `legacy_projection_only` | none | none | none (null-ID legacy) | **none** | unchanged synchronous best-effort, unchanged bytes |
| `suspended` | none created; an existing `running` run is not advanced **and cannot be abandoned** (section 1.1.2 step 1's blocked branch) | unchanged | none | none | none |
| `shadow` / `eligible`(→`shadow`) | created | created | per user | run-level rows at finalization | only via dispatcher |
| `authoritative` | created | created | per user | run-level rows at finalization | only via dispatcher |

- The legacy leg and the durable leg must fail **independently** under
  mutation; neither may be the exclusive failure reason for the other.
- A posture flip between run creation and a later per-user transaction is
  remediation, never a rebase — per-user operation transactions are
  unaffected by `O-4` and keep this rule unconditionally. Whether a posture
  flip is remediation or a rebase specifically **at finalization** is
  pending `O-4`/`OD-W4C-52` (section 1.7.1); this row's finalization column
  above reflects section 1.8 step 1 as drafted, which states both options.
- An `eligible` state normalizes to accepted write posture `shadow` before it
  reaches the run row, exactly as in W4C-0 amendment section 1.2.
- A run with `expected_user_count = 0` (no `generate` targets — every
  resolved user went to review, which is the ordinary output of an
  assigned/group scheduling ambiguity and not an edge case; see
  `plugins/plugin-attendance/index.cjs:21208-21238`'s three
  `reviewRequired.push` branches, and `review_count > 0` && `total: 0` is
  its common shape) has its run-creation transaction (section 1.7) **be**
  the finalization transaction: after inserting the run and target rows,
  step 5 continues inline into section 1.8's steps 5-9 in the same
  transaction — there is no separate finalization transaction and no
  waiting, because `completed_user_count = expected_user_count = 0` is
  already known to hold. The run witness this inline finalization enqueues
  outbox rows against is obtained from
  `mintAttendanceScheduledRunIdentityFromInsertedRowV1` (section 1.4.1)
  over the run row's own `INSERT ... RETURNING`, not from
  `rehydrateVerifiedAttendanceScheduledRunIdentityV1` — there is no
  separately-committed row yet to re-read at this point, only the row this
  same transaction just inserted, still under the class-`01` lock. This is
  **not** a third transaction shape; it is
  section 1.8's finalization transaction, entered from the create path
  instead of a later resume path, and section 2 gates 8/15 apply to it
  exactly as written. `attendance.work_date.review_required` still emits
  only when `review_count > 0`, with the full `reasons` array and
  `total = review_count`; `attendance.absence.generated` still emits
  unconditionally with `total: 0`, matching today's
  `total: rows.length` (`rows.length === 0`) behavior byte-for-byte. The
  pre-existing `skipped` early
  returns (`holiday-rest-no-policy`, `dedup`) still create nothing and emit
  nothing.

### 1.10 Migration and rollback

One new `zzzz`-prefixed migration (both new tables and the outbox alteration
must sort after the W4C-0 `zzzz20260725120000_...` migration they depend on).

`up()`:

1. create `attendance_scheduled_runs` and
   `attendance_scheduled_run_targets` with every constraint above, plus the
   `DELETE`/`TRUNCATE` refusal triggers, the run `UPDATE` guard implemented
   per section 1.1's generic-allowlist form, and the deferred commit-time
   constraint tying frozen counts to target rows;
2. add `identity_kind` and `scheduled_run_id` to the outbox, drop
   `NOT NULL` on `operation_id`;
3. **backfill**, crossing the existing (pre-amendment) guard trigger
   correctly: `ALTER TABLE attendance_result_event_outbox DISABLE TRIGGER
   trg_areo_update_guard;` then `UPDATE ... SET identity_kind = 'operation'`
   for every existing row, then `ALTER TABLE
   attendance_result_event_outbox ENABLE TRIGGER trg_areo_update_guard;`.
   **This disable/enable pair is required, not optional**: the pre-existing
   guard's first clause (`IF OLD.delivery_state = 'delivered' THEN RAISE
   EXCEPTION`, migration `zzzz20260725120000_...:1498-1500`) rejects **any**
   `UPDATE` on an already-`delivered` row regardless of which column
   changes, so a plain backfill `UPDATE` aborts the migration the first
   time it reaches a `delivered` pre-existing row. Every pre-existing row
   has a non-null `operation_id` by the old `NOT NULL` constraint, so once
   the trigger is out of the way the backfill itself is total. `DISABLE
   TRIGGER`/`ENABLE TRIGGER` are catalog changes, not session state, but
   this migration's `up()` runs inside one transaction (this repo's
   existing migration runner convention), so a failure between the two
   statements rolls the catalog change back with everything else —
   the guard is never left off outside a failed, rolled-back attempt;
4. `ALTER COLUMN identity_kind SET NOT NULL` (must come after step 3's
   backfill — the backfill runs while `identity_kind` is still nullable, so
   this must not be pulled earlier), **then** add the CHECK constraints,
   both FKs, and the two partial unique indexes; drop `uq_areo_identity`
   only after the operation partial unique index exists. Section 1.4's SQL
   block already shows this `SET NOT NULL` inline in its `-- after backfill
   (section 1.10):` fragment (the second `ALTER TABLE` statement there); it
   is called out as its own numbered sub-step here because an implementation
   that copies the CHECK/FK/index additions from that fragment while missing
   the leading `SET NOT NULL` line would leave `identity_kind` nullable and
   defeat gate 1's block 6 (section 1.1) without any other step-4 leg
   catching it — a `NULL` discriminant is not a CHECK constraint and has no
   home among "the CHECK constraints, both FKs, and the two partial unique
   indexes" unless named explicitly;
5. `CREATE OR REPLACE FUNCTION attendance_w4_outbox_update_guard()` per
   section 1.4's rewrite — **only after** step 3's backfill, not before:
   the new generic-allowlist body treats `identity_kind` as frozen (it is
   not in the mutable set), so installing it before the backfill would
   block the backfill exactly as the old body does, just via a different
   clause. Once installed, `identity_kind`/`scheduled_run_id` are frozen
   before step 6 ever admits a row referencing them;
6. `ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT
   chk_areo_event_kind`, then re-add it with all **eight** members, defined
   as a literal **local to this new migration file**. The already-applied
   W4C-0 migration's `OUTBOX_EVENT_KINDS` module constant
   (`zzzz20260725120000_...:210-217`) is a historical artifact of an
   already-applied migration and **must not be edited** — doing so has zero
   effect on any database that has already run that migration, because the
   constant is read only once, at that migration's own `up()`, to build
   the CHECK this step now replaces. Only the runtime TS copy
   (`w4c0-operation-contract.ts:92`) is edited, in the same commit, so
   section 1.5's parity gate has two **current** lists to compare — the TS
   copy and **this new migration's** local eight-member literal — not the
   applied migration's six-member literal, which is permanently excluded
   from parity once this migration lands (see gate 9, section 2).

**Steps 7-9, conditional on `O-3`/`OD-W4C-50` (section 1.1.1) — written now
because implementation does not start until every decision including `O-3`
is ratified (section 4 step 2), so by the time this migration is actually
authored the fork below is already resolved to one side, not a
deploy-time branch:**

- **If `O-3` ratifies `(a)`:** `up()` gains three further steps —
  7. `CREATE TABLE attendance_scheduled_run_target_outcomes` with every
     constraint section 1.1.1 states (including the `DELETE`/`TRUNCATE`
     refusal triggers);
  8. `ALTER TABLE attendance_scheduled_run_targets ADD CONSTRAINT
     uq_asrt_id_org_run UNIQUE (id, org_id, run_id)` (section 1.2's
     conditional addition);
  9. narrow `chk_asr_terminal_shape`'s `completed` branch (section 1.1)
     from the equality shown in that section's SQL block to
     `completed_user_count IS NOT NULL AND completed_user_count <=
     expected_user_count`, and add the deferred
     `attendance_w4_run_completion_outcome_guard()` constraint trigger
     section 1.1.1 specifies.
- **If `O-3` ratifies `(b)`:** `up()` is exactly steps 1-6 above;
  `attendance_scheduled_run_target_outcomes` is never created, and
  `chk_asr_terminal_shape` keeps the equality shown in section 1.1's SQL
  block.

**Why the previous phrasing of step 5 was wrong, stated for the record.**
An earlier draft of this step said "extend `OUTBOX_EVENT_KINDS` (migration
copy) in lockstep with the TS copy," which reads as editing the applied
migration's module constant. That constant is consumed exactly once, at
`zzzz20260725120000_...:594`, to build the CHECK on a database that has
already applied it; editing the source file after the fact changes nothing
already-applied, so every upgraded database would be left with the original
six-member `chk_areo_event_kind` forever, and the finalization insert of
`attendance.absence.generated` (a run-level kind) would be rejected by the
DB on every upgraded database, with no gate in this draft's original gate 9
or gate 14 catching it (both exercised only a fresh database). Step 6 above
replaces that instruction with an explicit `DROP`/re-`ADD` against the live
constraint, which does change every upgraded database's schema, and gate 14
(section 2) now requires a positive control against exactly this scenario.

**Fail-closed semantics.** `fk_areo_operation` is added **validated**, never
`NOT VALID`: if any pre-existing outbox row references an operation row that
does not exist, the migration **aborts** and the deployment fails. The
migration never deletes, nulls, or quarantines a row to make itself pass. The
same rule applies to the extended kind CHECK (step 6).

**Compatibility with existing W4C-0 outbox rows.** W4C-0 landed the schema and
the transaction-bound enqueue interface with **no caller cutover**, so no
production code path enqueues today; in practice the table is empty. The
migration must not rely on that: it treats any existing row as real history,
classifies it as `identity_kind='operation'`, and preserves its identity,
payload, delivery state, attempts, and timestamps byte-for-byte.

**Upgrade path for runs that predate the migration.** None can exist under
W4C-2's hold, but the contract is explicit: a scheduled run with no run row
has no run-level identity, produces no run-level outbox row, and cannot be
resumed; its history is whatever the legacy best-effort emit produced. A
scheduled per-user operation naming a `source_root_id` with no run row is
rejected before source DML (section 1.7) rather than adopted.

`down()`:

- refuses **before the first DDL statement** while any row exists in
  `attendance_scheduled_runs`, `attendance_scheduled_run_targets`,
  `attendance_result_event_outbox`, or — **only if `O-3` ratified `(a)`** —
  `attendance_scheduled_run_target_outcomes`, with a `W4C2_DOWN_BLOCKED:`
  message naming the table and count — the same shape as W4C-0's `down()`
  guard (`zzzz20260725120000_...:1722-1755`). It never clears history to
  pass;
- only on a proven-empty database does it drop the two new tables (three,
  under `O-3=(a)`), drop the two partial unique indexes and the new
  constraints/columns, restore `operation_id NOT NULL` and the original
  single `uq_areo_identity`, `DROP`/re-`ADD` `chk_areo_event_kind` back to
  its original six-member form, and `CREATE OR REPLACE`
  `attendance_w4_outbox_update_guard()` back to its original nine-column
  freeze-list body — leaving the W4C-0 shape byte-equivalent. Under
  `O-3=(a)`, it additionally drops `attendance_scheduled_run_target_outcomes`,
  the `attendance_w4_run_completion_outcome_guard()` constraint trigger, and
  `uq_asrt_id_org_run`, and restores `chk_asr_terminal_shape`'s `completed`
  branch to the equality form;
- a fresh/upgrade/replay-safe/down-empty/down-populated gate matrix applies,
  as in section 12.1.

## 2. Required gates

W4C-2's P1-2 cannot pass until each of these is independently
**mutation-proven** on real PostgreSQL. Neutering any one guard must make its
own leg — and only its own leg — fail; a neighbouring guard's failure is not
accepted as the exclusive reason.

1. **Run ID cannot masquerade as an operation ID.** Inserting an outbox row
   whose `operation_id` is a `run_id` fails; whose `scheduled_run_id` is a
   per-user operation ID fails; a run-level kind with `identity_kind
   ='operation'` fails; a per-user kind with `identity_kind='scheduled_run'`
   fails; both non-null and both null fail. Dropping `fk_areo_operation`,
   `chk_areo_kind_identity_map`, or `chk_areo_identity_exclusive` each fails a
   different leg. At the TS boundary, passing a run witness to
   `enqueueAttendanceResultEventOutboxV1` (and an operation witness to the run
   enqueue, and a bare UUID string to either) is rejected before any SQL.
   **Added legs:** `UPDATE`ing a `pending` row's `scheduled_run_id` to a
   different run of the same org fails (widening the trigger's mutable
   allowlist to include `scheduled_run_id` — the only mutation shape the
   generic-allowlist form of section 1.4 admits — makes only this leg pass;
   the un-widened trigger must reject it); the symmetric `identity_kind`
   `UPDATE` fails; an `entrypoint` other than `'scheduled'` on a
   `scheduled_run` row fails `chk_areo_run_entrypoint` (dropping that CHECK
   fails only this leg); enqueuing a run-level or per-user event before its
   operation/run row exists fails `fk_areo_operation`/`fk_areo_scheduled_run`
   (this exercises the write-order dependency noted in section 1.4); an
   insert with **`identity_kind IS NULL`** (any `event_kind`, any
   `operation_id`/`scheduled_run_id` combination satisfying
   `chk_areo_identity_exclusive`) fails — this is section 1.1's block 6.
   Reverting section 1.10 step 4's `SET NOT NULL` (leaving `identity_kind`
   nullable while every other step-4 addition stays in place) must make
   **only this leg** fail; the `identity_kind='operation'`/`'scheduled_run'`
   legs above must remain green under that same mutation, since
   `chk_areo_kind_identity_map` and `chk_areo_run_entrypoint` still reject a
   non-`NULL`, wrongly-valued `identity_kind` on their own.
2. **`attendance.absence.generated` durable leg.** A crash after the
   finalization commit but before emit leaves the row `pending`; dispatcher
   restart delivers it exactly once; the run row is `completed` and no source
   or per-user DML repeats. Deleting the enqueue call makes only this leg
   fail.
3. **`attendance.work_date.review_required` durable leg.** Same, plus: with
   `review_count = 0` **no** row is inserted, and with `review_count > 0`
   exactly one row is inserted whose `reasons` array equals the pre-restart
   array byte-for-byte in ordinal order. Making the enqueue unconditional and
   making it never fire each fail their own leg.
4. **Payload/wire freeze.** For a fixture run, the delivered event names and
   payload bytes are identical to the pre-amendment synchronous emit for the
   same inputs, and exactly one event of each applicable kind is delivered per
   run. Adding a key, dropping `reasons`, renaming `total`, or emitting per
   user fails. **This gate's `reasons`-ordering scope is pending
   `O-2`/`OD-W4C-51`** (sections 1.2, 1.3): under option (a) this gate's
   "identical bytes" claim narrows to key-set/value-set equivalence plus
   the newly pinned canonical order; under option (b) it holds as written
   against whatever order the fixture's membership query happened to
   produce, which remains reproducible only within one run's lifetime, not
   across two separately-seeded fixture runs.
5. **Legacy posture zero-outbox leg.** Under `legacy_projection_only` the run
   produces no run row, no target row, no operation row, no outbox row, and
   the unchanged synchronous best-effort emit with unchanged response bytes.
   Removing either side of the posture split fails independently.
6. **Restart completes only unfinished users.** A run interrupted after k of n
   users is resumed; the n−k remaining users execute, the k completed users
   replay with zero DML (row-count and content-hash snapshots before/after are
   byte-congruent), and the finalized `generated_count`/`total` equals the
   uninterrupted run's. Deriving the remaining set from an in-memory cursor,
   or folding `total` from in-process results instead of durable evidence,
   fails this leg (this is section 0.3's defect).
7. **Concurrent finalization is serialized.** Two connections attempt
   finalization of the same run simultaneously; exactly one inserts the outbox
   rows and flips the state, the other returns the recorded outcome with zero
   DML, no `23505` or `55P03` escapes, and exactly one row per kind exists.
   Removing the class-`01` acquisition, the `FOR UPDATE`, or the
   `state='running'` predicate each fails a two-connection leg; a leg that
   holds the first transaction beyond the helper budget returns values-free
   `503 ATTENDANCE_SCHEDULED_RUN_BUSY` with zero extra DML and replays later.
8. **Finalization atomicity.** An injected failure after the outbox insert and
   before the state flip (and the reverse order) leaves **both** unwritten;
   a test-only witness proves one `txid_current()`/backend PID for the whole
   finalization. Splitting them into two transactions fails.
9. **Closed-set parity.** The comparison is between `w4c0-operation-contract.ts:92`'s
   list and **this new migration's** local eight-member literal (section
   1.10 step 6) — **not** the already-applied W4C-0 migration's
   six-member `OUTBOX_EVENT_KINDS` constant, which is permanently excluded
   from parity once this migration lands. The two current lists are proven
   equal in membership and order by an executed gate (not a source regex);
   changing either copy alone fails. An unlisted kind is rejected at the DB
   boundary. The same parity and negative-value gates cover the closed
   review-reason list of section 1.2.1, scoped to its 14 reachable members
   (11 `unresolved`-segment `REASON` codes plus 3 literals — not the full
   20-member `REASON` map).
10. **Target-set resume guard.** A resume whose recomputed target set differs
    by one user or one reason code is fail-closed remediation with zero DML;
    a byte-identical recomputation resumes. Removing the fingerprint
    comparison fails only this leg. **The "or one ordinal" leg is pending
    `O-2`/`OD-W4C-51`**: under option (a) an ordinal-only difference is
    also fail-closed remediation (kept, since ordinal becomes a
    deterministic function of membership and a spurious difference implies
    corruption); under option (b) it is explicitly **withdrawn** — an
    ordinal-only difference across a resume is expected and must **not**
    trip this guard, per the order-insensitive fingerprint of section 1.3
    option (b).
11. **Run row invariants.** Two `running` runs for one
    `(org, initiator, work_date)` are impossible; `generation` is strictly
    increasing; `accepted_write_posture`, `target_set_fingerprint`,
    `expected_user_count`, and `review_count` are immutable after insert;
    illegal state transitions (`completed->running`, `completed->abandoned`,
    `running->running` with changed frozen columns) are refused; target rows
    refuse `UPDATE`/`DELETE`/`TRUNCATE`; a run whose frozen counts disagree
    with its target rows cannot commit.
12. **Derived-identity binding.** A target row whose `operation_id` is not the
    canonical UUIDv5 of `(run_id, user_id, work_date)` under
    `ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1` is refused by the DB, and a
    per-user operation naming a non-existent or non-`running` run is rejected
    before source DML.
13. **Cross-org isolation.** A run row, target row, or outbox row referencing
    another org's run/operation is refused; a second org's concurrent run for
    the same `work_date` is unaffected.
14. **Migration gates.** Fresh, upgrade (with pre-existing outbox rows —
    the fixture **must** include at least one `delivery_state='delivered'`
    row and one `'pending'` row, not only `pending`, since the delivered
    row is what exercises step 3's disable/enable requirement), replay,
    `down()`-empty success, and `down()`-populated refusal all pass; an
    outbox row referencing a missing operation row makes `up()` abort
    rather than mutate data; `down()` restores the exact W4C-0 outbox
    shape. The pre-existing `delivered` row's identity, payload,
    `delivery_state`, `attempts`, and timestamps must be byte-identical
    after `up()`; removing the disable/enable pair around step 3's backfill
    must make only this leg fail (the migration aborts partway instead of
    completing).
    **Upgrade positive control (required, not optional):** on a database
    that has run only the W4C-0 migration (no earlier attempt at this one),
    apply this migration, then `INSERT` a row with
    `identity_kind='scheduled_run'`, `event_kind='attendance.absence.generated'`,
    a valid `scheduled_run_id` — this **must succeed**. Reverting section
    1.10 step 6 to a no-op (leaving `chk_areo_event_kind` at its
    six-member W4C-0 form) must make **only** this leg fail; gate 9 and the
    fresh-database leg of this gate must both stay green under that same
    mutation, since neither exercises an upgraded database — this is the
    exact false-green shape this control exists to close.
15. **Lock-order gate.** Acquiring class-`01` before class-`00`, or acquiring
    class-`11` inside the finalization transaction, or performing any source
    DML in the finalization transaction, each fails its own leg.
16. **Builder-disjointness gate covers every exported builder, not a
    hand-written list.** Rewriting `w4c0-identity.test.ts:740` (section 1.6)
    to iterate the module's exported builder surface: the fourth
    (run-key) builder's key falls in `[2^62, 2^63)`; every other exported
    builder's key falls outside it; an exported builder with no class
    assignment fails the gate rather than passing silently. Reverting the
    iteration to a hand-written three-builder list makes only this leg fail
    once a fifth builder is later added — the gate's own regression proof
    is: add a synthetic fifth builder with a deliberately wrong class in a
    test-only fixture and confirm the gate catches it.
17. **Suspended pause and mid-run finalize-exactly-once.** With the org
    resolved to `blocked`/`suspended`, an attempt to finalize a `running`
    run with all targets terminal returns
    `ATTENDANCE_SCHEDULED_RUN_FINALIZATION_DEFERRED` with zero DML and the
    run stays `running` (section 1.8 step 1); once the org returns to
    `shadow`/`authoritative` matching the run's frozen posture, the next
    attempt (or the recovery sweep, gate 18) finalizes it exactly once.
    Folding the suspended branch into the posture-mismatch remediation
    branch (i.e. reverting section 1.8 step 1's three-way split to two-way)
    fails only this leg.
18. **Recovery sweep — positive and negative control.** *Positive:* the
    last per-user operation commits, the process is killed before the
    finalization attempt runs, and — with no further caller invocation —
    the sweep (section 1.7) finalizes the run exactly once within its
    bounded scan window, including for a run whose `work_date` is a prior
    calendar day relative to the sweep's current tick (the cross-`workDate`
    leg). *Negative:* disabling the sweep leaves the run permanently
    `running` with all targets terminal — and this must be the **only**
    leg that fails; gates 2, 3, 6, and 7 (which do not depend on the sweep)
    must stay green under that same mutation. A same-process run whose
    `lastAutoAbsenceKey` is already set does not prevent the sweep from
    reaching its resume/finalize decision (the dedup-early-return
    positioning requirement in section 1.7).
19. **Zero-`generate`-target run.** A run with `expected_user_count = 0` and
    `review_count > 0` creates and finalizes in section 1.7's single
    create transaction; `txid_current()` is the same value throughout
    (gate 8 applies verbatim); no class-`11` lock is acquired (gate 15
    applies verbatim); `attendance.absence.generated` emits with `total: 0`
    and `attendance.work_date.review_required` emits with the full
    `reasons` array. Splitting this into two transactions, or omitting
    either emission, fails this leg without touching gates 8/15's other
    legs.

**Pending, activate on ratification of the named decision — not required
today, but the amendment must not implement `O-3`/`O-4` without them:**

20. *(activates on `O-3`/`OD-W4C-50` = (a))* A run with one
    deterministically-failed `generate` target and the rest `completed`
    reaches `state='completed'`, folds `completed_user_count` excluding
    the failed target, and emits both run-level events with counts
    matching option (a)'s definition (section 1.1.1); a target left with
    neither `completed` nor `failed` still blocks finalization (the
    deferred `attendance_w4_run_completion_outcome_guard()` trigger
    raises). **Added legs (the outcome side table itself):** a second
    `INSERT` for a target that already has an outcome row fails
    `uq_asrto_target`; `UPDATE`/`DELETE`/`TRUNCATE` on
    `attendance_scheduled_run_target_outcomes` all fail; an outcome row
    whose `terminal_outcome` disagrees with its target's operation row's
    `state` (`'completed'` paired with an operation row that is not
    `completed`, or `'failed'` paired with one that is not `canceled`)
    fails the deferred trigger at commit; recording an outcome row for a
    target via any path other than `recordAttendanceScheduledRunTargetOutcomeV1`
    (i.e., bypassing the per-user operation witness gate) is rejected
    before any SQL; `attendance_scheduled_run_targets` itself remains
    immutable even after its outcome is recorded — attempting an `UPDATE`
    on the target row post-outcome fails exactly as it did pre-outcome,
    proving the side table did not reopen target-row mutability.
21. *(activates on `O-4`/`OD-W4C-52` = (a))* Promotion from `shadow` to
    `authoritative` is refused, values-free and with zero DML, while any
    `attendance_scheduled_runs` row for that org is `state='running'`.
    *(activates on `O-4`/`OD-W4C-52` = (b) instead)* A run created under
    `shadow`, with the org promoted to `authoritative` before the run's
    last target completes, still finalizes exactly once under its frozen
    `shadow` posture, folding counts and emitting events as section 1.7.1
    option (b) specifies.
22. **Zero-`generate`-target minting factory is unreachable outside the
    run-creation transaction, and equivalent in guarantee to rehydration.**
    `mintAttendanceScheduledRunIdentityFromInsertedRowV1` (section 1.4.1)
    is absent from its defining module's compiled public surface — proven
    by importing that module's exports at test time and asserting the
    symbol is `undefined`, not by a source-text grep. A caller-fabricated
    plain object (JSON clone, spread, prototype lookalike) with the same
    field shape is rejected by both run-identity constructors identically.
    *Positive control:* a zero-`generate`-target run's inline-finalization
    outbox rows (minted from the `INSERT ... RETURNING` row) satisfy every
    `CHECK`/FK the section 1.4 discriminated union enforces — indistinguishable,
    at the DB layer, from rows enqueued via
    `rehydrateVerifiedAttendanceScheduledRunIdentityV1` on the mainline
    path. *Negative control:* forcing the run-creation transaction to roll
    back after the minting factory has been called in-process but before
    `COMMIT` leaves zero outbox rows — the mint does not itself durably
    commit anything ahead of its enclosing transaction.
23. **`abandoned` transition: authorization, org anchor, lock order,
    concurrency, idempotency (section 1.1.2).** An actor posture outside
    `{platform_admin, attendance_admin}`, or one missing the `retirement`
    capability, is rejected before any lock is acquired — zero DML, zero
    lock-wait (a positive control instruments lock-wait counters and shows
    zero for the rejected call). A caller authenticated for org A
    attempting to abandon org B's run is rejected (extends gate 13). Two
    connections attempt to abandon the same `running` run simultaneously:
    exactly one transitions it to `abandoned` and computes
    `completed_user_count`; the other returns the recorded outcome with
    zero DML — same shape as gate 7, no new lock-order leg. A third call
    against an already-`abandoned` run, and a call against an
    already-`completed` run, both return the recorded outcome with zero
    DML (idempotency; a `completed` run is never overwritten to
    `abandoned`). `abandoned_by_actor_posture` cannot be changed by any
    subsequent legal `UPDATE` — a mutation that relaxes the
    out-of-`abandoned`-transition check while leaving the column in the
    mutable set must make only this leg fail. The transition writes no
    outbox row and no source DML and acquires no class-`11` lock (extends
    gate 15 to this transaction shape explicitly, rather than assuming
    gate 15's existing legs already cover a transaction they were not
    written against). **Blocked-org deferral (`W4C-R43`):** an abandon
    call against a `running` run whose org resolves to `blocked` returns
    `ATTENDANCE_SCHEDULED_RUN_ABANDON_DEFERRED` with zero DML and the run
    stays `running`; once the org is no longer `blocked`, a retried call
    succeeds. Removing section 1.1.2 step 1's blocked branch (folding it
    into the normal path) must make only this leg fail — gates 17's
    equivalent finalization-side leg must stay green under that same
    mutation, since it is a different transaction.

Section 12.3's existing scheduled gates remain in force and are amended only
to read: run-level outbox rows are inserted in the finalization transaction
that marks the run `completed`, while per-user outbox rows remain inserted
before their operation seal.

### 2.1 CI gate home

Twenty-one required gates (plus two pending gates, 20-21, inert until
`O-3`/`O-4` rule — the required count above includes the new gates 22-23,
neither of which is pending on anything) that are only "mutation-proven on
real PostgreSQL" in prose, with no suite or workflow step named, is this
repo's own documented false-green shape (real-DB integration suites that
never run in any workflow, or that skip-green in the no-DB job). This
amendment requires:

| Gate family | Suite location | CI gate home |
| --- | --- | --- |
| Gates 1-3, 5, 7-9, 11-15, 17-23 (constraint/trigger/transaction legs needing a real, committed transaction) | new `packages/core-backend/tests/integration/attendance-w4c2-scheduled-run-*.db.test.ts` file(s) | `.github/workflows/plugin-tests.yml`, job `test`, step **"Run attendance integration tests"** (whole-file wiring, alongside the existing `attendance-w4c0-*.db.test.ts` files) — **and** the same file name(s) added to `packages/core-backend/vitest.config.ts`'s `exclude` array, so the no-DB default `pnpm --filter @metasheet/core-backend test` run cannot skip-green them. A new no-DB `node --test` contract, `scripts/ops/w4c2-run-identity-ci-wiring.test.mjs` (following the established pattern of e.g. `scripts/ops/t1-org-transfer-ci-wiring.test.mjs`), asserts both wiring points exist for every `.db.test.ts` file this slice adds, and is itself run as a step in the same job. Gate 22's module-export-absence leg (unlike its positive/negative controls) needs no real transaction and may live in either row — placed here because its controls (legs (c)/(d)) do. |
| Gate 4 (payload/wire freeze, pure-function legs), gate 6 (restart cursor derivation), gate 10 (resume fingerprint), gate 16 (builder disjointness) | `packages/core-backend/src/attendance/__tests__/w4c0-identity.test.ts` or a sibling `w4c2-scheduled-run-identity.test.ts` for the new builder/fingerprint math (no DB needed for pure key/fingerprint computation) | `.github/workflows/plugin-tests.yml`, job `test`, step **"Run core-backend tests"** (`pnpm --filter @metasheet/core-backend test`), which runs on both matrix legs (`18.x`, `20.x`) — but **only `test (20.x)` is a required branch-protection check** (`branches/main/protection/required_status_checks`, verified against `origin/main`, does not list `test (18.x)`). A Node-18-only regression in this step would go red without blocking merge; `test (20.x)` is the check that actually gates. The durable-row-dependent halves of gates 4 and 6 (does the *delivered* byte stream match; does the *replayed* row set match) belong in the real-DB row above instead. |
| Gate 9's parity leg specifically | a no-DB vitest/`node --test` comparing `w4c0-operation-contract.ts:92` against the new migration's local eight-member literal | same row as above (core-backend unit step). |

Any new `.db.test.ts` file this slice adds that is **not** wired at both
points above is, by this repo's own prior incident record, indistinguishable
from a gate that was never run. Section 4 step 4's independent adversarial
review must re-verify both wiring points for every gate claimed
mutation-proven, not just read the gate's own assertions.

## 3. Decisions

| Decision | Options | Recommendation |
| --- | --- | --- |
| `OD-W4C-44` scheduled run identity — **its option (a) below names states that are themselves the subject of `OD-W4C-48`; see section 3.3 for the exact coupling and why this is wording, not a hidden second decision** | (a) durable `attendance_scheduled_runs` row with server-minted `run_id`, frozen posture/counts/target-set fingerprint, immutable target rows, and run-level outbox written in the same finalization transaction as `completed`, with closed states per whichever `OD-W4C-48` selects (`running|completed|abandoned` under `OD-W4C-48=(a)`, this document's default and the form section 1.1's SQL block shows; `running|completed` under `OD-W4C-48=(b)`, which additionally requires the schema/gate edits section 5 already flags); (b) keep the derived in-process run ID and add only outbox columns; (c) no run object — reduce the two run-level events to per-user events | **(a)** |
| `OD-W4C-45` repeat invocation and roster drift — **its option (a) below names a serialization mechanism that is itself the subject of `OD-W4C-46`; see section 3.3** | (a) `generation` allocated under whichever serialization mechanism `OD-W4C-46` ultimately selects (class `01` under `OD-W4C-46=(a)`/`OD-W4C-49=(a)`; the fallback mechanism under `OD-W4C-46=(b)`/`(c)` if `OD-W4C-49=(b)`, not itself fully specified by this document — section 3.3); a fresh invocation after a terminal run starts generation `n+1` (today's re-emit behavior preserved), while the frozen `target_set_fingerprint` guards **resume** only and any drift on resume is fail-closed remediation; (b) one run per `(org, initiator, work_date)` forever — a repeat invocation is a zero-DML replay that emits nothing; (c) include the fingerprint in the run identity so a roster change mints a different run | **(a)** |
| `OD-W4C-46` advisory class for the run lock — **conditional on `O-1`/`OD-W4C-49` (section 3.1): option (a) is only available if `O-1` resolves to `(a)`; if `O-1` resolves to `(b)`, this item cannot resolve to (a) and must instead be decided between (b)/(c) (see `OD-W4C-49`'s option (b) cell for the forcing argument)** | (a) assign the reserved class `01` over `(org, initiator, work_date)`, ordered `00 → 01 → 10 → 11`, with its own values-free `503 ATTENDANCE_SCHEDULED_RUN_BUSY`; (b) reuse class `10` with a third `kind` discriminant `scheduled_run`; (c) rely on the partial unique index and row locks alone | **(a)**, contingent on `O-1=(a)` |
| `OD-W4C-47` run-level payload and delivery order | (a) freeze both payloads byte-identically, keep the closed `reasons` vector rebuilt in target `ordinal` order, and leave inter-event delivery order unconstrained (as today's two independent `emit` calls already are); (b) additionally add a stored `delivery_ordinal` and require `attendance.absence.generated` to be delivered before `attendance.work_date.review_required` for the same run; (c) reduce `reasons` to a count | **(a)** |
| `OD-W4C-48` non-terminal run escape hatch | (a) add the terminal `abandoned` state with a closed values-free reason code, written by an operator remediation path, emitting no event and writing no source DML; (b) `running|completed` only, and accept that an unsatisfiable run holds the partial unique index indefinitely | **(a)** |

`OD-W4C-44(b)` fails because a derived ID cannot carry counts, terminal state,
or a resume guard, and would leave section 0.3's `total` drift unfixed.
`OD-W4C-44(c)` is the already-rejected option `(a)` of the G-2 ruling.
`OD-W4C-45(b)` silently changes today's admin re-run behavior;
`OD-W4C-45(c)` makes an ordinary mid-run roster change fabricate a second run
for one day. `OD-W4C-46(b)` would extend an already RATIFIED key tuple and
weaken the "cross-class upgrade is impossible" property;
`OD-W4C-46(c)` makes `23505` a control path. `OD-W4C-47(b)` is defensible but
adds a column and a delivery constraint that today's behavior does not
actually guarantee; `OD-W4C-47(c)` is a wire break. `OD-W4C-48(b)` creates a
stuck non-terminal state.

### 3.1 Pending decisions (`O-1..O-5`) — not resolved by this draft

`OD-W4C-44..48` above are ordinary recommendations this draft makes and
argues for. The five decisions below are different in kind: each is a
**two-reading point** raised by an independent gate review — a place where
this draft's own text pulls in two directions, or where closing a
disclosed gap (section 0.5) requires reopening ground `OD-W4C-40..43`
already settled one way. This draft states the options and a recommendation
where one is defensible, but does **not** treat any of the five as decided,
and section 4 step 2 requires all five ratified before implementation
starts, not just accepted by omission. Four of the five (`O-1..O-4`) are
raised against this document's own text; the fifth (`O-5`, section 3.2) is
raised against a separate branch (PR #4612) and is bundled here only for
one-pass ratification — see the scope note at the top of this document.

| Decision | Options | Recommendation |
| --- | --- | --- |
| `OD-W4C-49` (`O-1`) — rewrite red line `W4C-R42` for class `01` | (a) rewrite `W4C-R42` (lock line 214) and the three dependent clauses (lock lines 2049-2050, 2126-2130, 2570) from "`01` is forbidden" to "`01` is acquired only by the scheduled-run helper; any other caller acquiring `01`, or that helper acquiring `00`/`10`/`11`, fails independently" — i.e. `01` becomes a fifth reserved-then-assigned class rather than staying forbidden; (b) do not rewrite the red line — class `01` stays forbidden, so `OD-W4C-46` cannot resolve to (a) (reserved class `01`) and must instead resolve to (b) (reuse class `10` with a third `kind` discriminant) or (c) (partial unique index + row locks alone, no advisory class), with section 1.6 and gate 16 rewritten to match whichever is chosen; `OD-W4C-44(c)` (no run object) remains a separate, already-rejected fallback if neither `OD-W4C-46(b)`/(c) is judged adequate | **(a)**, because both `OD-W4C-46(b)` and (c) were already argued against on their own merits (weakening the "cross-class upgrade is impossible" property, and making `23505` a control path, respectively) — reopening the red line's wording is a smaller change than accepting either of those costs |
| `OD-W4C-50` (`O-3`) — per-`generate`-target permanent failure outcome | (a) add a durable `terminal_outcome`/`failure_reason_code` pair on a new **append-only side table**, `attendance_scheduled_run_target_outcomes` — never a column on the immutable `attendance_scheduled_run_targets` row (section 1.1.1); `completed` no longer requires every target to succeed, only every target to reach a recorded outcome, checked by a deferred commit-time constraint trigger since a single-row `CHECK` cannot see another table; (b) keep the all-or-nothing shape and accept, as a declared residual, that one user's permanent deterministic failure withholds both run-level events for the entire org's `work_date` until an operator abandons the run (section 1.1.2) | **(a)**, because (b) makes an org-wide, permanently-lost outcome the consequence of a single user's unrelated failure, for a lock whose W4-covered posture matrix produces deterministic per-user failures routinely |
| `OD-W4C-51` (`O-2`) — canonical order for `ordinal` / resume-guard shape | (a) pin the membership resolution query to `ORDER BY user_id` (or another explicit total order); `ordinal` becomes a pure function of membership; narrow gate 4's "byte-identical to pre-amendment emit" claim to key/value-set equivalence plus the new canonical order; (b) leave resolution order undefined as today; change the resume guard (section 1.7 step 3) to an order-insensitive set fingerprint; withdraw gate 10's "or one ordinal" leg | **(a)**, because the ordered fingerprint this draft already specifies (section 1.3) cannot be satisfied on resume by an unpinned membership query, and pinning without owner sign-off is not available to the author alone — a one-time, disclosed change to `reasons` ordering is preferable to shipping a resume guard that spuriously fires on a benign restart |
| `OD-W4C-52` (`O-4`) — does a `running` run block shadow/eligible promotion | (a) extend the lock's promotion-block predicate (lock lines 2689-2690, 2250) to treat a `running` `attendance_scheduled_runs` row as blocking, same as an incomplete operation; accept the operational cost that a promotion window must avoid colliding with an in-flight scheduled run; (b) do not block promotion; instead redefine finalization (section 1.8 step 1) to execute under the run's own frozen posture rather than the currently resolved one — a considered, narrow reversal of this draft's own "posture flip is remediation, never a rebase" stance, scoped to finalization only | no recommendation — this is an operational rollout-timing tradeoff ((a)) versus a semantic reversal of a stance this same draft asserts elsewhere ((b)); both are internally consistent, and the choice is the owner's to make, not the author's |
| `OD-W4C-53` (`O-5`) — lock §8.2 step 7's "source-definition fingerprint equality": which domain does it hold on (section 3.2) | **Two unconditional tokens, one conditional token:** (i) ratify a narrow comparison domain, `{resolvedAt, reasonCode}` excluded, as a **second**, permanently-maintained fingerprint distinct from the storage column — unconditional; **(ii-wide)** re-resolve before the legacy write or reorder lock §8.2 steps 3/4 (safe by construction, but reopens RATIFIED step-numbering text with an unaudited citation surface) — unconditional; **(ii-narrow)** exclude the operation's own just-written row from the resolver's `openPreviousMatches` match — **conditional**: section 3.2 demonstrates by executed counterexample that the mechanism *as specified in this document* flips both `workDate` and `shiftId` (not only `reasonCode`) when this operation's write touches a pre-existing open record it did not create; a ruling of `(ii-narrow)` authorizes the *direction* (eliminate self-observation at the resolver, not by widening the fingerprint domain) but is **void as an implementation authorization unless and until** the four preconditions in section 3.2's "Gate shape this option needs" (corrected, `matching.length === 1`-gated mechanism spec; positive control; the negative control from the counterexample above; a check-out/disappearance analysis) are supplied and gated — implementation does not start on the mechanism as currently specified | (i) over (ii-wide) among the two unconditional tokens — see reasoning in section 3.2. No recommendation is made on `(ii-narrow)`'s *direction* (that remains the owner's to prefer, per section 3.2's closing paragraph) or on whether its voidness condition will ever be satisfied — only that today's specified mechanism does not clear it |

### 3.2 `O-5`/`OD-W4C-53` — a fifth pending decision, bundled from outside this document's own schema

**Provenance, stated plainly.** This decision is not raised against
anything in section 1's schema. It is raised against a commit on the
separate, still-Draft/OWNER-AUTHORIZATION-HOLD branch of PR #4612
(`claude/w4c2-live-scheduled-shadow-20260725`), commit
`64ea17d1931c142a080aeab9dabe2e8c1098c2cd` ("wire outer-vs-inner
source-definition fingerprint (lock §8.2 step 7)"), which is not present on
`origin/main` and is not part of this document's diff. It is placed here,
in this document's decision table, solely so the owner can rule on it in
the same pass as `O-1..O-4` rather than in a second round-trip.

**The clause in dispute.** Governing lock section 8.2 step 7 (lock line
1821-1822): "re-run attribution/context selection from the transaction
snapshot and require candidate identity plus **source-definition
fingerprint** equality." As of `origin/main`
`9fdf68fa5c34d2224fbe6bd0d71b14ca78263502` (as of this pass, this now
matches the SHA cited in this document's header, which was refreshed to the
same commit), exactly one thing in this repository is named
"source-definition fingerprint": the
storage column `attendance_record_calculations.source_definition_fingerprint`
(lock section 7.3) and its sole producer,
`computeAttendanceSourceDefinitionFingerprintV1`
(`packages/core-backend/src/attendance/w4c1-fingerprints.ts:34`, domain
separator `SOURCE_DEFINITION_DOMAIN =
"metasheet2:attendance:w4:source-definition-fingerprint:v1"`, which
projects out only `resolvedAt`).

**What PR #4612's commit did.** It wired step 7's equality check using a
**second**, newly-introduced function,
`computeAttendanceOuterComparableSourceDefinitionFingerprintV1`
(`w4c1-fingerprints.ts:~127-146`), over a **second** domain separator,
`OUTER_COMPARABLE_SOURCE_DEFINITION_DOMAIN =
"metasheet2:attendance:w4:outer-comparable-source-definition-fingerprint:v1"`
(`w4c1-fingerprints.ts:~39-40`), which projects out `resolvedAt` **and**
`reasonCode` — one field wider than the storage domain's exclusion set. The
storage column and its original producer are unchanged; the new function is
used only for the outer-vs-inner comparison
(`w4c2-live-scheduled-boundary.ts`, `identityDrift = identityMismatch ||
fingerprintMismatch`).

**Why, per that commit's own message.** Empirically, on a real-DB fixture
(`attendance-w4c2-p2-1-canonical-freeze-anchor.db.test.ts`, "Group E /
eDay2"), lock §8.2's own step-3-before-step-4 ordering lets this
operation's own step-3 legacy write become visible to step 4's
re-resolution **inside the same transaction**, with **zero concurrency**:
the W2 resolver's `openPreviousMatches` branch
(`selectAmongMatchingCandidates`) matches the row this same operation just
wrote, producing a different `reasonCode` (`OPEN_PREVIOUS_NIGHT_RECORD` vs
`PREVIOUS_NIGHT_CONTAINING_SHIFT`) than the route's pre-transaction outer
read could ever have seen — while `workDate` and `shiftId` (the identity
conjunct) are unchanged in the one fixture this was observed on. Compared
against the storage-domain fingerprint, PR #4612's own diagnosis (its body,
comment thread addendum 8, and the commit message cited above) treats this
as a false positive: the resolved candidate did not actually change, only
the code path/reasonCode that found it. **This document has not
independently re-verified that diagnosis against the resolver's source**
beyond the read in the next paragraph — it is reporting PR #4612's own
claim, not an independent finding of this document's own testing.

**The dispute, stated precisely.** The diagnosis of *why* a false positive
occurs is not contested by this document. What is contested: lock §8.2 step
7 names one specific, already-defined object ("the source-definition
fingerprint"). Constructing a second object with a different exclusion set
and comparing *that* instead is a change to **which object satisfies the
lock's own words**, not a change to how that object is computed or a
narrowing of an ambiguous term — the lock's step 7 is not ambiguous about
which fingerprint it means, because until this commit only one existed.
Under this document's own governing precedent (section 0.1 reason 1, on
`(c)-plus`): "the RATIFIED lock is not ambiguous" and a reading that
substitutes a different compared object for the one the lock names is a
**contract change**, not an implementation detail an author may settle
alone — the same standard this document applies to itself throughout
section 3.1 governs this clause too.

**Option (i) — ratify the narrow comparison domain.** The owner rules,
by a new `OD-W4C-53=(i)`, that lock §8.2 step 7's equality holds on the
domain that excludes `{resolvedAt, reasonCode}`, distinct from the storage
column's domain (`{resolvedAt}` only).
- *Consequences.* The storage column
  `attendance_record_calculations.source_definition_fingerprint` and its
  producer are unaffected — no migration, no backfill. A **second**,
  permanently-maintained domain separator and function must be kept in
  sync with the first by hand (an extra dual-copy risk of the same shape
  section 1.2.1 and section 5 of this document already flag elsewhere in
  this line, not a new category of risk). `reasonCode` drift between the
  outer read and the in-transaction re-resolution stops being detectable
  by step 7's equality gate — this is intentional (per the diagnosis
  above, `reasonCode` describes *why* a tie-break resolved a way, not
  *which* candidate won or *what policy* produced it), but it is a real,
  permanent narrowing of what step 7 catches, and must be stated as such
  rather than as a pure bugfix.
- *Gate shape this option needs.* A **positive control**: the exact
  zero-concurrency same-operation `reasonCode`-flip fixture from Group E /
  eDay2 passes step 7's equality gate under the narrow domain (proving the
  false positive is actually gone). A **negative control**, on the same
  fixture family: drift in any field the narrow domain does **not**
  exclude — grace, rounding, thresholds, segments, timezone, shift
  policy, or the identity conjunct (`workDate`/`shiftId`) itself — still
  fails step 7's equality gate (proving the narrowing is exactly the one
  field wide it claims to be, not wider). Both must be mutation-provable
  on real PostgreSQL, per this document's own section 2 standard.

**Option (ii) — eliminate the self-observation at its root, not a single
fix but two sub-variants of differing cost and, as this addendum now
establishes, differing readiness.** `OD-W4C-53`'s ballot has **three**
tokens this pass: `(i)` and `(ii-wide)` are unconditional. The third,
**`(ii-narrow)`**, is described in full below for the same reason a prior
draft was faulted for understating it (a prior advisor round caught this
document steering the owner toward `(i)` by omission in the `O-1` cell,
section 3.1's table, `OD-W4C-49` history — this section still owes the
owner the full shape of `(ii)`), and is a **conditional token**: castable
as a direction decision this pass, but void as an implementation
authorization until section 3.2's four preconditions (below) are supplied
and gated — the mechanism this document specifies for it is demonstrated
unsafe below by an executed counterexample, and a corrected mechanism has
not yet been specified or gated. If the owner rules `(ii-wide)` (or, in a
follow-up round, a corrected `(ii-narrow)`), the
storage-domain fingerprint (unchanged) is what step 7 compares, and the
false positive is closed by removing its cause rather than by narrowing
the comparison. There are two structurally different ways to do that:
  - **(ii-narrow) Exclude the operation's own just-written row from
    `openPreviousMatches`.** `selectAmongMatchingCandidates`
    (`plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs:~L371-428`)
    filters `openRecords` for `hasIn && !hasOut` rows matching the
    candidate's `workDate` (`~L384-395`), with no field in that filter
    distinguishing "an open record from a prior, unrelated operation" from
    "the row this same transaction's own step 3 just wrote." If step 4's
    caller can identify and exclude the latter (by row ID, or by not
    re-reading `openRecords` past whatever step 3 last touched), the
    self-observation the commit message describes disappears without
    touching lock §8.2's step order at all — the smallest possible fix.
    **Update (this addendum), superseding a RETRACTED claim.** A prior
    revision of this addendum asserted here: "this exclusion has now been
    verified semantically safe, in general, not only on the one fixture PR
    #4612 exercised" and, further down this cell, "(ii-narrow) is confirmed
    semantically safe" (both sentences, and every sentence downstream of
    them in this cell and in the "Consequences"/"Gate shape"/
    "Recommendation" subsections below, that restated or relied on that
    conclusion). **Both are retracted.** A subsequent adversarial pass
    constructed an executed counterexample (transcribed below, from this
    repository's own fixture) in which the exclusion mechanism as specified
    two paragraphs above — "by row ID," applied unconditionally — flips
    both the resolved `workDate` **and** `shiftId`, not merely `reasonCode`.
    The retracted argument's flaw, stated precisely so it is not repeated:
    it proved a claim about the case where this operation's write **creates**
    the previous-workDate open record, and then treated that as covering
    the mechanism as specified, which excludes-by-row-ID **any** row this
    operation wrote to — including a row that **already existed**, created by
    an earlier, different operation, that this operation's own write only
    *touches* (via `mode:'append'` upsert). Those are different sets; the
    proof below is corrected to say only what it actually covers.

    The code-reading work that follows (Fact 1, Fact 2) is unaffected by the
    retraction — it establishes true, load-bearing properties of the
    resolver and is kept. What is retracted is the step **after** those two
    facts: the claim that they compose into an unconditional safety proof
    for the exclusion mechanism as specified. Reading code to settle a fact
    this ballot depends on remains within the precedent cited above
    (section 0.1 reason 3 governs *implementation* choices, not fact-finding);
    that precedent question is not what failed here — the composition step
    that follows the facts is what failed, and is corrected below.
    The read covers `selectAmongMatchingCandidates`'s full body
    (`attendance-work-date-resolver.cjs:371-519`), its caller
    (`:982-1007`), the internal `calendarWorkDate` derivation
    (`:792-814`), and — on the still-unmerged PR #4612 branch, commit
    `64ea17d1931c142a080aeab9dabe2e8c1098c2cd`, since that is where the
    concrete call sites this proof depends on live — **all three** resolve
    call sites: `punchWorkDate`'s own call to
    `resolvePunchWorkDateByShiftWindow` (`index.cjs:26933`, unchanged from
    `origin/main:26321`, using the route's `timezone` local variable
    captured immediately before it is overwritten), the outer-fingerprint
    read this commit adds (`index.cjs:~26985-27021`, `timezone:
    requestTimezone`), and — located for this addendum, not merely
    inferred — the **freeze/inner re-resolution** the boundary itself
    performs at `w4c2-live-scheduled-boundary.ts:1109-1114`
    (`adapters.resolveLiveCandidate(pluginTrx, { orgId, userId, occurredAt:
    input.occurredAtResolved, timezone: input.requestTimezone })`,
    `calendarWorkDate` deliberately omitted per that call site's own
    comment at `:1098-1105`, "see `resolveLiveCandidate`'s own doc comment
    ... for why `input.timezone`/`input.workDate` (POST-resolution) must
    never be used here").
    - **Fact 1 — the candidate universe (`matching`) never depends on
      `openRecords`, and all three calls share the same `occurredAt` and
      `timezone`.** `resolve()` computes `workDates` and `candidates`
      (hence `matching`, via the `isInstantInWindow` filter at `:982-984`)
      purely from `occurredAt`, `timezone`, and the internally-derived
      `calendarWorkDate` (`:792-796`: `input.calendarWorkDate ||
      toWorkDate(occurredAt, timezone) || input.explicitWorkDate`).
      `openRecords` is loaded separately, afterward (`:986-997`), and never
      feeds back into `matching`. The `timezone` argument is where this
      could still break — `punchWorkDate.timezone` overwrites the route's
      `timezone` variable after resolution (`index.cjs:26958` on the #4612
      branch / `:26345` on `origin/main`) with the **winning shift's own**
      rule timezone, which can differ from the request's. This branch's own
      code closes that gap explicitly: `index.cjs:26931` captures `const
      requestTimezone = timezone` (the PRE-resolution value) **before**
      `punchWorkDate` is computed, and both the outer read and the
      boundary's `resolveLiveCandidate` call are wired to use only that
      captured `requestTimezone` (`index.cjs:27014`, threaded to the
      boundary at `:27256` as `requestTimezone`, consumed at
      `w4c2-live-scheduled-boundary.ts:1113` as `input.requestTimezone`) —
      never the post-resolution `timezone` field, which the boundary's own
      doc comments (`:40-52`, `:263-274`, `:380-398`) flag by name as
      unsafe for exactly this recomputation. A separate call site on this
      same branch makes the rule explicit in one sentence
      (`index.cjs:21275-21277`, the `deriveLegacyLivePunchAttributionV1`
      caller): "P1 fix: requestTimezone (the route's PRE-resolution
      input), NEVER timezone (the route's POST-resolution persistence
      value)". `occurredAt` is likewise the
      single route-level instant threaded through as `occurredAtResolved`.
      Given identical `(occurredAt, timezone)`, `matching` is identical
      across `punchWorkDate`'s call, the outer read, and the freeze/inner
      re-resolution, regardless of what has or has not been written to the
      DB in between.
    - **Fact 2 — an ambiguous `matching` set never reaches the write at
      all.** The route fails closed with `422
      WORK_DATE_ATTRIBUTION_AMBIGUOUS` and **returns before any write**
      whenever `punchWorkDate.resolution.kind === 'ambiguous'`
      (`index.cjs:26332-26343`, guarding the exact call at `:26321-26330`).
      `selectAmongMatchingCandidates` only reaches its ambiguous branches
      when a precedence step finds more than one candidate, or when no step
      resolves a unique winner and `matching.length !== 1` (the fallthrough
      at `:514-518`).
    - **Putting the two together — RETRACTED as a general claim; the
      narrower claim it actually proves is kept.** The paragraph this
      replaces argued: for step 3's (self-)write to ever **create** a
      previous-workDate open record — the only shape that can feed
      `openPreviousMatches` (`:397-403`, which requires `candidate.workDate`
      strictly before `calendarWorkDate`) — the write must have been driven
      by a *resolved*, non-ambiguous `punchWorkDate` result whose winner has
      `workDate < calendarWorkDate`; walking
      `selectAmongMatchingCandidates`'s precedence (`:371-519`) as
      `punchWorkDate`'s own call evaluates it (before step 3's write exists,
      so no self-observation is possible at that call), such a winner
      reaching steps 3/4 requires `matching.length === 1`
      (`:469-511`). **That narrower claim holds and is kept**: in the
      specific case where this operation's own write is the *sole* evidence
      that ever put a previous-workDate row into `openPreviousMatches` —
      i.e. the row did not exist, in an open state, on the resolved previous
      workDate before this operation ran — `matching.length` was `1` at
      write-decision time, is still `1` at the freeze/inner re-resolution
      (Fact 1), and `selectAmongMatchingCandidates`'s steps 1, 3, 4 then all
      resolve to the same `matching[0]`, differing only in `reasonCode`
      (`OPEN_PREVIOUS_NIGHT_RECORD` vs `PREVIOUS_NIGHT_CONTAINING_SHIFT`/
      `SINGLE_MATCHING_CANDIDATE`), never in `workDate`/`shiftId`.

      **What the retracted paragraph did not prove, and then claimed anyway:**
      it treated "sole evidence" (this write *creates* the row) as covering
      the exclusion mechanism as specified two paragraphs above, which
      excludes **by row ID**, unconditionally — any row this operation wrote
      to, whether that write created the row or merely updated one that
      **already existed**, in an open state, on the resolved previous
      workDate, written by an *earlier, different* operation. Step 1
      (`attendance-work-date-resolver.cjs:405-421`) gates only on
      `openPreviousMatches.length === 1`; it places **no constraint** on
      `matching.length`. So a pre-existing previous-workDate open record can
      make step 1 the outer-resolve winner while `matching.length > 1` —
      squarely outside the case the kept paragraph above analyses — and if
      this operation's own write then also touches that same row (a
      `mode:'append'` upsert onto it, per `plugin-attendance/index.cjs`
      `:26575-26590`, is exactly such a touch), the by-row-ID exclusion
      removes it from `openByWorkDate` at the freeze/inner re-resolution
      regardless.

      **Executed counterexample** (transcribed from the round-3 gate
      review's executed probe against this repository's own unit fixture,
      `packages/core-backend/tests/unit/attendance-work-date-resolver-w2.test.ts:222-276`,
      run against `origin/main` `9fdf68fa5c34d2224fbe6bd0d71b14ca78263502`;
      **this document has not independently re-run it** — the same
      disclosure standard this document applies to PR #4612's own diagnosis
      earlier in this section):
      overnight shift `22:00→06:00` on `2026-07-15` plus morning shift
      `06:00→14:00` on `2026-07-16`; a **pre-existing** open
      `(org, user, 2026-07-15)` record from an earlier `22:05` check-in (a
      *different* operation); a punch at `2026-07-16T06:00Z`. Both shift
      windows contain the punch, so `matching.length === 2` at outer
      resolve; step 1 wins on the pre-existing record (not ambiguous, so
      Fact 2's 422 does not fire), resolving `workDate: 2026-07-15,
      shiftId: shift-night, reasonCode: OPEN_PREVIOUS_NIGHT_RECORD` and the
      write proceeds onto that `2026-07-15` row via `mode:'append'`. With
      the exclusion applied at the freeze/inner re-resolution, that same row
      — pre-existing, but now also written-to by this operation — is
      excluded from `openByWorkDate`; step 1 no longer matches, and
      resolution falls through to `workDate: 2026-07-16, shiftId:
      shift-morning, reasonCode: CURRENT_DAY_CONTAINING_SHIFT`. **Both**
      `workDate` and `shiftId` flip, not only `reasonCode`. (Control leg,
      same fixture family, `matching.length === 1`: only `reasonCode`
      moves, `workDate`/`shiftId` do not — consistent with the kept
      narrower claim above.)

      **A second, separately unanalysed direction (not covered by either
      argument above).** For `eventType === 'check_out'`, this operation's
      write *closes* an existing open row (`updateLastOutAt`), which removes
      it from `loadOpenRecords`'s result set (`first_in_at IS NOT NULL AND
      last_out_at IS NULL`, `:14815-14821`) independently of any exclusion
      rule. Whether that disappearance can itself change which candidate
      `openByWorkDate` resolves to between the outer and inner reads is a
      question about record *disappearance*; the kept narrower-safety
      claim, the retracted general-safety claim, and the counterexample
      that disproves the latter — the arguments in this cell that reach any
      conclusion about the resolved candidate — analyse only record
      *appearance* (Fact 1 and Fact 2, above, establish structural
      properties of the resolver and do not themselves reach a safety
      conclusion either way). This document does not know the answer and
      does not claim one.
    - **Conclusion (corrected; supersedes the retracted "general case"
      claim below it).** The scenario this cell previously flagged as
      unverified — "`openPreviousMatches` is the *only* path that finds a
      given candidate, so excluding the self-written row changes the
      resolved candidate itself" — **does occur**, in the pre-existing-row
      shape above; it is not merely a hypothetical the retracted paragraph
      failed to rule out, it is now an executed counterexample against the
      exclusion mechanism exactly as this document specified it ("by row
      ID," unconditionally). `(ii-narrow)`, as specified in the mechanism
      paragraph that opens this `(ii-narrow)` bullet, is **not** semantically
      safe in general. What is established, precisely: safe when this operation's
      write is the sole evidence creating the previous-workDate open record
      (the narrower claim kept above); not safe, and demonstrated unsafe by
      the counterexample above, when it instead touches a pre-existing open
      record on that workDate; unanalysed for the check-out/disappearance
      direction. A corrected mechanism that additionally required
      `matching.length === 1` before applying the exclusion would avoid the
      demonstrated counterexample (in that regime the resolved candidate is
      already invariant per the kept claim, so gating on it — i.e. the
      *condition for applying the exclusion*, not the exclusion's effect on
      `reasonCode` — costs nothing there) — but that gated mechanism is not
      what the mechanism paragraph above specifies, has not itself been
      gated or fixture-tested by this document, and
      still leaves the check-out direction unanalysed. **The retracted
      sentence that previously closed this cell — "(ii-narrow) is confirmed
      semantically safe" — is withdrawn and is not replaced by an
      unconditional substitute.**
  - **(ii-wide) Reorder or re-resolve lock §8.2 steps 3/4.** Re-run step
    4's candidate re-resolution **before** step 3's legacy write commits,
    or swap the order of lock §8.2 steps 3 and 4 outright.
- *Consequences (both sub-variants).* No second fingerprint domain is ever
  introduced — the compared object stays exactly the object lock §8.2 step
  7 names, with no new dual-copy risk.
  *(ii-narrow)*, once a corrected form of it is specified and gated (see
  "Conclusion" above — the mechanism paragraph that opens this bullet, as
  currently written, is retracted as unsafe), would be confined to
  `selectAmongMatchingCandidates` and its direct gates (the resolver
  already has its own gate suite this document did not audit for this
  specific change). **`(i)` and `(ii-wide)` are unconditional tokens;
  `(ii-narrow)` is a conditional token** — ratifiable in direction now, but
  void as an implementation authorization until the preconditions below
  are met — see the ballot-row correction in section 3.1 and the
  voidness-condition note at the end of this cell.
  *(ii-wide)*'s cost is structural: lock §8.2's numbered step sequence is
  cited by name elsewhere in the **already-RATIFIED** governing lock (e.g.
  lock lines 2177 "the section 8.2 order", 2283 "8.2 and performs zero
  source/result DML"), so reordering steps 3/4 — or re-running step 4's
  resolution an extra time — is a change to RATIFIED lock text with a blast
  radius this document has not audited, not a change confined to the W4C-2
  branch. It also touches live-punch behavior more broadly (step 3's legacy
  write timing relative to candidate resolution), which this
  run-identity-focused document has no standing to evaluate for side
  effects beyond this one fingerprint gate.
- *Gate shape this option needs.* The same Group E / eDay2 fixture, run
  against whichever sub-variant is chosen, shows the **existing, unmodified**
  `computeAttendanceSourceDefinitionFingerprintV1` no longer flips between
  outer and inner reads — i.e., the fix is proven at the point of causation,
  not papered over by a second comparison domain. *(ii-narrow)*'s ratification
  is conditional (section 3.1's ballot row): before it discharges that
  condition and counts as an implementation authorization, it needs — as a
  **precondition** to implementation, not a confirming regression test
  after the fact — (1) a corrected mechanism specification, specifically
  gating the row-ID exclusion itself on `matching.length === 1` at the
  point the exclusion is applied (this is the discharge bar this document
  requires, matching section 4 step 3's phrasing, not one illustrative
  option among several — the *gating condition* costs nothing exactly
  where the kept narrower claim above already guarantees safety; the
  exclusion's effect of moving `reasonCode` at `matching.length === 1` is
  unaffected and remains the whole point of `(ii-narrow)`); (2) a positive control
  proving the resolved candidate (not just `reasonCode`) is unchanged
  across a representative set of fixtures where the open-record path and
  the containing-shift path would otherwise disagree; (3) a **required
  failing-without-fix negative control** using the
  pre-existing-open-previous-workDate-record shape from the counterexample
  above (`matching.length === 2`, an open record on the resolved previous
  workDate created by a *different, earlier* operation) — this leg must
  fail on the mechanism paragraph as originally specified above and pass on
  the corrected, gated mechanism; and (4) an
  analysis (not merely a gate) of the check-out/disappearance direction
  flagged above, since no gate can substitute for an argument that does not
  yet exist. **Acceptance criterion for (4)**, so it cannot be discharged by
  prose alone: the follow-up round must produce either (a) the same
  positive/negative control shape as (2)/(3) — a fixture in which this
  operation's `check_out` closes a pre-existing open row that was itself
  one of `openPreviousMatches`'s matches, showing by execution whether the
  resolved candidate can change between outer and inner reads because of
  the removal — or (b) a structural argument in the style of section 3.2's
  kept Fact 1/Fact 2 (a proof over a named, closed set of cases, not an
  unscoped safety claim) that the disappearance direction cannot affect the
  resolved candidate, **where the named closed set is itself shown to
  cover every row this operation's own write can trigger the mechanism
  against — the row-ID exclusion applies per row of this operation's
  `openRecords` writes, whether newly created or merely touched, not to a
  representative subset of them** (a closed-set proof that omits this
  coverage step is the same shape as the round-2 proof this document's
  own section 3.2 counterexample already defeated). Either form is
  acceptable; two paragraphs of prose declaring the question closed,
  without (a) or (b), does not discharge this precondition. *(ii-wide)* needs a full re-run of every other §8.2 gate in the
  governing lock and the W4C-1/W4C-2 gate suites unaffected by the reorder,
  since a step-order change is exactly the kind of edit this document's own
  precedent (section 0.1 reason 3) warns against making without checking
  every consumer.

**Recommendation, not a decision — restricted to the two unconditional
tokens.** (i), on balance, against **(ii-wide)**
specifically: (i) is the smaller, more contained change — one new domain
separator and function, fully gated both ways above — against (ii-wide)'s
reopening of RATIFIED lock text whose citation surface has not been audited
here. This is a weaker recommendation than `OD-W4C-49..51`'s (there, one
option was already argued indefensible on its own terms); here, (ii-wide)
is the architecturally cleaner fix and would be preferable if its blast
radius were already bounded — it is not yet, and bounding it is a larger
undertaking than this docs-only pass can responsibly claim to have scoped.

**`(ii-narrow)` — no recommendation, offered as a conditional third token,
not withdrawn.** A prior revision
of this document claimed the semantic-safety question was resolved in
`(ii-narrow)`'s favor and, on that basis, treated it as an unconditionally
ratifiable third option alongside `(i)`/`(ii-wide)`. That claim is
retracted above: the mechanism this document specifies for `(ii-narrow)`
is demonstrated unsafe by an executed counterexample (a pre-existing open
record touched, not created, by the operation's own write flips both
`workDate` and `shiftId`), and a corrected, gated form of the mechanism
has not itself been specified, gated, or checked against the
check-out/disappearance direction. That does **not** mean the token is
withdrawn — this document does not reject it, and the owner's choice of
*direction* (eliminate self-observation at the resolver, versus widen the
fingerprint domain) is not this document's to make. What changes is what
a ruling of `(ii-narrow)` *authorizes*: the owner may rule `OD-W4C-53 =
(ii-narrow)` this pass, and that ruling stands as the direction decision —
but it is **void as an authorization to implement** until the four
preconditions above (corrected mechanism spec, positive control, the
negative control from the counterexample, the check-out/disappearance
analysis) are supplied and gated; section 4 step 3 does not start work on
`(ii-narrow)`'s mechanism until then. This is a narrower, explicit
voidness condition on one ballot row, not the "vote that may be void" this
document elsewhere warns against (section 3.1's framing of why
`O-1..O-5` are not decided by omission concerns a vote whose scope is
*unclear*; here the scope and the condition are both stated on the row).
`(ii-wide)` remains the only *unconditional* way to deliver that same
root-cause shape today, at the structural cost described above.

### 3.3 Dependency matrix and bundle legality across `OD-W4C-44..53`

An independent gate review found that this document's own option cells,
read in isolation, can name assumptions that hold only if a *different*
item resolves a particular way — without saying so on the row itself
(three named instances below). The purpose of this section is to make
"is this combination of ten choices legal" a **mechanically checkable**
question rather than one a reader has to reconstruct from ten separately-
written cells.

**Method, and the method's own blind spot, stated before the results.**
The dependency edges below were found by reading each option's own cell
text for an explicit reference to another item's named object (a class
number, a state name, a lock, a prior ruling) — the same technique the
document already used, once, for `OD-W4C-46`'s existing conditional-on-
`O-1` annotation. This method finds **naming** couplings; it does **not**
find couplings that arise only from two options' *consequences*
interacting without either cell naming the other item. Section 1.7.1's
`50(b)`-times-`52(a)` interaction, added above by this pass, was found
that second way — by tracing what `50=(b)`'s residual (an unclosable
`running` state pending `abandoned`) does to `52=(a)`'s cost (blocks
promotion while any run is `running`), not by either cell naming the
other. **This section does not claim its method finds every such
consequence-level interaction; it claims only the edges listed below**,
found by the two techniques just described, applied once. A different
reviewer applying the same two techniques to the same ten cells is
expected to reproduce these edges; finding an edge this pass missed is
not evidence the pass was performed incorrectly, only that the search was
not exhaustive by construction — no claim of exhaustiveness is made here.

**Wording decouplings (not dependencies — a naming fix, not a legality
constraint).** Two option cells, before this pass, hard-coded another
item's *default* answer into their own prose, which would have made the
cell's own text literally false the moment the owner picked the other
item's non-default option:
- `OD-W4C-44(a)`'s state list ("`running|completed|abandoned`") is now
  written conditional on `OD-W4C-48` (fixed above, in section 3's table);
- `OD-W4C-45(a)`'s "generation allocated under class-`01`" is now written
  conditional on `OD-W4C-46`/`OD-W4C-49` (fixed above, in section 3's
  table).

Neither of these is a legality constraint on `44`/`45` themselves — `44`
and `45` each still have exactly the same legal-option set described
below regardless of what `48`/`46` resolve to. They are listed here
because the review that requested this matrix named them as the kind of
thing a dependency matrix exists to catch, even though the fix in both
cases was wording, not a new exclusion.

**What "legal" means here — two different bars, not one.** This document's
own section 1/2 text is written to a **specific** shape for `44`, `45`,
`47`, and `48` (their `(a)` options only) and does not carry a parallel,
equally-complete alternative spec for their other options the way it does
for `49`-`53`. Picking anything other than `44=a`/`45=a`/`47=a`/`48=a` (or,
for `46`, anything other than what `49` permits) does not make this
document's *implementation* wrong so much as **incomplete for that
branch** — sections 1/2 as written do not cover it, and a follow-up
amendment round would be needed before implementation could proceed on
that branch. This is a real, if softer, form of "not authorized by this
document," distinct from a combination that is **structurally impossible
no matter what is written** — of which this pass found exactly two.

**Structural exclusions (hard — true for any possible spec, not just this
draft's).**

| # | Excluded pair | Why |
| --- | --- | --- |
| D0a | `44=(b)`, any other value | This document's already-written sections 1.1-1.9 (durable row, frozen counts, resume-by-row-read, finalization-by-fold) presuppose a durable run row with an ID that outlives the process; `44(b)`'s derived in-process ID cannot carry any of that (section 3's own "fails because…" text). Not a bundling issue — `44` is not a free choice this document's own body leaves open. |
| D0b | `44=(c)`, any other value | Foreclosed by an **external, already-ratified** decision: `44(c)` is verbatim the G-2 option `(a)` the owner already rejected (section 0.1) in favor of `(b2)`. Re-litigating it here would contradict a ruling this amendment itself takes as given. |
| D1 | `46=(a)`, `49=(b)` | `OD-W4C-49(b)`'s own cell text states this directly: if the red line is not rewritten, class `01` remains forbidden, so `46` cannot be `(a)`. (Already annotated on `46`'s row before this pass; restated here for the matrix's completeness, not newly found.) |
| D2 | `48=(b)`, `50=(b)` | Section 1.1's own rules assert "`running` is the only non-terminal state and is always recoverable" (no stuck absorbing state). `48=(b)`'s own cell text ("accept that an unsatisfiable run holds the partial unique index indefinitely") was drafted before `O-3` existed as an axis, and — read precisely — describes exactly the `48(b)+50(b)` world: under `50=(a)` instead, every `generate` target always reaches a recorded outcome (`completed` or `failed`, section 1.1.1) and finalization is therefore always eventually admitted, so no run is ever "unsatisfiable" in the sense `48(b)`'s cell means — that residual is **vacuous**, not merely accepted, under `50=(a)`. So the pairing does not create a *new* problem out of two independently-tolerable ones; it is the **one** case `48(b)`'s own pre-existing text was actually describing, now made precise by naming `50`'s role in it, and it is a direct contradiction of section 1.1's "always recoverable" assertion (zero legal exit, not "holds indefinitely pending some remediation" — there is no remediation left once `abandoned` is also removed). `48=(b)` is legal — and its own residual clause non-vacuous only in the sense of "textually present," never actually triggered — when paired with `50=(a)`. |

**Interaction (not an exclusion — a cost multiplier the ballot should
see together, not on two separate rows).**

| # | Pair | Effect |
| --- | --- | --- |
| I1 | `50=(b)`, `52=(a)` | Not mutually exclusive (an exit still exists via `abandoned`), but the combination turns `52=(a)`'s stated cost ("a promotion window must avoid colliding with an in-flight run," section 1.7.1) into "one user's permanent, unrelated failure can block the org's shadow-to-authoritative promotion until an operator manually abandons the run" — a materially different, and materially larger, operational cost than either item's own cell states in isolation. See section 1.7.1's updated text. |

**Free axes.** `47`, `51`, `52`, and `53` each have every option fully
specified in this document (section 1.5/gate 4 for `47`; section 1.3/gate
10 for `51`; section 1.7.1/section 1.8 step 1/gate 21 for `52`; section
3.2 for `53`) and no naming or consequence coupling to any other item was
found by the method above. Picking any legal value for one does not
constrain any other's legal value, subject only to D1/D2/I1 above (none of
which involve `47`, `51`, `53`; `52` is involved only in the non-exclusion
interaction I1).

**Decision rule.** A bundle (one choice per item, `44` through `53`) is:

- **structurally illegal** iff it contains `44=(b)`, `44=(c)`, the pair
  `(46=(a), 49=(b))`, or the pair `(48=(b), 50=(b))` (D0a/D0b/D1/D2 above);
- otherwise **legal**, and additionally **fully authorized by this
  document as currently drafted — no follow-up amendment round needed
  before implementation** iff `44=a ∧ 45=a ∧ 46=a ∧ 47=a ∧ 48=a ∧ 49=a`
  (the only branch of `44/45/47/48` this document fully specifies, paired
  with the only value of `49` that makes `46=a` legal) **and** `53 ∈
  {(i), (ii-wide)}` (excluding `(ii-narrow)`, which is legal to *rule*
  this pass per section 3.2 but void as an implementation authorization
  until its own four preconditions are met) — with `50`, `51`, `52` each
  free between their two fully-specified options. **Exactly 16 such
  bundles exist** (`50`, `51`, `52` each binary, `53` restricted to 2 of
  its 3 tokens: 2×2×2×2 = 16), all legal by the rule above and all
  requiring zero follow-up round;
- otherwise **legal, but not immediately implementable from this document
  alone** — some axis picked a value this document does not carry a full
  parallel spec for (`45∈{b,c}`, `47∈{b,c}`, `48=(b)` [with `50=(a)`,
  since `48=(b)` with `50=(b)` is D2-excluded], `46∈{b,c}` [reachable only
  when `49=(b)`], or `53=(ii-narrow)` [conditional per section 3.2]) — a
  follow-up round would need to write that branch's spec (or, for
  `(ii-narrow)`, its four preconditions) before implementation proceeds on
  it.

**The reviewer-suggested bundle
`44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)` is legal, and is one of the 16
zero-follow-up bundles above** — it picks the fully-specified branch on
every axis that has one, triggers neither structural exclusion (`48=a`
means D2 does not bind), and picks an unconditional `53` token. This
section confirms that bundle's mechanical legality; it does not rule on
it — the choice among the 16 (or among the wider legal-but-incomplete set)
remains the owner's, per this document's standing boundary (section 3.1's
own framing).

## 4. Execution sequence

1. Merge this document as **PROPOSED** with no runtime code. PR #4612 stays
   Draft under OWNER-AUTHORIZATION-HOLD and is not touched by this merge.
2. Owner RATIFYs the **exact merged SHA** of this file and decides
   `OD-W4C-44..53` — the recommendations (`44..48`) **and** the five pending
   two-reading decisions (`49..53`, sections 3.1-3.2). Nothing below starts
   before all ten are ratified.
3. Only then implement P1-2 on the W4C-2 branch: the migration, the two new
   tables (three, plus the deferred completion-outcome trigger, if `O-3`
   ratifies `(a)`, section 1.1.1), the outbox discriminated union, the
   class-`01` builder/helper, the run-scoped enqueue surface (including the
   private `mintAttendanceScheduledRunIdentityFromInsertedRowV1` factory,
   section 1.4.1), the run/resume/finalization transactions, the
   `abandoned` transition (section 1.1.2), the two closed-set copies, and
   all of section 2's gates (including the new gates 22-23; section 3.3's
   dependency matrix determines which of gates 20-21's legs are required
   once `O-3`/`O-4` are known).
   `OD-W4C-53`/`O-5` is implemented separately from this step, and its
   ballot has two unconditional tokens and one conditional token per
   section 3.2, each with its own implementation branch: if ratified `(i)`,
   commit `64ea17d1931c142a080aeab9dabe2e8c1098c2cd` (already on the W4C-2
   branch) needs only section 3.2's positive/negative gate pair added
   before it counts as closed; if ratified `(ii-wide)`, that commit is
   reverted and lock §8.2's steps 3/4 are reordered or re-resolved and
   gated per section 3.2's (ii-wide) gate shape, including the full §8.2
   gate re-run it requires. If ratified `(ii-narrow)`, that ruling records
   the direction decision but does **not** by itself authorize starting
   implementation (section 3.2's retraction): work on `(ii-narrow)`'s
   mechanism starts only after a follow-up round supplies and gates
   section 3.2's four listed preconditions (corrected, `matching.length
   === 1`-gated mechanism spec; positive control; the negative control
   from the counterexample; the check-out/disappearance analysis) — until
   then this item blocks on that follow-up round; `OD-W4C-53` is a
   single-choice ballot, so this document does not presume a fallback
   token the owner did not also cast. Whichever token is ratified, this
   item is governed by section 3.2's gate shape, not by this step's
   run-identity gate list.
4. New **exact-head** independent adversarial review of the resulting head.
5. Even at zero P1/P2, the lane **stops**: merging PR #4612 remains an owner
   decision, and this amendment authorizes no arming, flag enablement, org
   enablement, deployment, or closure of #4556.
6. Issue #4616, which was opened as the `(c)-plus` residual-risk carrier, is
   rewritten against the `(b2)` boundary or closed with a public note once
   this amendment lands; it is not silently left stating a superseded
   premise.

## 5. Declared residuals

These are stated rather than hidden; each is either an owner decision above or
an accepted bound:

- **External consumers are unenumerable.** No in-repo runtime subscriber to
  either run-level event exists at `origin/main`
  `9fdf68fa5c34d2224fbe6bd0d71b14ca78263502` (re-verified this addendum:
  `git grep -n "attendance.absence.generated\|attendance.work_date.review_required"`
  over non-test `.ts`/`.cjs`/`.js` finds only the two `emit(...)` call sites
  themselves, `index.cjs:21243` and `:21249`); only two DB tests assert
  emission. This amendment therefore preserves the
  wire contract instead of arguing from a consumer inventory.
- **Third dual-copy created.** The closed review-reason list now lives in the
  resolver module and in a migration CHECK. Section 1.2.1 requires a parity
  gate, but the underlying duplication is real and is a maintenance cost.
- **`run_id` FK direction.** `attendance_scheduled_run_targets` binds the
  operation ID by derivation CHECK rather than by FK, because target rows are
  written before the operation rows exist. The operation row's own
  `chk_aro_derived_identity` is the other half of that binding.
- **Finalization and the `abandoned` transition (section 1.1.2) are two new
  transaction shapes** in section 8.2's world, not one: both hold
  class-`00` and class-`01` only and are forbidden from source DML and
  from class-`11`, but they are otherwise distinct (different terminal
  state, different fold, no outbox insert on the `abandoned` path).
  Section 2 gates 15 and 23 together are what keep that honest — gate 15
  alone was written against finalization only and does not, by itself,
  cover the `abandoned` path's no-source-DML/no-class-`11` legs.
- **`abandoned` has no consumer today.** It exists solely to prevent a stuck
  non-terminal run; if the owner picks `OD-W4C-48(b)`, gate 11 and section 1.1
  must be edited accordingly before implementation.
- **Cross-generation per-user state amplification.** A fresh invocation
  after a terminal run (section 1.1's `generation` allocation) mints a new
  `run_id`, and because every per-user `operation_id` derives from
  `(run_id, user_id, work_date)` (section 1.2), every user's operation
  identity changes too — the registry sees `n` all-new operations, not a
  replay, for generation `n+1`. Restart/crash replay **within one
  generation** is unaffected, and is in fact strengthened by this
  amendment (a restarted process re-reads the same `running` run row
  instead of re-deriving an ID, per section 1.1). The wire is not broken:
  a regeneration's absence-insert path stays guarded by `NOT EXISTS`
  (`generateAbsenceRecords`), so a repeat generation for an
  already-generated user inserts nothing and that user's contribution to
  `generated_count`/`total` is unaffected. `OD-W4C-45` already puts "one
  run per day, repeat calls replay" versus "each terminal-then-repeated
  call is a new generation" on the table; this note makes explicit that
  the recommended option (a) carries this per-user identity amplification
  as its accepted cost.
- **The finalization-reachability gap (section 0.5) is not closed by this
  draft.** Until `O-3`/`OD-W4C-50` and `O-4`/`OD-W4C-52` are ratified and
  implemented, a `running` run can, on the paths section 0.5 names, only
  be closed by the explicit `abandoned` transition, which loses both
  run-level events for the run's unaffected users too. Sections 1.1.1 and
  1.7.1 are the full specification of both provisional fixes; section 2
  gates 20-21 are inert (not required today) until the corresponding
  decision selects a side.
- **`50=(b)` + `52=(a)` is a cost interaction, not a fresh residual, but
  is recorded here for visibility alongside the other cost-bearing
  choices in this list.** See section 3.3's interaction row I1 and section
  1.7.1's updated text: one user's permanent, unrelated failure can, under
  that pairing, block an org-wide shadow-to-authoritative promotion until
  an operator manually abandons the run.
- **Abandon-transition authorization is specified at the capability/posture
  level only.** Section 1.1.2 requires the `retirement` capability and
  `{platform_admin, attendance_admin}` actor posture, mirroring this
  line's existing command-envelope check, but this run-identity-focused
  document has not read, and does not specify, the HTTP route,
  request-validation, or session layer that would actually enforce that
  check, nor a general-purpose audit-log table beyond the run row's own
  `abandoned_by_actor_posture`/`abandon_reason_code`/`finalized_at`
  fields. That wiring is implementation detail governed by however this
  line's other admin surfaces are already authenticated — a system this
  document does not audit.
