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
**PROPOSED / runtime HOLD** at this baseline (its preparation PR #4771 merged
contract types, an out-of-build OpenAPI draft, fixtures, and an unmounted UI
shell; no W6 runtime exists, and OD-W6-0..9 are OPEN). This document therefore
does **not** treat any W6 semantic as decided. Section 6 lists every
dependence on a W6 outcome explicitly.

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
effective calculation group for that work date instead of (or layered onto)
the legacy per-user resolution, and (ii) the frozen context records that
provenance (`calculationGroupId` non-null, a non-`legacy` selector). Readers
(§1.3) then see group-derived provenance in the same immutable evidence chain.
Nothing else in the write boundary moves.

### 1.2 The group-side inputs that already exist

| Fact | Evidence |
| --- | --- |
| W1 effective-dated calculation-group membership exists with an org/user/date no-overlap exclusion constraint and an `(id, org_id)` uniqueness guard. | `packages/core-backend/src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships.ts:42-43`, `:89` |
| The membership service exposes list/transition plus the typed overlap conflict `ATTENDANCE_CALCULATION_GROUP_CONFLICT` posture. | `packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts:5`, `:283`, `:302` |
| W6 preparation (types only, **no runtime, not owner-signed-off**) landed closed unions for source labels, domains, conflict codes (incl. `CALCULATION_GROUP_MEMBERSHIP_OVERLAP`), a read-only calculation-posture mirror, and the editorRef union. | `packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts:25-96`; PR #4771 |
| W5 flex policy is a closed discriminated shape on the frozen context (`strict | flex_required_duration`, single-segment only). | `packages/core-backend/src/attendance/w5-flex-policy.ts:27-47`, `:143`, `:222`; `packages/core-backend/src/attendance/w4c0-write-boundary-types.ts:113-122` |
| Fixed-schedule effectiveness has exactly one derivation (FSER service), declared the only source for group/employee/trace/report projections. | `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs:71`, `:180` |

### 1.3 The landed W4C machinery W7 reuses (not redefines)

