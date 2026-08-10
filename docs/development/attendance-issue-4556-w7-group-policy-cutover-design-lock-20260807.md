# Attendance Issue #4556 W7 Group-Policy Calculation Cutover Design Lock (DRAFT)

> Status: **PROPOSED / Draft / runtime HOLD**
>
> Date: 2026-08-07
>
> Pinned baseline: `origin/main@4e6a35d99ea64291dd0588bbf5daa74dccec385b`
>
> Scope: issue #4556, W7 only (parent lock §9.8 组策略核算切换 — cutover of
> accounting/calculation context sourcing from the legacy per-user path to the
> group-effective-policy source).
>
> Authorization: on 2026-08-07 the owner authorized **W7/W8 design-lock DRAFT
> preparation only** (docs-only). This document authorizes **no** runtime and
> no merge — including the Draft/HOLD docs PR that carries it, which merges
> only on explicit owner instruction — no staging, no soak, no flag change, no
> deployment, no production/customer data use, and no closure of issue #4556. The runtime order remains
> **W6 owner sign-off → W6 runtime → W7 → W8**; every W7 statement below that
> touches a W6 outcome is written as *conditional on the named OD-W6-x choice*
> and presupposes nothing about how the owner will decide W6.
>
> Risk class: **same as the W4C-3 cutover arc** (W4C-3a/3b/3c). W7 changes
> which policy source feeds authoritative accounting for an org. Every house
> rule that governed the W4C-3 slices (serial contract, fresh-main PRs,
> independent adversarial gate with 0 P1/P2, exact-head tests + mutation legs,
> real-DB two-connection races, no org enabled) applies to every W7 runtime
> slice unchanged.

## 0. Purpose and authority

The owner-ratified parent lock
`attendance-shift-group-advanced-capability-design-lock-20260723.md` defines
W7 in §9.8 (lines 743-753) as **group policy calculation cutover**:
precedence and snapshots; conflict fail-closed; synthetic staging soak;
named-org opt-in.

The owner-ratified W4 lock
`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`
explicitly parks this work for W7: §2.3 (lines 155-168) lists "W6/W7
calculation-group winner selection or policy precedence" as OUT of W4 and
states "W4 stores `calculationGroupId=null` and `contextSelector='legacy'`. A
W4 query against W1 group-membership tables is a scope violation." W7 is the
slice that — and only after its own gates — lifts exactly that boundary.

The remaining-slice plan
`attendance-issue-4556-w4-remaining-slice-plan-20260726.md` §6 (lines
122-125) fixes the sequence: W5 单段 flex → W6 组有效策略只读聚合 → **W7
组策略核算切换** → W8 验证与收口.

The W6 design lock
`attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md` is
now **RATIFIED (W6-1 backend aggregate only)** on `origin/main` — its
preparation PR #4771 merged contract types, an out-of-build OpenAPI draft,
fixtures, and an unmounted UI shell; the RATIFY record (PR 4821, below)
subsequently landed. This document therefore treats only the W6-1 scope named
below as decided, and treats every W6 semantic beyond it (W6-2 contract
wiring, W6-3 UI, W6-4 verification) as still undecided. Section 6 lists every
remaining dependence on a W6 outcome explicitly.

**Re-verified 2026-08-10 against `origin/main@d78b27d37c96b66cd8d898dc6b8b17e2a5f294a5`
— the decision state has moved twice since this document's pinned baseline,
and both moves are recorded here rather than silently carried forward or left
at their earlier "OPEN/unmerged" wording.**

- **2026-08-08:** PR **4821** (the durable W6 RATIFY record) **MERGED** as
  `ecf77d2433596bbdd8b67c312a37178dbc97f715` (verified an ancestor of
  `origin/main`). It records: `OD-W6-0` adopt the W6 lock; `OD-W6-1..9`
  option **(a)** for each, against PR #4771's merge commit
  `2967da018ceea41b91098e14d4c15a57236eb5f8`; and it prospectively authorizes
  **the W6-1 backend aggregate slice only**, Draft/HOLD, stopping after a
  fresh exact-head gate. The W6 lock's own header on `origin/main` now reads
  "RATIFIED (W6-1 backend aggregate only) ... every W6 slice beyond W6-1
  remains HOLD" (re-read at the current tip, not carried forward).
- **2026-08-10:** PR **4805** (the W8 plan's L8 CI-wiring precondition — see
  the W8 plan §5 row L8) **MERGED** as
  `4c28467c54f376ad5a68718d3dbe6ad50c76a917`. It is unrelated to W6/W7
  semantics — it wires two orphaned real-DB suites and converts a
  hardcoded-allowlist CI guard to derived completeness — named here only
  because every earlier round of this document cited it as OPEN/unmerged and
  that wording is now stale everywhere it appears.

Three limits matter and are stated rather than glossed, even though the
RATIFY record itself is now on `main`:

1. **Scope.** The authorization PR 4821 carries, by its own text, is the
   **W6-1 backend aggregate slice only**, Draft/HOLD, stopping after a fresh
   exact-head gate. **PR 4814** (the W6-1 backend slice itself) is **OPEN,
   Draft, unmerged** at `origin/main@d78b27d3` (head
   `4cc0122883846900a1325cdacd5eda0355d77215`, re-verified 2026-08-10). W6-2
   contract wiring, W6-3 UI, W6-4 verification, any merge, staging, soak,
   flag, deployment, and closure of issue 4556 each remain withheld. Ratifying
   the OD table is not an adoption of W6 runtime.
2. **Nothing has landed.** No W6 runtime exists on `origin/main@d78b27d3`:
   `git diff 4e6a35d9 origin/main` over
   `packages/core-backend/src/attendance`,
   `packages/core-backend/src/services`, `plugins/plugin-attendance`,
   `packages/openapi`, and `apps/web/src/views/attendance` is empty
   (re-verified 2026-08-10). PR 4821 touched exactly one file, the W6 lock MD
   itself (68 insertions / 28 deletions per its own diff stat), and PR 4805
   touched only CI-workflow / vitest-config / test-tooling files outside every
   one of those five paths.
3. **W7 is unaffected either way.** §8 item 1 makes W6 sign-off *and W6
   runtime completion* a hard precondition; the second half is unmet
   regardless of how the first resolves. Every §6 row therefore stays
   conditional, and no OD-W7-*n* has any ruling at all.

Where this document and an owner-ratified lock disagree, the ratified lock
wins and this document must be amended.

## 1. Verified current-state spine

Evidence checked by reading each file at the pinned baseline. Full file:line
provenance is in §10.

### 1.1 What "cutover" actually flips — the legacy path today

