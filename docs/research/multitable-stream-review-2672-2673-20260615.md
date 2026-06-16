# Multitable in-flight stream — per-PR review (Claude, 2026-06-15)

Scope: two in-flight multitable PRs reviewed against their head commits.
- **#2672** per-field (column-level) record restore — backend (`6ed4d9afc`)
- **#2673** B6-a comment emoji reactions — storage + API (`7a62ff92d`)

Each finding below carries its FINAL severity after an adversarial pass. Tags:
`CONFIRMED` = verdict upheld at the original severity; `↓ X→Y` = downgraded with the
reason that survived re-reading the code; `un-adjudicated` = raw finding self-consistent
but not separately re-verified (listed at its self-rated severity, no verdict invented).
Nothing in either PR was fully refuted.

---

## PR #2672 — per-field record restore

### Headline: **REQUEST-CHANGES**

Driver = the one finding that came through the adversarial pass **un-downgraded**: per-field
restore reintroduces, through a side channel, the very change-history bit the record-history
field mask (#2144) was built to hide. It is a confidentiality regression of a deliberately
engineered control, and it has a concrete silent-drop fix. The other medium (M2, reject-branch
coverage) was downgraded high→medium; the remaining four findings are low.

### Confirmed / surviving findings (high → low)

**M1 — Per-field restore is a single-field change-timeline oracle for `visible=false` columns** — **medium** · `CONFIRMED`
`packages/core-backend/src/routes/univer-meta.ts:5801` (`selectedDiff` filter), `:5804-5816` (forbidden gate over `selectedDiff` → 403), `:5818-5821` (empty `selectedDiff` → 200 no-op). Defeats `redactRecordRevisionEntry` at `:3244-3250`, applied by the history GET at `:5615-5617`.
- An actor with `canEditRecord` but `visible=false` (or `read_only`) on field `F` can probe `restore` with `fieldIds:[F]`: **403 RESTORE_FORBIDDEN** when `F` differs between target `vN` and current (`selectedDiff=[F]` → gate fires), vs **200 no-op** when `F` is unchanged at `vN` (`selectedDiff=[]` → gate skipped). 403-vs-200 is an exact per-field oracle for "did this confidential column change at version N"; sweeping `targetVersion` reconstructs the column's full modification timeline. Values stay hidden — this is metadata/timeline disclosure, gated behind record-edit capability, hence medium not high.
- Diff is built over **all** fields against unmasked `currentData`/`targetSnapshot`, so `F` enters the diff purely on value-difference. The generalized 403 message (`:5811-5815`) was added precisely to avoid leaking hidden-field metadata; the per-field selector isolates one field and defeats it. Delta vs prior: full-record restore already 403s when *any* forbidden field differs (entangled signal); `fieldIds` makes it single-field precise. New leak is scoped to `visible=false`/`hidden` fields only — `visible+read_only` fields already show as changed in history, so no new bit there.
- **Fix:** treat a selected-but-forbidden field identically to a selected-but-unchanged one — drop forbidden `fieldIds`-selected fields from `selectedDiff` **before** the `hasForbidden` gate, so the response is identical whether or not the confidential field changed (only NOT-selected forbidden fields, i.e. full-restore mode, keep atomic-reject). Trap: do **not** echo the dropped ids into `skippedFieldIds` — that re-leaks the same bit; `skippedFieldIds` may carry only non-forbidden skip reasons.

**M2 — Per-field permission-gate REJECT branch is untested (selection-as-bypass unproven-safe)** — **medium** · `↓ high→medium`
`packages/core-backend/src/routes/univer-meta.ts:5801-5817` (gate over `selectedDiff`); `tests/integration/multitable-record-restore.test.ts:557,576,591` (T15/T16/T17 all select writable/unchanged fields; no `fieldIds:[FLD_SECRET]`-as-USER_RO case anywhere).
- The core security guarantee — naming a non-writable field in `fieldIds` must still 403, not bypass the gate — has no direct test. T16 proves only the permissive direction (`fieldIds:[FLD_A]` succeeds while a co-changed forbidden SECRET is *not* selected → 200). T4's 403 runs over the full diff with no `fieldIds`, so it never exercises the gate over a caller-selected subset.
- **Downgraded because:** no live bug — tracing `fieldIds:[FLD_SECRET]` as USER_RO, the gate correctly returns 403. And the finding's own named regressions (gate-over-`diff`, apply-after-gating) are in fact **already caught**: T16-partial expects 200, which would flip to 403 (RED) if the gate ran over `diff`. The residual unpinned composition is narrow — the per-element predicate firing when the forbidden field *is* the selected one — and its halves are independently covered (T4 = predicate flags SECRET; T16 = gate iterates `selectedDiff`). The predicate is field-id-keyed, not position-keyed, so the unpinned case is low-likelihood.
- **Fix:** add a real-DB test — seed `A`+`SECRET` both differing, `testUserId=USER_RO`, send `fieldIds:[FLD_SECRET]`; assert 403 / `RESTORE_FORBIDDEN`, body excludes `FLD_SECRET`, live data unchanged (atomic). One line; pins selection-is-not-a-bypass.

**L1 — Link-field per-field restore has no coverage (`meta_links` sync + no-bleed)** — **low** · `↓ medium→low`
`tests/integration/multitable-record-restore.test.ts:285-360` (T6/T6e/T6a/T6f/T6g all full-record, no `fieldIds`); route `univer-meta.ts:5780-5786` (link diff, pre-existing), `:5801` (type-blind filter), `:5834` (`changesByRecord: selectedDiff`).
- Literal claim true — zero per-field × link coverage in either direction. **Downgraded because:** the new code adds no link-specific logic; the filter is type-blind (`diff.filter(ch => fieldIds.includes(ch.fieldId))`), a link `set` is shape-identical to a scalar `set`, and `meta_links` sync lives in `patchRecords` (already covered by T6e). Selecting `[FLD_LK]` alone = T15 behavior + T6e behavior; selecting a scalar while a link also differs drops the link from `selectedDiff` so its target value never reaches `patchRecords` (current link value unchanged → idempotent re-sync → no bleed mechanism exists). Belt-and-suspenders, not bug exposure.
- **Fix (optional):** T18 `fieldIds:[FLD_LK]` → assert link + `meta_links` re-sync to target while an unselected scalar stays; T19 scalar-only selection while link differs → assert `meta_links` untouched.

**L2 — Per-field UNSET isolation untested (the one new spine primitive × the new feature)** — **low** · `↓ medium→low`
`packages/core-backend/src/routes/univer-meta.ts:~5793` (`unset` emitted when `inCur && !inSnap`), `:~5798` (filter); `tests/integration/multitable-record-restore.test.ts:550-596` (T15/T16/T17 all `set`/no-op, no `unset`); full-record `unset` only at T1 `:169-193`.
- Gap real — no per-field test produces an `unset` diff entry, so neither "select `[A]`, B's unset must be filtered out so B survives" nor "select `[B]`, only B unsets" is asserted. **Downgraded because:** the untested code is provably correct — the route filter is op-agnostic (keys on `fieldId`), and the spine after-image (`record-write-service.ts:783` `{...previousData, ...patch}` then `:786` `delete afterImage[removedId]` only for `unsetIds`) is partial-safe: select-`[A]` → `unsetIds=[]` so B stays; select-`[B]` → after-image `{A}`, B removed from live row and stored after-image. Regression-protection over sound code.
- **Fix (optional):** T1-style per-field test — current `{A,B}`, snapshot `{A:a1}`; `fieldIds:[FLD_A]` → A=a1 & B present; `fieldIds:[FLD_B]` → B absent from live row **and** `latestRevision().snapshot`, A unchanged.

**L3 — `SCHEMA_DRIFT` runs before the `fieldIds` filter (parity asymmetry + uncovered)** — **low** · `↓ medium→low`
`packages/core-backend/src/routes/univer-meta.ts:5760-5764` (drift loop over full `targetSnapshot`, returns 422) vs `:5801` (`selectedDiff` filter, strictly after); `:5804` forbidden gate over `selectedDiff`. Test gap: `tests/integration/multitable-record-restore.test.ts:362-371` (T6b full-record only); no per-field drift variant.
- All three claims confirmed: a drifted **unselected** co-field 422s the whole per-field restore, which is inconsistent with the per-field "win" for permissions (T16 proves an unselected *forbidden* co-field does **not** block). **Downgraded because:** the behavior is fail-closed — the over-conservative path rejects (422) rather than writing anything wrong; no corruption, no bypass, no bleed. The Slice-1 design frames `SCHEMA_DRIFT` as a record-level "no cross-schema restore" invariant predating the per-field Gate. Likelihood moderate-low (needs a revision snapshot carrying a since-deleted field AND a selection of only survivors).
- **Fix:** decide intended semantics and lock with a test — if drift should still hard-fail regardless of selection, document the asymmetry vs forbidden co-fields and add a `fieldIds:[FLD_A]`-still-422s test; if per-field should skip unselected drifted fields, move the drift check after the filter.

**L4 — `skippedFieldIds` still hard-coded `[]`; OpenAPI still says "reserved for a future mode" — but this PR *is* that mode** — **low** · un-adjudicated
`packages/core-backend/src/routes/univer-meta.ts:5821,5847` (`skippedFieldIds` always `[]`); `packages/openapi/src/paths/multitable.yml:~512` (response desc "reserved for a future partial-restore mode").
- Caller passing `fieldIds:[A,B,C]` where only `A` is in the diff gets `restoredFieldIds:[A], skippedFieldIds:[]` — `B`/`C` silently dropped with zero signal. Contract/observability gap, not correctness; the response-side doc is now stale and a checkbox-driven frontend cannot reconcile which requested fields applied.
- **Fix:** either (a) populate `skippedFieldIds` with **non-forbidden** requested-but-not-restored ids (respecting M1's leak constraint — never forbidden ids), or (b) at minimum update the OpenAPI response description and document the silent-drop semantics on the response side, mirroring the request-field note.

**L5 — T17 title overclaims "unknown field" but only asserts an unchanged existing field** — **low** · un-adjudicated
`tests/integration/multitable-record-restore.test.ts:590-596` (title says "unknown" but selects `FLD_B`, a real unchanged field).
- The genuine unknown-id path (id not in schema → filter drops it → empty `selectedDiff` → no-op) is asserted by name only. A regression where an unknown id threw or matched-nothing-yet-wrote would not be caught.
- **Fix:** fix the title to "unchanged field", or add `fieldIds:['fld_does_not_exist']` → expect 200 `noop:true`, live data unchanged.

### What the adversarial pass changed
M2/L1/L2/L3 all began higher (one high, three medium) and were re-rated after tracing the actual code: each is a real coverage/parity gap over **correct, fail-closed code**, not a latent defect. M1 is the lone finding that stayed at its rating — and it is the headline driver because it regresses an intentional control rather than merely under-testing it.

---

## PR #2673 — comment emoji reactions (B6-a)

### Headline: **REQUEST-CHANGES**

Driver = the keystone real-wire test (the PR's own headline anti-drift proof) runs in **no CI
workflow**, while the unit suite that *does* run is vacuous about the load-bearing SQL —
so idempotency, the aggregation, and self-scoped delete have **zero regression protection in
CI**. This is the repo's own documented "invisible debt" / "wire-vs-fixture" trap, named in
`vitest.config.ts`'s self-doc (#2052/#2068) and memory (#1435/#1436). One shared root cause and
one shared fix span the two mediums and the low below.

### Confirmed / surviving findings (high → low)

**M1 — Mock-DB unit tests are vacuous about the SQL (idempotency / aggregation / self-scope asserted by nothing CI runs)** — **medium** · `CONFIRMED`
`packages/core-backend/tests/unit/comment-reactions.test.ts` — mock harness `:14-56` (every chain method `vi.fn(chainFn)` ignoring args; `execute` shifts a pre-queued array), insert path `:170-174`, delete path `:182-185`, aggregation `:196-208`. Service: `CommentService.ts` `listReactionsForComments` projection callback and `addReaction` `ON CONFLICT … doNothing()` / `removeReaction` `where user_id` — **none invoked by the mock**.
- The mock never runs the `.select(({fn})=>…)` or `.onConflict(oc=>…)` callbacks; zero call-arg assertions exist. So the unit suite proves only JS mapping/control-flow: (1) idempotency — "inserts when comment exists" queues `[]` and asserts undefined; `ON CONFLICT DO NOTHING` never exercised; (2) aggregation — hand-fed `{count, reacted_by_me}` rows mapped to `{count, reactedByMe}`; the `group by` / `count(*)` / `bool_or`-via-`max(CASE WHEN user_id=viewer)` SQL never runs; (3) **self-scope of delete** (the severity anchor) — "deletes (idempotent)" queues `[]`, nothing asserts the `where user_id = actor` filter that stops a user deleting another's reaction.
- A refactor dropping the `user_id` filter — a permission-integrity guarantee — would let userA delete userB's reaction with no running CI job catching it. Code is structurally sound (composite PK + `ON CONFLICT`, user-scoped delete) and the integration test passes locally, which is why this is medium (missing-CI-guard) not high.
- **Fix:** treat the real-wire integration test (M2) as the authoritative proof for `ON CONFLICT` idempotency, the aggregation SQL, and self-scoped delete, and ensure it runs in CI. Add a negative real-wire assertion that userA's DELETE cannot remove userB's reaction (only userA-removes-own is shown today).

**M2 — Keystone real-wire integration test runs in NO CI workflow (+ test DDL drifts from migration)** — **medium** · `↓ high→medium`
`packages/core-backend/vitest.config.ts:32` (excludes `comments.api.test.ts`; `:35-46` self-documents this exact "invisible debt / no CI job caught" trap citing #2052/#2068); `.github/workflows/plugin-tests.yml:135-160` (core-backend `test` step runs default `vitest` at `:137`, **before** Postgres starts at `:146`; integration allowlists `:168-235,288-296` omit the file — `grep -c` = 0); keystone test at `tests/integration/comments.api.test.ts:1228` (real PG + real HTTP).
- The PR's central verification claim — idempotent add (`ON CONFLICT DO NOTHING`), the grouped aggregation, self-scoped delete (`where user_id`), the multi-codepoint `❤️` DELETE round-trip, delete-cascade — lives entirely in this excluded file. It passed only on the author's laptop. The exclusion is pre-existing, but this PR deposits its whole real-wire verification into it. Secondary: `ensureCommentsTables` hand-rolls `varchar(50)` ids vs the migration's `text` — so even if it ran it would test a fixture schema, not the migration's DDL.
- **Downgraded because:** "the ONLY place those behaviors are exercised" overstates coverage. Layer the feature: migration DDL is covered by `migration-replay.yml` (runs `db:migrate` on fresh PG every PR, auto-discovers the new `meta_comment_reactions` migration); service JS logic is covered by the (non-excluded) unit suite. Only **layer 3 — real-SQL semantics** — is the genuine CI gap, on one low-stakes feature, with no live defect.
- **Fix (shared with M1, L1):** add `tests/integration/comments.api.test.ts` to the real-DB integration step's explicit file list in `plugin-tests.yml` (after the Postgres-start step) so add/aggregate/idempotent-re-add/self-scoped-DELETE/cascade run against real PG on every PR. Align `ensureCommentsTables` string columns to `text`.

**L1 — `comments:write` gate has zero test coverage and no anti-revert guard** — **low** · `↓ medium→low`
`packages/core-backend/src/routes/comments.ts:400` (POST) and `:419` (DELETE) both `rbacGuard('comments','write')`, matching `createComment` `:296`; `tests/integration/comments.api.test.ts:120` (`RBAC_BYPASS='true'` in `beforeAll` — bypasses the guard for every request). The new unit suite is pure service-layer (no route/RBAC).
- No test sends a reader-only token and asserts 403 on a reaction; the design-lock even *mandated* a reader-deny test for this route (line 68), which was dropped. Nothing prevents a future edit flipping `'write'` → `'read'` (read-only users writing attributed data).
- **Downgraded because:** the gate is verified-correct, so present exploitability is zero — this is a missing regression guard, contingent on a hypothetical future edit. Quality/test-parity, caps at low. (Evidence-chain note: the cited "design-lock §3.4" does not exist; the accurate, stronger ref is design-lock line 68, the spec-promised-then-dropped reader-deny test.)
- **Fix:** after wiring the suite into CI (M2), add a reaction request with a reader-only / no-write token asserting 403 (mint a token outside `RBAC_BYPASS` or add a focused route-guard unit test).

**L2 — Skip-when-unreachable guard green-skips the keystone if PG/port is unavailable** — **low** · un-adjudicated
`packages/core-backend/tests/integration/comments.api.test.ts:1229` (`if (!baseUrl) return`), `:121-122`/`:132-134` (`beforeAll` silently early-returns leaving `baseUrl` unset when the ephemeral port can't bind or the server has no address).
- The documented skip-when-unreachable trap (#1435/#1436): with no live PG/port the test passes vacuously. Moot today (file runs in no workflow), but it becomes load-bearing the moment M2 wires the file in — without a hard assertion the wiring could green-skip and re-hide the same gap.
- **Fix:** when wiring the file in (M2 fix), add a fail-loud assertion (assert `baseUrl` set in `beforeAll`, or `expect(baseUrl).toBeTruthy()` before the body) so a missing PG/port turns the keystone RED, not skipped-green.

**L3 — add-reaction / delete-comment race leaves an orphaned reaction row (no FK)** — **low** · un-adjudicated
`packages/core-backend/src/services/CommentService.ts:581-592` (`addReaction` insert is non-transactional, runs after a passing `getRequiredCommentRow`); `:220-224` (`deleteComment` txn cascade); migration `zzzz20260615190000_create_meta_comment_reactions.ts:14-21` (no `FOREIGN KEY`).
- If `addReaction`'s `INSERT … ON CONFLICT DO NOTHING` lands after a concurrent `deleteComment` commits, the row inserts against a vanished `comment_id` (no DB FK, by design — comments sub-domain cascades at the app layer). Genuinely low and non-blocking: orphans are invisible to all read paths (`listReactionsForComments` is driven only by surviving `meta_comments` ids, which are non-recurring UUIDs), so it's a storage leak, not a count/desync bug. Matches the established `markCommentRead` no-FK pattern — not a new regression.
- **Fix (optional, non-blocking):** (a) accept as the documented no-FK app-cascade pattern + periodic orphan-sweep if it ever matters; (b) add FK `ON DELETE CASCADE` (departs from sub-domain convention); or (c) re-check existence after insert and delete the just-inserted row if the parent vanished.

**L4 — `emoji` body field has no max-length bound before NFC normalization** — **low** · un-adjudicated
`packages/core-backend/src/routes/comments.ts:295,314` (`z.string().min(1)`, no `.max()`); `CommentService.ts:369-375` (`.normalize('NFC').trim()` on raw input before the allowlist check); `index.ts:950` (`express.json` 10mb cap).
- Oversized input is ultimately 400'd by the `COMMENT_REACTION_EMOJIS` allowlist, so no persistence/integrity risk; the only ceiling before NFC normalization is the global 10mb body cap. Normalizing a multi-MB string per request is wasteful but negligible. Proto-pollution structurally absent (body parsed as `{emoji: string}`; only the string is consumed; allowlist `Set` membership can't be poisoned).
- **Fix (defensive):** `z.string().min(1).max(64)` so absurd payloads are rejected before NFC normalization.

### What the adversarial pass changed
M2 began high and L1 began medium; both were re-rated after confirming the migration DDL and the service JS each have separate CI coverage, leaving only the real-SQL semantics genuinely unguarded — a real gap on a low-stakes feature with no live defect, not a broad coverage hole. M1 held at medium because its self-scoped-delete vacuity touches a permission-integrity guarantee. The two mediums and L1 share one root cause (keystone not in `plugin-tests.yml`) and one shared fix.
