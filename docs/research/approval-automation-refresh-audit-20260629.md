# Approval & Process-Automation — refresh audit (2026-06-29)

> Code-grounded audit of the whole 审批及流程自动化 line against `origin/main` (`8bb4a757`+, post-#3375).
> Method: 4 parallel code-inventory reads (approval product · automation engine · workflow/bridges ·
> benchmark digest), each verdict carrying a `file:line` anchor. **Reading discipline: code wins.** The
> April Feishu gap-matrix and May Yida benchmark pre-date the heavy June work, so they are treated as the
> *question* ("what should exist") never the *answer* ("what is missing") — every gap below is a code
> finding, not a doc claim. Benchmark naming (DingTalk/Feishu/Yida) is permitted here because this is a
> `docs/research` benchmark doc, not a committed design doc.

## 0. Headline

**The code is materially AHEAD of the team's own ladder/roadmap docs.** Multiple capabilities filed as
"deferred / future / runtime-not-built / backend-only" are in fact shipped end-to-end on main:

- `requester.title` + `requester.role` RA conditions — wired create→publish-gate→executor→evaluator
  (`ApprovalProductService.ts:3042/3046/2645`, `ApprovalConditionFormula.ts:783/802`), though the
  06-27 round-2 doc still calls role "RUNTIME NOT BUILT".
- **P1-D detail/sub-form fields** SHIPPED (`approval-product types:54-64`, executor submit-validation
  `:457`, authoring `:763`) — ladder filed as deferred.
- **P3-C delegation/proxy** SHIPPED (CRUD `ApprovalDelegationConfig`, resolver substitution
  `ApprovalAssigneeResolver.ts:102-136`, routes `approvals.ts:800-845`) — ladder filed as *future*.
- Formula-condition routing, auto-approval 3-merge, admin-jump, version-freeze, add/reduce-sign —
  all real, not stubs.
- `start_approval` + `form.submitted` are now **editor-exposed** (the 06-27 multitable refresh calling
  them "BACKEND-ONLY" is itself stale).

So "完成度" is **high for the core**; the genuine remaining work is a narrow frontier (P2/P3 polish), a
short list of competitor-parity gaps, and one governance gap. Sizing follows as ladder-rung counts +
S/M/L, never a fabricated percentage.

## 0.1 Discovered risks — triage tickets, NOT roadmap-feature scope

Surfaced by the audit, severity verified in one pass. These are not "build next" items — they are
**fix/decide** items that should get their own tickets independent of the feature ladder:

- **[Sev: moderate] Un-governed executable BPMN runtime + authenticated SSRF.** The legacy
  `BPMNWorkflowEngine` is mounted at `/api/workflow` (deploy/start/complete/signal, `index.ts:1088`)
  behind **`authenticate` only — no RBAC** (`routes/workflow.ts`, every route just `authenticate`).
  `executeServiceTask` runs an **`http` task as a real `fetch(url)`** to a process-definition-supplied
  URL (`BPMNWorkflowEngine.ts:550`) → any logged-in user can deploy+start a process that makes the
  server fetch arbitrary/internal URLs (**SSRF-class**). *Verified mitigations:* the `script` task is
  **sandboxed** — a regex-limited assignment interpreter with a `child_process`/eval blocklist
  (`:587-625`), **not** arbitrary code, so this is **not RCE**. Recommend: gate `/api/workflow` behind an
  explicit permission (or feature-flag it off) and constrain/allowlist service-task `fetch` targets.
  This is also the convergence-doctrine breach (the "designer = preview-only" fence) — fixing the risk
  and enforcing the fence are the same action.
- **[Sev: low–moderate] `getApproval` returns the un-redacted form snapshot** (`ApprovalProductService.ts:4239`).
  `hidden`-field redaction lives in a separate read-layer module (`approval-form-redaction.ts`, consumed
  at `ApprovalBridgeService.ts:777`). Any future read path that returns the product-service snapshot
  directly would leak `hidden` fields. Recommend: a regression test asserting every approval read path
  goes through the redaction layer (or push redaction into the snapshot getter).
- **[Sev: low, correctness] `webhook.received` silent-never-fires trap.** Editor-selectable + validated
  + persisted, but no event map / no ingestion route → a saved rule silently never fires
  (`scheduler.ts:508`). Recommend: either build the inbound endpoint or remove it from the selectable
  set so the UI stops advertising an inert trigger.

## 1. Completeness by ladder band (the spine: `approval-capability-ladder-and-gates-20260616.md`)

**Baseline (9 capabilities): 9/9 ✅** — graph runtime, authoring MVP+anti-flatten, assignment sources,
modes (single/all/any + parallel join), empty-assignee policy, visibility rules, template SLA+metrics,
typed/redacted completion events, `start_approval` bridge. All code-anchored.

**P0 Trial-readiness — code-done, ops-sign-off pending.** Not code rungs; validation gates. The RA stack
is test-locked. The one open item is the **W6 deployed operator smoke** (owner sign-off) — exactly what
PR #3373's acceptance record captures (in-process seam ✅, deployed leg ⬜ owner).

**P1 High-frequency authoring — 3 shipped + 1 partial of 4:**
| Rung | Verdict | Note |
|---|---|---|
| P1-A org-derived assignees | ✅ | direct_manager/dept_head/continuous_managers/manager_at_level (`Resolver:163-205`). Sequential reading-B = per-level primitive only (manual N-node), no auto-expansion |
| P1-B add/remove signers | ✅ | `ProductSvc:3562/3614` |
| P1-C node-level field perms | 🔶 PARTIAL | `hidden` enforced at read (`approval-form-redaction.ts`); `readonly`/`editable` inert (`types:42-46`); not UI-authorable |
| P1-D detail/table field | ✅ | shipped (ladder: deferred) |

**P2 Workflow completeness — 0 fully shipped, 3 partial, 3 not-started of 6:** P2-A handler node ⬜;
P2-B self-approval ✅ but broader empty-matrix ⬜ → 🔶 PARTIAL; P2-C node-level SLA ⬜ (template-level
only); P2-D related-approval field ⬜; P2-E sequence-number 🔶 (basic ✅, configurable ⬜); P2-F
auto-approval invalidation — dedupe/merge primitives ✅ but no formal policy surface 🔶. (Partial = B/E/F;
not-started = A/C/D.)

**P3 Operations & admin — 1 shipped, 2 partial, 2 not-started of 5:** P3-A scoped admins ⬜; P3-B
handover/bulk-reassign ⬜ (per-instance transfer only); P3-C delegation ✅ (ladder: future); P3-D
diagnostics 🔶 (template/instance/breach views ✅; person/team ⬜); P3-E sequential ✅ / N-of-M
threshold voting ⬜ (modes are single/all/any only).

**S MetaSheet-native (approval-as-records) — ⬜ not-started** (strategic; W7 backwrite is the narrow
first bridge, not the band).

## 2. Automation engine — mature, with a short defect list

Triggers: **8 of 9 live + editor-exposed** (record.created/updated/deleted, field.value_changed,
form.submitted, schedule.cron/interval/date_field). Actions: **14 total — 12 editor-selectable** +
`delete_record`/`record_click` backend-only. Mechanics all ✅: leader-gated scheduler (UTC cron +
interval + self-re-arming date_field), `workflow_job_v1` jobs, single-use suspend/resume with
action-fingerprint drift guard, 12-operator type-aware conditions, A5 retry/provenance, depth-guard
(`MAX_AUTOMATION_DEPTH=3`), date-reminder idempotency ledger + 1y retention.

Defects/gaps (code-anchored): (1) **`webhook.received` is a UI trap** — selectable+validated+persisted
but no event map / no ingestion route → silently never fires (`scheduler.ts:508`, zero ingestion); (2)
`delete_record` backend-only (capability without UI); (3) legacy `field.changed`/`notify`/`update_field`
accepted but inert; (4) **no dedup on event-driven triggers** (only date_field has a ledger — a
redelivered `record.*`/`form.submitted` re-runs side effects); (5) `wait_for_callback` has no external
resume emitter (admin-route only); (6) **schedules are UTC-only** (the `timezone` config is accepted but
ignored); (7) branching intentionally shallow (no nesting; parallel children limited to
update_record+send_notification); (8) conditions compare against literal constants only (no
field-to-field, no date-math).

## 3. Convergence & bridges — W6/W7 shipped; one governance gap

**W6 (start_approval → approval → suspend/resume) and W7 approved-path backwrite are SHIPPED**
(`automation-approval-bridge-service.ts`, `automation-service.ts:1783 writeApprovalResultBack`). Run-gov
primitives — condition_branch, parallel_branch (join-all only), wait_for_callback, suspend/resume — all
shipped behind `workflow_job_v1`. Named follow-ups, explicitly gated (not silent): **rejection backwrite**
(non-approved currently fails the run by design), **cross-base backwrite** (same-base only), branch-local
start_approval (rejected at save).

**⚠️ Governance gap (headline): the "BPMN designer = preview-only, never a runtime" doctrine is NOT
enforced in code.** `bpmnCompilePreview` is genuinely side-effect-free, but the legacy
`BPMNWorkflowEngine` was never gated/retired: `/api/workflow` (deploy/start/complete/signal,
`index.ts:1088`) and the designer's own `/deploy`+`/test` (`workflow-designer.ts:1211/1282`) are mounted
and executable behind `authenticate` only — a draft can be *run*, not just previewed. Also: three
approval bridges exist (W6 convergence + PLM + after-sales) but only W6 is governed by the convergence
path; `workflow-job-contract.ts:10` overclaims "not imported by any runtime path" (its status vocabulary
is imported). These are doctrine/safety items, not competitor features, and warrant an explicit decision
(gate or retire the legacy engine).

## 4. Benchmark gap map (DingTalk / Feishu / Yida)

**Old gaps that the June work CLOSED (do not resurface):** 会签/或签 (all/any), 加签/减签, 抄送 CC
node+tab, 转交/撤回, conditional + formula routing, auto-approval 3-merge, admin jump, dynamic
manager-chain assignees, amount/formula fields, detail/sub-form, delegation, version-freeze. The single
best example of the staleness trap is add-sign: 暂不做 (Apr) → 战略推迟 (May) → **shipped** (June).

**Genuine remaining gaps vs DingTalk/Feishu (code-confirmed):**
| Gap | Size | Where it bites |
|---|---|---|
| Node-level SLA + timeout actions (remind/transfer/jump/auto-approve/auto-reject) | M | only template-level SLA + remind today (P2-C) |
| Business/work-day calendar wired to SLA; multi-time-dimension; non-counting windows | M–L | calendar exists (attendance) but unwired; hours-only, UTC-only |
| Webhook **inbound** real endpoint (signed, audited) | M | INERT trap today |
| Approval→automation event-bridge **trigger** (`approval.*` as a rule trigger) | M | completion event drives W6 resume, but no general "on approval done → run automation" trigger |
| Node-level field perms `readonly`/`editable` + authoring UI | S–M | only `hidden` works; not UI-authorable |
| `delete_record` editor exposure; configurable sequence-number; CC push channel | S | contained finish-line items |
| Person/team process analytics (drill-down BI) | M | template/instance/breach metrics ✅; person/team ⬜ |
| N-of-M threshold voting | M | modes are single/all/any only |
| Scoped approval admins + handover (bulk reassign on leave/role-change) | L | P3-A/B; permission-model + ownership redo |
| Timezone-aware scheduling | S–M | UTC-only |
| Mobile approval surface | L | web only |
| Handwritten signature / compliance | M–L | absent (国内合规缺项) |
| W7 rejection + cross-base backwrite | M each | named follow-ups |
| S-band: approval data as first-class multitable records | L | strategic |

## 5. Ranked improvement ladder (each a gated opt-in — recommend, not authorize)

**Tier 0 — finish lines (cheap, high-trust):** W6 deployed operator sign-off (clears P0; owner call) ·
**W7 resultWriteback UI implementation** (the #3375 design-lock just merged) · expose `delete_record` in
the editor. These close already-built capability.

**Tier 1 — high-frequency parity, contained (S–M):** node-level SLA + timeout actions (the most-cited
benchmark gap) · webhook-inbound real endpoint (close the INERT trap) · `approval.*` automation trigger
(unlocks "on approval done, run automation") · finish P1-C field-perms (readonly/editable runtime +
authoring UI).

**Tier 2 — ops/admin maturity (M–L):** scoped approval admins (P3-A) + handover (P3-B) · person/team
analytics (finish P3-D) · N-of-M threshold voting (P3-E) · timezone-aware scheduling · event-driven
dedup ledger.

**Tier 3 — strategic / heavy (L):** mobile approval · business-calendar-wired SLA ·
handwritten-signature/compliance · W7 rejection + cross-base backwrite (each its own arc) · S-band
approval-as-records. (The **BPMN fence** is *not* here — it is a §0.1 risk ticket to triage now, not a
roadmap feature; gating/retiring the legacy engine is the same action as enforcing the convergence
doctrine.)

## 6. Discipline reminders (from the ladder §8–9)

No generic "approval parity" epic; no three-engine merge; no live BPMN production-runtime *expansion*
(the fence decision is about *containing* the existing one, not growing it); no hidden approval→record
writes; runtime ownership stays per the convergence doctrine; each rung above is an independent
demand-gated opt-in, design-lock-first. The stale `readonly`/`editable`/`webhook.received`/`field.changed`
enum entries should be either wired or removed so the contract stops advertising inert capability.
