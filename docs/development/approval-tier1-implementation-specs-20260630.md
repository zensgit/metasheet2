# Approval & Process-Automation — Tier-1 implementation & verification specs (2026-06-30)

> Design & verification MD for the ratified Tier-1 rungs (T1-1, T2-5, T2-4). The headline decisions
> are already owner-ratified (defaults approved); this doc turns them into **turnkey, file-level
> implementation maps + verification plans** so each build is mechanical. **Status note:** the
> parallel build agents were blocked by persistent server-side rate-limiting (both wrote nothing), so
> these rungs are **design-locked-to-turnkey, pending a focused implementation pass** — not rushed at
> the tail of a long session, because approval-lifecycle and DST-scheduling bugs are high-stakes.
> Ratified per-decision detail: the decision register (#3385); prioritization: the completion-refresh (#3396).

## 0. Shipped + verified this overall arc (context)
T2-3 person/team analytics (#3387, `approvals:analytics` gating) · W7 resultWriteback UI (#3384) · R2 redaction guard + R3 inert-trigger removal (#3382) — all on `main`, each CI-verified.

---

## 1. T1-1 — node-level SLA + `remind` (slice 1)

**Ratified defaults:** wire `remind` only this slice (transfer/jump/auto_* enum-declared but rejected at
publish); deadline = wall-clock `afterMinutes` from node `activatedAt`, resets on re-entry; single-shot
per activation; deadline stored as scalar columns on `approval_metrics`; reuse existing record actions
with `metadata.timeoutEffect` (no new enum); remind inside a parallel region only; whole minutes.

**Implementation map (traced against current code):**
1. **Types** — `packages/core-backend/src/types/approval-product.ts`: add `NodeTimeoutEffect =
   'remind'|'transfer'|'jump'|'auto_approve'|'auto_reject'` and `NodeTimeoutConfig { afterMinutes: number;
   effect: NodeTimeoutEffect }`; add `timeout?: NodeTimeoutConfig` to `ApprovalNodeConfig` (interface at
   `:78-90`).
2. **Migration** — new `zzzz2026063010xxxx_add_node_timeout_to_approval_metrics.ts`: `ALTER TABLE
   approval_metrics ADD COLUMN current_node_deadline_at TIMESTAMPTZ`, `ADD COLUMN
   current_node_timeout_effect TEXT`; partial index `(current_node_deadline_at) WHERE
   current_node_deadline_at IS NOT NULL` (mirror `idx_approval_metrics_sla_scan`,
   `zzzz20260425100000_create_approval_metrics.ts`).
3. **Stamp the deadline at activation** — `ApprovalMetricsService.recordNodeActivation` (`:219`) gains
   optional `timeoutDeadline?: Date | null` + `timeoutEffect?: string | null`, and writes the two columns
   (alongside the `mutateBreakdown` JSONB append). `recordNodeDecision` (`:245`) clears both columns to
   NULL. The **3 activation call sites** are `ApprovalProductService.emitNodeActivationMetric` (`:4207`),
   called at `:3405 / :3846 / :4176` — thread the activating node's `config.timeout` (look it up in the
   runtime graph that the dispatch flow already loads), compute `deadline = now + afterMinutes·60s`, pass
   it through. All sites are wrapped in `safeMetricsCall` (best-effort — a metrics failure never fails the
   approval).
4. **Scan** — `ApprovalMetricsService.scanNodeTimeouts(now)`: `SELECT instance_id, current_node_timeout_effect
   FROM approval_metrics WHERE current_node_deadline_at < $1 AND terminal_at IS NULL` (uses the partial
   index). `markNodeTimeoutFired(instanceId)` = clear `current_node_deadline_at` → re-fire impossible
   (single-shot).
5. **Scanner hook** — `ApprovalSlaScheduler.tick` (`:135`), after `checkSlaBreaches`, calls
   `scanNodeTimeouts`; for each due row (effect `remind`) resolve the node's **current active assignees**
   (`approval_assignments WHERE instance_id = … AND is_active`) and notify via the existing
   `ApprovalBreachNotifier` primitive; then `markNodeTimeoutFired`. Reuse the scheduler's existing
   leader-gating (no second leader mechanism).
6. **Publish validation** — in `ApprovalProductService` publish/graph-validation (near the parallel-jump
   restriction `:3274`): `afterMinutes > 0` and capped; `effect ∈ enum`; **reject transfer/jump/auto_* this
   slice** (`APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED`); reject non-remind timeout on parallel-branch nodes.

**Verification plan:** tsc 0 · publish-validation unit test (reject non-remind + parallel) · real-DB
integration `approval-node-sla-remind.test.ts` (`describeIfDatabase` + sentinel): seed a published
template whose approval node has `timeout:{afterMinutes:1,effect:'remind'}`, start an instance, set
`current_node_deadline_at = now()-'1 min'`, run the scan → assert a remind fired to the active assignee,
and a **second scan is a no-op** (single-shot). **CI-wire** the new test into both `vitest.config.ts`
exclude and the `Run approval real-DB integration` whole-file list in `plugin-tests.yml`.

**Slice 2 (separate PR, state-mutating):** `transfer`/`jump` effects — reuse the existing
transfer/admin-jump dispatch with a `system:approval-timeout` actor + `metadata.timeoutEffect=true` + the
configured target; `auto_approve`/`auto_reject` stay inert behind `APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS`.

---

## 2. T2-5 — timezone-aware scheduling (automation)

**Ratified defaults:** both cron + date_field tz-aware; DST fall-back = **fire once** (advance cursor past
the repeated window); spring-forward = **skip** the missing hour; cron misfire = at-most-once / no
catch-up (unchanged); honor persisted tz **going forward** + a **one-time startup audit log** of enabled
non-UTC cron rules; invalid IANA tz = **reject 400 at save** + runtime catch→UTC-fallback; relax the
date_field save-validator from reject-non-UTC to accept-valid-IANA.

**Implementation map:**
1. `packages/core-backend/src/multitable/automation-scheduler.ts` — `cronMatches` / `nextCronOccurrenceMs`
   (`:144-156`, `:437-507`): convert the rule's wall-clock cron fields in its IANA tz to the next UTC
   instant; the minute-scan naturally yields fire-once (fall-back: advance cursor past the repeated window)
   and skip (spring-forward: no UTC instant maps to the gap). UTC / absent-tz path **unchanged** (regression
   guard).
2. `automation-date-reminder.ts` (`:20-21`): bucket the occurrence in the rule's tz instead of UTC.
3. `automation-triggers.ts` (`:39`) + the save-validator: accept valid IANA (validate via
   `Intl.DateTimeFormat(undefined,{timeZone}).format()` in a try); reject invalid with 400; relax the
   date_field non-UTC rejection.
4. Startup audit: on scheduler init, log enabled cron rules whose tz ≠ UTC (sheetId, ruleId, tz).
5. Runtime defense: a persisted-junk tz in the loop → catch → UTC fallback + warn (never throw).

**Verification plan:** **golden unit tests** (pure occurrence-math, no DB): normal-day wall-clock→UTC in
`America/New_York`; **DST fall-back fires once**; **spring-forward skips**; invalid-IANA rejected at save
+ caught at runtime; **no regression** on the UTC default path (existing scheduler + date-reminder suites
green). No DB required; no executor integration (self-contained) — lowest-risk Tier-1 build.

---

## 3. T2-4 — N-of-M threshold voting node mode

**Ratified defaults:** keep **single-reject-rejects** for v1 (no new counting on the destructive path);
add an N-of-M **approve** threshold only; (anchor-caveat — verify the aggregation anchors before build).

**Implementation map:**
1. `types/approval-product.ts`: extend the node config with an optional approve-threshold (e.g.
   `approvalThreshold?: number` on `ApprovalNodeConfig`, valid only with `approvalMode: 'all'|'any'`-family
   or a new `threshold` mode — pick per the register's mode decision).
2. `ApprovalGraphExecutor` aggregation (`:3894-3969`, the single/all/any resolution): when a threshold is
   set, a node resolves **approved** once `approveCount ≥ threshold` (instead of all/any); **reject path
   unchanged** (a single reject still rejects — conservative).
3. Migration only if the threshold needs persistence beyond the graph JSON (likely none — it lives in the
   node config).
4. Publish validation: `1 ≤ threshold ≤ assigneeCount`; reject threshold on incompatible node types.

**Verification plan:** tsc 0 · real-DB test: a node with 3 assignees + `approvalThreshold:2` resolves
approved on the 2nd approval (not the 3rd), and a single reject still rejects; unit tests for the
threshold validation. CI-wire any DB test.

---

## 4. Verdict & next step

**Parity-ready plan + increment shipped (T2-3 + W7 UI + risk fixes) — not parity achieved.** The Tier-1
rungs are **ratified + turnkey-specced**; the remaining step is a **focused implementation pass per rung**
(T2-5 is the lowest-risk — self-contained occurrence-math; then T1-1, then T2-4). Recommended cadence:
build one rung at a time, each verified (tsc + real tests + CI-wiring + openapi-dist where touched) and
opened as a reviewable PR — not a rushed multi-rung pass. The Tier-2 security/permission/destructive rungs
remain design-lock-first pending ratification (#3385/#3396).