| Fact | Evidence |
| --- | --- |
| The frozen calculation context is hard-typed to the legacy selector: `FrozenAttendanceContextV1` declares `selector: 'legacy'` and `calculationGroupId: null` as literal types. | `packages/core-backend/src/attendance/w4c0-write-boundary-types.ts:124-152` (`:126`, `:134`) |
| The pure calculator fail-closes on anything else: `validateFrozenContextShape` requires `schemaVersion === 1`, `selector === 'legacy'`, `calculationGroupId === null`; unknown keys fail closed. | `packages/core-backend/src/attendance/w4c1-segment-calculator.ts:335-363` (`:350`, `:351`, `:358`) |
| The canonical import kernel enforces the same closed shape on import-carried contexts. | `packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts:162-173` |
| There is exactly one production frozen-context builder, `buildW4ShadowFrozenContextV1`, and it writes the literal `selector: 'legacy'`, `calculationGroupId: null`. It takes `shiftId` as an input — policy resolution happens upstream. | `plugins/plugin-attendance/index.cjs:22625` (literal at `:22740-22750`); call sites `:24510`, `:24721`, `:28775`, `:29365`, `:35338` (an earlier draft cited `:35286`, which is the comment above that call) |
| Upstream resolution is the legacy per-user path: `resolveW4LiveCandidateInTransactionV1` / `resolveW4ScheduledCandidateInTransactionV1` resolve the winning shift per user/date through `createPluginAttendanceWorkDateResolver` with schedule-fact locking. No calculation-group membership or group-effective policy is consulted. | `plugins/plugin-attendance/index.cjs:22593-22620` |
| Segment calculation is not authoritative anywhere: `SEGMENT_CALCULATION_IMPLEMENTED = false` in the canonical shift service. | `plugins/plugin-attendance/lib/attendance-shift-service.cjs:60`, guard `:495`, export `:1208` |

**Cutover therefore means**: for an org that has completed the W7 staging
ladder, (i) the frozen-context builder's policy inputs (shift/segments/flex/
rules/timezone) are resolved from the **group-effective policy** of the user's
effective calculation group for that work date — **whether this REPLACES the
legacy per-user resolution or LAYERS ONTO it is `OD-W7-9`, a new decision
below, not settled by this sentence** — and (ii) the frozen context records
that provenance (`calculationGroupId` non-null, a non-`legacy` selector).
Readers (§1.3) then see group-derived provenance in the same immutable
evidence chain. Nothing else in the write boundary moves.

### 1.2 The group-side inputs that already exist

| Fact | Evidence |
| --- | --- |
| W1 effective-dated calculation-group membership exists with an org/user/date no-overlap exclusion constraint and an `(id, org_id)` uniqueness guard. | `packages/core-backend/src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships.ts:42-43`, `:89` |
| The membership service exposes list/transition plus the typed overlap conflict `ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP` posture. (An earlier draft of this row named `ATTENDANCE_CALCULATION_GROUP_CONFLICT` — that string has zero hits anywhere under non-`docs/` paths on `origin/main`; the parent lock's own prose (`:350`) and the W6 lock's prose (`:91`) both use that phrase as **narrative shorthand**, never as a code identifier, and no module defines or throws it.) | `packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts:5-6` (constant declaration), `:283` (`listAttendanceCalculationGroupMemberships`), `:302` (`transitionAttendanceCalculationGroupMembership`), thrown at `:543` |
| W6 preparation (types only, **no runtime, not owner-signed-off**) landed closed unions for source labels, domains, conflict codes (incl. `CALCULATION_GROUP_MEMBERSHIP_OVERLAP`), a read-only calculation-posture mirror, and the editorRef union. | `packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts:25-96`; PR #4771 |
| W5 flex policy is a closed discriminated shape on the frozen context (`strict \| flex_required_duration`, single-segment only). | `packages/core-backend/src/attendance/w5-flex-policy.ts:27-47`, `:143`, `:222`; `packages/core-backend/src/attendance/w4c0-write-boundary-types.ts:113-122` |
| Fixed-schedule effectiveness has exactly one derivation (FSER service), declared the only source for group/employee/trace/report projections. | `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:71`, `:180` |

### 1.3 The landed W4C machinery W7 reuses (not redefines)

