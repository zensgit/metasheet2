# Lock-3 — Handler / Business-Operation Node and Its Mutation Boundary (2026-08-17)

**Status:** PROPOSED — NOT RATIFIED. This document authorizes nothing; §5 is blank until an explicit
owner decision names it and its SHA.
**Baseline:** `origin/main@2f4bf6ce3ea49ea01b31c352aab70d32d162b9f7`. Every anchor below was READ AT
THIS BASELINE, which is newer than the master lock (`d33a6a0fa1`), Lock-0 (`5b31cb4349`) and Lock-1
(`0e8ed11671`); line numbers are exact here and may differ from those documents' own citations.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-3 row, §P4, M4, M8, M11
— this is that row's draft; `approval-lock0-d0-interaction-delta-20260817.md` (RATIFIED, **on main at
this baseline**, so Lock-1's "conditional on Lock-0 landing" caveat does not apply here) L0-1/L0-2/L0-6;
`attendance-approval-s7-resolver-direct-manager-dept-head-multilevel-design-lock-20260716.md` (RATIFIED)
— unimplemented fails closed 422 at authoring AND runtime, never inert;
`approval-canvas-v2-interaction-design-lock-20260721.md` §10.2/§10.3 (typed pickers, one picker).
**Conditional parents (NOT on main — every seam citing them is conditional):** Lock-1 (PR #4940) for new
assignee kinds; Lock-4 (PR #4941) for the fallback/dedup/departure vocabulary.
**Non-effects:** no runtime code, no migration executed, no flag change, no tenant UAT, no deployment,
no completion label; each slice still needs its own PR, required checks, and named human approval.
`readonly`/`editable` ENFORCEMENT is Lock-7 — named as a seam here, not designed; per-node operation
policy is Lock-5.

## 0. Corpus evidence, and its one internal conflict

Corpus = the offline Feishu administrator handbook (`feishu/6933484342190538780.txt`) §4.5 办理节点 lines
1907-2060, §5.3 line 2199, dedup note line 2175, designer IA line 1514; and the member handbook
(`feishu/7128306615077601308.txt`) §2.4 lines 224-236 and §3.2 lines 313-330. Master M11 governs the
language: "the reference corpus did not evidence", never "the competitor lacks".

| # | Corpus statement | Line | Lock-3 disposition |
|---|---|---|---|
| C-1 | 办理人 is a node inserted from the same edge `+` menu as 审批人/抄送人/条件分支 | 1514, 1911 | §1.5 registry row |
| C-2 | own handler roster: 上级(±n)/部门负责人(±n)/角色/用户组/指定成员(≤25)/提交人自选/提交人本人/表单内联系人/表单内部门 | 1919-1990 | §1.5 subset — 节点审批人 and both 连续多级 kinds are ABSENT from it |
| C-3 | multi-handler modes: 会签 (all submit) / 或签 (any one submits). No 依次, no threshold | 1992-2003 | §1.1 `handlerMode: 'all' \| 'any'` |
| C-4 | empty handler: 指定人员办理 / 转交给审批管理员. **No auto-pass arm** | 2005-2018 | §1.1/§1.2 — v1 carries no fallback key; auto-pass inadmissible; Lock-4 F4-B seam |
| C-5 | departed handler auto-transfers to their 上级 | 2019 | Lock-4 F4-E seam (§2.2); NOT designed here |
| C-6 | handlers are exempt from approver dedup — the same person handles at every node | 2175 | §2.4 dedup exemption |
| C-7 | per-node form permission has BOTH 可读 and 可编辑 (default all checked); 操作权限 = 允许转交 (default ON) + 办理意见 (default OFF) | 2022-2048 | §1.1 `fieldPermissions` + opinion policy; §2.2 transfer; §3 |
| C-8 | handler time is NOT counted in efficiency diagnostics (team/personal/admin), and handler nodes support neither 批量操作, 秒批提示, nor 快捷审批 | 2050, 2199 | §2.5; §2.2 |
| C-9 | member surface at a handler node is exactly 提交 and 转交 — no 同意/拒绝 button described | 313-330 | §2.2 — no reject verb |

**The conflict, recorded verbatim so it is not quietly resolved later.** C-7's 办理意见 row reads
`勾选后，办理人无论同意还是拒绝，均需填写办理意见` — the only place in the handler spec implying a
two-outcome decision. It contradicts C-3 (`所有办理人完成提交，该节点才通过` — the verb is 完成提交)
and C-9 (提交 and 转交 only). The reading taken here is that the sentence is boilerplate reused from
the approval node's identical 审批意见 row, since both handbooks describing handler *behavior* say
submit-only. **That reading is a judgement, not a proof**, so the reject verb is OD-L3-7 rather than a
silent decision. v1 ships submit-only.

## 1. Node contract

### 1.1 Type and config shape

`ApprovalNodeType` gains a seventh member `'handler'` (three mirror sites, R-1).

```ts
type HandlerNodeConfig = {
  assigneeSources: ApprovalAssigneeSource[]        // §1.5 subset; the ONLY assignee carrier — no legacy assigneeType/assigneeIds pair
  handlerMode?: 'all' | 'any'                      // absent ≡ 'all'
  opinionRequired?: boolean                        // 办理意见; absent ≡ false (corpus C-7 default)
  fieldPermissions?: NodeFieldPermission[]         // same shape as approval nodes; enforcement is Lock-7
}
```

**No empty-assignee/fallback key exists on a handler node in v1** — deliberately, so Lock-3 mints no
second vocabulary for Lock-4 to supersede and no inert switch reaches the inspector (M4/M7). Empty
resolution is the shipped `APPROVAL_ASSIGNEE_EMPTY` 400 (§2.2).

`handlerMode` is a NEW key, not a reuse of `ApprovalMode`, for two mechanical reasons: reuse drags
`single`/`threshold` (and, if Lock-1 K6 lands, `sequential`) into a node type the corpus evidences none
of them for, and it inherits `normalizeApprovalMode` (`ApprovalGraphExecutor.ts:291-293`), which
silently maps ANY unrecognized mode to `'single'` — the fail-OPEN Lock-1 K6 must fix before it becomes
reachable. `handlerMode`'s own normalizer fails closed from line one. Absent ≡ `'all'` because `'any'`
is the weaker guarantee and the corpus states no default.

### 1.2 Prohibitions enforced at the authoring choke, not in the UI

The criterion is master M4 / the S7 precedent: *would a misconfiguration be REJECTED today*, not *would
we author it*. Each row is a `failValidation`/`ServiceError` arm in the new `case 'handler':` of
`normalizeApprovalGraph`'s switch (`ApprovalProductService.ts:1764`), gated by G-7.

| Rejected on a `handler` node | Why | Error |
|---|---|---|
| ANY empty-assignee or fallback key — `emptyAssigneePolicy` (any value, `'auto-approve'` included) and, once Lock-4 lands, `emptyAssigneeFallback` until its handler arm is ratified | corpus C-4 evidences no auto-pass arm; auto-skipping 财务打款/盖章 means the work did not happen — a genuine fail-open, not a UI gap. Rejecting on key PRESENCE is what keeps v1 free of a second vocabulary | `APPROVAL_HANDLER_CONFIG_INVALID` |
| `handlerMode` outside `{'all','any'}` — `'single'`, `'threshold'`, `'sequential'` named explicitly | corpus C-3 | `APPROVAL_HANDLER_MODE_INVALID` |
| `approvalMode` / `approvalThreshold` / `autoApprovalPolicy` / `assigneeType` / `assigneeIds` | approval-node keys; a handler that silently carried them would be read as an approval node by every reader keyed on config shape | `APPROVAL_HANDLER_CONFIG_INVALID` |
| `timeout` | v1 CONFIRM-EXCLUDE: `validateNodeTimeoutConfigs` (`:1317-1420`) restricts `transfer`/`jump` to approval nodes (`:1385-1388`) and the scanner's single-cursor deadline model is untested for a node type that is not in `approvalNodeOrder` | `APPROVAL_HANDLER_CONFIG_INVALID` |
| a request payload carrying the reserved field-write key (§3) | Lock-7 has not landed | 422 `APPROVAL_HANDLER_FIELD_WRITES_UNSUPPORTED` |

An empty `assigneeSources` array is rejected at authoring — a handler with nobody to handle it is a
publish-time error, never a dispatch-time surprise. A source that RESOLVES empty at dispatch is the
different case and terminates at `APPROVAL_ASSIGNEE_EMPTY` (§2.2).

### 1.3 Topology legality

**Legal:** anywhere on the main path between `start` and `end`, and inside a `condition` branch body,
with exactly one incoming and one outgoing edge (mirroring the approval-node degree rule the FE linear
projector already asserts, `apps/web/src/approvals/templateAuthoring.ts:553`).

**Illegal in v1, publish-time 400:** inside a parallel region (any branch body) and as a parallel
`joinNodeKey`. Checked with the SHIPPED primitive `collectParallelRegionNodeKeys`
(`ApprovalProductService.ts:1276-1302`) — already node-type agnostic, already used this way for node
timeouts at `:1366`/`:1413` — plus a `joinNodeKey` equality test; no new walker is written. FE mirror:
the edge-insert menu hides 办理人 on any edge for which `isEdgeInsideParallelRegion`
(`apps/web/src/approvals/approvalCanvasCommands.ts:86-91`) is true.

Justification, in order of force. (1) The runtime hazard is concrete: `collectAllBranchAssignees`
(`:2137`, arm `:2158-2159`) and the fingerprint gate (`assertNoParallelDynamicAssigneeConflicts`,
`:1484-1530`, arm `:1510`) BOTH skip non-`approval` nodes, so a handler in one branch sharing an assignee
with a sibling branch is invisible to every publish-time cross-branch gate and collides only at runtime
(§1.4). (2) Three linear-only precedents exist for exactly this reason: `threshold`
(`types/approval-product.ts:113-120`, enforced `:2116-2122`), Lock-4 F4-A, Lock-1 K6. (3) The corpus
cannot advise — its designer has no parallel branch at all — so nothing is narrowed relative to it.
Widening is OD-L3-1 and must first extend the two gates in (1), not merely delete the placement check.

### 1.4 Assignment identity — corrected, and a genuine fork

A prior survey asserted a 4-column `UNIQUE (instance_id, assignment_type, assignee_id, source_step)`
(`zzzz20260404100000_extend_approval_tables_for_bridge.ts:95`). **That constraint no longer exists:**
`zzzz20260411120100_approval_templates_and_instance_extensions.ts:128-145` drops every unique CONSTRAINT
on `approval_assignments` and replaces it with the partial index `idx_approval_assignments_active_unique
ON (instance_id, assignment_type, assignee_id) WHERE is_active = TRUE`; no later migration touches it.
Three consequences, and only these. **Sequential handler nodes are safe** — one node is active at a
time, so the same person legally holds a fresh seat at each in turn, exactly what corpus C-6 requires.
**Concurrently-active duplicates are the hazard**, guarded by `assertNoActiveAssignmentConflicts`
(`:7821-7874`, typed 409 `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT`, itself gated at `:7827` on at
least one dynamically resolved assignment) with the partial index as the last line for static
duplicates — the runtime failure §1.3 forbids by placement. **`source_step` is therefore an
ordering/reporting field for handlers, not an identity field:** `stepIndexForNode`
(`ApprovalGraphExecutor.ts:1361-1364`) returns `0` for any node absent from `approvalNodeOrder`, so
every handler seat — including one from `buildTransferAssignments` (`:907-915`) — lands in one
`source_step = 0` bucket, which `AttendanceDecisionTrace.ts:1598` reads with `ORDER BY source_step ASC,
created_at ASC` and groups by at `:1604-1606`. OD-L3-5 is the fork; (b) is recommended as the only
option giving each handler seat a distinct stable ordinal without changing one shipped number.

### 1.5 Registry rows

**Assignee-source subset (per-node-type registry, master M4 / Lock-0 L0-2).** Of the shipped eight
kinds a handler node admits **seven**: `static_user`, `static_role`, `requester`, `form_field_user`,
`direct_manager`, `dept_head`, `manager_at_level`. `continuous_managers` is NOT admitted — corpus C-2
lists 连续多级上级 for approvers and not for handlers. Per M11 that is absence of evidence in the
manual, not proof the semantic is impossible; OD-L3-6 offers the owner the widening.

Forward rows, conditional on Lock-1 landing: `user_group` (K1), `requester_choice` (K2) and
`dept_head_at_level` (K5-b) ADMIT (corpus C-2 lists 用户组 / 提交人自选); `prior_node_approver` (K3) and
`continuous_dept_heads` (K4) do NOT; Lock-2's 表单内部门 admits when it exists. Each row lands in the
same slice as its kind, per Lock-1 §2.3.

**Inspector tabs (Lock-0 L0-1, derived from the registry, not hand-written).** A handler renders exactly
two: `办理人设置` (source cards, `handlerMode`, opinion switch — no fallback control exists) and `表单权限`
(per-field rows carrying the L0-6 honesty copy verbatim, `TemplateAuthoringView.vue:999`). `操作权限`
MUST NOT render until Lock-5 lands ≥1 functional server-enforced per-node policy — same gate, same
mechanism, one more node type. The first tab's LABEL differs from the approval node's `审批人设置`, which
is why the strip is registry-derived per node TYPE.

**Canvas edge-insert menu.** A fifth item 办理人 beside 审批人 / 抄送人 / 条件分支 / 并行分支
(`apps/web/src/approvals/components/ApprovalFlowCanvas.vue:288-331`), emit `edge-insert-handler` (joining
`:69-72`), testid `approval-canvas-edge-insert-handler`, hidden on edges inside a parallel region per
§1.3; card label via `NODE_TYPE_LABELS` (`TemplateAuthoringView.vue:1310-1321`).

## 2. Runtime contract

### 2.1 The action verb touches three sites, and they are already divergent

A handler completes by submitting; the verb is `'handle'`. Three independent sites must move together —
and the TypeScript union (8 members) and the DB CHECK (14 members) ALREADY disagree, so neither implies
the other and each needs its own gate:

1. `APPROVAL_ACTION_TYPES` / `ApprovalActionType` — `types/approval-product.ts:19-29` (`approve, reject,
   transfer, revoke, comment, return, add_sign, reduce_sign`).
2. The dispatch guard — `routes/approvals.ts:1966` rejects any action outside that const.
3. **A migration.** `approval_records.action` carries `approval_records_action_check`, last rewritten by
   `zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts:26-52` to fourteen members (`created,
   approve, reject, return, revoke, transfer, sign, comment, cc, remind, jump, add_sign, reduce_sign,
   reassign`) — `'handle'` is not among them, so the audit INSERT would violate the CHECK. The migration
   follows that file's `up`/`down` list pattern.

Rejected, recorded so it is not re-proposed: `'approve'` (every history, dedup, quorum and metrics
reader keyed on `action='approve'` would count a handler submission as an approval — including the
threshold tally at `:6975-6985`) and `'sign'` (already overloaded by `insertAutoApprovalEvents` for
`metadata.skipped` rows).

### 2.2 Pause and completion semantics

A handler node PAUSES the instance exactly as an approval node does — activation resolves assignees,
inserts assignments, the instance waits. It differs in what may then happen.

- **`handle`** — permitted only to an actor holding an ACTIVE assignment at the CURRENT node, decided by
  the shipped `assignmentMatchesActor` (`:2452-2465`, `user` by id / `role` by current role ids). `'any'`
  completes on the first submission; `'all'` when every resolved seat has submitted, tallied by the
  epoch-scoped pattern the threshold quorum uses (`:6975-6985`). `opinionRequired: true` makes a blank
  comment a values-free 422.
- **`transfer`** — allowed, per corpus C-7's default-ON 允许转交. The shipped path (`:6456-6480`) is
  structurally node-type agnostic: it reads the node epoch, deactivates the actor's seat, and inserts
  `buildTransferAssignments` rows (`:907-915`); the only handler-specific concern is §1.4's ordinal. The
  per-node 允许转交 SWITCH is Lock-5 — Lock-3 hardcodes transfer-allowed and names that seam.
- **`approve` / `reject` / `return` / `add_sign` / `reduce_sign`** — REJECTED with a values-free 409; per
  corpus C-9 a handler has no decision to make, so 驳回 has no handler meaning in v1 (a blocked handler
  transfers, or an admin moves the instance). `comment` and `revoke` are instance-level and unchanged.
- **Batch / 秒批 / quick-card surfaces** exclude handler tasks (corpus C-8); the shipped center batch
  paths operate on `approve`/`reject`, so exclusion falls out of §2.1 rather than needing new code.

Empty resolution at dispatch terminates at the shipped `APPROVAL_ASSIGNEE_EMPTY` 400 carrying
`{ nodeKey }`. **Seam, named not designed:** corpus C-4's two arms (指定人员办理 / 转交给审批管理员) are
the vocabulary Lock-4 F4-B defines as `emptyAssigneeFallback: 'designated'` (转审批管理员 expressed by
designating the approval-admin role). Lock-3 therefore carries NO fallback key at all (§1.1) and adopts
Lock-4's when it lands, rather than minting a narrower key of its own for Lock-4 to supersede — staging
is OD-L3-2. Lock-4's rule that fallback is exactly ONE non-recursive step, never chaining to auto-pass,
binds the handler too, and for a handler auto-pass is inadmissible outright (§1.2). Departure
auto-transfer (corpus C-5) is Lock-4 F4-E's; Lock-3 adds no second mechanism beside the shipped
`bulkReassignApprovals` (`:5648`).

### 2.3 Required-coverage blast radius

The inventory the implementing slice executes against. **Disposition** is EXTEND (a handler arm is added)
or CONFIRM-EXCLUDE (approval-only behavior deliberately retained and gated). The dangerous class is not
the walks that throw — it is the `node.type !== 'approval'` early-return guards, which SILENTLY SKIP a
handler node; those are marked.

| # | Site | Anchor | Disposition |
|---|---|---|---|
| R-1 | Node-type unions + runtime admission set | `types/approval-product.ts:13`; `apps/web/src/types/approval.ts:16`; `ApprovalProductService.ts:454` | EXTEND — all three or the type is unpublishable |
| R-2 | `normalizeApprovalGraph` per-type config switch | `:1764` (`approval` `:1765`, `cc` `:1858`, `parallel` `:1869`, `condition` `:1896`) | EXTEND — new `case 'handler'` carrying §1.2 |
| R-3 | Walk 1 `listVisitedApprovalNodeKeysUntil` (return-target trail) | `ApprovalGraphExecutor.ts:842-905` | EXTEND — **has no unknown-type arm**: an unhandled type leaves `nextNodeKey` unchanged and the next iteration throws `Runtime graph contains a cycle near X`. Loud but MISATTRIBUTED |
| R-4 | Walk 2 `resolveFromNode` (initial + forward) | `:955-1177`, throw `:1162` | EXTEND — pause/activate arm |
| R-5 | Walk 3 `resolveBranchAdvance` (parallel branch) | `:1253-1355`, throw `:1350` | CONFIRM-EXCLUDE — throw RETAINED as the second door behind §1.3's publish gate |
| R-6 | `approvalNodeOrder` / `totalSteps` | `:666-669`, `:671-673` | CONFIRM-EXCLUDE — a handler is not an approval step; `totalSteps` unchanged |
| R-7 | `stepIndexForNode` | `:1361-1364` | EXTEND per OD-L3-5 (§1.4) |
| R-8 | `getApprovalNodeConfig` / `getApprovalMode` / `resolveAfterApprove` | `:1366-1376`, `:815-817`, `:831` | EXTEND — all three throw for a non-approval key today, so completion needs a handler config accessor and its own advance entry point |
| R-9 | `resolveAssignmentsForApprovalNode` | `:1378-1393` | EXTEND — handler seats resolve through the same `assignmentResolver` option |
| R-10 | `validateApprovalAssigneeSourcesAgainstFormSchema` | `ApprovalProductService.ts:657-670` | EXTEND — **silent skip**: a handler's `form_field_user` would never be schema-checked |
| R-11 | `assertNoUnconfiguredPlaceholderRoles` | `:732-746` | EXTEND — **silent skip**: a handler could publish carrying `APPROVAL_ROLE_CONFIGURE_SENTINEL` |
| R-12 | `validateNodeFieldPermissionsAgainstFormSchema` | `:1255-1266` | EXTEND — **silent skip**: handler `fieldPermissions` could reference a deleted field, which §3 makes load-bearing |
| R-13 | `runtimeGraphUsesManagerChain` | `:2900-2910` | EXTEND — **silent skip**: a handler using `manager_at_level` gets no `managerChainIds` in the snapshot and resolves empty |
| R-14 | `runtimeGraphUsesOrgAssigneeSource` | `:2922-2937` | EXTEND — **silent skip, P1**: leaving it unextended reproduces the exact B5-b fail-open (failed org read + empty resolution) that guard closed |
| R-15 | Parallel branch assignee collection + fingerprint gate | `:2110`, `:2137-2159`, `:1484-1530` (arm `:1510`) | CONFIRM-EXCLUDE — the placement rule (§1.3) is the gate; these stay approval-only |
| R-16 | `validateNodeTimeoutConfigs` | `:1317-1420` (`:1385-1388`) | CONFIRM-EXCLUDE — no `timeout` key on handler in v1 |
| R-17 | Jump targets — admin jump and timeout jump | `:5478-5480`, `:6112-6116` | CONFIRM-EXCLUDE — both stay approval-only; recorded as a decision, not an oversight |
| R-18 | Auto-approval policy detectors | `:2975-2981`, `:2961-2973` | CONFIRM-EXCLUDE — a handler carries no `autoApprovalPolicy` (§1.2) and is dedup-exempt (§2.4) |
| R-19 | Route preview `walkPreviewRoute` | `:5030-5116` | EXTEND — the row shape (`nodeKey`, `nodeLabel`, `assignees`) has NO node type, so a handler renders indistinguishable from an approver; the row gains a node type and the FE chip renders 办理 |
| R-20 | FE recognised node types | `templateAuthoring.ts:562-569` | EXTEND — until then a handler graph correctly opens read-only with save blocked (fail-closed, and this row's own positive control) |
| R-21 | FE backend-drop allowlists | `templateAuthoring.ts:588-596`, `:681-710` | EXTEND — a `BACKEND_HANDLER_CONFIG_KEYS` list plus a `case 'handler'` arm, or every handler key is silently dropped on save |
| R-22 | FE linear projection | `templateAuthoring.ts:548-555`, `:756-780` | CONFIRM-EXCLUDE — a graph containing a handler is COMPLEX (canvas-only); the linear editor is not taught the node type |
| R-23 | FE canvas move guard, edge-insert menu, labels | `approvalCanvasCommands.ts:216`; `ApprovalFlowCanvas.vue:69-72`, `:288-331`; `TemplateAuthoringView.vue:1310-1321` | EXTEND (§1.5) — movable like `approval`/`cc` |
| R-24 | Version diff / restore-to-new-draft | `TemplateDetailView.vue` | CONFIRM — the graph is stored verbatim; proved by the G-5 round-trip gate, not by reading |
| R-25 | Per-node metrics breakdown | `ApprovalMetricsService.ts:392-425` | decision — §2.5 / OD-L3-4 |

### 2.4 Epoch, dedup, audit

**`nodeEntryEpoch` is reused unchanged.** Handler activation is an ACTIVATION (bump
`bumpNodeActivationSeq`, per `:5273`, `:6761`, `:7182`); handler transfer is a same-round MUTATION
(preserve `currentNodeEntryEpoch`, per `:6463-6468`). `insertAssignments` (`:7608-7644`) is already shared
by both classes and needs no change beyond §1.4's ordinal. A re-entered handler node starts a fresh
round; prior-round submissions never satisfy the new round's `'all'` tally.

**Dedup exemption (corpus C-6).** Handler assignments never enter the historical-dedup surface:
`mergeAdjacentApprover`, `dedupeHistoricalApprover` and `mergeWithRequester` neither consume nor produce
handler rows, and no handler node is ever auto-completed by them. Stated in the shape Lock-4 used for
Lock-1's K3 — the exemption is Lock-4's to ratify for its own flags; Lock-3 asserts only that a handler
must be exempt. It is load-bearing, not cosmetic: the requester themself may be a handler (corpus
提交人本人 for 信息复核), so `mergeWithRequester` must not auto-dispose of a requester's handler seat.

**Audit rows.** One append-only `approval_records` row per submission: `action:'handle'`, `actor_id` = the
submitting handler, `comment` = 办理意见, `from_status`/`to_status` unchanged (the instance stays
`pending` across a handler node — it is not a status transition), `metadata: { nodeKey, nodeEntryEpoch }`
per the shipped idiom (`:6885-6886`, `:7195`; query form `:6959-6981`). No auto-approval event is ever
written for a handler node; transfer keeps writing `action:'transfer'` with the same metadata shape.

### 2.5 SLA and efficiency metrics

Two surfaces must be answered separately because only one can honour corpus C-8.
`recordNodeActivation`/`recordNodeDecision` (`ApprovalMetricsService.ts:392-425`) maintain a per-node
breakdown with `durationSeconds` — this one CAN exclude handler nodes, and the corpus-aligned position is
that it should, since 办理 wall-clock (waiting on an offline stamp) is not approver latency.
`recordTerminal` (`:458-473`) computes the instance-level `duration_seconds` as `terminal_at -
started_at`, which unavoidably INCLUDES handler time; excluding it would change what "how long did this
request take" means. Honest split: exclude from the breakdown, include in the instance total, label the
SLA view accordingly — OD-L3-4 is the owner's.

## 3. The field-edit mutation boundary — the Lock-7 seam, named not designed

The handler is the first node type for which per-node `editable` means anything, which is why master M8
ties the two. **Lock-3 defines the transaction SHAPE and the seam INTERFACE; Lock-7 defines which fields
are writable and enforces it. Until Lock-7 lands, a handler submit carries NO field writes.**

**Fail-closed until then.** The submit request reserves the key `fieldWrites`; a submit carrying it —
non-empty, `{}`, or `null` — is rejected with a values-free 422
`APPROVAL_HANDLER_FIELD_WRITES_UNSUPPORTED` before any row is written. Reserving the key NOW makes the
rejection testable (G-9) and makes Lock-7 a widening rather than a rename, so Lock-3 ships alone:
财务打款/盖章/归档 nodes work with no form mutation.

**Transaction shape, for when Lock-7 lands.** One transaction on the action dispatch's existing client
(`BEGIN`…`COMMIT`, e.g. `:6452`, `:6480`), in this order: (1) claim — verify and deactivate the actor's
active seat, exactly as transfer does at `:6467`; (2) apply field writes through the seam; (3) bump
`approval_instances.version` (the shipped optimistic-concurrency carrier, e.g. `:6526`) so a stale client
loses; (4) insert the `action:'handle'` audit row; (5) resolve and insert the next node's assignments.
All five commit or none — the same-transaction discipline the FWB line holds for mutation + revision +
claim + outbox. No field write happens outside this transaction or post-commit. The seam is
`applyHandlerFieldWrites(client, instanceId, nodeKey, writes)`, implemented by Lock-7, called only from
step (2), unreachable in Lock-3 because the request contract rejects the payload. Lock-7 owns which
fields `fieldPermissions` make writable, how `hidden` composes with `editable`, validation against the
FROZEN form schema, and the HTTP-level bypass gates.

**Two facts Lock-7 inherits, true at this baseline.** `approval_instances.form_snapshot` is written ONCE
at create (`:5209`) and has no UPDATE path anywhere in `packages/core-backend/src`; Lock-7 creates the
first, so the FWB/projection readers treating it as immutable (`automation-executor.ts:3192-3232` —
"immutable form_snapshot … the ONLY sources of truth") must be re-examined in that same slice. Second,
Lock-4 records a FORWARD obligation that "the first named field-edit surface (Lock-7 / master P4 handler
node) must invalidate dedup history in the same slice that creates it". **Lock-3 does NOT discharge it**
— it ships no field-write path, so 内容变更 stays vacuous and the obligation transfers intact to Lock-7.
No later document may cite Lock-3 as having satisfied it.

## 4. Acceptance gates

Every absence assertion carries a positive control; an absence test without one is green against nothing.
Every mutation row must name the test it turns red and assert the anchor was actually hit.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| G-1 | Walk coverage, per site | For EACH of R-3/R-4/R-5: removing that walk's handler arm turns a NAMED test red. R-3's test asserts the ERROR IDENTITY, not merely that something throws — today an unhandled type yields `cycle near X`, so a "it throws" assertion passes both before and after a wrong fix | a graph with no handler node still executes every walk unchanged; each mutation must red exactly one named test and leave the no-handler test green |
| G-2 | Silent-skip guards | For EACH of R-10/R-11/R-12/R-13/R-14: a handler node carrying the offending config is REJECTED (or resolves correctly). Deleting the handler arm makes the fixture pass silently — that is the mutation | the same fixture on an `approval` node already fails today, proving the guard is type-selected rather than newly invented |
| G-3 | R-14 fail-closed, specifically | org read failed + a handler node with an org-derived source ⇒ create fails 422/503 with ZERO rows | a graph whose ONLY org-derived source is on an approval node still fails — and a graph with no org-derived source still creates |
| G-4 | `totalSteps` invariance | inserting a handler node into a graph leaves `totalSteps` and every approval node's step index byte-identical | removing an APPROVAL node from the same fixture DOES change both — the assertion is not vacuous |
| G-5 | Old-graph byte compatibility | a corpus of pre-Lock-3 published graphs round-trips save → publish → preview → execute → version-compare → restore byte-for-byte | mutate one handler-adjacent key in a new-format fixture and assert the version diff SHOWS it |
| G-6 | Unknown node type still fail-closed | a graph with type `'handlerx'` is still rejected by `APPROVAL_NODE_TYPES` (`:454`) and still forces FE read-only (`templateAuthoring.ts:562-569`) | `'handler'` itself is accepted in the same fixture — admission is enumerated, not permissive |
| G-7 | Choke prohibitions (§1.2) | each rejected key/value fails at authoring: `emptyAssigneePolicy:'auto-approve'`, `handlerMode:'sequential'`, `handlerMode:'threshold'`, `approvalThreshold`, `autoApprovalPolicy`, `timeout` | a valid handler config with the SAME surrounding graph saves — rejection is shape-selected, not blanket |
| G-8 | Topology | a handler inside a parallel branch and a handler as `joinNodeKey` each fail at publish | the identical handler on the main path and inside a condition branch both publish — the gate is placement-selected |
| G-9 | Field-write fail-closed | a submit carrying `fieldWrites` (non-empty, `{}`, and `null`) is 422 with zero rows written and zero node advance | a submit WITHOUT the key succeeds and advances — the rejection is payload-selected |
| G-10 | Action authorization | only an actor with an ACTIVE seat at the current handler node may `handle`; `approve`/`reject`/`return`/`add_sign` at a handler node are 409 | the same actor CAN `handle`, and `approve` at an approval node still succeeds — both dimensions asserted |
| G-11 | Transfer | a handler transfers; the target holds the seat, the original does not, and the epoch is PRESERVED (not bumped) | a node ACTIVATION in the same fixture DOES bump the epoch |
| G-12 | Mode semantics | `'any'` completes on the first submission; `'all'` completes only after every seat submits, epoch-scoped | a re-entered node's prior-round submissions do NOT satisfy the new round |
| G-13 | Registry exact set | the handler roster equals a DECLARED seven-member handler registry constant by exact set equality — not count, not subset, and not the eight-member `ApprovalAssigneeSourceKind` union | two separate mutations: drop one admitted kind, and add `continuous_managers`; each must fail |
| G-14 | Inspector tabs | a handler node renders exactly `办理人设置` and `表单权限`; no `操作权限` element exists in the DOM | a registry fixture declaring a ratified operation policy renders the third tab — proving two tabs is the registry's doing |
| G-15 | Dedup exemption | with every dedup flag ON, the same person handles at two handler nodes and is auto-approved at two adjacent APPROVAL nodes in the same instance | flags OFF: the approval nodes also require action — the exemption is node-type-selected, not flag-blind |
| G-16 | Audit + action verb | a submission writes exactly one `action:'handle'` row carrying `{ nodeKey, nodeEntryEpoch }`; the CHECK migration accepts it and `'handlex'` is still rejected by the DB | reverting only the migration turns the insert red — proving the CHECK, not just the TS union, is exercised |
| G-17 | Preview distinguishability | a route preview over a mixed graph labels the handler row as a handler | an all-approval graph's rows are unchanged from today |
| G-18 | Values-free errors | every new error path carries no person id, roster membership, or form value | assert the SAME path carries `nodeKey` — the check is not passing on an empty payload |

## 5. Owner ratification block

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision: <RATIFY | REQUEST CHANGES | REJECT>
Owner:
Date:
Document SHA:
Decisions required ([R] = this document's recommendation; rejected options are listed so they are
not re-proposed):

  OD-L3-1  Topology placement — (a)[R] main path + condition branches only; parallel region and join
           FORBIDDEN in v1 · (b) allow inside a parallel region, which REQUIRES first extending
           collectAllBranchAssignees (:2158) and the fingerprint gate (:1510); deleting only the
           placement check is not an option
  OD-L3-2  Empty-handler fallback staging — (a)[R] v1 carries NO fallback key (empty = the shipped
           APPROVAL_ASSIGNEE_EMPTY 400) and adopts Lock-4 F4-B's emptyAssigneeFallback:'designated'
           when Lock-4 lands · (b) Lock-3 mints its own designated-persons arm now, accepting two
           vocabularies until merged · (c) block Lock-3 on Lock-4. Auto-pass is inadmissible in all three
  OD-L3-3  Opinion-required default — (a)[R] absent ≡ not required (corpus C-7 未勾选) · (b) required
  OD-L3-4  Handler time in metrics — (a)[R] excluded from the per-node breakdown (:392-425), included
           unavoidably in instance duration_seconds (:467), SLA copy states the split · (b) recorded
           with a node-type marker, excluded at aggregation · (c) counted as an ordinary node
  OD-L3-5  Handler assignment ordinal (§1.4) — (a) leave source_step = 0 for every handler seat ·
           (b)[R] a separate handler ordinal for source_step only, leaving stepIndexForNode and
           totalSteps byte-identical · (c) fold handlers into approvalNodeOrder, changing what
           totalSteps counts and what users read as "第 N / M 步"
  OD-L3-6  Handler roster width — (a)[R] seven of the shipped eight; continuous_managers excluded on
           corpus evidence · (b) all eight — a widening the corpus did not evidence, not a fix
  OD-L3-7  Handler reject verb — (a)[R] submit-only, per corpus C-3/C-9 · (b) add a handler-reject
           verb on the strength of the single conflicting 办理意见 sentence quoted in §0

Deltas:
Runtime authorization: NONE unless explicitly stated — ratifying this document authorizes design only.
  No flag, no UAT, no deployment, no runtime capability. Lock-7 remains NOT DRAFTED and this
  document does not discharge Lock-4's 内容变更 forward obligation.
```