| Machinery | Current fact | Evidence |
| --- | --- | --- |
| Rollout state machine (w4c3a) | Org-keyed five-state machine `legacy <-> shadow <-> eligible -> authoritative <-> suspended`, `scope='synthetic_staging'`; the closed `LEGAL_TRANSITIONS` matrix (7 pairs) is the sole source of pair legality; `transitionAttendanceCalculationRolloutV1` is the ONLY rollout-state writer (module header, incl. the NIT-4 precision that `closeLegacyRollbackWindowV1` is a second writer of rollout *events*, never state); a DB trigger enforces the identical pair set as backstop. Hardening per OD-W4C-61=(a) landed in PR #4773. | `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1-21`, `:85-93`, `:1089`, `:1125`; trigger `packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:1032-1058`; states `:201` |
| Write-posture gating (w4c0) | Accepted write posture is minted from rollout state ∧ env allowlist (`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`); orgs outside fall to `legacy_projection_only`. | `packages/core-backend/src/attendance/w4c0-identity.ts:76`, `:363`, `:381` |
| Zero-bypass discipline (w4c3c) | Hard zero-bypass is live: the current-tree open-debt set is asserted exactly empty (`unclaimed=0`), with a mutation leg proving a new side-door business DML fails; the P16 allowlist is exact `relPath::enclosingSymbol::table::verb`. | `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033`, `:1074`, `:1386`; `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74` |
| Decision trace (w4c3c/w4c4) | Dual-hosted read-only decision-trace routes; W4 trace evidence is read via `readAttendanceW4TraceEvidence`; the four named read surfaces (anomaly listing, makeup-anomaly facts, open-record attribution, decision trace) each use the canonical active-current helper with a closed surface union. | `packages/core-backend/src/routes/attendance-admin.ts:1376`, `:1416`; `packages/core-backend/src/services/AttendanceDecisionTrace.ts:344-346`, `:437`, `:589`; `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:781`; `packages/core-backend/src/attendance/w4c3c-active-current.ts:56`, `:197-198` |
| Request-snapshot fingerprint freeze (w4c3b + #4780) | Calculation-affecting requests freeze payloads with a domain-separated canonical-JSON fingerprint at create/edit/terminal-bind; the W4C-5 §3 precondition is the closed **8-cell** set `(pending | reversible) × (missing | unsupported | payload-stale | reversal-incomplete)` (`ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1`), completed by PR #4780, with stored payloads re-hashed rather than trusting the stored fingerprint column. | `packages/core-backend/src/attendance/w4c3b-request-snapshots.ts:430`, `:997`, `:1096`, `:1239`, `:1368`; `packages/core-backend/src/attendance/w4c3a-rollout-control.ts:802-823`, `:863`, `:1044` |
| Shadow ledger / calculation detail (w4c4) | Closed shadow-diff code set; `computeAttendanceW4ShadowDiff`; dual-host calculation-detail routes (admin + self, self rejects `userId` input); shadow backlog reader; expected-differences roster with a fail-closed probe (single ratified entry `correction_applied_daily_adjusted`). | `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:8-23`, `:252`, `:505`, `:593`; `packages/core-backend/src/routes/attendance-admin.ts:1479`, `:1512-1515`; `packages/core-backend/src/attendance/w4c2-shadow-expected-differences.ts:39-53`, `:75-83`, `:135` |
| Outbox + scheduled-run identity (w4c2) | One transactional outbox table `attendance_result_event_outbox` (scheduled-run events insert into the same union table); the dispatcher performs DML on the outbox table only; server-minted scheduled-run identity, per-target outcomes as an append-only side table, and the #4770 sweep fairness/observability arc (durable `last_attempt_at` rotation + values-free counters) are landed (PRs #4774/#4779). | `packages/core-backend/src/attendance/w4c2-scheduled-run.ts:168-179`, `:307`, `:328-350`, `:593`, `:857`, `:922`, `:1056`; `packages/core-backend/src/attendance/w4c2-outbox-dispatcher.ts:84`, `:110-146`; `packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts:44`, `:176-182`; `packages/core-backend/src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:1-28`, `zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts` |
| Manual override / recompute (w4c3c) | Immutable manual overrides with closed set/unset field lists; recompute policies are the closed pair `frozen_prior | current_policy` and append immutable calculations. | `packages/core-backend/src/attendance/w4c3c-manual-override.ts:46-56`, `:388`; `packages/core-backend/src/attendance/w4c3c-recompute.ts:31-36`, `:201` |

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
  owner-level W6 decision (made at W6 ratification while the W6 lock is still
  PROPOSED, or as a W6 amendment if W6 is already ratified), not a W7 side
  effect.

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
| W7-R10 | W6's own red line W6-R5 ("no calculation writer consumes the W6 aggregate") survives W7 unless the owner explicitly overrides it: W7's resolver reads persisted facts under locks, not the W6 HTTP aggregate. | Two legs over a pinned `CALCULATION_PATH_MODULES` inventory (an explicit module list fixed in the W7-0 contract, same exact-allowlist shape as the P16 inventory — the assertion's domain is a closed list, not an undefined "any calculation-path module"): (i) import-graph — zero imports of the W6 aggregate service/route modules from any inventoried module; (ii) outbound-HTTP — zero `fetch`/`axios`/`request`/internal-HTTP-client calls targeting any attendance route path from any inventoried module, because a resolver that does `await fetch('/api/attendance/groups/:groupId/effective-policy')` imports nothing yet violates the rule. Each leg carries a positive control: a probe adding such an import / such a call must turn that leg red. (Conditional on OD-W7-1; if the owner chooses (b) there, this row is replaced by an owner-signed W6 decision — at W6 ratification, or an amendment if W6 is already ratified.) |

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

Conditional on OD-W7-3 for the exact state carrier; semantics are fixed here:

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
4. **No restatement on rollback** (parent R3): rolling an org back changes the
   producer for **future** work dates only; already-frozen calculations and
   their evidence stay immutable (W7-R6 mechanical check applies).
5. **Evidence**: every W7 transition inserts an event with the evidence
   manifest hash and closed reference keys, exactly the
   `requireEvidenceReferences` discipline (`w4c3a-rollout-control.ts:114-163`).

## 6. Explicit W6-dependence markers

Every W7 dependence on an undecided W6 outcome, stated once, here:

| W7 element | Depends on | Conditionality |
| --- | --- | --- |
| Group-policy domain grouping used in resolution completeness checks | OD-W6-4 (domain/conflict closed inventory) | W7 adopts whatever closed inventory the owner fixes for W6; if W6 narrows it, W7's "policy incomplete" predicate narrows identically. |
| `preview_only` labeling vs. calculability of segments/flex | OD-W6-6 (preview_only derivation) | W7's eligibility predicate must be consistent with the W6 derivation the owner picks; conflicting definitions require a W6 amendment first. |
| Conflict surfacing of membership overlap in the workspace | OD-W6-4 / W6 §4.4 | W7 only *emits* the fail-closed runtime conflict (W7-R2); the display inventory is W6's. |
| Whether W7's resolver may share code with the W6 aggregate's readers | OD-W6-2 (FSER composition) and W6-R4 (single FSER derivation) | W7 must compose the same FSER service rather than re-derive, whatever W6 decides about embedding. |
| The aggregate as calculation input | W6-R5 | Preserved by default (W7-R10); overriding it is an owner-level W6 decision (at W6 ratification, or a W6 amendment if W6 is already ratified), not a W7 choice. |
| Label spellings reused in read-side labeling | OD-W6-3 | For the W6-owned source-label union, W7 §4.4 adopts the ratified spellings and mints none of its own. The W7-owned provenance values on the W4 detail/trace enums are a different enum family, owned by OD-W7-5 (strings fixed at W7-0) — see §4.4. |
| W6 runtime existing at all | OD-W6-0 + W6 completion gates | If the owner does not adopt/complete W6, W7 as specified here is **not startable**; §8's sequence makes this a hard precondition. Declining OD-W6-0 also has a consequence beyond W7: parent lock §10 item 8 (the effective/inherited/preview-only/conflicting group workflow) has no landed implementation at this baseline and W6 is its only planned vehicle, so issue #4556 could not close under §10 as ratified without an owner amendment to parent §10 — see the W8 plan §5-§6. |

## 7. Decision points (owner menu, all OPEN)

| ID | Question | Options (recommended first) and consequences |
| --- | --- | --- |
| OD-W7-1 | Source of group policy for calculation | **(a)** A dedicated in-transaction resolver reading persisted facts (W1 membership, group row, FSER-composed schedule facts) under the existing lock order; W6-R5 stays intact; the W6 aggregate remains display-only. (b) Consume the W6 aggregate service in-process — rejected by default: violates W6-R5, couples display labeling to accounting, and makes the aggregate's values-free posture a calculation constraint. |
| OD-W7-2 | Frozen-context evolution | **(a)** `schemaVersion: 2` with a discriminated selector (`'legacy' \| 'group_effective'`); `calculationGroupId` non-null iff `group_effective`; v1 stays valid/immutable with untouched golden bytes; the calculator accepts exactly {v1-legacy, v2-either} and fail-closes on all else. (b) Widen v1 in place — rejected, for the value-domain reason: W7 must widen the value domain of two existing **mandatory** keys (`selector` beyond `'legacy'`, `calculationGroupId` beyond `null`), which destroys `schemaVersion` as a discriminator and silently invalidates every existing v1 consumer's `selector === 'legacy'` assumption. Honesty note: the fingerprint argument does **not** carry — this repo's W5 precedent already widened v1 in place with an *optional* key (`flexPolicy?`, `w4c0-write-boundary-types.ts:147-151`; validator accepts the legacy exact key set or the same set plus optional `flexPolicy`, `w4c1-segment-calculator.ts:331-345`) and the v1 golden literals did not move (`w4c1-fingerprint-golden.test.ts` still pins the no-`flexPolicy` context to the unchanged `GOLDEN_STORAGE_FINGERPRINT`). An optional-key widening leaves old bytes alone; a mandatory-value-domain widening is a different operation, and that — not fingerprint movement — is why (b) is rejected. |
| OD-W7-3 | Cutover state carrier | **(a)** A second org-keyed state machine for context-source (`off <-> group_shadow <-> group_eligible -> group_authoritative <-> suspended`) in its own table, cloning the hardened-boundary pattern (single writer, closed matrix, trigger backstop, evidence manifest); keeps the W4 machine's meaning ("is segment calculation authoritative") untouched. (b) Extend the existing five-state machine with combined states — rejected: breaks the ratified closed matrix, its DB trigger, and every landed test that pins the 7 legal pairs. Consequence of (a): an org has two postures; the legal combinations table is part of the W7-0 contract. |
| OD-W7-4 | Suspended-from-group fallback direction | **(a)** No legacy fallback from `group_authoritative`; suspend/resume only, mirroring W4's `authoritative <-> suspended` asymmetry — history stays explainable with one producer per work date. (b) Allow an explicit owner-driven fall-back-to-legacy transition with its own evidence manifest — larger matrix, more drills, only justified if soak shows group-authoritative is not operationally recoverable. |
| OD-W7-5 | Read-side provenance spellings | **(a)** Extend the existing closed enums by amendment (detail `projectionOwner`/trace source-kind gain group-provenance values; exact strings fixed at W7-0). (b) A parallel provenance field — rejected: second spelling of the same fact. |
| OD-W7-6 | Group-policy snapshot form | **(a)** Freeze group policy INTO the frozen context (plus its fingerprint), no second snapshot table; the context is already the immutable policy carrier (`w4c0-write-boundary-types.ts:124`). (b) A separate group-policy snapshot table keyed by group/date — needed only if per-group dedup matters for storage; adds a join to every immutability proof. |
| OD-W7-7 | Which entrypoints cut over together | **(a)** All source entrypoints (live punch, scheduled, import, approval-driven, recompute `current_policy`) flip atomically with the org's posture — one producer per org per work date. (b) Phased per-entrypoint cutover — rejected by default: two producers in one org/date makes evidence and parity claims ambiguous (the W4C-3a lesson: same canonical row, separately snapshotted projections, was already the maximum tolerable split). |
| OD-W7-8 | First-org scope | **(a)** The named synthetic staging org only, reusing the W4C-5 allowlist discipline (exact org, `scope='synthetic_staging'`, no wildcard); real named-org opt-in is a separate later owner decision per parent §9.8. (b) Two synthetic staging orgs — the named one plus a second synthetic org with a deliberately different group topology (multi-group, overlapping effective dates at the boundary), both under the same exact-allowlist discipline, zero customer data — buys cross-org isolation evidence before any real named-org decision, at the cost of a second full evidence chain and soak window. Real named-org opt-in remains a separate later owner decision per parent §9.8 under either option. |

## 8. Landing sequence (conditional skeleton)

1. **Precondition (hard)**: owner signs off the W6 lock at its exact merged
   SHA and answers OD-W6-1..9; W6 runtime slices complete their own gates.
2. Owner reviews this draft, answers OD-W7-1..8, and signs off the exact
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

`OD-W7-0` (adopt this lock) and `OD-W7-1..8` are **OPEN**. This document
carries no default: absent owner sign-off — and absent the W6 preconditions
in §8 item 1 — W7 remains a paper plan and no W7 runtime work is authorized.

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
- `scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs:1033, 1074, 1386`
- `scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs:74`
- `packages/core-backend/src/attendance/__tests__/w4c1-fingerprint-golden.test.ts:1-13`; `packages/core-backend/tests/utils/attendance-w4c2-golden-response.ts`; `packages/core-backend/tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts` (existence/role)
- `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml`, `apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue` (existence only — W6-0 prep)

Documents:

- parent lock `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md:179-233` (R1-R9; R2 `:186`, R3 `:192`, R4 `:198`, R8 `:221`), `:627-638` (OD-4556-1..12), `:731-762` (§9.7-9.9), `:764-777` (§10)
- W4 lock `docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md:155-168` (§2.3), `:2002-2016` (§9), `:2334-2403` (§10.1-10.3), `:3000-3031` (§12.8), `:3090-3104` (§14; item 10 at `:3103-3104`), `:3106+` (§15)
- `docs/development/attendance-issue-4556-w4-remaining-slice-plan-20260726.md:103-125` (§5-§6)
- `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md` (whole; §1 matrix, §3 predicates, §4 manifest, `OD-W4C-61`)
- `docs/development/attendance-issue-4556-w4c2-per-target-failure-taxonomy-amendment-20260729.md` (existence/role)
- W6 lock `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md` (whole; §2.3 `:89-97`, W6-R4/R5 `:106-107`, OD-W6-1..9 `:234-246`)
- `docs/development/attendance-4709-fser4-member-projection-contract-amendment-20260804.md:136-183` (§3-§4)

GitHub state (queried 2026-08-07): PR #4771 MERGED (W6 prep), PR #4773 MERGED
(OD-W4C-61=(a) hardening), PRs #4774/#4779 MERGED (#4770 arc), PR #4780 MERGED
(#4775 8-cell); issues #4556, #4629, #4770, #4775, #4791, #4792 OPEN.