| Machinery | Current fact | Evidence |
| --- | --- | --- |
| Rollout state machine (w4c3a) | Org-keyed five-state machine `legacy <-> shadow <-> eligible -> authoritative <-> suspended`, `scope='synthetic_staging'`; the closed `LEGAL_TRANSITIONS` matrix (7 pairs) is the sole source of pair legality; `transitionAttendanceCalculationRolloutV1` is the ONLY rollout-state writer (module header, incl. the NIT-4 precision that `closeLegacyRollbackWindowV1` is a second writer of rollout *events*, never state); a DB trigger enforces the identical pair set as backstop. Hardening per OD-W4C-61=(a) landed in PR #4773. | `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1-21`, `:85-93`, `:1089`, `:1125`; trigger `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:1032-1058`; states `:201` |
| Write-posture gating (w4c0) | Accepted write posture is minted from rollout state ∧ env allowlist (`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`); orgs outside fall to `legacy_projection_only`. | `packages/core-backend/src/attendance/w4c0-identity.ts:76`, `:363`, `:381` |
| Zero-bypass discipline (w4c3c) | Hard zero-bypass is live: the current-tree open-debt set is asserted exactly empty (`unclaimed=0`), with a mutation leg proving a new side-door business DML fails; the P16 allowlist is exact `relPath::enclosingSymbol::table::verb`. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033`, `:1074`, `:1386`; `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` |
| Decision trace (w4c3c/w4c4) | Dual-hosted read-only decision-trace routes; W4 trace evidence is read via `readAttendanceW4TraceEvidence`; the four named read surfaces (anomaly listing, makeup-anomaly facts, open-record attribution, decision trace) each use the canonical active-current helper with a closed surface union. | `packages/core-backend/src/routes/attendance-admin.ts:1376`, `:1416`; `packages/core-backend/src/services/AttendanceDecisionTrace.ts:344-346`, `:437`, `:589`; `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:781`; `packages/core-backend/src/attendance/w4c3c-active-current.ts:56`, `:197-198` |
| Request-snapshot fingerprint freeze (w4c3b + #4780) | Calculation-affecting requests freeze payloads with a domain-separated canonical-JSON fingerprint at create/edit/terminal-bind; the W4C-5 §3 precondition is the closed **8-cell** set `(pending \| reversible) × (missing \| unsupported \| payload-stale \| reversal-incomplete)` (`ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1`), completed by PR #4780, with stored payloads re-hashed rather than trusting the stored fingerprint column. | `packages/core-backend/src/attendance/w4c3b-request-snapshots.ts:430`, `:997`, `:1096`, `:1239`, `:1368`; `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:802-823`, `:863`, `:1044` |
| Shadow ledger / calculation detail (w4c4) | Closed shadow-diff code set; `computeAttendanceW4ShadowDiff`; dual-host calculation-detail routes (admin + self, self rejects `userId` input); shadow backlog reader; expected-differences roster with a fail-closed probe (single ratified entry `correction_applied_daily_adjusted`). | `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:8-23`, `:252`, `:505`, `:593`; `packages/core-backend/src/routes/attendance-admin.ts:1479`, `:1512-1515`; `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53`, `:75-83`, `:135` |
| Outbox + scheduled-run identity (w4c2) | One transactional outbox table `attendance_result_event_outbox` (scheduled-run events insert into the same union table); the dispatcher performs DML on the outbox table only; server-minted scheduled-run identity, per-target outcomes as an append-only side table, and the #4770 sweep fairness/observability arc (durable `last_attempt_at` rotation + values-free counters) are landed (PRs #4774/#4779). | `packages/core-backend/src/attendance/w4c2-scheduled-run.ts:168-179`, `:307`, `:328-350`, `:593`, `:857`, `:922`, `:1056`; `packages/core-backend/src/attendance/w4c2-outbox-dispatcher.ts:84`, `:110-146`; `packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts:44`, `:176-182`; `packages/core-backend/src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:1-28`, `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` |
| Manual override / recompute (w4c3c) | Immutable manual overrides with closed set/unset field lists; recompute policies are the closed pair `frozen_prior \| current_policy` and append immutable calculations. | `packages/core-backend/src/attendance/w4c3c-manual-override.ts:46-56`, `:388`; `packages/core-backend/src/attendance/w4c3c-recompute.ts:31-36`, `:201` |

### 1.4 Expected-but-absent (verified honestly)

- There is **no** `context_selector` / `calculation_group_id` database column
  on the W4 tables: the W4 lock's "W4 stores `calculationGroupId=null` and
  `contextSelector='legacy'`" is implemented as fields **inside** the frozen
  context JSON payload (`w4c0-write-boundary-types.ts:126`, `:134`), not as
  dedicated columns. W7 designs against the payload shape, not a column.
- There is **no** W6 aggregate service or route at this baseline — only the
  types-only contract module, the out-of-build OpenAPI draft
  (`packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml`),
  and the unmounted shell
  (`apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue`).
  Any W7 sentence that mentions the aggregate is conditional on W6.
- There is **no** group-policy → frozen-context resolver anywhere in the tree;
  no candidate implementation exists to "migrate". W7-1 would be new code.

## 2. Scope and explicit non-goals

### 2.1 W7 delivers (all conditional on W6 sign-off + W6 runtime completion)

1. one org-scoped **group-effective policy resolution** input to the canonical
   frozen-context build path, with fail-closed winner selection (§4, §5);
2. a versioned frozen-context evolution that records group provenance without
   disturbing v1 bytes (§5, OD-W7-2);
3. the **shadow → compare → cutover** staging ladder per org, driven by the
   existing hardened rollout-transition boundary (§4, OD-W7-3);
4. failure/rollback semantics for every stage (§5);
5. decision-trace/shadow-ledger labeling of group-derived results (§4.4).

### 2.2 W7 reuses without redefining

Every §1.3 row, by construction: the rollout state machine and its single
transition writer; w4c0 posture minting; the zero-bypass inventory; the
request-snapshot 8-cell precondition; the w4c4 shadow ledger, diff codes, and
dual-host detail; the w4c2 outbox and scheduled-run identity; W1 membership
semantics and the overlap conflict posture; W5 flex shapes; the FSER single
derivation.

### 2.3 OUT (unchanged by this document)

- everything W8 (verification MD, runbook, acceptance ledger, closure input);
- closure of issue #4556 (owner-only per W4 lock §14 item 10; see the W8 plan);
- production enablement, deployment, UAT, customer data;
- any write endpoint, incl. a universal group save (parent R4, OD-4556-10);
- per-group punch-policy **enforcement** (OD-4556-9: org-inherited/read-only
  in this line);
- historical restatement (parent R3): cutover affects work dates at/after an
  org's flip; it never recalculates existing results silently;
- FSER-4 (`/effectiveness/me`) — its own gated line (#4709);
- changes to the W6 read-aggregate contract — any needed change is an
  owner-level W6 decision, and the W6 lock is now RATIFIED (W6-1 backend
  aggregate only), so that decision can only be made as a **W6 amendment**
  going forward, not a W7 side effect.

## 3. Non-negotiable red lines

Each red line carries a MECHANICAL check — a predicate a later gate can run,
not prose.

| ID | Rule | MECHANICAL check |
| --- | --- | --- |
| W7-R1 | The frozen-context builder stays singular: no second production builder and no selector spelling outside the closed union. | Structural inventory, not text matching: a repo inventory test (extend the `w4c3a-rollout-control-inventory` pattern) pins every module that *produces* a `FrozenAttendanceContextV*` value as an exported-symbol/import-graph inventory, and the write boundary asserts at persist time that the context carries a builder-minted marker (a domain-separated fingerprint only the single builder computes) — so a second builder evades no gate by spelling (double quotes, `selector: sel` via variable, spread/`Object.assign`, computed key): its rows fail the persist-time assertion. The text grep `grep -rn "selector: '" plugins packages --include='*.cjs' --include='*.ts'` (test/fixture paths excluded, resolving to the pinned set) remains a secondary tripwire only, not the gate. Adding a second builder or a novel selector string turns the inventory test or the persist-time assertion red; a mutation that mints a context outside the builder must redden the persist-time leg. |
| W7-R2 | No silent group winner (parent R2): >1 effective membership for one `org+user+work_date` at calculation time fail-closes with the typed conflict; never latest-updated/first-row/array-order. | Real-DB leg seeds two effective memberships on one date, asserts the typed conflict outcome and **zero** new rows in `attendance_record_calculations` for that target; a choose-first and a choose-latest mutation each make the leg red independently. |
| W7-R3 | Legacy byte preservation until flip: for any org not group-authoritative, every response/projection byte and every v1 frozen-context byte is unchanged. | Golden response/fingerprint literals (extend `w4c1-fingerprint-golden.test.ts` and `tests/utils/attendance-w4c2-golden-response.ts`): fixed input → fixed hash/bytes for v1 contexts, run in **each of three org postures — no W7 posture, `group_shadow`, and `group_eligible`** (the latter two are not group-authoritative yet are exactly where the new resolver runs alongside the legacy producer, i.e. where drift is most likely), asserting byte-identity in all three; any drift is a red literal mismatch, not a relational comparison. A mutation that lets the shadow path touch the served projection must redden the `group_shadow` leg specifically. |
| W7-R4 | Cutover state moves only through the hardened transition boundary: one writer, closed legal matrix, evidence manifest, no env/flag side channel that flips policy sourcing per org. | DML sweep (both query syntaxes) over the W7 diff shows zero writes to any rollout/posture table outside `w4c3a-rollout-control.ts` (or its OD-W7-3 analog); the zero-bypass collector run stays `unclaimed=0`; a probe that flips sourcing via env alone must be provably inert (posture requires state-row ∧ allowlist, `w4c0-identity.ts:363-381` pattern) — paired with a named positive control: the same probe with the state row present **must** flip sourcing, proving the probe is live rather than a no-op (an "inert" verdict without that control is indistinguishable from a probe that does nothing). |
| W7-R5 | Frozen-context evolution is versioned and closed: v2 (or the OD-W7-2 choice) validates exact-key fail-closed; v1 rows remain valid and immutable; unknown selector/schemaVersion fails closed, never maps to a default. | Calculator validator negatives: unknown selector, unknown schemaVersion, v2 shape with v1 version tag, `calculationGroupId` null/non-null mismatched with selector — each an individually red leg; a silent-fallback mutation (unknown → legacy) turns a test red. |
| W7-R6 | Policy is consumed only as frozen snapshot: after freeze, recomputation of the same calculation must not re-read live group/membership/shift config; group policy enters through the frozen context (and the OD-W7-6 snapshot choice) with a fingerprint. | Mutation legs, one per §4.1 fact family: after freezing a calculation, UPDATE (i) the W1 membership rows, (ii) the group's policy rows, and (iii) the FSER-composed schedule facts — each in its own leg — then re-read via detail/trace: stored evidence bytes unchanged in all three legs (byte-exact re-read, W4C-2 QA G4 pattern); a builder mutation that re-reads live config post-freeze makes the corresponding byte-parity leg red. |
| W7-R7 | W7 makes no writes outside the canonical W4 write boundary and adds no DML side door: every new writer is claimed in the generated DML inventory. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` hard zero-bypass legs (`:1033`, `:1386`) stay green on the W7 head with the W7 writers claimed by exact `relPath::enclosingSymbol::table::verb` entries — no prefix claims. |
| W7-R8 | Shadow is never presented as authoritative: group-derived shadow calculations are labeled as such in the ledger/trace; the legacy projection remains the served result until the org's flip. | Exact-key assertions on detail/trace responses for a group-shadow org: posture/label fields assert the shadow labeling; a mutation that serves the W7 shadow projection to the read path in a non-authoritative org turns the golden response leg red. |
| W7-R9 | This document authorizes no runtime. The W7-0 preparation PR (if the owner later authorizes one) is byte-inert: deleting its contract/fixture files leaves every existing test green. | Deletion-green run recorded in that PR; `git diff <base> HEAD -- packages plugins apps scripts .github` for THIS docs PR is empty. |
| W7-R10 | W6's own red line W6-R5 ("no calculation writer consumes the W6 aggregate") survives W7 unless the owner explicitly overrides it: W7's resolver reads persisted facts under locks, not the W6 HTTP aggregate. | **Derived domain, not a module allowlist.** *Leg 0 (completeness)*: the guard enumerates its own domain at run time — every source file under a pinned set of **roots** (`plugins/plugin-attendance/**`, `packages/core-backend/src/attendance/**`, and the W7 resolver's own directory; the root set, not a file set, is what the W7-0 contract fixes), collected by directory walk under a scannable-extension filter, then partitioned by a curated classification file into `calculation_path` / `not_calculation_path` (every non-calculation entry carrying its reason) — and asserts `unclaimed = 0`, so a file added under a root that nobody classified reds the guard by construction. **Non-empty-domain leg** (an empty read is not an absence): each pinned root must be asserted to exist and to contribute at least one file to the walked domain — **a pinned root resolving to zero files reds the guard**, because a mistyped, moved, or not-yet-created root would otherwise satisfy `unclaimed = 0` vacuously while every ban leg passes over nothing. Since the W7 resolver's directory does not exist at this baseline (§1.4), **the guard itself lands with W7-1** — the slice that creates the resolver, and therefore the first head at which every pinned root is real; W7-0 records only the root set and the reason each root is pinned ahead of the code it names, so nothing here makes W7-0 non-byte-inert (W7-R9) or leaves a red test inside it. That zero-file red is therefore a property of W7-1's gate, not a red test sitting inside W7-0. Pinning **roots** is the P16 shape; pinning **files** is the defect this replaces (an earlier draft of this row specified a hand-maintained `CALCULATION_PATH_MODULES` list, which a helper module outside the list walked straight through). *Leg (i) reference ban*, over the `calculation_path` partition: zero static `import`, zero `require`, and zero dynamic `import()` of the W6 aggregate service/route modules (a static import graph alone does not see `await import(…)`). *Leg (ii) transport ban*, over the same partition: zero `fetch`/`axios`/`request`/internal-HTTP-client call and zero occurrence of the aggregate's route string — matched against the route literal exactly as the repo writes it (`/api/attendance/groups/{groupId}/effective-policy`, `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml:25`, plus the `:groupId` express spelling), never via a home-grown path normalizer — because a resolver that does `await fetch('/api/attendance/groups/:groupId/effective-policy')` imports nothing yet violates the rule. **Positive control = the bypass this criterion exists to catch**, not a probe that merely confirms the criterion: create a **new, unclassified** helper file under a pinned root containing `await fetch('/api/attendance/groups/:groupId/effective-policy')` and import it from a `calculation_path` module; Leg 0 must red (`unclaimed ≠ 0`) with the helper unclassified, and Leg (ii) must red once the same helper is classified `calculation_path` — one probe reddening both legs is what proves the domain gap is closed. Verify the probe's anchor was actually hit (the probe file really entered the scanned domain; an unhit probe and a dead gate look identical), and restore from a file backup (`cp`), never `git checkout -- <file>`. **Correct statement of the P16 analogy** — an earlier draft of this row called it "the same exact-allowlist shape as the P16 inventory", which is inverted: P16's scan domain is **derived** (`buildRawCensus` walks `discoverRuntimeRoots` → `listAllFiles` → `isScannablePath` → `scanFileForDmlSites`, `scripts/attendance/w4c0-dml-inventory/collector.cjs:53, 104, 574, 807-823`) and its completeness leg is `assert.deepEqual(unclaimed, [], 'hard zero-bypass requires unclaimed=0')` (`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1045, 1074`); the exact allowlist (`scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74`) is P16's **claim** side and is never its scan domain. That correction also makes this row consistent with its sibling: the W8 plan §3.3 names the hardcoded-allowlist form as "the mechanism that let L8 stay invisible" and prescribes glob-derived completeness for the same reason. **What this criterion does not catch** (stated, not papered over): (1) a file classified `not_calculation_path` — deliberately or by mistake — leaves the ban legs inapplicable to it while Leg 0 stays green, because the classification file is the **claim** side and a `not_calculation_path` entry is a reviewable assertion, not a proof (P16 has the identical property; the mitigation is the same one P16 relies on — the classification diff is reviewed, and each `not_calculation_path` entry is spot-checked for non-reachability from the frozen-context build path — not a mechanical guarantee); (2) a call originating in a module outside the pinned roots — Leg 0 narrows this to "someone added a directory nobody pinned as a root", itself a reviewable event; (3) a route string assembled from fragments at run time; (4) any consumption path that is neither a module reference nor an HTTP call to that route. (Conditional on OD-W7-1; if the owner chooses (b) there, this row is replaced by an owner-signed W6 decision — the W6 lock is already RATIFIED (W6-1 backend aggregate only), so that decision can only be made as a W6 amendment.) |

## 4. Cutover mechanics (draft, all OPEN)

### 4.1 Resolution input (conditional on OD-W6-2/OD-W6-6 outcomes)

A new in-transaction resolver — the OD-W7-1 decision — determines, for
`(org, user, workDate)` in a W7-postured org:

1. the user's effective calculation-group membership (W1 tables; the
   no-overlap constraint is a *storage* guard — runtime still re-checks and
   fail-closes per W7-R2, because effective-dating means storage-level
   validity is date-dependent);
