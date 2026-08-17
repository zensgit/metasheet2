# Lock-4 — Automatic Decisions, Fallback, Dedup, and Same-Person Flow Policy (2026-08-17)

**Status:** PROPOSED — NOT RATIFIED. This document authorizes nothing; §4 is blank until an explicit
owner decision names it and its SHA.
**Baseline:** `origin/main@075d078eb42dc133b1164902c95f5775863bd8ec`. Every anchor was read at THIS
baseline, which is NEWER than every parent (master pins `d33a6a0fa1`, Lock-0 pins `5b31cb4349`,
Lock-1 pins `0e8ed11671`) — line numbers are exact here and may differ from those documents'.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-4 row, §P3-A, M4,
M7, M8, M11 — this is that row's draft. §P3-A is the binding scope: *"preserve the shipped merge
flags and ratify only the missing Lock-4 semantics … Do not rebuild `mergeWithRequester`,
`mergeAdjacentApprover`, or `dedupeHistoricalApprover`."*
`approval-lock0-d0-interaction-delta-20260817.md` (RATIFIED, on main) — L0-1 places the node-level
审批类型 control in the `审批人设置` tab; L0-4 keeps the wizard at 4 steps.
`approval-lock1-enterprise-assignees-20260817.md` (PROPOSED, branch
`docs/approval-lock1-enterprise-assignees-20260817` @ `02e80020c2`, **NOT on main**) — its K3 no-dedup
seam is ruled on in F4-D, conditional on Lock-1 landing.
`approval-canvas-v2-interaction-design-lock-20260721.md` §1.2/§17 (no auto-approve/auto-reject terminal
effects) — F4-A is the first document that may change that, and only by owner decision.
**Non-effects:** no runtime code, no migration, no flag change, no tenant UAT, no deployment, no
completion label, and **no activation of the fifth wizard step** (M7 / L0-4 keep `测试发布` fourth
until a ratified global policy is implemented and server-enforced; ratifying this document is not
that). Per-node operation policy is Lock-5; new assignee kinds are Lock-1/2; the handler node is
Lock-3; `readonly`/`editable` enforcement is Lock-7.

## 0. Shipped surfaces this lock reuses (so no slice rebuilds them)

| Shipped surface | Anchor at this baseline | Lock-4 disposition |
|---|---|---|
| the merge/dedup trio, evaluated first-match | `evaluateAutoApprovalAssignment:3049-3113` — `mergeWithRequester:3062-3066`, `mergeAdjacentApprover:3069-3089` (cross-branch skip `:3116-3130`), `dedupeHistoricalApprover:3091-3111` | PRESERVED verbatim (master P3-A); F4-C maps the first, F4-D maps the other two |
| policy precedence | `getEffectiveAutoApprovalPolicy:2961-2973` — node key **present** ⇒ whole-object override (an all-false node policy DISABLES the template policy there); absent ⇒ template `runtimeGraph.policy.autoApproval` | REUSED unchanged by every family below; note the linear editor cannot author the all-false opt-out because `buildStepConfig` omits an empty policy object (`templateAuthoring.ts:989`) |
| automatic-action audit shape | `buildAutoApprovalEvent:2998-3021` → `{ policySource, originalApprover, matchedAgainst?, actorMode }`, persisted by `insertAutoApprovalEvents:7882` as `action:'approve'` (or `'sign'` when `metadata.skipped`) | REUSED as the metadata pattern for every new automatic action |
| system actor sentinels | `system:auto-approval` (`:3133-3146`), `system:approval-timeout` (`:474`) | REUSED for auto-pass; auto-reject needs a NEW sentinel (F4-A) |
| empty-assignee behavior | executor `:1019-1035` and `:1311-1327` (two copies), default `error` ⇒ `APPROVAL_ASSIGNEE_EMPTY` with `{ nodeKey }` | EXTENDED by F4-B at BOTH sites |
| terminal automatic effects | `NODE_TIMEOUT_SUPPORTED_EFFECTS:465` excludes auto_*; publish rejects them `:1349-1355`; `APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS:469` ships CLOSED; the scanner leaves auto_* rows un-fired (`ApprovalSlaScheduler.ts:248-250`) | the governing precedent F4-A must answer to |
| departed-approver handling | `bulkReassignApprovals:5648` — an admin moves a user's pending seats | the shipped sanctioned path; F4-E must not duplicate it |

