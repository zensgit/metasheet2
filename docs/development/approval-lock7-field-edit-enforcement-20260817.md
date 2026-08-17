# Lock-7 — Per-Node Form Field Edit / Visibility Enforcement (2026-08-17)

**Status:** PROPOSED — §4 is intentionally blank until an explicit owner decision names this document and
its SHA. Design authority only when ratified: no runtime, flag, UAT, or deployment authorization.
**Baseline:** `origin/main@b296b4d6ebf2e2314a452b13e2c17a296aeb09b2`. Every anchor below was READ AT THIS
BASELINE, verified newer than every parent by `git merge-base --is-ancestor` (master `d33a6a0fa1`, Lock-0
`5b31cb4349`, Lock-1 `0e8ed11671`, Lock-3 `2f4bf6ce3e`, Lock-4 `075d078eb4`, Lock-5/6 `3c5f0992ba` are all
ancestors; the repository is not shallow, so the ancestry answer is trustworthy) — line numbers are exact
here and may differ from those documents' own citations. Unqualified `:NNNN` anchors are
`packages/core-backend/src/services/ApprovalProductService.ts` (APS); `AGE:` is
`packages/core-backend/src/services/ApprovalGraphExecutor.ts`.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-7 row, §P4 (the binding
scope: *"Lock-7 may be designed independently, but its enforcement lands only with a named field-edit
mutation surface; the handler is the first planned consumer"*), M4, M7, M8, M11, UI-1 — this is that row's
draft. `approval-lock3-handler-node-20260817.md` (RATIFIED, **on main**) §3 is BINDING and is not re-opened:
it fixes the seam signature, the five-step transaction order, the reserved-key 422, and the two facts Lock-7
inherits. `approval-lock0-d0-interaction-delta-20260817.md` (RATIFIED, on main) L0-1/L0-2/**L0-6** — L0-6
makes the readonly notice mandatory *until this lock lands enforcement* and names Lock-7 as the only lock
that may remove it. `approval-lock4-flow-policies-20260817.md` (RATIFIED, on main) — its 内容变更 forward
obligation transfers here intact (§2.6). `approval-lock5-node-operation-policy-20260817.md` and
`approval-lock6-requester-global-policy-20260817.md` (RATIFIED, on main) — their ratified ODs are cited,
never re-opened; L6-C is a second consumer blocked on this surface.
**Conditional parents (NOT on main — every citation is conditional):**
`approval-lock2-org-controls-field-routing-20260817.md` (its §4 records RATIFIED, but it lives on branch
`docs/approval-lock2-org-controls-field-routing-20260817` @ `478f18fc83`) — **OD-L2-5** (the
no-`visibilityRule` pin) and its §L2-C required-pin finding are cited as-is and NOT re-adjudicated here;
`approval-lock8-field-vocabulary-20260817.md` (PROPOSED, branch `docs/approval-lock8-field-vocabulary-20260817`
@ `cbf1014a65`) — its §0.3 MS-1…MS-13 census and MS-3 fail-open finding are cited, version-pinned. Every
argument below also stands on shipped anchors read at this baseline, so this document is ratifiable whether
or not either lands.
**Non-effects:** no runtime code, migration, flag change, tenant UAT, deployment, or completion label. Each
contract still needs its own PR, required checks, adversarial gate, and ledger row. The handler node itself
is Lock-3's; per-node operation policy is Lock-5's; dedup tiers are Lock-4's; instance-detail **read scope**
(who may fetch an instance at all) is an OPEN owner question outside this document (§2.7) and is not settled
here.

## 0. Corpus evidence, and two premise corrections

Corpus = the offline Feishu administrator handbook (`feishu/6933484342190538780.txt`), section boundaries
derived from the file's own `## ` headers (never a fixed-width slice), plus the 2026-08-16 scratchpad digest
(a working note, not authority). Master M11 governs the language: "the reference corpus did not evidence",
never "the competitor lacks".

| # | Corpus evidence | Lines | Disposition |
|---|---|---|---|
| C-1 | 发起节点 表单权限: 可读 + 编辑, two independent rows, *默认均勾选* | 1529-1546 | node-type width, OD-L7-4 |
| C-2 | 审批节点 表单权限: 可读 + 编辑, 默认均勾选; purpose stated as 保护信息隐私 **或允许补充信息** | 1759-1776 | surface width, OD-L7-3 |
| C-3 | 抄送节点 表单权限: **可读 only — there is no 编辑 row**, purpose stated as 保护信息隐私 only | 1894-1906 | asymmetry pinned in OD-L7-4 |
| C-4 | 办理节点 表单权限: 可读 + 编辑, 默认均勾选 | 2024-2041 | §L7-C — the v1 surface |
| C-5 | 结束节点 表单权限: 可读 + 编辑, 默认均勾选 | 2088-2105 | OD-L7-4 |
| C-6 | Lock-3 C-7's reading of the same 办理 block (可读 AND 可编辑, default all checked) | via Lock-3 §0 | inherited, not re-derived |

**Correction 1 — the tri-state is OURS; the corpus evidences a 2×2.** The task framing
`{可见可编辑, 仅可见, 隐藏}` is a three-state enum. The corpus rows above are **two independent
checkboxes**, both default-checked, so the corpus's own designer can express four combinations. The shipped
carrier `NodeFieldAccess` (`types/approval-product.ts:53`) is already the three-state enum, and the mapping
is 可读+编辑 → `editable`, 可读 only → `readonly`, neither → `hidden`. The fourth combination — **编辑
without 可读** — is *unrepresentable in our carrier by construction*. Per M11 the corpus does not evidence
whether Feishu rejects it, renders it as edit-only, or silently treats it as read+edit; absence of a
documented rejection is not evidence of acceptance. Collapsing it away is a fail-closed choice and is
OD-L7-2, not a silent normalization. The 抄送 asymmetry (C-3) is evidence in the *other* direction: the
corpus does distinguish read-only surfaces from editable ones per node type.

**Correction 2 — "no grid UI until enforcement exists" is already false, and the obligation inverts.** The
three-option selector 可编辑 / 只读 / 隐藏 **ships today in both authoring surfaces**: the linear editor
(`apps/web/src/views/approval/TemplateAuthoringView.vue:626-666`, selector `:643-654`, section copy
`:629-631`) and the canvas inspector (`apps/web/src/approvals/components/ApprovalGraphNodeConfigEditor.vue:518-560`,
selector `:532-543`), sharing one copy module (`apps/web/src/approvals/fieldPermissionHonestyCopy.ts:14`,
`:25`). Master M7's no-inert-control rule was discharged for `只读` by **disclosure**, not by absence:
`只读将在后续版本（T1-4b）生效，当前保存但暂不强制`. Lock-0 L0-6 pins that exact string, names Lock-7 as the
only lock that may remove it, and requires a retirement to land **in both surfaces in one change**. So
Lock-7's M8 obligation is the inverse of "build no grid": enforcement, the copy retirement, and both
surfaces move in the SAME slice, and that is gate G-13 rather than a paragraph. Lock-0 L0-6 and Lock-3 §1.5
both cite `TemplateAuthoringView.vue:999` for this copy from their own (older) baselines; at THIS baseline
it is `:655-659`. Both anchors are given so neither parent's citation is silently re-pointed.

## 1. Contracts

### L7-A — one derivation of "this actor's access to this field", three consumers

The shipped mask is **instance-scoped and explicitly not viewer-scoped**: *"Redaction is keyed on the
INSTANCE's currently-active node(s) — NOT the viewer's assignment set"*
(`services/approval-form-redaction.ts:17-21`), so an observer, an admin and the requester are all redacted
alike while the instance sits at a hiding node. An **edit** mask cannot be instance-scoped: the question it
answers is *which node's row governs THIS actor*. Those are two different node sets over one matrix, and two
hand-maintained readers of one matrix is the failure mode this program keeps finding (Lock-2 §2.3, Lock-5
§2.3).

**Locked.** One pure exported function in the module that is ALREADY the shared derivation
(`approval-form-redaction.ts`, whose own header records that the snapshot echo and the attachment byte gate
must not drift):

```ts
resolveFieldAccessAtNodes(
  runtimeGraph: RedactableRuntimeGraph | null,
  nodeKeys: ReadonlyArray<string | null | undefined>,
): Map<string, NodeFieldAccess>      // absent key ≡ 'editable'
```

Most-restrictive-wins across the given nodes: `hidden` ≻ `readonly` ≻ `editable`. On the hidden axis that is
byte-identical to the shipped union (`collectHiddenFieldIds:47-71`, whose parallel-region union is pinned by
`tests/unit/approval-form-redaction.test.ts:66-75`), so `collectHiddenFieldIds` is **re-expressed as a
derivation over this function**, not left as a second traversal. Three consumers, each supplying its own
node set and nothing else:

| Consumer | Node set | Effect |
|---|---|---|
| snapshot echo — `redactHiddenFormFields:73-93`, called `ApprovalBridgeService.ts:167-171` (list `:557`, detail `:633`) | `collectActiveNodeKeys(current_node_key, metadata)` — instance-scoped, **unchanged** | `hidden` ⇒ key removed from the echoed snapshot |
| attachment byte gate — `isFieldHiddenAtActiveNode` (`services/approval-attachment-runtime.ts:253-267`, fail-closed on unknown instance `:262`) | same instance-scoped set, **unchanged** | `hidden` ⇒ no bytes |
| **NEW** write mask — inside Lock-3 §3's seam | exactly `[nodeKey]`, the seam's own argument | `editable` ⇒ writable; `readonly` and `hidden` ⇒ values-free refusal |

The write mask takes a SINGLE node, so no precedence question arises on the write side; precedence exists
only to preserve the shipped instance-scoped read. The `nodeKey` the mask reads MUST be the same key step (1)
of Lock-3's transaction claimed the seat at — never a re-derivation, because a second derivation of "the
actor's node" is exactly the drift this section exists to prevent. The shipped actor-effective-node
resolution already exists and is the reuse anchor: `:6290-6318` (`actorBranchNodeKey`,
`currentNodeAssignments`, `actorAssignments`, `actorCanAct`), with the 403 `APPROVAL_ASSIGNMENT_REQUIRED` at
`:6321-6323`.

**Do not mint a fourth participant predicate.** Two divergent ones already ship: `isInstanceParticipant`
(`approval-attachment-runtime.ts:201-243`) is attachment-COUPLED — it requires an `approval_attachments` row
stamped with the caller's org, so it returns false for an instance with no attachments — and
`routes/approval-metrics.ts:193-215` is a second inline predicate with no cc arm and no admin arm. Named
here, reused as-is by neither: the write mask's authorization is the shipped active-seat check, not
participation.

### L7-B — the authoring-time matrix, and what publish must newly reject

The carrier is the **shipped** `fieldPermissions?: NodeFieldPermission[]` (`types/approval-product.ts:128`,
entry shape `:55-58`, enum `:53`) — OD-L7-1. Minting a parallel key would violate Lock-3 §1.1's own rule
against a second vocabulary for a later lock to supersede, and five sites already author this one.
Shape normalization is already fail-closed and needs no change: `normalizeNodeFieldPermissions:1119-1148`
rejects a non-array, a missing/blank `fieldId`, an out-of-enum `access`, and a duplicate `fieldId` with
`failValidation(400)`, keeps `editable` entries through, and returns `undefined` for an empty array so the
key is omitted (`:1128`, emitted `:1852`). The access enum has **four hand copies, none exhaustiveness-forced**:
`types/approval-product.ts:53`, `NODE_FIELD_ACCESS_VALUES:460` (`Set<NodeFieldAccess>` — members are typed,
but a fifth union member would not fail the build), FE `apps/web/src/types/approval.ts:66`, and FE literal
`apps/web/src/approvals/approvalNodeEdit.ts:177`.

Cross-reference already runs at five entry points — `restoreTemplateVersion:3657`, `createTemplate:3722`,
`updateTemplate:3886`, `publishTemplate:4004`, `cloneTemplate:4283` — through
`validateNodeFieldPermissionsAgainstFormSchema:1249-1267`, which rejects a dangling `fieldId` against
`formSchema.fields` (**top-level only**, `:1254`) and early-returns on any node whose type is not `approval`
(`:1256`).

Four NEW publish-time pins, each fail-closed, each raised at every one of those five entry points:

1. **A routing driver may not be `editable` at any node.** This is the load-bearing pin and it closes a
   privilege-escalation path that opens the moment writes land. At EVERY dispatch the executor and the
   assignment resolver are rebuilt from the instance's CURRENT `form_snapshot` (`:6059-6065`, `:6270-6276`),
   so a mid-flight edit to a field referenced by a `form_field_user` source changes **who the next node's
   approver is**, and an edit to a field named in a `ConditionRule` changes **which branch runs**. An
   approver editing the field that names the next approver is not a form correction; it is choosing their
   own reviewer. Pin: a field referenced by any node's `assigneeSources` (and, conditionally, Lock-2's
   field-derived kinds) or by any `ConditionRule.fieldId` / condition formula is rejected as `editable`
   anywhere in the graph. The shipped FE already computes the driver set for its hint
   (`routingDriverFieldIds`, `TemplateAuthoringView.vue:2343-2354`, deliberately unioning both authoring
   models); the pin is server-side and does not depend on it, because an affordance is not a boundary.
   OD-L7-8 offers the owner the alternatives, both of which must first answer re-resolution.
2. **`editable` at a node whose type has no write surface is rejected, not dropped.** Today a
   `fieldPermissions` array on a `cc`, `parallel`, `condition`, `start` or `end` node is **silently
   discarded** — `normalizeApprovalGraph`'s switch rebuilds `cc` from a two-key whitelist (`:1858-1867`) and
   ends `default: normalizedNode.config = {}` (`:1943-1945`) — so an author who configures it gets no error
   and no effect. That is a shipped defect (§2.7 D-1) independent of Lock-7; this lock must not inherit it
   for the write axis. Until a node type has a ratified write surface, `editable` on it is a 400.
3. **The `required` × `hidden` conflict, stated exactly.** The generic phrasing is not the real conflict.
   The node mask does **not** feed `pruneHiddenFormData` (AGE:265-289) or `validateApprovalFormData`
   (AGE:616-646): those read the data-keyed `visibilityRule` axis, which the type comment already calls
   orthogonal (`types/approval-product.ts:124-127`). Required-for-visible-only (AGE:625-627) is Lock-2's
   OD-L2-5 finding, **re-verified byte-identical at this baseline and cross-cited, not re-adjudicated**. The
   two conflicts Lock-7 owns are: (a) a field the node's own write surface must be able to fill but the SAME
   node marks `hidden` — self-contradictory, rejected; and (b) a `required: true` field marked `hidden` at
   every node that could write it, which is unfillable by anyone and is rejected with the field id and node
   key but no value.
4. **Detail sub-columns are out of scope in v1.** The cross-reference set is top-level only (`:1254`), so a
   sub-column id is already rejected as unknown, and the FE grid rows are top-level fields
   (`fieldPermissionFields`, `TemplateAuthoringView.vue:2330`). Inheriting Lock-2's reasoning verbatim: N row
   values are ambiguous for a per-field access decision. Stated as a boundary (OD-L7-12), not left implicit.

### L7-C — the write path: Lock-3's seam, and what it must persist

Lock-3 §3 is BINDING and is not redesigned. Lock-7's landing condition is exactly: widen the reserved key
`fieldWrites` from an unconditional values-free 422 `APPROVAL_HANDLER_FIELD_WRITES_UNSUPPORTED` into an
accepted payload, implement `applyHandlerFieldWrites(client, instanceId, nodeKey, writes)`, and keep it
callable only from step (2) of that transaction — claim, apply, bump `approval_instances.version`, insert the
`action:'handle'` audit row, resolve the next node's assignments; all five commit or none.

**Validation of a write is the create path's validation, against the FROZEN schema.** The instance's pinned
`approval_template_versions.form_schema` is the schema (already loaded on the read path at
`ApprovalBridgeService.ts:641-648`), never the live template. Each written value re-runs
`validateFieldType` / `validateFieldConstraints` (AGE:637, `:642`) and, for a `detail` value,
`validateDetailFieldValue` (AGE:634). This inherits Lock-8 MS-3's fail-open defaults verbatim —
`validateFieldType` ends `default: return null` (AGE:412-413) and `validateFieldConstraints` ends
`default: return []` (AGE:552-553) — so a field type with no explicit arm is written **with no value
validation at all**. Lock-7 does not fix MS-3, but its gate G-6 asserts the inheritance so no later document
reads the write path as validated for every type.

**What the write mutates (OD-L7-6).** Two facts Lock-3 handed over, both re-verified here.
`approval_instances.form_snapshot` is written ONCE, by the create INSERT at `:5205-5216`, and has **no UPDATE
path anywhere** in `packages/core-backend/src` — all 32 references are reads, comments, migrations, or the
one INSERT. The FWB / projection readers rely on that: `automation-executor.ts:3192-3194` reads it under the
comment *"immutable form_snapshot + pinned template-version schema are the ONLY sources of truth"* (also
`:3077-3084`, `:3232`), and the attendance snapshot module states the same posture
(`attendance/w4c3b-request-snapshots.ts:1219`, `:1232`). Lock-7 creates the first mutation, so those readers
are re-examined **in this slice**, per Lock-3 §3.

The recommended arm updates `form_snapshot` in place inside the one transaction **and** appends an
append-only per-field revision row (before/after, actor, node key, epoch). In-place update means every
existing reader — the DTO echo, FWB, condition routing, the projection — is automatically correct with no
composition step; a delta table read-composed by each reader would be fail-OPEN by omission, because any
reader that forgets to compose silently serves the create-time value (five independent read sites named
above).

**The audit row carries field IDs, never values (OD-L7-7).** `GET /api/approvals/:id/history`
(`routes/approval-history.ts:43`) is guarded by `authenticate` ALONE — no `approvals:read`, no participant
check — and its query selects raw `approval_records` columns including `comment` with no mask applied
(`:86-104`, `comment` at `:93`); the FE detail timeline consumes exactly that endpoint
(`apps/web/src/approvals/api.ts:960`). That history is intentionally outside redaction is corroborated by the
real-DB spec's own comment — *"redaction is a read-time echo transform, never a write"* — beside its
records-table assertion (`tests/integration/approval-p1c-field-permissions.api.test.ts:273-280`); the route
is the primary evidence, the comment only the recorded intent. So a before/after VALUE placed in
`approval_records.comment` or `.metadata` would be readable by any authenticated user and would bypass the
`hidden` mask entirely — including for the very field the author hid. The `action:'handle'` row therefore
carries `{ nodeKey, nodeEntryEpoch, changedFieldIds }` and no values; values live in the revision table
behind a mask-aware read. (This is the same audit-versus-error split Lock-2 §2.6 drew, one surface further
out: here even the *audit* surface is too wide for values.)

## 2. Cross-cutting

**2.1 Vocabulary may widen only — narrowing breaks IN-FLIGHT execution, not just re-save.** `asRuntimeGraph`
(`:2708-2726`) re-runs `normalizeApprovalGraph` over the STORED runtime graph on **every dispatch**, and each
dispatch rebuilds the executor from it (`:6059-6065`, `:6270-6276`). So a narrowing of
`normalizeNodeFieldPermissions` — a newly required key, a removed enum member, a stricter shape — does not
merely fail re-save and `restoreTemplateVersion` (the Lock-2 §2.7 / Lock-8 2.5 class); it makes running
instances **undispatchable**. Locked: any Lock-7 slice may only widen the accepted set, and any narrowing
requires a mechanical census of persisted `fieldPermissions` shapes first, escalated on a non-empty result.

**2.2 Freeze and versioning are already correct; the matrix rides the published definition.** Publish INSERTs
a new `approval_published_definitions` row (`:4028-4033`) and only flips the previous rows'
`is_active = FALSE` (`:3980-3985`); `buildRuntimeGraph` (`:2734-2744`) deep-copies the graph verbatim and
`deepFreeze`s it, so `fieldPermissions` rides through unchanged; the read path pins per instance via
`published_definition_id` (`loadRuntimeGraphs:925-944`). Therefore a frozen instance keeps ITS version's
matrix with no new mechanism, and re-publishing a template cannot retro-edit an in-flight instance's access
rules. Nothing here is designed; it is verified and depended upon.

**2.3 Blast radius the implementing slice executes against.** EXTEND = a Lock-7 arm is added;
CONFIRM-EXCLUDE = existing behavior deliberately retained and gated; SILENT = the dangerous class, where the
current code neither throws nor logs.

| # | Site | Anchor | Disposition |
|---|---|---|---|
| R-1 | Access enum, four hand copies | `types/approval-product.ts:53`; `:460`; `apps/web/src/types/approval.ts:66`; `approvalNodeEdit.ts:177` | CONFIRM — no new member in v1; G-14 pins the four by exact set |
| R-2 | Shape normalizer | `:1119-1148`, called only in `case 'approval':` at `:1825-1829` | EXTEND — widen-only per §2.1 |
| R-3 | Per-type config switch | `:1764`; `cc` `:1858-1867`; `default: config = {}` `:1943-1945` | **SILENT** — `fieldPermissions` dropped on every non-approval type (defect D-1); §L7-B pin 2 |
| R-4 | Form-schema cross-reference | `:1249-1267`, `node.type !== 'approval'` `:1256`, top-level ids `:1254` | EXTEND — Lock-3 R-12 already claims this function for the handler; the pins of §L7-B land here |
| R-5 | Hidden derivation | `approval-form-redaction.ts:47-71` | EXTEND — re-expressed over `resolveFieldAccessAtNodes`, hidden output byte-identical |
| R-6 | Snapshot echo | `approval-form-redaction.ts:73-93`; `ApprovalBridgeService.ts:167-171` | CONFIRM-EXCLUDE — instance-scoped read behavior unchanged in v1 |
| R-7 | Attachment byte gate | `approval-attachment-runtime.ts:253-267` | CONFIRM — third consumer of the one derivation; G-2 includes it |
| R-8 | Active-node derivation | `approval-form-redaction.ts:104-131` | CONFIRM — tolerant/best-effort by design; unchanged |
| R-9 | Actor effective node + seat check | `:6290-6318`, 403 `:6321-6323` | EXTEND — supplies the seam's `nodeKey`; no second derivation |
| R-10 | `form_snapshot` write | INSERT `:5205-5216`; no UPDATE path | EXTEND — Lock-7 creates the first UPDATE (OD-L7-6) |
| R-11 | FWB / projection immutability readers | `automation-executor.ts:3077-3084`, `:3192-3194`, `:3232`; `attendance/w4c3b-request-snapshots.ts:1219`, `:1232` | EXTEND — re-examined in the same slice (Lock-3 §3) |
| R-12 | Value validators | AGE:637, `:642`, `:634`; fail-open defaults AGE:412-413, `:552-553` | EXTEND — re-run on writes; MS-3 inherited, asserted not fixed (G-6) |
| R-13 | Dispatch re-normalize | `:2708-2726` | CONFIRM — the §2.1 constraint; gate G-9 |
| R-14 | Condition + assignee re-read at dispatch | `:6059-6065`, `:6270-6276` | EXTEND — the §L7-B pin 1 hazard; gate G-4 |
| R-15 | Audit insert + history read | `approval_records`; `routes/approval-history.ts:43`, `:86-104` | EXTEND — values-free row (OD-L7-7); gate G-8 |
| R-16 | Read DTO | `ApprovalBridgeService.ts` `toUnifiedDTO:158-…`; FE `detailField.ts:529-561`, skip-if-absent `:547` | EXTEND per OD-L7-10 — no per-field access channel exists today |
| R-17 | Authoring grids + honesty copy | `TemplateAuthoringView.vue:626-666`, `:655-659`; `ApprovalGraphNodeConfigEditor.vue:518-560`; `fieldPermissionHonestyCopy.ts:14`, `:25` | EXTEND — both surfaces in one change (G-13) |
| R-18 | FE draft model + backend-drop allowlists | `templateAuthoring.ts:161`, `:383-387`, `:394`, `:981-990`, `:1011-1012`, `:595`, `:653`, `:768`, `:781`; `approvalNodeEdit.ts:35`, `:74`, `:99-101`, `:172-179` | CONFIRM — `editable`-means-absent and the delete-when-editable projection are preserved (OD-L7-9) |
| R-19 | OpenAPI | `packages/openapi/src/base.yml:3453-3477` | decision — OD-L7-10; `ApprovalNodeConfig` omits `fieldPermissions` (and `assigneeSources`, threshold, timeout, `signaturePolicy`; its `approvalMode` enum lacks `threshold`), and no runtime validator is wired, so this is codegen / `tools/guard-codegen.mjs` only |
| R-20 | Legacy terminal routes | `routes/approvals.ts:2097`, `:2247`; raw UPDATEs `:2180`, `:2337` | CONFIRM-EXCLUDE — they write NO form data (§2.7 D-3); locked: no field write is ever added there |
| R-21 | Bridged instance inserts | `ApprovalBridgeService.ts:1024`; `AfterSalesApprovalBridgeService.ts:515` | CONFIRM — neither writes `form_snapshot` and neither pins a published definition, so the mask is a no-op there **by construction, not by decision** |
| R-22 | Version diff / restore | `restoreTemplateVersion:3651-3660` (re-validates history against today's contract) | CONFIRM — the §2.1 widen-only rule is what keeps restore working; G-10 |

**2.4 Two consumers besides the handler are already waiting, and one obligation transfers in.** Lock-6 L6-C
(修改 x 天内已通过) is DEFERRED explicitly because *"`form_snapshot` is written once at create and no dispatch
branch edits it — the same fact that keeps `readonly`/`editable` inert"*, and it names master P4 / Lock-7 as
the owner of the surface it needs. Master §P4's exit adds approval-decision transaction parity. Neither is
designed here; both are named so the surface is not later widened by inference.

**2.5 The honesty copy retires with enforcement, in both surfaces, in one change.** Lock-0 L0-6 pins
`只读将在后续版本（T1-4b）生效，当前保存但暂不强制` character-for-character including the `（T1-4b）` marker,
and its acceptance spec pins the exact string so a one-sided edit fails. A second string retires with it:
`该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析`
(`fieldPermissionHonestyCopy.ts:25`, linear original `TemplateAuthoringView.vue:660-664`). Its promise is
true for `hidden` and **false once writes exist** — an edit to a driver field does change assignee resolution
(§L7-B pin 1) — so the slice that lands writes must correct it rather than leave a stale reassurance beside
a new capability. The section-level copy at `TemplateAuthoringView.vue:629-631` (`「只读」将在后续版本生效`)
is a third site in the same change.

**2.6 Lock-4's 内容变更 obligation lands here.** Lock-4 §F4 records it verbatim: 内容变更 is *"vacuous at this
baseline and therefore deliberately ungated"* because no mid-flight form mutation exists, locked instead as a
FORWARD obligation that *"the first named field-edit surface (Lock-7 / master P4 handler node) must
invalidate dedup history in the same slice that creates it"*. Lock-3 §3 states explicitly that it does NOT
discharge it and transfers it intact, and forbids citing Lock-3 as having satisfied it. Lock-7 is that
surface. OD-L7-11 is whether the discharge lands in this slice (scoping the dedup readers' history to the
post-edit round, reusing the `nodeEntryEpoch` machinery the threshold tally already uses) or is re-transferred
with a named owner — a re-transfer is a decision the owner makes, not a silence.

**2.7 Shipped defects and open dependencies surfaced by this census.**

| # | Finding | Anchor | Honest classification |
|---|---|---|---|
| D-1 | `fieldPermissions` on a `cc` / `start` / `end` / `condition` / `parallel` node is silently discarded at normalize — no error, no effect; the author believes the field is hidden | `:1858-1867`; `default:` `:1943-1945` | Real shipped defect. Not a live *bypass* (no such node reads the mask today), but a configuration-loss class: the same shape that would be honored on an approval node is dropped elsewhere. Independent of Lock-7; §L7-B pin 2 keeps Lock-7 from inheriting it |
| D-2 | `approvals:admin-data` ("Approval Data Recovery Admin") is declared and seeded but has **zero** enforcement sites in the repository | `types/approval-product.ts:7`; `db/migrations/zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts:16-19` | Declared-inert, **not** a vulnerability — granting it confers nothing, so the failure direction is closed. Recorded because it is the obvious carrier for a later admin data-repair surface and must not be adopted by inference |
| D-3 | Legacy `POST /api/approvals/:id/approve` and `/reject` terminate an instance with a raw status UPDATE, bypassing the graph executor and any assignment check, on `approvals:act` alone | `routes/approvals.ts:2097`, `:2247`; UPDATEs `:2180`, `:2337` | Pre-existing, out of Lock-7's scope, and **cannot bypass a field mask today because they write no form data**. Stated so the row is not read as a live field-write bypass; locked forward: no field write may ever be added on these paths |
| D-4 | Two divergent participant predicates with no shared helper | `approval-attachment-runtime.ts:201-243`; `routes/approval-metrics.ts:193-215` | Pre-existing divergence. Lock-7 adds no third; its authorization is the active-seat check |
| D-5 | `GET /api/approvals/:id` is guarded by `approvals:read` alone — `getApproval` (`ApprovalBridgeService.ts:615-660`) applies no participant scoping — and `GET /api/approvals/:id/history` is guarded by `authenticate` alone | `routes/approvals.ts:2404`; `routes/approval-history.ts:43` | **EXTERNAL DEPENDENCY, OPEN owner question, deliberately not settled here.** Lock-7 does not narrow or widen the read scope; it only refuses to add a values channel to the wider of the two surfaces (OD-L7-7). Any later document must resolve read scope on its own authority |

## 3. Acceptance gates

Master §P4's exit applies (*"hidden/readonly permissions cannot be bypassed by HTTP calls; old graphs remain
byte-compatible"*). Every absence assertion carries a positive control; every mutation row names the test it
turns red and asserts the anchor was actually hit.

| # | Gate | Assertion | Positive control / mutation (mandatory) |
|---|---|---|---|
| G-1 | The derivation is DERIVED, not three copies | mutating ONLY `resolveFieldAccessAtNodes` (flip the `hidden ≻ readonly` precedence) reds a named test for **each** of the three consumers — snapshot echo, attachment byte gate, write refusal | if fewer than three red, a consumer holds its own copy and the gate FAILS. Plus: a fixture matrix asserts the derived hidden set equals `collectHiddenFieldIds`' output by exact set equality, and the shipped parallel-union case (`approval-form-redaction.test.ts:66-75`) stays green |
| G-2 | Read behavior is byte-identical | the full shipped redaction suite plus the real-DB P1-C spec pass unchanged: hidden at the active node, retained at a non-hiding node, identical reference when nothing hides, parallel union, null-safe | mutate the new function to hide nothing ⇒ those SAME tests red — the suite is exercising the new path, not a bypassed old one |
| G-3 | Write mask is actor-node-scoped | a field `readonly` at the actor's node is refused even though it is `editable` at another node in the same graph; a field `editable` at the actor's node is written even though another node marks it `hidden` | the mirror fixture (swap the two nodes) inverts both outcomes — the mask is node-selected, not graph-wide |
| G-4 | Routing drivers cannot be edited | for EACH driver kind (a `form_field_user` source's field, a `ConditionRule.fieldId`, a condition-formula operand): marking it `editable` fails publish at all five entry points | a NON-driver field publishes `editable` in the same graph; and a second fixture proves the hazard is real by construction — with the pin neutered, an edit to the driver field changes the NEXT node's resolved assignee (asserted on `approval_assignments`, not on a log line) |
| G-5 | Self-contradiction and unfillable-required | a field `hidden` at the same node whose write surface must fill it, and a `required: true` field `hidden` at every write-capable node, each fail publish | a `hidden` field that no node needs to write still publishes — rejection is conflict-selected, not blanket |
| G-6 | Writes re-run the frozen validators | a write violating a type or constraint is refused with zero rows and no node advance, validated against the instance's PINNED version schema, not the live template | mutate the live template's schema after create ⇒ the write still validates against the frozen one; and a named test RECORDS the MS-3 inheritance (a type with no `validateFieldType` arm is accepted unvalidated) so the fail-open is disclosed, not implied fixed |
| G-7 | Transaction atomicity | forcing a failure at each of Lock-3 §3's five steps leaves zero snapshot change, zero revision row, zero audit row, zero assignment change, and an unchanged `version` | the success path changes all five — the rollback test is not passing against a no-op |
| G-8 | Audit is values-free but answerable | the `handle` row carries `{ nodeKey, nodeEntryEpoch, changedFieldIds }` and NO value; the revision table carries before/after and is mask-aware | the SAME slice asserts the history endpoint (`authenticate`-only) returns no form value for an edited instance, AND that the revision surface DOES return before/after to an authorized reader — both directions, or "no values" is green against an empty payload |
| G-9 | In-flight re-normalize survives | an instance created before the slice dispatches unchanged after it; every persisted `access` value still normalizes | mutate the normalizer to reject one previously-legal shape ⇒ a named test reds on DISPATCH of a pre-existing instance, not only on save — proving `:2708-2726` is the exercised path |
| G-10 | Round-trip and restore | save → publish → preview → execute → version-compare → restore preserves every matrix entry byte-for-byte; a changed entry SHOWS in the diff | a pre-Lock-7 template corpus round-trips unchanged through the same path |
| G-11 | Legacy default | a template with no `fieldPermissions` behaves byte-identically before and after the slice: every field writable at a write-capable node, nothing redacted | a template WITH a matrix diverges in the same fixture — absent-≡-editable is default-selected, not accidental |
| G-12 | Non-approval node types | `editable` on a `cc` / `start` / `end` / `condition` / `parallel` node is REJECTED at publish, not dropped | the pre-slice behavior is pinned first (the key is silently discarded, asserted on the SAVED graph) so the mutation shows the change; and `hidden` on an approval node still round-trips |
| G-13 | Honesty copy retires atomically, both surfaces | when enforcement lands, neither `FIELD_PERMISSION_READONLY_HINT` nor the `（T1-4b）` marker appears in either authoring surface or in `fieldPermissionHonestyCopy.ts`, and the routing hint is corrected | before the enforcement commit the SAME test asserts both strings ARE present in both surfaces; deleting the copy from only one surface reds a named test (Lock-0 L0-6's one-change rule) |
| G-14 | Enum mirror sites | the four access-enum copies are asserted equal by exact set (not count, not subset) | dropping a member from any one of the four reds a distinct named test — the four are hand copies, so nothing else catches it |
| G-15 | Direct-HTTP bypass matrix | for each write-refusal reason (no active seat, wrong node, `readonly`, `hidden`, unknown field, detail sub-column, non-write-capable node type) a direct API call is refused values-free with zero rows | one fully-compliant call succeeds in the same fixture — refusal is reason-selected; and the legacy `/approve` `/reject` routes are asserted to accept NO field payload |
| G-16 | Dedup invalidation (OD-L7-11(a) only) | with a dedup tier ON, an edited instance does not auto-approve a later node on a pre-edit approval by the same actor | with no edit, the same fixture DOES auto-approve — the invalidation is edit-selected, not flag-blind. Under arm (b) this gate is replaced by a ledger row naming the transferee |

## 4. Owner ratification block

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision:
Owner:
Date:
Document SHA:
Decisions required ([R] = this document's recommendation; rejected options carry their citation so
they are not re-proposed):

  OD-L7-1  Carrier — (a)[R] the SHIPPED `fieldPermissions` / `NodeFieldAccess` enum
           (`types/approval-product.ts:53`, `:128`), whose own comment declares it forward-stable, with
           five FE/BE sites already authoring it · (b) a new per-node field-edit key [rejected §L7-B:
           Lock-3 §1.1's rule against minting a second vocabulary for a later lock to supersede] ·
           (c) two independent booleans mirroring the corpus [see OD-L7-2]
  OD-L7-2  The tri-state collapse — (a)[R] keep the shipped three-state enum; 编辑-without-可读 stays
           UNREPRESENTABLE by construction (fail-closed), and §0 Correction 1 records per M11 that the
           corpus does not evidence how Feishu treats that combination · (b) two booleans, which makes the
           fourth state expressible and then needs its own rejection rule at publish plus a migration of
           every persisted entry · (c) three states now, a fourth member later [rejected §2.1: an enum
           widening is safe but a per-entry SHAPE change is a narrowing, and §2.1 makes narrowings break
           in-flight dispatch]
  OD-L7-3  Write-surface width in v1 — (a)[R] handler-only: exactly Lock-3 §3's seam, one reserved key,
           one ratified transaction shape · (b) also approval-node approve-time writes, which corpus C-2
           evidences (审批节点 carries 编辑 and states 允许补充信息) but for which NO reserved key and no
           ratified transaction shape exist — a second surface designed in the same slice · (c) block
           Lock-7 until the approval-node surface is designed. Under (a) the approval-node surface is the
           named next slice, not an omission
  OD-L7-4  Node-type width — (a)[R] approval + handler only, matching where a write surface exists;
           `editable` elsewhere is a 400 (§L7-B pin 2) · (b) also start / cc / end for corpus parity
           (C-1/C-3/C-5), which requires first fixing the silent drop (D-1) AND answering what "editable at
           the start node" means for a form the requester already submitted · (c) read-only (`hidden`)
           support on cc only, per C-3's read-only asymmetry — the cheapest corpus-aligned widening
  OD-L7-5  Mask scope — (a)[R] ONE derivation, instance-scoped node set for the two shipped read
           consumers (behavior byte-identical) and the actor's single claimed node for the write consumer ·
           (b) make the read mask actor-scoped too, which CHANGES shipped read behavior for observers,
           admins and the requester (`approval-form-redaction.ts:17-21` documents the current choice) and
           is a separate owner decision on read semantics, not a Lock-7 side effect · (c) two independent
           derivations [rejected §L7-A: two hand-maintained readers of one matrix is the drift class
           Lock-2 §2.3 and Lock-5 §2.3 both had to close]
  OD-L7-6  What a write mutates — (a)[R] UPDATE `form_snapshot` in place inside Lock-3 §3's single
           transaction, PLUS an append-only per-field revision row; the FWB/projection immutability readers
           (`automation-executor.ts:3192-3194`, `attendance/w4c3b-request-snapshots.ts:1219`) are
           re-examined in the SAME slice per Lock-3 §3 · (b) a delta table composed at read time [rejected
           §L7-C: five independent read sites must each compose or silently serve the create-time value —
           fail-open by omission] · (c) a versioned snapshot column, which changes every reader's query
           shape for a benefit (a) already gives through the revision table
  OD-L7-7  Audit value carriage — (a)[R] `approval_records` carries `changedFieldIds` and no values;
           before/after lives in the revision table behind a mask-aware read · (b) before/after in
           `approval_records.metadata` or `.comment` [rejected §L7-C: `GET /api/approvals/:id/history`
           is `authenticate`-only (`routes/approval-history.ts:43`) and selects raw record columns with no
           mask (`:86-104`), so a hidden field's value would become readable by any authenticated
           user] · (c) no before/after anywhere, leaving
           "what changed" unanswerable and the 内容变更 tier ungroundable
  OD-L7-8  Routing drivers × editable — (a)[R] publish-pin: a field referenced by any assignee source,
           `ConditionRule` or condition formula may not be `editable` at ANY node · (b) allow, and
           re-resolve downstream from the edited value — which lets an approver choose their own reviewer
           (`:6059-6065`, `:6270-6276` rebuild the resolver from the CURRENT snapshot at every dispatch) ·
           (c) allow, but freeze the driver value at create so edits do not re-route, which means the form
           and the routing disagree from that point on and the shipped hint's promise silently changes
           meaning. Runtime truncation of a resolved approver list remains inadmissible in all three
  OD-L7-9  Legacy default for templates with no matrix — (a)[R] absent ≡ `editable`, exactly as shipped
           (`types/approval-product.ts:37-52`; FE `stepFieldAccess:383-387` and the delete-when-editable
           projection `setStepFieldPermission:394`), so every existing template and instance is
           byte-stable · (b) all-visible-read-only [rejected §2.1/§2.2: it retro-narrows every published
           version, and because `asRuntimeGraph` re-normalizes on every dispatch it would change the
           behavior of instances already in flight] · (c) per-template opt-in flag, a second vocabulary
           for the same question
  OD-L7-10 Read-DTO access channel and its OpenAPI cost — (a)[R] add a per-field access map to the detail
           DTO, actor-scoped from the same derivation, and pay the OpenAPI edit in the same slice
           (`base.yml:3453-3477` currently omits `fieldPermissions` entirely; no runtime validator is
           wired, so the cost is codegen plus `tools/guard-codegen.mjs`) · (b) no channel, which leaves
           `readonly` unrenderable — today `hidden` is indistinguishable from empty because
           `buildDisplayFields` skips any field absent from the snapshot (`detailField.ts:547`) — so the
           FE would have to infer access, i.e. re-derive the matrix client-side · (c) instance-scoped map,
           cheaper but wrong for the write surface, since the actor needs to know what THEY may edit
  OD-L7-11 Lock-4's 内容变更 obligation — (a)[R] discharged in this slice: scope the dedup readers'
           history to the post-edit round using the shipped `nodeEntryEpoch` machinery, gated by G-16 ·
           (b) re-transferred with a named owner slice and a ledger row, leaving the tier honest only
           while it stays unauthorable. Lock-4's own wording asks for (a); Lock-3 §3 forbids treating the
           obligation as already discharged under either arm
  OD-L7-12 Detail sub-columns — (a)[R] excluded in v1: the cross-reference set is top-level only
           (`:1254`) and the grid rows are top-level fields (`TemplateAuthoringView.vue:2330`); N row
           values are ambiguous for one access decision (Lock-2's reasoning, inherited) · (b) per-column
           access, which needs a second addressing scheme (`fieldId.columnId`) in the matrix, in both
           validators and in both grids

Unverified at this baseline, recorded so no later document treats it as settled:
  - Whether any HTTP surface echoes `approval_records.metadata` for a LOCAL instance. The
    `authenticate`-only history route selects `comment` but NOT `metadata`
    (`routes/approval-history.ts:87-93`), while `ApprovalBridgeService.loadLocalHistory:975-991` maps
    `metadata` into its DTO and the only route call site reached from HTTP is the PLM branch
    (`routes/approval-history.ts:60`). OD-L7-7(a) is the fail-closed choice under either reading, and
    gate G-8 asserts the behavior either way.
  - Whether any persisted `fieldPermissions` entry carries a shape the current normalizer would reject
    (§2.1's census is a slice deliverable, not a finding here).
  - Lock-2's OD-L2-5 and §L2-C required-pin finding, and Lock-8's MS-1…MS-13 census and MS-3 defaults, are
    cited from branch-pinned documents that are NOT on main. The MS-3 anchors themselves (AGE:412-413,
    `:552-553`), the required-for-visible-only behavior (AGE:625-627) and the no-rule-≡-visible arm
    (AGE:230-233) WERE re-read at this baseline and are exact here.
  - Whether the corpus's 编辑-without-可读 combination is accepted, rejected, or coerced by Feishu (§0
    Correction 1). Per M11 this is absence of evidence in the manual, not evidence of behavior.
  - D-5's instance-detail read scope is an OPEN owner question and is NOT resolved by this document.

Deltas:
Runtime authorization: NONE unless explicitly stated — ratifying this document authorizes design only.
  Each contract still needs its own PR, required checks, adversarial gate, and ledger row. No flag, no
  UAT, no deployment. The handler node remains Lock-3's; per-node operation policy remains Lock-5's;
  dedup tiers remain Lock-4's; Lock-6 L6-C stays DEFERRED until this surface lands; instance-detail read
  scope remains an external owner question.
```