2. the group's effective policy for that date (schedule strategy, shift and
   segments, W5 flex, rules/timezone posture) from the same persisted facts
   the (future, conditional) W6 aggregate reads — **not** from the W6 HTTP
   surface (W7-R10);
3. a fail-closed outcome when membership is absent, ambiguous (W7-R2), or the
   group's policy is incomplete for calculation.

### 4.2 Staging ladder (per-org, shadow → compare → cutover)

Conditional on OD-W7-3 for the exact state carrier; semantics are fixed here.

**The rollout-control boundary alone does not resolve posture — this is a
two-part condition, not a single source of truth.** The W4 precedent
(`resolveSegmentCalculationPosture`,
`packages/core-backend/src/attendance/w4c0-identity.ts:454`) reads a
*persisted row* from `attendance_calculation_rollout_state` and ONLY advances
past `legacy` when that row exists, is not `suspended`, AND the org passes an
exact-match allowlist/scope check (`isOrgExactlyAllowlisted`, same file,
`:471-482`) — an org with a `shadow`/`eligible`/`authoritative` row but no
allowlist entry, or an allowlist entry but no row, still resolves to
`legacy`. The rollout-control **transition boundary** (single writer, closed
matrix — W7-R4) governs how that row gets written; it says nothing about how
posture is *read*. Whatever carrier OD-W7-3 selects for W7's own posture
must clone **both** halves — the write-side transition boundary AND a
`resolveSegmentCalculationPosture`-shaped read-side function requiring row ∧
allowlist/scope — not the write-side discipline alone. A W7 implementation
that treats "a legal transition landed" as sufficient to advertise a new
posture, without an analogous read-side allowlist/scope gate, reproduces the
exact class of bug the W4C-0 persisted-row-plus-allowlist design exists to
prevent.