## 1. Contracts

### F4-A — Node-level automatic decision (审批类型: 人工 / 自动通过 / 自动拒绝)

**Carrier.** `ApprovalNodeConfig.approvalType?: 'manual' | 'auto_approve' | 'auto_reject'`, absent ≡
`'manual'` ≡ today's behavior (byte-stable for existing graphs). It is a CONFIG field on
`type:'approval'`, **not a new node type** (OD-L4-1): a new type touches all three executor node-type
walks (`ApprovalGraphExecutor.ts:877`, `:1011`, `:1303`) plus `totalSteps` (`:667-673`) — Lock-3 blast
radius for a semantic needing none of it — and `type:'approval'` keeps the node countable in
`totalSteps`, which is what an ordinary user reads as "step 3 of 5".

**Forbidden placements, publish-time 400 at the authoring choke.** `approvalType` on
`start`/`end`/`cc`/`condition`/`parallel` is rejected (separate config unions; they must not grow the
key). A non-`manual` node inside a parallel region is rejected in v1, mirroring `threshold`'s
linear-only restriction (`types/approval-product.ts:113-120`) and
`APPROVAL_NODE_TIMEOUT_PARALLEL_UNSUPPORTED` (`ApprovalProductService.ts:1367-1371`): an automatic
decision inside a branch interacts with join accounting and the cross-branch skip guard (`:3116-3130`),
and that interaction is not designed here. A non-`manual` node may still be a condition-branch TARGET —
routing is unchanged, the node simply decides without a human.

**auto_approve.** On activation the node emits an auto-approval event and advances, exactly as the
shipped `emptyAssigneePolicy:'auto-approve'` arm does (executor `:1020-1029`), with a new reason
`auto-node-approve` on `ApprovalAutoApprovalReason`. Assignee resolution is SKIPPED, so an empty source
list is legal here and only here; the actor is the shipped `system:auto-approval` sentinel. **The event
records NO `originalApprover`** — a node the product decided is not evidence that any person approved,
and recording one would let `dedupeHistoricalApprover` (F4-D) later bypass a node that person was
genuinely meant to review. This also keeps Lock-1 G-11's sentinel-drop correct without amendment.

**auto_reject is NOT the mirror image** (OD-L4-2). It is the only construct here producing a TERMINAL
instance state, and the shipped machinery cannot carry it: `insertAutoApprovalEvents:7882` writes only
`action:'approve'|'sign'`, `ApprovalAutoApprovalReason` is a closed approve-side union, no shipped path
sets `status='rejected'` without a human actor, and the §0 terminal-effects row shows the owner already
declining terminal automation once. If admitted it needs a NEW sentinel `system:auto-reject` (never
reusing `system:auto-approval`), a reject-side audit path, and Lock-1's sentinel drop list (K3 / G-11)
extended in the SAME slice — a cross-lock obligation named here, not discovered during implementation.

### F4-B — Expanded empty-assignee fallback (审批人为空时)

`EmptyAssigneePolicy` (`types/approval-product.ts:18`) grows from `'error' | 'auto-approve'` to add
`'designated'`, with `emptyAssigneeUserIds: string[]` / `emptyAssigneeRoleIds: string[]` on the node
config through typed pickers only (D0 §10.2). `'error'` stays the absent default.

**转审批管理员 is deferred, with a named blocker (OD-L4-3).** There is **no shipped reverse lookup from
a permission code to a user set** at this baseline: `approval-templates:manage` /
`approvals:admin-templates` are only ever checked FORWARD against one actor
(`routes/approvals.ts:59`, `:195-196`; `ApprovalProductService.ts:4660-4661`), and the nearest
precedents are also single-actor probes (`attendance/w4c3b-central-approval-hooks.ts:300-327`,
`attendance/w4c3a-import-rollback-boundary.ts:237-265`). A reverse enumeration would have to union the
three grant channels visible in that probe (`user_permissions`, `user_roles`⋈`role_permissions`, a
`users` JSONB `permissions` array), expand wildcards (`approvals:*`, `*:*` — sweeping every super-admin
into an approval seat), and invent an org scoping those tables do not carry. Recommendation is
`'designated'` only: an author wanting 转审批管理员 designates the approval-admin ROLE — the same outcome
through a curated, auditable, values-free reference. A curated per-org admin table (the Lock-1
OD-L1-2(a) pattern, empty by default) is the option if the owner wants the label itself.

