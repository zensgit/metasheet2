# Lock-6 — Requester and Global Approval/Document Policy (2026-08-17)

**Status:** RATIFIED (2026-08-17 — §4 record; design authorization only, slices still gated)
**Baseline:** `origin/main@3c5f0992ba931f9a7a1115c0e43c4d33e7a306f6`. Every anchor below was read at
THIS baseline, which is NEWER than every parent (master pins `d33a6a0fa1`, Lock-0 pins `5b31cb4349`,
Lock-4 pins `075d078eb4`). The six `ApprovalProductService.ts` anchors Lock-4 cites for the
auto-approval family (`:2856`, `:2961`, `:2975`, `:2998`, `:3049`, `:7882`) were re-read here and land
on the identical lines, so Lock-4's cross-references hold verbatim. The two `TemplateAuthoringView.vue`
anchors those parents cite do NOT: `authoringSections` is `:1216-1225` here (Lock-0 L0-4 cites `:1555-1564`)
and `setApprovalNodeMergeWithRequester` is `:1674-1683` (Lock-4 OD-L4-6 cites `:2013-2024`). The construct
at each site is unchanged; this document uses ITS OWN numbers and a slice must re-derive them again.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-6 row — this is that
row's draft. §P3-B is the binding scope and it is tighter than a two-policy reading:
*"select and ratify **one** bounded Lock-6 global policy. Mount 'More settings' only after P3-A plus
that first functional global policy."* Master M7 (no empty More-settings step), M8 (configuration and
enforcement must be honest), M4 (unknown persisted values stay round-trip-safe and read-only), M11
(scoped evidence language) all bind. Master P5 owns the member-facing chrome for any requester control
ratified here ("owner-ratified requester controls").
`approval-lock0-d0-interaction-delta-20260817.md` (RATIFIED, on main) — L0-4 keeps the wizard at 4
steps with `测试发布` fourth until ≥1 ratified, server-enforced global policy exists, and defines
activation as a typed change to the `AuthoringSectionId` union plus `authoringSections`.
`approval-lock4-flow-policies-20260817.md` (RATIFIED, on main) — §2.6 NOMINATES the template-level
dedup tier as the first 更多设置 control; F4-D fixes the tier shape (OD-L4-6(a)) and the return-invalidation
prerequisite (OD-L4-10(a)). This document engages that nomination and adopts it (§1 L6-A).
**Non-effects:** no runtime code, no migration, no flag change, no tenant UAT, no deployment, no
completion label. Ratifying this document does not itself activate the fifth wizard step — the step
activates only when the L6-A control lands and is server-enforced (§2.7). Per-node operation and
member-action policy is Lock-5; new assignee kinds are Lock-1/2; the handler node is Lock-3;
`readonly`/`editable` enforcement is Lock-7.

**Corpus provenance.** The block used below is the offline capture `feishu/6933484342190538780.txt` §5
更多设置 (lines 2106-2229: 提交人权限 / 审批人去重 / 审批人设置 / 转发设置 / 效率诊断) plus the changelog entry
支持审批人撤回"已同意"的审批 (`feishu/6933483925062909979.txt:193-209`). Per master M11 the corpus evidences
documented behavior and never absence.

## 0. Shipped surfaces this lock reuses or must not break