- **group_shadow**: the legacy path remains the authoritative producer byte
  for byte (W7-R3). Alongside it, the W7 resolver produces a group-derived
  frozen context and a shadow calculation, recorded through the existing
  shadow machinery with the existing closed diff codes
  (`context_mismatch`/`input_mismatch`/etc.). A W7 expected-differences
  roster (same pattern as `ATTENDANCE_W4C2_EXPECTED_SHADOW_DIFFERENCES_V1`,
  fail-closed probe) enumerates every anticipated legacy-vs-group divergence
  before soak; anything off-roster is a real diff.
- **group_eligible**: entry requires the compare window's exit criteria
  (below) — zero critical diffs (work-date/context/input/review classes),
  zero unresolved reviews, the 8-cell request-snapshot precondition clean,
  and the W4C-5 transition-safety predicate style applied to W7's own
  predicates (counts returned by the command, no caller-supplied
  `ready=true`).
- **group_authoritative**: the org's frozen contexts are built from the
  group-effective source; provenance recorded per OD-W7-2. Per parent §9.8
  this is named-org opt-in, synthetic staging first.
- **suspended / rollback**: see §5.

### 4.3 Soak

Per parent §9.8, W7 cutover has its own synthetic staging soak. The W8 plan
§4 carries the operational summary of entry/exit criteria (this document does
not duplicate numbers), but that summary does not govern: the governing texts
are the ratified W4 lock §12.8 (`:3000-3031`) and the W4C-5 amendment §3-§4
(`:84-128`) verbatim, and where the W8 §4 summary and a ratified lock differ
the ratified lock wins (see the W8 plan §4's own precedence clause). W7's
contribution is the expected-differences roster (§4.2) and per-stage residue
definitions.

### 4.4 Read-side labeling

The w4c4 detail/trace surfaces already carry posture/provenance concepts
(`projectionOwner=legacy_untracked`, `posture=undeterminable`, shadow diff
codes). W7 extends the *values* of existing closed enums (a contract
amendment, not a silent extension) so that group-derived evidence is
distinguishable from legacy-derived evidence in the same immutable chain.
Two distinct enum families are involved, with different owners — stated here
to avoid a spelling-ownership ambiguity: (i) the W6-owned source-label union
(OD-W6-3): W7 adopts whatever spellings W6 ratifies and mints none of its
own (§6 row 6); (ii) the W7-owned provenance values on the existing W4 enums
(detail `projectionOwner`, trace source-kind): their exact strings are
OD-W7-5, fixed at W7-0.

## 5. Failure and rollback semantics

1. **Per-target failure**: a user whose group resolution fail-closes (W7-R2 or
   incomplete policy) becomes a recorded per-target outcome — reusing the
   append-only per-target outcome pattern
   (`attendance_scheduled_run_target_outcomes`,
   `w4c2-scheduled-run.ts:857`; taxonomy per
   `attendance-issue-4556-w4c2-per-target-failure-taxonomy-amendment-20260729.md`)
   — never an org-wide wedge and never a silently-substituted legacy result in
   a group-authoritative org.
2. **Stage rollback**: group_shadow → off and group_eligible → group_shadow
   follow the legal-matrix pattern (each pair explicit, everything else
   rejected before DML, DB-trigger backstop mirrored — the
   `w4c3a-rollout-control.ts:85-93` + migration-trigger discipline).
3. **Authoritative rollback**: group_authoritative → suspended preserves
   owners/pointers and changes no operation/source/result/pointer/job rows
   (the W4C-5 suspend contract, amendment §3); resume requires the offline
   replay artifact with zero critical/unresolved diffs. Whether a suspended
   group-authoritative org may fall back to the *legacy* source (a
   direction the W4 matrix does not have) is OD-W7-4 — it is a policy
   question with historical-explainability consequences, not a mechanical
   one.
4. **No restatement on rollback** (parent R3) — **corrected this round; the
   previous wording was contradicted by landed code, not merely stale.**
   Already-frozen calculations and their evidence stay immutable
   (calculations are append-only; W7-R6 mechanical check applies) — that
   half is TRUE and unchanged. The other half — "rolling an org back changes
   the producer for **future** work dates only" — is **false as stated**:
   `w4c3c-recompute.ts:1-8` (header) and `:165-176` (the `current_policy`
   input contract) show `policy=current_policy` builds a **fresh** frozen
   context, via `buildW4ShadowFrozenContextV1`, at recompute time for an
   **arbitrary (including past) work date** — recompute is not restricted to
   future dates. Reachability is proven, not assumed: a live route accepts
   it at `plugins/plugin-attendance/index.cjs:30685`
   (`policy: z.enum(['frozen_prior', 'current_policy']).default('frozen_prior')`)
   with the adapter building that fresh context at `~L35284`
   (`buildW4ShadowFrozenContextV1` call inside the `current_policy` branch).
   **Failure scenario**: org X is group-authoritative; work date D3 is frozen
   from the group-effective source; X is rolled back (to `group_shadow` or
   `legacy`, per whichever OD-W7-3/OD-W7-4 shape lands); an operator later
   runs `current_policy` recompute on D3 → a **second** calculation for D3,
   built by whatever producer is current at recompute time (potentially the
   legacy producer) — i.e. **two producers for one org+work-date**, exactly
   the ambiguity `OD-W7-7(b)` was rejected to avoid. This is also
   **self-inconsistent with `OD-W7-7(a)` as already written** (§7 below),
   which itself lists recompute `current_policy` as an entrypoint that "flips
   atomically with the org's posture" — meaning OD-W7-7(a)'s own text
   anticipates `current_policy` tracking posture, which is precisely the
   behavior this item's old wording denied existed. The disposition — refuse
   post-rollback `current_policy` recompute for work dates frozen under a
   superseded source, vs. record the producer on the calculation and make
   recompute honor the frozen source — is **`OD-W7-10`** (new, §7 below); this
   item states the corrected fact and defers the choice.
5. **Evidence**: every W7 transition inserts an event with the evidence
   manifest hash and closed reference keys, exactly the
   `requireEvidenceReferences` discipline (`w4c3a-rollout-control.ts:114-163`).

## 6. Explicit W6-dependence markers

Every W7 dependence on an undecided W6 outcome, stated once, here:

| W7 element | Depends on | Conditionality |
| --- | --- | --- |
| Group-policy domain grouping used in resolution completeness checks | OD-W6-4 (domain/conflict closed inventory) | W7 adopts whatever closed inventory the owner fixes for W6; if W6 narrows it, W7's "policy incomplete" predicate narrows identically. |
| `preview_only` labeling vs. calculability of segments/flex | OD-W6-6 (preview_only derivation) | **RATIFIED as option (a)** — W6 lock §9: single-segment `strict` is `effective` under any posture; multi-segment and `flex_required_duration` are `preview_only` unless posture is `authoritative` **and** `SEGMENT_CALCULATION_IMPLEMENTED` is true. W7's eligibility predicate must be consistent with this ratified derivation; a conflict now requires a **W6 amendment** to resolve (the ratify-time branch is no longer open — ratification already happened). |
| Conflict surfacing of membership overlap in the workspace | OD-W6-4 / W6 §4.4 | W7 only *emits* the fail-closed runtime conflict (W7-R2); the display inventory is W6's. |
| Whether W7's resolver may share code with the W6 aggregate's readers | OD-W6-2 (FSER composition) and W6-R4 (single FSER derivation) | W7 must compose the same FSER service rather than re-derive, whatever W6 decides about embedding. |
| The aggregate as calculation input | W6-R5 | Preserved by default (W7-R10); overriding it is an owner-level W6 decision, and the W6 lock is now RATIFIED (W6-1 backend aggregate only), so overriding W6-R5 can only be made as a **W6 amendment**, not a W7 choice. |
| Label spellings reused in read-side labeling | OD-W6-3 | For the W6-owned source-label union, W7 §4.4 adopts the ratified spellings and mints none of its own. The W7-owned provenance values on the W4 detail/trace enums are a different enum family, owned by OD-W7-5 (strings fixed at W7-0) — see §4.4. |
| W6 runtime existing at all | OD-W6-0 + W6 completion gates | If W6 completion is not reached, W7 as specified here is **not startable**; §8's sequence makes this a hard precondition. **Status as of 2026-08-10** (§0 update): OD-W6-0 is **RATIFIED as adopt** — PR 4821 MERGED `ecf77d2433596bbdd8b67c312a37178dbc97f715`, and the W6 lock's own header on `origin/main` reads RATIFIED (W6-1 backend aggregate only) — so the "declines" branch is now foreclosed for the W6-1 scope specifically, not merely recorded pending a merge. That still does not satisfy this row: the row requires W6 **completion gates**, and the **second** conjunct is untouched — no W6 runtime is on `main` (`git diff` over the five W6-relevant paths between the pinned baseline and current main is empty), and only the W6-1 backend slice is prospectively authorized (PR 4814, Draft/HOLD, unmerged), which does not reach the four-label workflow item 8 names. This row stays conditional. |

## 7. Decision points (owner menu, all OPEN)

| ID | Question | Options (recommended first) and consequences |
| --- | --- | --- |
| OD-W7-1 | Source of group policy for calculation | **(a)** A dedicated in-transaction resolver reading persisted facts (W1 membership, group row, FSER-composed schedule facts) under the existing lock order; W6-R5 stays intact; the W6 aggregate remains display-only. (b) Consume the W6 aggregate service in-process — rejected by default: violates W6-R5, couples display labeling to accounting, and makes the aggregate's values-free posture a calculation constraint. |
| OD-W7-2 | Frozen-context evolution | **(a)** `schemaVersion: 2` with a discriminated selector (`'legacy' \| 'group_effective'`); `calculationGroupId` non-null iff `group_effective`; v1 stays valid/immutable with untouched golden bytes; the calculator accepts exactly {v1-legacy, v2-either} and fail-closes on all else. (b) Widen v1 in place — rejected, for the value-domain reason: W7 must widen the value domain of two existing **mandatory** keys (`selector` beyond `'legacy'`, `calculationGroupId` beyond `null`), which destroys `schemaVersion` as a discriminator and silently invalidates every existing v1 consumer's `selector === 'legacy'` assumption. Honesty note: the fingerprint argument does **not** carry — this repo's W5 precedent already widened v1 in place with an *optional* key (`flexPolicy?`, `w4c0-write-boundary-types.ts:147-151`; validator accepts the legacy exact key set or the same set plus optional `flexPolicy`, `w4c1-segment-calculator.ts:331-345`) and the v1 golden literals did not move (`w4c1-fingerprint-golden.test.ts` still pins the no-`flexPolicy` context to the unchanged `GOLDEN_STORAGE_FINGERPRINT`). An optional-key widening leaves old bytes alone; a mandatory-value-domain widening is a different operation, and that — not fingerprint movement — is why (b) is rejected. |
| OD-W7-3 | Cutover state carrier | **(a)** A second org-keyed state machine for context-source (`off <-> group_shadow <-> group_eligible -> group_authoritative <-> suspended`) in its own table, cloning the hardened-boundary pattern (single writer, closed matrix, trigger backstop, evidence manifest) **and** a `resolveSegmentCalculationPosture`-shaped read-side resolver (persisted row ∧ allowlist/scope check — §4.2's two-part-condition note; the transition-writer discipline alone does not resolve posture); keeps the W4 machine's meaning ("is segment calculation authoritative") untouched. (b) Extend the existing five-state machine with combined states — rejected: breaks the ratified closed matrix, its DB trigger, and every landed test that pins the 7 legal pairs. Consequence of (a): an org has two postures, each independently gated by its own row-plus-allowlist read; the legal combinations table is part of the W7-0 contract. |
| OD-W7-4 | Suspended-from-group fallback direction | **(a)** No legacy fallback from `group_authoritative`; suspend/resume only, mirroring W4's `authoritative <-> suspended` asymmetry — history stays explainable with one producer per work date. (b) Allow an explicit owner-driven fall-back-to-legacy transition with its own evidence manifest — larger matrix, more drills, only justified if soak shows group-authoritative is not operationally recoverable. |
| OD-W7-5 | Read-side provenance spellings | **(a)** Extend the existing closed enums by amendment (detail `projectionOwner`/trace source-kind gain group-provenance values; exact strings fixed at W7-0). (b) A parallel provenance field — rejected: second spelling of the same fact. |
| OD-W7-6 | Group-policy snapshot form | **(a)** Freeze group policy INTO the frozen context (plus its fingerprint), no second snapshot table; the context is already the immutable policy carrier (`w4c0-write-boundary-types.ts:124`). (b) A separate group-policy snapshot table keyed by group/date — needed only if per-group dedup matters for storage; adds a join to every immutability proof. |
| OD-W7-7 | Which entrypoints cut over together | **(a)** All source entrypoints (live punch, scheduled, import, approval-driven, recompute `current_policy`) flip atomically with the org's posture — one producer per org per work date. (b) Phased per-entrypoint cutover — rejected by default: two producers in one org/date makes evidence and parity claims ambiguous (the W4C-3a lesson: same canonical row, separately snapshotted projections, was already the maximum tolerable split). |
| OD-W7-8 | First-org scope | **(a)** The named synthetic staging org only, reusing the W4C-5 allowlist discipline (exact org, `scope='synthetic_staging'`, no wildcard); real named-org opt-in is a separate later owner decision per parent §9.8. (b) Two synthetic staging orgs — the named one plus a second synthetic org with a deliberately different group topology (multi-group, overlapping effective dates at the boundary), both under the same exact-allowlist discipline, zero customer data — buys cross-org isolation evidence before any real named-org decision, at the cost of a second full evidence chain and soak window. Real named-org opt-in remains a separate later owner decision per parent §9.8 under either option. |
| OD-W7-9 | **New this round (§1.1 update).** Replace vs. layer — the single most load-bearing choice of the cutover, previously buried in a §1.1 parenthetical ("instead of (or layered onto) the legacy per-user resolution") and absent from this menu entirely, even though it is one of the two facts §1.1's own next sentence depends on. **No option is recommended-first: these are two different systems with different W7-R1/W7-R3 exposure, and the choice is the owner's, not a default this document offers.** The code exposes the chokepoint: `buildW4ShadowFrozenContextV1` (`plugins/plugin-attendance/index.cjs:22625` def, `~L22746` reads `shift.timezone`, `~L22751` reads `shift.rounding_minutes`) takes `shiftId` and reads policy fields off the **shift row itself** — there is no second, group-aware builder and no branch inside this one. **(REPLACE)** A new group-effective resolver supplies the shift/segment/timezone/rounding inputs to the *existing* `buildW4ShadowFrozenContextV1` in place of the legacy per-user resolvers (`resolveW4LiveCandidateInTransactionV1` / `resolveW4ScheduledCandidateInTransactionV1`, §1.1); the legacy resolvers and the single production builder are both untouched in shape, only their upstream caller for group-authoritative orgs changes. Under REPLACE, W7-R3's parity legs mean exactly what W7-R3 says: for a non-group-authoritative org, the legacy resolvers still run and the builder still receives their output unchanged, so "every response/projection byte and every v1 frozen-context byte is unchanged" is a claim about an **untouched code path**. The exposed slice boundary is upstream of the builder — a new resolver module, no change to `buildW4ShadowFrozenContextV1` itself. **(LAYER-ONTO)** The single production builder (`buildW4ShadowFrozenContextV1`) itself gains group-aware inputs — its own `shift`/`timezone`/`rounding_minutes` reads (`~L22746`, `~L22751`) become conditional on posture, sourced from the group's effective policy instead of the shift row when an org is group-authoritative. Under LAYER-ONTO, W7-R3's parity legs assert something **different and possibly unsatisfiable as currently worded**: the builder is no longer an untouched code path for *any* org once the change lands — its own body now branches on posture — so "every v1 frozen-context byte is unchanged" for a non-group-authoritative org depends on that branch's `legacy` arm reproducing the pre-change code exactly, a runtime property to be proven per release rather than a structural guarantee from an unmodified function. The exposed slice boundary is *inside* the single production builder — the one module W7-R1 pins as singular. Consequence for OD-W7-1 (§7, resolution-input source): both branches are compatible with OD-W7-1(a) (a dedicated in-transaction resolver reading persisted facts); REPLACE makes that resolver a **new caller** of the existing builder, LAYER-ONTO makes it an **input provider consulted from inside** the existing builder — different files touched, different W7-1 slice boundary, same OD-W7-1(a) posture-source discipline either way. |
| OD-W7-10 | **New this round (§5 item 4).** Disposition of post-rollback `current_policy` recompute for a work date frozen under a superseded (now-rolled-back) group-effective source — see the §5 item 4 correction above; this decision is what that correction's second sentence defers to, not resolved by the correction itself. **No option is recommended-first.** **(a)** Refuse `current_policy` recompute, at the route/adapter layer, for any work date whose existing frozen calculation's producer/source differs from the org's *current* rollout state — requires recording which producer built each calculation (a new field or a derivable equivalent) and a new fail-closed check in the recompute path (`plugins/plugin-attendance/index.cjs:30685` route, `~L35284` adapter) before `buildW4ShadowFrozenContextV1` is called; preserves "one producer per org+work-date" (the invariant OD-W7-7(a) already committed to) at the cost of a new refusal surface and its own negative-path test. **(b)** Record the producer/source on the calculation at freeze time (extending the frozen-context or evidence-manifest shape) and make `current_policy` recompute **honor the frozen source** rather than always resolving current policy — i.e., `current_policy` for a work date frozen under a superseded group source recomputes against *that superseded source*, not today's policy; keeps the recompute route unconditionally available (no new 4xx surface) at the cost of redefining what "current_policy" means for such a record, which needs its own naming/labeling so it is not confused with true current-policy recompute for a never-group-authoritative work date. Either option requires `w4c3c-recompute.ts` and the route/adapter to change; neither is free, and OD-W7-7(a)'s "one producer per work date" claim is **false today** for this path regardless of which option the owner later picks (§5 item 4). |

## 8. Landing sequence (conditional skeleton)

1. **Precondition (hard)**: owner signs off the W6 lock at its exact merged
   SHA and answers OD-W6-1..9; W6 runtime slices complete their own gates.
   (**Status as of 2026-08-10** — see the §0 update: the first clause is now
   MET — PR 4821 MERGED `ecf77d2433596bbdd8b67c312a37178dbc97f715`, ratifying
   merged SHA `2967da018ceea41b91098e14d4c15a57236eb5f8` and answering
   OD-W6-1..9 option (a); the authorization it carries reaches only the W6-1
   backend slice. The second clause — W6 runtime slices completing their own
   gates — remains unmet: PR 4814 (the W6-1 slice) is OPEN/Draft/unmerged, and
   no W6 runtime exists on `main`. So this precondition as a whole is still
   unmet and step 2 below is not reached.)
2. Owner reviews this draft, answers OD-W7-1..10, and signs off the exact
   merged SHA of this document (docs may be amended until then).
3. W7-0 preparation PR (contract/fixtures only, byte-inert, Draft/HOLD;
   separate owner authorization — this document does not grant it).
4. W7-1 resolver + frozen-context v2 (runtime, own gate).
5. W7-2 group_shadow + compare machinery + expected-differences roster.
6. W7-3 cutover transitions + drills (synthetic staging only).
7. W7-4 verification MD feeding W8.
8. Stop. Soak execution, named-org opt-in, production enablement, and issue
   #4556 closure each require separate owner authorization; no gate in this
   document auto-triggers anything.

## 9. Owner decision

`OD-W7-0` (adopt this lock) and `OD-W7-1..10` are **OPEN** (`OD-W7-9` and
`OD-W7-10` added this round — see §7 — and are no less load-bearing than
`OD-W7-1..8`: `OD-W7-9` gates which code path W7-1 even touches, and
`OD-W7-10` gates whether the rollback invariant in §5 item 4 is enforceable
as written). This document carries no default: absent owner sign-off — and
absent the W6 preconditions in §8 item 1 — W7 remains a paper plan and no W7
runtime work is authorized.

## 10. Provenance

All of the following were read at
`origin/main@4e6a35d99ea64291dd0588bbf5daa74dccec385b` (full `git rev-parse`
output, not abbreviated). Line numbers are from that tree.

Code:

- `packages/core-backend/src/attendance/w4c0-write-boundary-types.ts:113-122, 124-152` (flex shape; frozen context; `:126` selector literal; `:134` calculationGroupId)
- `packages/core-backend/src/attendance/w4c1-segment-calculator.ts:304-319, 335-363` (closed keys; validator; `:350/:351/:358`)
- `packages/core-backend/src/attendance/w4c3a-canonical-import-kernel.ts:162-173`
- `plugins/plugin-attendance/index.cjs:22593-22620` (per-user resolvers), `:22625` (builder), `:22740-22750` (context literal), `:24510, :24721, :28775, :29365, :35338` (call sites; `:35338` corrects the earlier `:35286`, a comment anchor)
- `plugins/plugin-attendance/lib/attendance-shift-service.cjs:60, :495, :1208` (`SEGMENT_CALCULATION_IMPLEMENTED`)
- `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:71, :180`
- `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1-21, 85-93, 114-163, 802-823, 863, 1044, 1089, 1125`
- `packages/core-backend/src/attendance/w4c0-identity.ts:76, 363, 381`
- `packages/core-backend/src/attendance/w4c3b-request-snapshots.ts:135, 430, 997, 1096, 1239, 1368`
- `packages/core-backend/src/attendance/w4c3c-active-current.ts:15-18, 56, 77, 152, 172, 197-198`
- `packages/core-backend/src/attendance/w4c3c-manual-override.ts:46-56, 388`
- `packages/core-backend/src/attendance/w4c3c-recompute.ts:31-36, 201`
- `packages/core-backend/src/attendance/w4c2-scheduled-run.ts:168-179, 307, 328-350, 593, 857, 922, 1056`
- `packages/core-backend/src/attendance/w4c2-outbox-dispatcher.ts:15, 84, 110-146`
- `packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts:44, 176-182`
- `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53, 75-83, 135`
- `packages/core-backend/src/attendance/w5-flex-policy.ts:27-47, 143, 222`
- `packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts:25-96`
- `packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts:5, 283, 302`
- `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:8-23, 252, 505, 593, 781`
- `packages/core-backend/src/services/AttendanceDecisionTrace.ts:344-346, 437, 589`
- `packages/core-backend/src/routes/attendance-admin.ts:1376, 1416, 1479, 1512-1515`
- `packages/core-backend/src/index.ts:151, 2152`; `packages/core-backend/src/types/plugin.ts:1182-1188`
- `packages/core-backend/src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships.ts:42-43, 89`
- `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:201, 693-694, 1032-1058`
- `packages/core-backend/src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` (existence/purpose)
- `packages/core-backend/src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:1-28`
- `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1045, 1074, 1386` (`:1045`/`:1074` are the two `assert.deepEqual(unclaimed, [], …)` completeness legs cited by W7-R10)
- `scripts/attendance/w4c0-dml-inventory/collector.cjs:53, 104, 574, 807-823` (P16's **derived** scan domain: `isScannablePath`, `discoverRuntimeRoots`, `scanFileForDmlSites`, `buildRawCensus`'s roots→`listAllFiles` walk — read at the pinned baseline and re-read at the current rebase base `origin/main@5c3146acbc81b655e62bee9249b68eaec4e6e4c6`; the file's blob hash is identical at both, so the line anchors hold by construction rather than by re-reading)
- `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` (the exact P16 allowlist — the **claim** side, not the scan domain)
- `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml:25` (the aggregate route literal `/api/attendance/groups/{groupId}/effective-policy` W7-R10 leg (ii) matches against)
- `packages/core-backend/src/attendance/__tests__/w4c1-fingerprint-golden.test.ts:1-13`; `packages/core-backend/tests/utils/attendance-w4c2-golden-response.ts`; `packages/core-backend/tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts` (existence/role)
- `apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue` (existence only — W6-0 prep; the W6 OpenAPI draft is cited with its route anchor above)

Documents:

- parent lock `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md:179-233` (R1-R9; R2 `:186`, R3 `:192`, R4 `:198`, R8 `:221`), `:627-638` (OD-4556-1..12), `:731-762` (§9.7-9.9), `:764-777` (§10)
- W4 lock `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:155-168` (§2.3), `:2002-2016` (§9), `:2334-2403` (§10.1-10.3), `:3000-3031` (§12.8), `:3090-3104` (§14; item 10 at `:3103-3104`), `:3106+` (§15)
- `docs/development/attendance-issue-4556-w4-remaining-slice-plan-20260726.md:103-125` (§5-§6)
- `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` (whole; §1 matrix, §3 predicates, §4 manifest, `OD-W4C-61`)
- `docs/development/attendance-issue-4556-w4c2-per-target-failure-taxonomy-amendment-20260729.md` (existence/role)
- W6 lock `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md` (whole; §2.3 `:89-97`, W6-R4/R5 `:106-107`, OD-W6-1..9 `:234-246`)
- `docs/development/attendance-4709-fser4-member-projection-contract-amendment-20260804.md:136-183` (§3-§4)

GitHub state, **re-queried 2026-08-10 against current
`origin/main@d78b27d37c96b66cd8d898dc6b8b17e2a5f294a5`** (this branch's own
base is the older `5c3146acbc81b655e62bee9249b68eaec4e6e4c6`; main has moved
ahead of it and every fact below is checked against the newer tip, not the
branch's stale base — see the standing house rule against verifying against a
stale base). The 2026-08-08 round's line this replaces listed PRs 4805/4821 as
OPEN/unmerged; both have since merged, so the line is superseded rather than
re-dated:

- PRs MERGED: #4771 (W6 prep, merge commit
  `2967da018ceea41b91098e14d4c15a57236eb5f8`); #4772 (FSER-4 §2 member-safe
  `/me` projection); #4773 (OD-W4C-61=(a) hardening); #4774/#4779 (#4770 arc);
  #4780 (#4775 8-cell); #4799 (`51c3d8720789476efa15f6b99b6dc5f51df4743b`, the
  issue-4791 scratch-DB teardown fix); **4821** (durable W6 RATIFY record,
  merge commit `ecf77d2433596bbdd8b67c312a37178dbc97f715`, merged
  2026-08-08T10:41:37Z — see the §0 update); **4805** (the W8 plan's former
  L8 CI-wiring precondition, merge commit
  `4c28467c54f376ad5a68718d3dbe6ad50c76a917`, merged 2026-08-10T06:59:23Z —
  see the W8 plan §5 row L8, now landed).
- Issues OPEN (re-checked 2026-08-10): #4556, #4629, #4709, #4770, #4775,
  #4792.
- Issues CLOSED: **4791** (57P01 teardown flake), CLOSED COMPLETED
  2026-08-07T15:44:55Z, and its rollup **4796**, closed 2026-08-07T15:45:30Z
  on the same evidence. The W8 plan's OD-W8-3 carries the full record; the
  criterion was the `scratchDrain=` line reporting `CLEAN` on main's required
  gate, not a green run.
- PRs OPEN / unmerged, named for provenance only and authorized by nothing
  here: **4814** (the W6-1 backend slice itself, Draft, head
  `4cc0122883846900a1325cdacd5eda0355d77215`, re-verified 2026-08-10 —
  this is the one PR whose merge would actually put W6 runtime on `main`);
  **4839** (Draft operator CLI for the rollout-transition writer named at
  `w4c3a-rollout-control.ts:1125` — the W8 plan §5 ledger row L11 records that
  landing this PR removes the "no production caller" gap it documents) —
  naming either authorizes neither.