**Fallback is exactly ONE non-recursive step (locked).** If `'designated'` itself resolves to zero
active assignees — empty list, deactivated ids, role with no members — the node terminates at the
shipped `APPROVAL_ASSIGNEE_EMPTY` 400 carrying `{ nodeKey }` only: never chaining to `'auto-approve'`,
never falling back to a manager, never retrying. A fallback that can fall back again is how an empty
org read silently auto-approves, the exact fail-open the B5-b guard closed.

**Both executor sites or neither.** The empty-assignee block is DUPLICATED at
`ApprovalGraphExecutor.ts:1019-1035` (initial/forward resolution) and `:1311-1327`
(`resolveAfterApprove`); a one-sided edit is the predictable failure, and gate B-3 exercises both.

### F4-C — Same-person policy (审批人=提交人)

Enum `samePersonPolicy?: 'self_approve' | 'auto_skip' | 'transfer_direct_manager' |
'transfer_dept_head'`, absent ≡ `'self_approve'` ≡ today's behavior when `mergeWithRequester` is off.

**Mapping to the shipped flag, which is preserved.** `mergeWithRequester:true` (`:3062-3066`) IS the
自动跳过 family: the requester's own seat is auto-approved away with reason `auto-merge-requester`. It is
retained as the *implementation* of `'auto_skip'` and stays the persisted carrier for that value, so no
existing graph changes shape. The two transfers are the genuinely new values.

**Level: NODE, inside the existing `autoApprovalPolicy` object (OD-L4-4).** The justification is
precedent, not preference: the §0 precedence row is already a node-over-template whole-object override
for exactly this policy family, and a template-level default reaches every node through its
`runtimeGraph.policy.autoApproval` arm at no extra cost. Putting the enum elsewhere creates a second,
differently-shaped precedence rule for a semantic that composes with `mergeWithRequester` on one node.

**Transfer resolution needs no new snapshot read.** The target is the *requester's* manager or
department head, both already frozen at create as `managerId` / `deptHeadId`
(`ApprovalDirectoryOrg.ts:481-484`), so resolution stays a pure function of the frozen snapshot (Lock-1
§2.1) — the one same-person option costing nothing at dispatch. The transferred seat keeps the
originating `resolvedFrom.kind` and gains `metadata.samePersonTransfer: { from: <requester>, policy }`,
so "why is this person here" stays answerable from the row.

**Absent transfer target** (no linked directory account, no manager, or a manager who IS the
self-excluded requester): the seat is simply not produced, and if the node then has no assignee at all
`emptyAssigneePolicy` (F4-B) governs — one mechanism for emptiness, per Lock-1 §2.6. It must NOT fall
back to `'self_approve'`, which hands the approval to the person the policy exists to exclude (OD-L4-5).

**Interaction with `dedupeHistoricalApprover`.** Evaluation is first-match in shipped order (`:3062`
before `:3091`), so a requester seat is disposed of by the same-person policy before any history flag
sees it. `'transfer_direct_manager'` can produce a manager who ALSO approved earlier; the history flags
then apply to that manager normally. That is intended, and is stated so it is not later called a bug.

### F4-D — Dedup tiers (去重三档) and the Lock-1 K3 ruling

| Corpus tier | Shipped carrier | Exact shipped predicate | Verdict |
|---|---|---|---|
| 仅连续节点 | `mergeAdjacentApprover` | the LATEST history entry whose `nodeKey !== this node` has `actorId === this assignee` (`:3069-3089`) | ≈ MATCHES, with the caveat below: "adjacent" is *consecutive in decision order*, not graph adjacency |
| 仅一次全自动同意 | `dedupeHistoricalApprover` | ANY earlier entry with a different `nodeKey` and the same `actorId` (`:3091-3111`) | MATCHES "any earlier node" |
| 不去重 | both flags false/absent | `hasEnabledAutoApprovalRule:2856-2862` returns false ⇒ no effective policy ⇒ no auto-approval | ALREADY EXPRESSIBLE — no new field needed |