| Shipped surface | Anchor at this baseline | Lock-6 disposition |
|---|---|---|
| the only template-level runtime policy that exists | `RuntimePolicy` (`types/approval-product.ts:242-246`) — `allowRevoke`, `revokeBeforeNodeKeys?`, `autoApproval?`; carried on `runtime_graph.policy`, validated by `assertRuntimePolicy:2683-2705`, compiled by `buildRuntimeGraph:2734-2747` | the carrier L6-A extends; L6-P1 repairs its authoring round-trip |
| policy is a PUBLISH argument, never a template/version column | `PublishApprovalTemplateRequest.policy` (`types/approval-product.ts:542-543`) → `publishTemplate:3937`, `:3940`, `:4026`; `TemplateRow:177-196` and `TemplateVersionRow:198-213` have no policy field; `ApprovalTemplateDetailDTO:494-497` exposes none | the structural cause of L6-P1 |
| revoke enforcement, the ONE shipped requester policy | `dispatchAction` revoke branch `:6615-6688` — `allowRevoke` gate `:6616-6618`, requester-only `:6619-6622`, active-node requirement `:6623-6625`, `revokeBeforeNodeKeys` allowlist `:6626-6631`, current-node handled-probe `:6632-6642` | PRESERVED verbatim; §2.8 records its exact (non-)equivalence to the corpus |
| revoke is structurally in-progress-only | an approved resolution sets `currentNodeKey: null` (`ApprovalGraphExecutor.ts:694-695`, `:772`, `:1150-1151`, `:1166-1167`) persisted at `:7164-7181`, so `:6623` rejects any post-terminal revoke before the generic status guard at `:6690-6696` is even reached | the blocking constraint L6-B must answer |
| `policy_snapshot` is an ECHO, not the enforcement source | written at create as `{ rejectCommentRequired, allowRevoke, sourceOfTruth }` (`:5224`), read only into the DTO (`:2433`) and by the DingTalk card's reject-comment flag (`ApprovalCardDeliveryAction.ts:132-134`, `:193`); the FE affordance keys on it (`ApprovalDetailView.vue:1007`, button `:470`) | echo stays display-only (§2.4); no policy may make it authoritative |
| the dedup trio and its precedence | `evaluateAutoApprovalAssignment:3049-3113`; `getEffectiveAutoApprovalPolicy:2961-2973` (node key present ⇒ whole-object override; absent ⇒ template `runtimeGraph.policy.autoApproval` at `:2970-2972`); enable-predicates `hasEnabledAutoApprovalRule:2856` and `runtimeGraphHasAutoApprovalPolicy:2975-2981` | L6-A's enforcement — pre-existing, unchanged |
| the history the dedup flags read | `loadApprovalHistory:3210-3243` — every `action='approve'` row (`:3222`) ordered by time, with NO epoch/round/return filter | Lock-4 OD-L4-10(a) round-scoping is inside L6-A's slice |
| FWB fires on APPROVED only, keyed by a version-bearing event id | `automation-executor.ts:3014-3020` (`fwb_outcome_not_approved` skip); `eventId = approval:<instanceId>:<toVersion>:<eventType>` (`ApprovalCompletionEvent.ts:98`) | the seam L6-B and L6-C must answer (§1 L6-B) |
| resubmit is a NEW instance, and excludes `approved` | `ApprovalDetailView.vue:1016-1021` (`rejected`/`revoked`/`cancelled` only) → `handleResubmit:1426` routes to a fresh draft; `prefillFromSnapshot.ts` is FE-only | not reusable for L6-C |
| identity-only requester override already exists | `assembleCreationContext` `requesterOverride:4638` — identity only, org attributes always re-resolved from the DB (`:4766-4782`, snapshot built `:4942-4959`); reachable only via `previewTemplateRoute:5013` behind `canManageTemplates` (`routes/approvals.ts:508`, `:524`, `:549`); `createApproval:5118` calls the context with no options (`:5130`) | L6-D's substrate |
| per-user template visibility at the write boundary | `templateVisibleAtCreateBoundary:7545-7567` (`FOR SHARE`, actor-scoped), called once for `actor.userId` at `:5178-5183`; `approvals:write` re-checked at `:5196` | L6-D's both-parties check reuses it |
| approve-derived tallies with no "un-approve" path | threshold tallies `COUNT(DISTINCT actor_id) … action='approve'` at `:6958`, `:6966`, `:6979`; the revoke probe counts `approve/reject/transfer` at `:6636` | the cost centre of L6-E |
| efficiency aggregates | `ApprovalMetricsService` readers `getMetricsSummary:541` (overall `:585` + per-template `:618`), `getMetricsByDimension:663` (`:712`), `getMetricsByRequester:737`, `getMetricsByDepartment:741`, `getMetricsReport:745` (`:786`, `:811`); SLA-breach paths `checkSlaBreaches:507`, `listBreachesPendingNotification:873`, `listActiveBreaches:904` | L6-F2's enforcement surface, with the SLA boundary stated |

## 1. Contracts

### L6-P1 — Template-policy authoring carrier (prerequisite, not a policy)