Caveat, stated because it bounds what the UI may claim: history is every `action='approve'` record for
the instance ordered by time (`loadApprovalHistory:3210-3243`), so "latest from another node" is a
temporal predicate. Between two approval nodes, `cc`/`condition`/`parallel` nodes write no approve rows
and so do not break adjacency — matching the ordinary-user reading. Inside a parallel region "latest"
is branch-arbitrary, which is exactly why the cross-branch skip guard exists (`:3116-3130`). At create
the cascade is handed an EMPTY history (`:5134`), so neither history flag can fire at the first node;
only `mergeWithRequester` can.

**Invalidation conditions — the shipped implementation does NOT honor them.** The corpus records the
tiers as invalidated by 内容变更 or 回退.

- *回退*: `loadApprovalHistory` applies no epoch, round, or return filter, and the return path feeds
  that unfiltered history into the cascade (`:6740`) after minting a fresh activation epoch (`:6764`).
  Reading those together: with `mergeAdjacentApprover` on and a graph A→B whose approver is the same
  person at both nodes, a return to A re-resolves A, finds the pre-return approval at B by that actor
  and auto-approves A — after which B auto-merges again and the return is nullified with no human in
  the loop. **Reachability, stated exactly:** `mergeAdjacentApprover` is not FE-authorable
  (`templateAuthoring.ts:968-978` writes only `mergeWithRequester`) but IS settable through the
  documented graph API and round-trip preserved (`BACKEND_AUTO_APPROVAL_POLICY_KEYS:613`,
  `originalAutoApprovalPolicy:502`) — reachable via the API, not via the shipped UI, and not dead code.
  **This document did not execute that trace**; it is a code reading, and gate D-3 is what would prove
  or refute it. **Locked requirement:** any slice making a dedup tier authorable must FIRST scope the
  history the flags read to the current post-return round (the `nodeEntryEpoch` machinery at `:5273`,
  `:6764`, `:7195` already does this for the threshold tally at `:6975-6985`), or state in the authoring
  copy that returns do not invalidate prior approvals. Shipping the switch without one is forbidden.
- *内容变更*: **vacuous at this baseline and therefore deliberately ungated.** `form_snapshot` is written
  once at create (`:5209`) and never updated; no mid-flight form-mutation surface exists, so a gate here
  would be green against nothing. It is locked instead as a FORWARD obligation: the first named
  field-edit surface (Lock-7 / master P4 handler node) must invalidate dedup history in the same slice
  that creates it.

**Config level and shape (OD-L4-6).** The tiers keep the §0 precedence unchanged. Two booleans give four
states against three tiers, and with both history flags ON the first-match order makes the recorded
reason ALWAYS `auto-merge-adjacent`, so the audit row cannot report which tier was configured. The
recommended shape is a frontend 3-way radio projected over the two existing booleans, the fourth
(both-ON) state rendered read-only and labelled honestly: zero contract change, zero migration, P3-A
compliant. The projection MUST use the delete-key-keep-siblings pattern of
`setApprovalNodeMergeWithRequester` (`TemplateAuthoringView.vue:2013-2024`) so switching tiers never
clears `mergeWithRequester` or `actorMode`.

**Ruling on the Lock-1 K3 seam (OD-L4-7), conditional on Lock-1 landing.** Lock-1 §K3 asks whether a
default historical-dedup policy applies to `prior_node_approver`. **Ruling: `prior_node_approver`-derived
assignments are EXEMPT from BOTH history-derived flags — `mergeAdjacentApprover` and
`dedupeHistoricalApprover` — and remain subject to `mergeWithRequester`.** Lock-1's framing was narrower
than the hazard: `mergeAdjacentApprover` is the worse of the two, because the referenced node is
typically the immediately preceding decision, so an unexempted K3 seat would be auto-approved away
essentially every time — making the kind inert rather than merely deduplicated. `mergeWithRequester` is
not history-derived and is a separate org policy, so it continues to apply. The mechanism needs no new
plumbing: `ApprovalGraphAssignment.metadata` (`ApprovalGraphExecutor.ts:25-31`) carries
`resolvedFrom.kind`, readable at `ApprovalProductService.ts:3049-3111`.

### F4-E — Departure fallback (离职自动转上级)

**The blocking constraint, stated first.** The departed person is an arbitrary approver, not the
requester. Their manager is NOT in the frozen requester snapshot, and Lock-1 §2.1 forbids a database
call inside the resolver — so "resolve the departed approver's manager at dispatch" is unavailable
without breaking resolver purity for every approval.

**Recommended shape (OD-L4-9): out-of-band, not in-resolver.** Model it on the shipped SLA transfer
effect — a departure signal moves the departed user's ACTIVE assignments to a manager resolved by a live
read at that moment, in its own transaction, single-shot, keeping the SAME node-entry epoch (the
MUTATION posture of the timeout transfer at `:6078`), with a NEW sentinel `system:approval-departure`
and the `buildAutoApprovalEvent` metadata shape. This keeps the resolver pure, reuses
`applyNodeTimeoutEffect`'s race and consumption discipline (`:5963` onward), and does not duplicate
`bulkReassignApprovals:5648`, which stays the admin-driven path.

**Detection source (OD-L4-8) — with honest limits.** The candidate signal is the directory deprovision
planner's `user_changed` effect (`directory/deprovision-planner.ts:8`, `:82-95`, emitted at `:178-186`),
the per-user local-deactivation outcome counted as `usersDeactivatedCount`
(`directory/directory-sync.ts:1664-1666`). Three disclosures that must not be lost: it is produced ONLY
under the `mark_inactive` policy (`manual_review` returns zero effects at `:126-131`); ONLY when
`globallyClear` — no other active linked directory account anywhere — so a user leaving one of two orgs
produces nothing; and the whole application path is env-gated by `DIRECTORY_DEPROVISION_ENABLED`,
default off (`directory-sync.ts:1325`, `:1337`). A fallback keyed on this signal therefore does not fire
for every org, and the authoring copy may not say 离职自动转上级 works universally. Local
`users.is_active=false` is the alternative trigger but is an ops action (a reversible suspension), not a
departure, and is NOT recommended.

**Interaction with delegation.** Delegation substitution happens inside `pushResolved` BEFORE the dedup
key (`ApprovalAssigneeResolver.ts:99-131`) and is frozen at create, so a departing DELEGATOR's seats are
already held by the delegatee and must NOT be transferred again. The fallback applies to the
assignment's CURRENT assignee only; a row whose `metadata.delegatedFrom` is the departed user is out of
scope.

**Fail-closed default when no manager exists (locked, not an enum).** The assignment is LEFT IN PLACE
and an audit row plus operator warning is emitted — never auto-approved, never dropped, never escalated
to an admin seat. Auto-approving a task because its approver left is the worst available outcome and no
option in this document offers it.

## 2. Cross-cutting invariants

**2.1 Server-enforced before any switch renders (M7/M8).** No control above may render until its
behavior is enforced in `packages/core-backend` AND a discriminating negative exists: with the
enforcement neutered, a named test must go red. A switch whose removal breaks no test is theater.

**2.2 The two enable-predicates are the silent-inert trap.** `hasEnabledAutoApprovalRule:2856-2862` and
`runtimeGraphHasAutoApprovalPolicy:2975-2982` are both three-flag ORs over
`mergeWithRequester|mergeAdjacentApprover|dedupeHistoricalApprover`. Any new `AutoApprovalPolicy` field
— `samePersonPolicy` included — that does not extend **both** is silently inert: the first makes
`getEffectiveAutoApprovalPolicy` return `null` for that node, the second skips the cascade for the whole
instance. Extending both is a locked requirement with a mandatory gate (X-1).

**2.3 Enum widening moves four frontend sites in ONE slice.** Widening `EmptyAssigneePolicy` (F4-B) or
`ApprovalMode` hits: the linear hydration FLATTEN at `templateAuthoring.ts:500`
(`config.emptyAssigneePolicy === 'auto-approve' ? … : 'error'` — a new value silently becomes
`'error'`); the linear unsupported-config guard at `:755-787`, which checks KEY presence and never
values, so it does not catch that flatten; and the two canvas validators at `approvalNodeEdit.ts:166-171`,
which REJECT an out-of-enum value and block the save. The hazards differ and both must be named: the
linear path flattens; the canvas path preserves the value (`:72`, `:96`) but refuses to save. Per master
M4, unknown persisted values round-trip read-only and are never flattened to a default.

**2.4 Values-free.** Every new error carries node key, source index, and policy name only — no person id,
group membership, form value, or resolved manager identity. `APPROVAL_ASSIGNEE_EMPTY` keeps its shipped
`{ nodeKey }` payload exactly.