**The shipped defect, stated plainly.** `RuntimePolicy` has no draft-side carrier. The authoring view
publishes `policy: { allowRevoke: draft.value.allowRevoke }` and nothing else
(`TemplateAuthoringView.vue:2850`), the draft's own `allowRevoke` is **hard-coded `true` on hydrate**
(`templateAuthoring.ts:834`; the create-empty default is also `true` at `:327`), the detail DTO carries
no policy to hydrate from (`types/approval-product.ts:494-497`), and `publishTemplate` rebuilds the
runtime policy from `request.policy` alone with **no merge** from the prior published definition
(`:3940` → `:4026`). Two consequences follow by construction:

1. a template published with `allowRevoke:false` reverts to `true` on the next editor republish; and
2. any `policy.autoApproval` set through the documented publish API is **destroyed** by the next editor
   publish.

(2) is why L6-A cannot be "add a radio". **Locked requirement:** before any template-level policy control
renders, the detail read must expose the active published definition's `policy`, the draft must hydrate
from it, and the publish payload must carry it — one carrier, so a second policy later adds a field
rather than a second lossy path. L6-P1 may land in its own PR ahead of the control; it does **not**
activate the fifth step (§2.7).

### L6-A — FIRST functional global policy: template-level 审批人去重 tier (adopted from Lock-4 §2.6)

**The nomination is adopted, and the reason is that the enforcement already exists.** The corpus places
去重 in 更多设置 (§5.2, corpus 2147-2175); the carrier `runtimeGraph.policy.autoApproval` already exists
and already executes through the template arm of `getEffectiveAutoApprovalPolicy:2970-2972`. Every
alternative candidate in this document needs either a new state transition (L6-B/C/E), a new create-path
identity (L6-D), a governed operation that does not exist (L6-F1), or a migration plus six reader edits
(L6-F2). L6-A is the only bounded control whose behavior is already server-enforced, which is exactly
what M7 asks the first policy to be.

**Shape (Lock-4 OD-L4-6(a), unchanged here).** A 3-way tier projected over the two shipped booleans —
仅一次全自动同意 ⇒ `dedupeHistoricalApprover`, 仅连续节点 ⇒ `mergeAdjacentApprover`, 不去重 ⇒ neither — at the
TEMPLATE level on `runtimeGraph.policy.autoApproval`. Both-ON renders read-only and round-trips
unchanged, because with both set the first-match order at `:3069` before `:3091` makes the recorded
reason always `auto-merge-adjacent` and the audit row therefore cannot report which tier was configured.
Zero contract change, zero migration.

**Default stays 不去重, deliberately deviating from the corpus.** Absent `autoApproval` ≡ both flags
absent ≡ no effective policy (`hasEnabledAutoApprovalRule:2856`) ≡ today's behavior, byte-stable for
every existing template. The corpus records 仅审批一次 as *Feishu's* default (corpus 2161); adopting that
default would silently start auto-approving nodes in already-published MetaSheet templates. The
authoring copy must therefore not describe 不去重 as an unusual choice.

**No enable-predicate widening is needed, and that is worth stating.** Because the tier projects onto
the two existing booleans, both `hasEnabledAutoApprovalRule:2856` and
`runtimeGraphHasAutoApprovalPolicy:2975-2981` already recognize it — Lock-4's X-1 silent-inert trap does
not apply to L6-A. A later `dedupTier` enum (OD-L4-6(b), rejected there) would re-open it.

**Node override precedence is unchanged and must be surfaced honestly.** A node carrying
`autoApprovalPolicy` overrides the template object wholesale, so the template tier governs only nodes
without their own policy; the linear editor writes `mergeWithRequester` on nodes
(`templateAuthoring.ts:968-978`) and thereby creates such an override. The template control's copy must
say "applies to nodes that do not set their own rule", and the projection must reuse the
delete-key-keep-siblings pattern of `setApprovalNodeMergeWithRequester`
(`TemplateAuthoringView.vue:1674-1683`) so the template edit never clears a node's `actorMode`.

**Lock-4 OD-L4-10(a) is inside this slice, not adjacent to it.** F4-D: *"any slice making a dedup tier
authorable must FIRST scope the history the flags read to the current post-return round … Shipping the
switch without one is forbidden."* `loadApprovalHistory:3222` applies no round filter today, so L6-A
carries the `nodeEntryEpoch` round-scoping and Lock-4 gate D-3 with it. This is a re-price of the tier
slice, not a discovery: it is the ratified condition on the nomination being usable.

**First-node vacuity, stated so the copy cannot overclaim.** The create-time cascade is handed an EMPTY
history (Lock-4 F4-D), so neither history flag can fire at the first approval node — a template tier affects nodes 2..N only.

**Enforcement provenance is pre-existing.** The L6-A PR lands authoring, carrier, projection and
round-scoping — it does **not** land the dedup enforcement. Gate A-2 is still mandatory: with the dedup
arms of `evaluateAutoApprovalAssignment:3049-3113` neutered, a named test must go red. No document may
describe the L6-A PR as introducing the enforcement.

### L6-B — 撤销 x 天内已通过 (post-approval revoke): DEFERRED, blocker named

**Not a widened window — a new construct.** The shipped revoke requires an active node (`:6623-6625`)
and an approved instance has `current_node_key = NULL` by construction (`ApprovalGraphExecutor.ts:694`,
`:772`, `:1150`, `:1166`). There is no shipped transition from `approved` back to `pending`, and
`APPROVAL_TERMINAL_STATUSES` (`types/approval-product.ts:31`) includes `approved`.

**The FWB seam, decisive against re-opening.** FWB fires on approved completions only
(`automation-executor.ts:3014-3020`) and its idempotency key derives from
`approval:<instanceId>:<toVersion>:approval.approved` (`ApprovalCompletionEvent.ts:98`). Version
increments on every action, so a SECOND approved transition on the same instance produces a DIFFERENT
event id and therefore a SECOND writeback — in `create` mode, a duplicate record. Re-open-and-re-approve
is thus unavailable without a new cross-transition dedup contract that FWB does not have. Equally, a
post-approval revoke must never be described as undoing the write: nothing in the shipped path deletes
or reverses a delivered record.

**Recommended shape when admitted (OD-L6-3, OD-L6-4).** A distinct compensating terminal transition —
`approved` → a revoked-after-approval terminal state, never a return to `pending` — plus a fail-closed
refusal when a writeback for that instance already fired (`fwb_action_applied` is the existing evidence
surface). Corpus 2127-2131 supports a *request* rather than an immediate flip ("提交人可申请撤销"), and corpus
2130 fixes non-retroactivity, which our per-instance frozen published definition already gives
structurally; the x-天 bound additionally needs a clock-source decision and a name that is not "revoke".

### L6-C — 修改 x 天内已通过（仅一次）: DEFERRED, blocked twice

`form_snapshot` is written once at create (`:5232`) and no dispatch branch edits it — the same fact that
keeps `readonly`/`editable` inert (`types/approval-product.ts:37-53`). Modify-approved therefore needs the
named field-edit mutation surface master P4 and Lock-7 own, and it inherits L6-B's duplicate-writeback seam
because a re-approval is a second approved transition. 再次提交 is not a substitute: it is FE prefill of a
NEW instance and excludes `approved` (`ApprovalDetailView.vue:1016-1021`). The once-only carrier would be
an instance counter, but nothing may be designed for it before that surface exists.

### L6-D — 代他人提交 (proxy submit): DEFERRED as v1, cheaper than it looks

**The routing substrate already exists and already does the right thing.** `requesterOverride`
(`:4638`) is identity-only, and every attribute routing consumes is re-resolved from the DB for that
identity (`:4766-4782`, snapshot `:4942-4959`) — so the resolver reads the ACTUAL person's snapshot,
which is exactly the corpus semantics. Dual identity is free: the `created` audit row records
`actorId: actor.userId` (`:5279-5292`) while `requester_snapshot.id` is the actual person.

**Three real constraints.** (a) `requesterOverride` is reachable only behind `canManageTemplates`
*because* it is an org-structure probe vector (owner order ③, `:4630-4631`); exposing it on create widens
that surface and needs its own decision (OD-L6-6). (b) Corpus 2142 requires BOTH the proxy and the actual
submitter to be inside 发起范围; `templateVisibleAtCreateBoundary:7545` is per-user and reusable, but it is
called once today (`:5178-5183`) and `approvals:write` is checked for the actor only (`:5196`) — whether
the actual submitter must also hold write is an owner call (OD-L6-5). (c) Revoke keys on
`requesterId !== actor.userId` (`:6620`), so under proxy submit the PROXY could not revoke; corpus
"提交后将共享审批单后续状态" is ambiguous about that (OD-L6-5). Default remains OFF (corpus 2141).