**2.5 Every automatic action writes an audit row**, reusing the §0 `buildAutoApprovalEvent` metadata
pattern, with `originalApprover` present ONLY where a real person's seat was consumed — never for a
node-type auto-pass (F4-A). New reasons extend `ApprovalAutoApprovalReason`; the member timeline must
render an unknown reason as a neutral labelled row rather than dropping it.

**2.6 First global-policy candidate for P3-B.** The template-level dedup tier (F4-D on
`runtimeGraph.policy.autoApproval`) is the natural first 更多设置 control: the corpus places 去重 in
更多设置, and a template-level carrier already exists and already executes. This document NOMINATES it and
nothing more — P3-B selects and ratifies its own Lock-6 policy, and the fifth step activates only after
that control is landed and server-enforced.

## 3. Acceptance gates

Every absence assertion carries a positive control; an absence test without one is green against
nothing. Backend gates land in the required backend lane; frontend gates extend the required web
collection (`apps/web/scripts/run-required-web-tests.sh`), never an ungated file.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| A-1 | F4-A placement | `approvalType` on start/end/cc/condition/parallel, and any non-`manual` node inside a parallel region, fail publish 400 | a non-`manual` linear approval node publishes — the rejection is placement-selected |
| A-2 | F4-A auto-pass | an `auto_approve` node advances with reason `auto-node-approve`, resolves NO assignees, and still counts in `totalSteps` | the same graph with `approvalType` absent holds pending for a human |
| A-3 | F4-A no historical residue | after an `auto_approve` node, a later node assigned to any real user is NOT auto-approved by `dedupeHistoricalApprover` | a genuine human approval at that same position DOES trigger the dedup — the exemption is event-selected |
| A-4 | F4-A auto-reject sentinel (only if OD-L4-2 admits it) | an auto-rejected instance records `system:auto-reject`, never `system:auto-approval`, and Lock-1's sentinel drop list rejects it too | a human reject in the same fixture records the human |
| B-1 | F4-B designated fallback | an empty primary source with `'designated'` dispatches to the designated set at BOTH executor sites (initial resolution and `resolveAfterApprove`) | `'error'` on the identical fixture still throws `APPROVAL_ASSIGNEE_EMPTY` |
| B-2 | F4-B no chaining | `'designated'` resolving to zero active users terminates at `APPROVAL_ASSIGNEE_EMPTY` with `{ nodeKey }` only; it never becomes auto-approve | a non-empty designated set dispatches — the failure is emptiness-selected |
| B-3 | F4-B one-sided-edit guard | mutating ONLY `ApprovalGraphExecutor.ts:1019-1035` turns a named test red, and so does mutating ONLY `:1311-1327` | each mutation must fail some named test; neither may pass silently |
| C-1 | F4-C auto_skip parity | `samePersonPolicy:'auto_skip'` produces events byte-identical to today's `mergeWithRequester:true` | `'self_approve'` leaves the requester's seat pending |
| C-2 | F4-C transfer purity | the transfers resolve from the FROZEN `managerId`/`deptHeadId`; no directory query runs during dispatch | a directory change after create does NOT move the seat, but DOES move it for a newly created approval |
| C-3 | F4-C absent target | with no manager in the snapshot the seat is not produced and `emptyAssigneePolicy` governs; it never falls back to self-approve | a snapshot WITH a manager produces the transferred seat |
| D-1 | F4-D tier equivalence | each of the three tiers produces its documented outcome on a shared fixture; 不去重 auto-approves nothing | each tier's own positive control approves where it should |
| D-2 | F4-D projection safety | switching tiers never clears `mergeWithRequester` or `actorMode`; the both-ON state renders read-only and round-trips unchanged | a single-tier value renders editable — read-only is state-selected |
| D-3 | F4-D return invalidation | the F4-D 回退 trace executed end to end: A→B, same approver, `mergeAdjacentApprover` on, return to A — assert the ratified behavior (round-scoped ⇒ A stays pending) | the identical flow WITHOUT a return still auto-merges at B — the change is return-selected |
| D-4 | F4-D K3 exemption (only if Lock-1 lands) | a `prior_node_approver`-derived assignment is consumed by neither history flag | a `static_user` assignment for the SAME person in the same fixture IS consumed — the exemption is kind-selected |
| E-1 | F4-E transfer | a departure signal moves the departed user's active seats to the resolved manager, same epoch, with the `system:approval-departure` sentinel and an audit row | a non-departed assignee's seats are untouched in the same run |
| E-2 | F4-E fail-closed | with no manager resolvable the assignment is UNCHANGED; no approval, rejection, or drop occurs | the resolvable case in the same fixture DOES transfer |
| E-3 | F4-E delegation | a seat already substituted by delegation is not transferred again on the delegator's departure | the delegatee's OWN departure does transfer that seat |
| X-1 | Enable-predicate | a node carrying ONLY a new `AutoApprovalPolicy` field executes that policy | a node with no policy at all still skips the cascade — proving the predicate widened rather than disappeared |
| X-2 | Unknown value round-trip | a persisted `emptyAssigneePolicy` / `samePersonPolicy` outside the frontend enum renders read-only and saves unchanged on BOTH the linear and canvas paths | a known value renders editable — the branch is value-selected |
| X-3 | Values-free | every new error path's message and details carry no person id, membership, or form value | assert the SAME path carries the node key — the check is not passing on an empty payload |
| X-4 | Enforcement is real (M7) | for every rendered switch, neutering its server enforcement turns a named test red | the unneutered build passes that same test |