### L6-E — 审批人撤回已同意 (approver retracts own approval): DEFERRED, mechanism enum required

**Window, in our terms, derived from corpus 207-209** ("审批人在下个审批人审批前，可以撤回自己已同意的审批结果并重新审批。
最后一个审批人不支持撤回"): retraction is admissible only while the instance is `pending`, the retracting
actor holds an `approve` record at a node the instance has already left, and NO decision record exists at
the instance's current node in its current `nodeEntryEpoch`. It is never admissible once the instance is
terminal, which also keeps it clear of the FWB seam.

**The cost is the derived tally, not the action.** Every consumer of an approval decision reads
`approval_records` directly: the three threshold tallies (`:6958`, `:6966`, `:6979`), the dedup cascade's
history (`:3210-3243`, `:3222`), and the revoke handled-probe (`:6636`). Retracting therefore means either
deleting audit rows — forbidden, audit rows are the only history source — or adding one exclusion
predicate to EVERY such reader in the same slice. A partial edit silently keeps a retracted approval
counted toward an N-of-M threshold or a dedup skip. The Lock-4 F4-D 回退 nullification reading is the same
family of bug, which is why the mechanism must be single and mechanical rather than per-call-site
(OD-L6-7). DingTalk card bindings (`:6340-6437`) and the Lock-1 K3 exemption both consume the same rows
and must be re-checked by whichever mechanism is chosen.

**Ownership is genuinely contested.** The corpus places 允许审批人撤回 under §5.3 审批人设置 — the same
subsection as 批量审批 / 秒批提示 / 快捷卡片, which Lock-5 owns and which this document does not touch.
L6-E is drafted here because the program assigned it, but it is a member-action policy; OD-L6-8 decides
whether it stays in Lock-6 or moves to Lock-5. Either way it is not v1.

### L6-F1 — 转发范围限制: REJECTED for v1 as an inert control

The corpus control restricts who an approval document may be 转发/分享'd to (corpus 2201-2215; the member
handbook shows it as a share affordance, `7128306615077601308.txt:395`) — a different operation from our
shipped `transfer` = 转交, handing over an approval seat (`APPROVAL_ACTION_TYPES`,
`types/approval-product.ts:19-28`). **This product has no share/forward operation**: no route exposes one
and no ad-hoc-CC action exists. A control whose governed operation does not exist is the disabled theater
M7 forbids, so it is not authored. A forwarding-scope control's subject is the instance visibility model,
which this lock neither owns, analyzes, nor claims anything about; any future share operation carries its own scoping.

### L6-F2 — 效率统计 exclusion: recommended SECOND slice, explicitly NOT part of v1

Corpus 2217-2228: 该流程数据不纳入效率统计, default unchecked, covering 团队/个人/管理员 dimensions. This one has
a real subject — `approval_metrics` rows carry `template_id`, so a template-scoped exclusion is
expressible as a filter on the aggregate readers. Its honest cost: a new column on `approval_templates`
(which is itself created by a `zzzz` migration, `zzzz20260411120100_approval_templates_and_instance_extensions.ts`,
so the new column must also be `zzzz`-prefixed to order correctly), plus filters added in ONE slice to the
three INDEPENDENT readers — `getMetricsSummary:541` (`:585`, `:618`), `getMetricsByDimension:663` (`:712`),
`getMetricsReport:745` (`:786`, `:811`). `getMetricsByRequester:737`/`getMetricsByDepartment:741` are
one-line wrappers over the second, NOT edit sites; counting them makes a per-reader mutation gate vacuous.
**Boundary, locked:** the exclusion covers aggregate/统计 readers ONLY. SLA breach detection and
notification (`checkSlaBreaches:507`,
`listBreachesPendingNotification:873`, `listActiveBreaches:904`) and per-instance metrics
(`getInstanceMetrics:853`) are NOT excluded — the corpus speaks about 效率诊断 dimensions and evidences no
suppression of breach alerting, and silently muting an operator alert from a template checkbox would be
the worse failure. Per master §P3-B ("ONE bounded Lock-6 global policy") this must not ride the L6-A PR.

## 2. Cross-cutting invariants

**2.1 Server-enforced before rendered (M7/M8).** No control above renders until its behavior is enforced
in `packages/core-backend` AND a discriminating negative exists: with the enforcement neutered, a named
test goes red. A switch whose removal breaks no test is theater. For L6-A the enforcement is
pre-existing; the gate is not waived on that account (§3 A-2).

**2.2 No shipped default may change.** Absent ≡ today's behavior for every field: absent `autoApproval`
≡ 不去重 (§1 L6-A), absent proxy policy ≡ OFF, absent exclusion ≡ included. `allowRevoke` is the one
field with NO server default — `assertRuntimePolicy:2688` requires the boolean — and L6-P1 must preserve
that rather than inventing one.

**2.3 One carrier, four sites, one slice.** A new template-policy key must move together: the publish
validator (`assertRuntimePolicy:2683-2705`), the compiler (`buildRuntimeGraph:2734-2747`), the detail read
L6-P1 adds, and the draft hydrate/serialize pair. Node-config keys additionally hit the backend rebuild's
fixed field list and the two frontend allowlists (`templateAuthoring.ts:588-596`, `:613`, `:757-770`) —
L6-A adds no node key, and the bar there is that the template stays EDITABLE, not just round-trip-safe.

**2.4 The echo never becomes authoritative.** `policy_snapshot` (`:5224`) and the DTO's `policy` (`:2433`)
are display inputs; enforcement always reads the instance's frozen published runtime graph (`:6616`).
Any policy added here follows the same split, and the FE affordance may only ever be a mirror of a
server gate.

**2.5 Every policy-driven action writes an audit row.** L6-A needs no new audit shape: a template-tier
auto-approval already records `policySource:'template'` via `buildAutoApprovalEvent:2998-3021`, persisted
by `insertAutoApprovalEvents:7882` — an observable no node-level policy can produce, which is what makes
gate A-3 discriminating. Any later policy reuses that metadata pattern.

**2.6 Unknown persisted values stay read-only (M4).** A persisted tier combination outside the projected
set — today, both booleans ON — renders read-only and saves unchanged, never flattened to a default. The same rule governs any future enum value.

**2.7 Fifth-step activation mechanics (M7 / L0-4).** Activation is a typed change to the
`AuthoringSectionId` union and the `authoringSections` array (`TemplateAuthoringView.vue:1215-1225`),
performed by the SAME PR that lands the functional L6-A control — not by L6-P1, and not by ratifying this
document. On activation `更多设置` becomes step 4 and `测试发布` becomes step 5; `测试发布` is always last
and nothing is ever inserted after it. A disabled or empty `更多设置` step is never rendered.

**2.8 Equivalence discipline: `allowRevoke` is NOT the corpus control.** Corpus 2121-2125 grants revoke of
an in-flight application, explicitly including the case where some node has already passed. Ours grants
that too — the handled-probe at `:6632-6642` is scoped to the CURRENT node key — but it additionally
refuses when the current node already carries an `approve`/`reject`/`transfer` record, which the corpus
does not evidence: a partially-decided 会签 or threshold node blocks revoke for us. `revokeBeforeNodeKeys`
(`:6626-6631`) has no corpus counterpart at all and stays unexposed (OD-L6-9). So the shipped switch is
**narrower than, not equal to,** 允许撤销审批中; no document may present it as parity, and the authoring
label stays the shipped 允许发起人撤回 (`TemplateAuthoringView.vue:201-204`).

**2.9 Values-free.** Every new error carries template id, node key and policy name only — never a person
id, membership, department, form value, or metric value. Existing payloads keep their shipped shape.

## 3. Acceptance gates