## 4. Owner ratification block

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision: <RATIFY | REQUEST CHANGES | REJECT>
Owner:
Date:
Document SHA:
Decisions required ([R] = this document's recommendation; rejected options are listed so they are
not re-proposed):

  OD-L4-1  F4-A carrier — (a)[R] `approvalType` config field on type:'approval' · (b) new node type(s)
           (three executor walks + totalSteps + parallel guards = Lock-3 blast radius)
  OD-L4-2  F4-A auto_reject — (a)[R] auto_approve only in v1, auto_reject deferred to its own owner
           decision · (b) both, auto_reject behind a default-CLOSED env gate mirroring
           APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS · (c) both ungated [rejected §F4-A: terminal
           automation was already declined once]
  OD-L4-3  F4-B admin fallback — (a)[R] 'designated' only, 转审批管理员 expressed by designating the
           approval-admin role · (b) curated per-org approval-admin table (Lock-1 OD-L1-2(a) pattern,
           empty by default) · (c) permission-code reverse enumeration [rejected §F4-B: no shipped
           reverse query, three grant channels, wildcard holders, no org scoping]
  OD-L4-4  F4-C level — (a)[R] node-level enum inside the existing autoApprovalPolicy override
           precedence · (b) template-level only · (c) a new, separately-shaped precedence rule
           [rejected §F4-C: two precedence rules for one composing family]
  OD-L4-5  F4-C absent transfer target — (a)[R] seat not produced, emptyAssigneePolicy governs ·
           (b) fail create 422 · (c) fall back to self_approve [rejected §F4-C: hands the approval to
           the person the policy exists to exclude]
  OD-L4-6  F4-D tier shape — (a)[R] frontend 3-way radio projected over the two shipped booleans,
           both-ON state read-only, zero contract change · (b) discrete `dedupTier` enum deriving the
           booleans (a fifth key and two sources of truth) · (c) booleans as-is, no tier presentation
  OD-L4-7  F4-D K3 seam (conditional on Lock-1 landing) — (a)[R] exempt prior_node_approver from BOTH
           history-derived flags, mergeWithRequester still applies · (b) exempt from
           dedupeHistoricalApprover only (Lock-1's narrower framing) · (c) no exemption [rejected
           §F4-D: mergeAdjacentApprover would make the kind inert]
  OD-L4-8  F4-E detection source — (a)[R] directory deprovision `user_changed` effect, with the
           mark_inactive-only, globallyClear-only and DIRECTORY_DEPROVISION_ENABLED limits disclosed
           in the authoring copy · (b) local users.is_active=false (an ops suspension, not a
           departure) · (c) both
  OD-L4-9  F4-E timing — (a)[R] out-of-band on the departure signal, modelled on the SLA transfer
           effect, resolver stays pure · (b) at dispatch via a live read [breaks Lock-1 §2.1 purity
           for every approval] · (c) at action-attempt [the departed user can never act, so the task
           deadlocks until an admin intervenes — today's behavior]

Deltas:
Runtime authorization: NONE unless explicitly stated — ratifying this document authorizes design
  only. No flag, no UAT, no deployment, no runtime capability, and no fifth wizard step.
```