Every absence assertion carries a positive control; an absence test without one is green against nothing.
Backend gates land in the required backend lane; frontend gates extend the required web collection
(`apps/web/scripts/run-required-web-tests.sh`), never an ungated file.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| P-1 | L6-P1 policy round-trip | publish `allowRevoke:false`, reload the editor, republish without touching the control ⇒ the published policy is still `false` | the same flow with `true` stays `true` — the assertion is value-selected, not a constant |
| P-2 | L6-P1 no policy destruction | a template whose published `policy.autoApproval` was set through the API survives an editor republish unchanged | a deliberate tier change through the editor DOES change it — preservation is not inertness |
| P-3 | L6-P1 no invented default | omitting `policy.allowRevoke` on publish still fails validation at `assertRuntimePolicy:2688` | a present boolean publishes — the rejection is absence-selected |
| A-1 | L6-A tier equivalence | each of the three tiers produces its documented outcome on one shared multi-node fixture; 不去重 auto-approves nothing | each tier's own fixture DOES auto-approve where its definition says it should |
| A-2 | L6-A enforcement is real (M7/§2.1) | with the `dedupeHistoricalApprover` arm of `evaluateAutoApprovalAssignment:3091-3111` neutered, a named test goes red; likewise, independently, for the `mergeAdjacentApprover` arm `:3069-3089` | the unneutered build passes both — each arm must be individually load-bearing, not covered by its sibling |
| A-3 | L6-A precedence + audit source | a template tier governs a node with no `autoApprovalPolicy` and records `policySource:'template'`; a node carrying its own all-false policy is NOT governed | the same node WITHOUT its own policy IS governed and records `'template'` — the exemption is override-selected |
| A-4 | L6-A projection safety | switching tiers never clears `mergeWithRequester` or `actorMode` on any node; the both-ON template state renders read-only and round-trips byte-unchanged | a single-tier value renders editable — read-only is state-selected |
| A-5 | L6-A default preservation | a template with no `autoApproval` auto-approves nothing after the control ships, byte-identical to the pre-slice fixture | the same graph with a tier selected DOES auto-approve — the null result is absence-selected |
| A-6 | L6-A first-node vacuity | with any tier selected, the FIRST approval node is never auto-approved by a history flag | a later repeat node IS auto-approved — the vacuity is position-selected |
| A-7 | L6-A round-scoping (Lock-4 D-3) | A→B with the same approver and 仅连续节点 selected: after a return to A, A stays PENDING | the identical flow WITHOUT a return still auto-merges at B — the change is return-selected |
| A-8 | L6-A values-free | the tier's validation errors carry template id and policy name only | assert the SAME path DOES carry the template id — the check is not passing on an empty payload |
| M-1 | Fifth step gating | at the commit BEFORE the L6-A control lands, the wizard renders 4 steps with `测试发布` fourth and no `更多设置` node in the DOM | at the control's commit it renders 5 with `测试发布` last — activation is commit-selected, and the absence assertion is not green against a missing view |
| M-2 | No inert control | every switch rendered in `更多设置` maps to a named enforcement test; a rendered switch with no such test fails the gate | the one shipped switch has one — the census is not vacuous |
| X-1 | Unknown persisted value (M4) | a persisted both-ON tier state renders read-only and saves unchanged | a known single-tier value renders editable — the branch is value-selected |
| X-2 | Echo never authoritative | with the instance `policy_snapshot` mutated to `allowRevoke:true` on a template published `false`, revoke still 409s `APPROVAL_REVOKE_DISABLED` | the same instance under a template published `true` revokes — the refusal is runtime-graph-selected |
| F-1 | L6-F2 (second slice only) | an excluded template's instances are absent from every aggregate query site, and removing the filter from any ONE of the three INDEPENDENT readers turns a named test red — never from a wrapper, which has no filter to remove | a non-excluded template appears at every one of those query sites |
| F-2 | L6-F2 SLA boundary | an excluded template's SLA breaches are still detected and still listed for notification | a genuine non-breach is still absent — the presence assertion is not trivially true |

## 4. Owner ratification block

```text
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-17), executing recorded recommendations;
  recorded by the executing session with this provenance; reversible before implementation lands.
  Independent pre-ratify review: Claude (fable) — spot-verified the L6-P1 shipped-defect anchors
  (templateAuthoring.ts allowRevoke:true hydrate hardcode; publish sends policy:{allowRevoke} only,
  destroying API-set policy.autoApproval on republish); drafted by opus with advisor correction.
Date: 2026-08-17
Document SHA: drafted 1653922682; this record lands on top.
Decisions recorded: OD-L6-1 (a) L6-A dedup tier first · OD-L6-2 (a) v1 = L6-A + L6-P1 only ·
  OD-L6-3 (a) compensating terminal · OD-L6-4 (a) reject-when-fired · OD-L6-5 (a) proxy holds
  write, dual visibility, revoke with actual submitter · OD-L6-6 (a) keep guard, new narrow path ·
  OD-L6-7 (a) one mechanical exclusion · OD-L6-8 (a) L6-E ownership moves to Lock-5 · OD-L6-9 (a)
  revokeBeforeNodeKeys stays unexposed · OD-L6-10 (a) keep shipped label + state restriction —
  all ten per this document's recommendations. Runtime authorization: NONE (design only; L6-P1 is
  the named prerequisite slice; fifth-step activation rides the L6-A landing PR per M7/L0-4).
Decisions required ([R] = this document's recommendation; rejected options are listed so they are
not re-proposed):

  OD-L6-1  Which policy is FIRST (master §P3-B "ONE") — (a)[R] L6-A template-level dedup tier, per
           Lock-4 §2.6's nomination: the only candidate whose behavior is already server-enforced ·
           (b) L6-F2 efficiency-stats exclusion first (needs a zzzz column plus five reader edits
           before anything renders) · (c) a requester policy first [rejected §1: L6-B/C need a new
           terminal transition or an edit surface that does not exist]
  OD-L6-2  v1 subset — (a)[R] L6-A alone, with L6-P1 as its prerequisite; B-F deferred with the enums
           below · (b) L6-A + L6-F2 in one wave [contradicts §P3-B's "ONE" and weakens the M7 claim] ·
           (c) L6-A + L6-D
  OD-L6-3  L6-B revoke-window state model — (a)[R] a distinct compensating terminal transition from
           `approved`, never a return to `pending` · (b) re-open to `pending` and re-run the tail
           [rejected §1 L6-B: a second approved transition mints a new FWB event id] · (c) drop the
           capability
  OD-L6-4  L6-B FWB seam — (a)[R] reject-when-fired: refuse the post-approval revoke once a writeback
           for that instance exists · (b) compensation-required: admit it only where a named reversal
           action is configured · (c) admit it and disclose that delivered records are not reversed
  OD-L6-5  L6-D permission model — (a)[R] proxy holds `approvals:write` and BOTH parties must pass
           `templateVisibleAtCreateBoundary`; revoke stays with the actual submitter only ·
           (b) both parties must hold write · (c) proxy may also revoke ["共享审批单后续状态" is
           ambiguous; this widens a requester-only gate]
  OD-L6-6  L6-D probe surface — (a)[R] keep `requesterOverride` behind its current guard and give
           proxy submit its own narrowly-typed path · (b) expose the existing override on create
           [widens the org-structure probe vector owner order ③ isolated]
  OD-L6-7  L6-E retraction mechanism — (a)[R] one mechanical exclusion applied to every consumer of
           `approval_records` decisions, proven by mutating each reader independently · (b) per-call-site
           handling · (c) delete/rewrite the audit row [rejected §1 L6-E: audit rows are the only
           history source]
  OD-L6-8  L6-E ownership — (a)[R] move to Lock-5 with the rest of §5.3 审批人设置 · (b) keep in Lock-6
           with an explicit non-overlap clause against Lock-5's three toggles
  OD-L6-9  `revokeBeforeNodeKeys` exposure — (a)[R] leave unexposed: no corpus counterpart, and a graph
           edit can strand a listed node key and silently close the window everywhere · (b) expose with
           publish-time validation that every listed key exists in the graph
  OD-L6-10 §2.8 honesty copy — (a)[R] keep the shipped 允许发起人撤回 label and state the current-node
           restriction in the control's help text · (b) relabel toward the corpus wording [would claim
           a parity §2.8 refutes]

Decisions recorded: (pending)
Deltas: (pending)
Runtime authorization: NONE — ratifying this document would authorize design only. Each L6 slice still
  needs its own PR, required checks, adversarial gate, and ledger row. No flag, no UAT, no deployment,
  and no fifth wizard step until the L6-A control lands server-enforced.
```
