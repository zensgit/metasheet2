# Lock-7B — Node-Level REQUIRED Field Tier (必填) (2026-08-20)

**Status:** DRAFT — §4 is BLANK. Nothing here is ratified, authorized, or implemented. Design authority
only: no runtime code, no flag, no UAT, no deployment.
**Baseline:** `origin/main@a0edbe39a488909c156ca7a6aaf757f4e78cfd7f`. Every anchor below was READ AT THIS
BASELINE. The repository is not shallow (`git rev-parse --is-shallow-repository` → `false`), so ancestry
answers here are trustworthy; no ancestry claim is made about any document this file does not cite by SHA.
Unqualified `:NNNN` anchors are `packages/core-backend/src/services/ApprovalProductService.ts` (**APS**);
`AGE:` is `packages/core-backend/src/services/ApprovalGraphExecutor.ts`; `RED:` is
`packages/core-backend/src/services/approval-form-redaction.ts`.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED, on main) — M4 (capability registry
is fail-closed; unknown persisted values are never flattened), M7 (no disabled theater), M8 (configuration
and enforcement must be honest), M11 (evidence language is scoped).
`approval-lock7-field-edit-enforcement-20260817.md` (RATIFIED, on main) — this document is a **delta on
Lock-7 and re-opens none of its twelve ODs**: OD-L7-3 (handler-only write surface v1), OD-L7-4 (field
permissions on approval + handler node types only), OD-L7-5 (one derivation, instance-scoped read +
actor-single-node write), OD-L7-8 (routing-driver publish pin over a shared helper), OD-L7-9 (absent ≡
`editable`), OD-L7-10 (actor-scoped `fieldAccess` DTO map) are each cited as BINDING.
`approval-lock3-handler-node-20260817.md` (RATIFIED, on main) §2.2/§3 — the handler submit transaction and
its `opinionRequired` 422 precedent. `approval-lock8-field-vocabulary-20260817.md` A-1 — `explanation`
carries no submitted value. `approval-lock0-d0-interaction-delta-20260817.md` L0-6 — the one-change rule
across the two authoring surfaces.
**Non-effects:** no migration, no flag change, no tenant UAT, no deployment, no completion label. The
contract below still needs its own PR, required checks, an independent adversarial gate, and a ledger row.

## 0. Shipped surfaces, and two premise corrections

### 0.1 What is already on main (read at baseline)

| # | Shipped surface | Anchor | Relevance here |
|---|---|---|---|
| S-1 | `NodeFieldAccess = 'editable' \| 'readonly' \| 'hidden'` + `NodeFieldPermission { fieldId, access }`, with the P1-C semantics comment above them | `packages/core-backend/src/types/approval-product.ts:82-103` | the carrier this lock widens (OD-L7B-1) |
| S-2 | Publish-time value admission: `NODE_FIELD_ACCESS_VALUES` + `normalizeNodeFieldPermissions` | `:563`; `:1595-1623` (enum check `:1612-1613`) | where a fourth member is admitted |
| S-3 | **One state per field per node**: a duplicate `fieldId` inside a node's matrix is a hard publish failure | `:1616-1618` (`seen.has(fieldId)` → `failValidation`) | the entire OD-L7B-1 unrepresentability argument rests on THIS line |
| S-4 | D-1 publish choke: `fieldPermissions` on a non-write-capable node type → 400 `APPROVAL_NODE_FIELD_PERMISSIONS_UNSUPPORTED_NODE_TYPE` | `:2669-2678` (code `:2675`) | the precedent for fail-closed publish validation, reused by OD-L7B-3 |
| S-5 | `collectRoutingDriverFieldIds` — the SHARED driver derivation, consumed by the publish pin and by the runtime write guard | `:1860-1893`; publish pin 1 `:1905-1917` (equality test `:1911`); runtime guard `:10469`, `:10482` | OD-L7B-4 reuses it; no second derivation |
| S-6 | `applyHandlerFieldWrites` — the handler write surface (Lock-7 P4-B): unknown field 400, driver 403 `APPROVAL_FIELD_WRITE_DRIVER_FORBIDDEN`, mask 403 `APPROVAL_FIELD_WRITE_FORBIDDEN`, unwritable type 400 `APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE`, then an in-place `form_snapshot` merge | `:10436` (signature); `:10469`; `:10482`; mask `:10484-10488`; type refusal `:10508` | the write step OD-L7B-5 enforces AFTER |
| S-7 | Handler submit: the `handle` branch, and the `opinionRequired` 422 `APPROVAL_HANDLER_OPINION_REQUIRED` with values-free `{ nodeKey }` | `:8819`; throw `:8829-8836`; field writes applied at `:8857` | the shape OD-L7B-5's 422 mirrors, and the ordering constraint |
| S-8 | Access resolution: `NODE_FIELD_ACCESS_RANK` (a `Record<NodeFieldAccess, number>`), `resolveFieldAccessAtNodes`, `fieldAccessAtNodes`, `collectHiddenFieldIds` | `RED:5-9`; `RED:71-100` (value filter `RED:91`); `RED:107-113`; `RED:116-129` | the silent-drop hazard of §2.3 |
| S-9 | Create-time required validation: `validateApprovalFormData` skips fields invisible under `getVisibleFormFieldIds`, then rejects `field.required && isEmptyValue(value)` | `AGE:798-826` (visibility skip `AGE:807-809`, required check `AGE:811-813`); `AGE:367-372`; `AGE:205-210` | the definition OD-L7B-5 reuses verbatim |
| S-10 | Lock-7 G-5 / pin 3: a form-level `required` field carrying a `visibilityRule` and `hidden` at EVERY write-capable node fails publish as unfillable | `:1919-1956` (deterministic node key `:1942-1944`) | a DIFFERENT obligation from this lock's (§2.6); not re-opened |
| S-11 | Actor-scoped DTO channel `fieldAccess: Record<string, NodeFieldAccess>` on the DETAIL read, plus its published wire enum | `ApprovalBridgeService.ts:683-695`; `approval-bridge-types.ts:43-51`; `packages/openapi/src/base.yml:3882-3894` (enum `:3887`) | OD-L7-10 DID land; a fourth member is client-visible (§2.4) |
| S-12 | Two authoring surfaces render the three-state control; the linear editor authors approval STEPS, the canvas inspector authors graph NODES | `TemplateAuthoringView.vue:1029-1040` (options `:1037-1039`), its own canvas getter/setter `:2412-2421`; `ApprovalGraphNodeConfigEditor.vue:1025-1036` (options `:1033-1035`), section flag `:1167-1169` | OD-L7B-7 |

### 0.2 Premise correction 1 — the create-time emptiness definition is type-AGNOSTIC, not per-type

The task framing describes "the empty-value definition per field type" in the create-time validator. It is
not per-type. `isEmptyValue` (`AGE:205-210`) is a single type-agnostic predicate:

```ts
value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
```

Per-type behaviour enters only through the SEPARATE validators (`validateFieldType` `AGE:480`,
`validateFieldConstraints` `AGE:632-636`, `validateDetailFieldValue`), which are emptiness-blind — each
returns early on `undefined`/`null`. So this lock reuses ONE predicate, and it inherits that predicate's
holes verbatim rather than minting a stricter second definition: `0`, `false`, a whitespace-only string,
`{}` (the shape a `date_range` field carries), and `{ recordId: '' }` are all NON-empty today at create,
and stay non-empty at a node. That inheritance is DISCLOSED and asserted (G-11), never implied fixed — the
Lock-7 G-6 precedent for the MS-3 fail-open. `isEmptyValue` is currently module-private; the implementation
obligation is to EXPORT the one definition, never to re-implement it.

### 0.3 Premise correction 2 — the corpus was not re-read, and it did not evidence a node-level 必填 row

The offline handbook corpus Lock-7 cites (`feishu/6933484342190538780.txt`) is **not present in this
worktree**, so no line-anchored corpus claim is made here. Lock-7's own §0 census, read at this baseline,
records the 表单权限 blocks for 发起 / 审批 / 抄送 / 办理 / 结束 as **two independent checkboxes, 可读 +
编辑** (C-1…C-6) — there is no 必填 row in any of the five. Under M11: the reference corpus as cited by
Lock-7 did not evidence a node-level 必填 tier at those blocks, and the absence of a documented row is not
evidence that the reference product lacks the capability elsewhere. The requirement in this document is
therefore **goal-set-supplied, not corpus-derived**, and the word "parity" is deliberately not used for it.
What IS corpus-grounded is the field-level 必填 already shipped as `FormField.required` (S-9) — a different
obligation (§2.6).

### 0.4 Carrier census, swept at this baseline (not inherited)

Lock-7 R-1 recorded FIVE hand copies of the access enum, and its G-14 pins them by exact set. That count is
NOT carried forward as a remembered figure: the sweep below was re-run at `a0edbe39a4` over all three
literals plus the type name, across `packages/core-backend/src`, `apps/web/src`, and
`packages/openapi/src`, excluding `*.test.*` / `*.spec.*` (a stated scope, not an accident — the test
mirrors are G-14's business). It finds **eight** sites, three of which R-1's five do not obviously cover:

| # | Site | Kind | Compiler-guarded? |
|---|---|---|---|
| C-1 | `types/approval-product.ts:98` — the type alias | declaration | n/a (source of truth) |
| C-2 | `:563` `NODE_FIELD_ACCESS_VALUES` | runtime `Set` | no — a `Set<NodeFieldAccess>` literal type-checks while incomplete |
| C-3 | `RED:5-9` `NODE_FIELD_ACCESS_RANK` | `Record<NodeFieldAccess, number>` | **YES** — a missing member fails the build |
| C-4 | `RED:91` inline `candidate !== 'editable' && … !== 'hidden'` filter | runtime literal chain | **no — fails SILENTLY** (§2.3) |
| C-5 | `apps/web/src/types/approval.ts:166` — FE mirror alias | declaration | no (hand mirror of C-1) |
| C-6 | `apps/web/src/approvals/approvalNodeEdit.ts:456` — validator literal tuple | runtime literal | no |
| C-7 | `apps/web/src/approvals/templateAuthoring.ts:536-538` `isNodeFieldAccess`, consumed by `isBackendDroppedFieldPermission:1001-1008` | runtime literal | no — and see §2.5 for its behavioural consequence |
| C-8 | `packages/openapi/src/base.yml:3887` `enum: [editable, readonly, hidden]` on the `fieldAccess` response map | published wire contract | no |

Two further sites read the enum by VALUE rather than mirroring it, and must be re-read rather than merely
widened: the publish pin's equality test `:1911` and the write mask's `access !== 'editable'` at `:10485`
(§2.2).

## 1. Contracts

### 1.0 Decision list

Each row states the RECOMMENDED arm `[R]` and the arm being rejected, so the rejected arm is not
re-proposed later.

| OD | Question | `[R]` recommended arm | Rejected arm, and why |
|---|---|---|---|
| OD-L7B-1 | Carrier for 必填 | **(a)** `required` becomes a FOURTH member of the SAME `NodeFieldAccess` enum: `'editable' \| 'readonly' \| 'hidden' \| 'required'`. A node assigns exactly ONE state per field (S-3), so 必填 × hidden at one node is **unrepresentable by construction** | **(b)** an orthogonal `requiredAtNode: boolean` alongside `access` — rejected: it CREATES the `hidden` + `required` combination, which then needs a validator, which then needs trap enumeration for `readonly` + `required`, for cross-node interactions, and for every member added later. A criterion that cannot be expressed cannot be bypassed; a criterion enforced by a check can |
| OD-L7B-2 | Cross-node composition | **(a)** masks are PER NODE and independent: `hidden` at node A and `required` at node B is LEGAL and meaningful (A must not see it; B must ensure it is filled) | **(b)** a graph-wide consistency rule rejecting the pair — rejected: it is not an inconsistency, it is the point of per-node masks, and such a rule would break legitimate templates. Stated explicitly so nobody "fixes" it later |
| OD-L7B-3 | Where `required` is satisfiable | **(a)** **handler nodes ONLY in v1**. An approval node has no field write surface (OD-L7-3), so `required` there is unsatisfiable by anyone at that node ⇒ publish REJECTS it, values-free 400, at the S-4 choke | **(b)** accept it inert on approval nodes "for forward compatibility" — rejected under M7/M8: an author who marks a field 必填 and gets no enforcement has been told a falsehood by the product. Widening rides the future approval-node write surface (OD-L7-3's named next slice), not this lock |
| OD-L7B-4 | Routing-driver fields | **(a)** a routing driver is never writable at any node (`:10482`, matrix-independent), so `required` on a driver field is unsatisfiable ⇒ publish REJECTS, using the SAME `collectRoutingDriverFieldIds` (S-5) — one helper, no second derivation (Lock-7 OD-L7-8 discipline) | **(b)** a fresh driver derivation local to this check, or a runtime-only refusal — rejected: two derivations drift, and a runtime-only refusal converts an authoring mistake into an in-flight deadlock |
| OD-L7B-5 | Enforcement point + emptiness | **(a)** at handler SUBMIT (the `handle` action), AFTER `applyHandlerFieldWrites` has merged the actor's writes: every field marked `required` at that node, and visible per the create-time visibility rule, must be non-empty in the EFFECTIVE snapshot. A value already filled by the requester SATISFIES it. Emptiness = `isEmptyValue` (`AGE:205-210`) verbatim, holes and all (§0.2). Violation ⇒ 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY` | **(b)** enforce per-field at write time, or mint a per-type emptiness definition — rejected: write-time enforcement cannot see a field the actor did not send (the empty case is exactly the absent case), and a second emptiness definition guarantees that create and node disagree about the same value |
| OD-L7B-6 | `hidden` ⊄ writable | **(a)** restate and ASSERT the shipped invariant: a field `hidden` at a node is not writable there (`:10484-10488` refuses everything outside the writable set), and `required` at that same node is unrepresentable (OD-L7B-1) | **(b)** treat `required` as implying visibility, overriding a `hidden` mark — rejected: at one node there is no `hidden` mark to override, and across nodes OD-L7B-2 governs |
| OD-L7B-7 | Authoring surface | **(a)** the fourth option renders ONLY on handler nodes, in the canvas node-config field-permission control; on approval nodes it is **absent, not disabled-greyed** (M7). The linear editor authors approval steps only and therefore gains NO fourth option | **(b)** render it everywhere, disabled, with a tooltip — rejected: M7 forbids disabled theater; an unrendered capability is honest, a greyed one invites "when does this turn on?" |
| OD-L7B-8 | Non-goals | **(a)** no DDL (`fieldPermissions` is graph JSON inside the published definition), no new action verb (`handle` is unchanged), no bootstrap-version bump, no feature flag: the tier is config opt-in, and an absent `required` entry leaves behaviour byte-identical | **(b)** ship behind a flag — rejected: there is no default-ON behaviour change to gate, so a flag adds a second inert state to test without reducing risk. NOTE the deliberate exception in §2.4: the DTO / OpenAPI enum widening IS in scope of the slice |
| OD-L7B-9 | Unsatisfiable BY TYPE | **(a)** publish REJECTS `required` on a field whose type can never acquire a value at a handler node: `explanation` (carries no value at any time, Lock-8 A-1) and `record-link` / `attachment` (refused at `:10508` pending binding + authz) | **(b)** allow them and rely on a create-fill analysis à la Lock-7 G-5 — rejected: that mints a SECOND guaranteed-filled-at-create analyzer, and it leaves a template where the handler is told to fill a field the write surface refuses. Widening rides each type's write support |
| OD-L7B-10 | How the fourth member is added | **(a)** ONE mechanical enumeration over `NODE_FIELD_ACCESS_VALUES` replaces the `RED:91` literal chain, and the §0.4 census is asserted by exact set including the OpenAPI enum | **(b)** hand-edit the eight copies and rely on review — rejected: six of the eight are invisible to the compiler and one of those fails silently. The discipline is a mechanical enumeration, never "add one more `\|\|` arm" |

### 1.1 L7B-A — the carrier, and what makes 必填 × hidden unrepresentable

`NodeFieldAccess` gains `'required'` (OD-L7B-1). The four members are mutually exclusive by the SAME
mechanism that already makes 编辑-without-可读 unrepresentable in Lock-7: a node's `fieldPermissions` is a
list of `{ fieldId, access }`, and `normalizeNodeFieldPermissions` HARD-FAILS a duplicate `fieldId` inside
one node (`:1616-1618`). One field, one node, one state. There is consequently **no `required` × `hidden`
combination to validate, reject, or write a trap test for** — and the correct gate is therefore not a
rejection test but an assertion on the dedup guard itself (G-1), because the whole claim hangs on that one
line.

Semantics of the fourth member, stated so that no reader has to infer them:

- `required` is `editable` **plus an obligation**. It is not more restrictive than `editable`; it is the
  same write permission with a submit-time condition attached.
- Therefore `required` is WRITABLE. §2.2 is the load-bearing consequence.
- Absent from a node's matrix still ≡ `editable` (OD-L7-9, untouched). `required` is never a default.
- On the read axis `required` hides nothing and redacts nothing: `collectHiddenFieldIds` (`RED:116-129`)
  keys on `'hidden'` alone and is unchanged.

### 1.2 L7B-B — what publish must newly reject (all fail-closed, all values-free)

At the existing publish / normalize chokes, in addition to everything Lock-7 already rejects:

1. `access: 'required'` on an **approval** node ⇒ 400 `APPROVAL_NODE_REQUIRED_FIELD_UNSUPPORTED_NODE_TYPE`,
   metadata `{ nodeKey, nodeType, fieldId }` (OD-L7B-3). Every other non-handler node type is ALREADY
   rejected wholesale by S-4 (`:2669-2678`) for carrying `fieldPermissions` at all, so this new rejection
   is exactly the approval-node case and nothing wider.
2. `access: 'required'` on a field in `collectRoutingDriverFieldIds(approvalGraph.nodes)` ⇒ 400
   `APPROVAL_NODE_REQUIRED_FIELD_DRIVER_UNSUPPORTED`, `{ nodeKey, fieldId }` (OD-L7B-4). Placed inside
   `validateFieldEditEnforcementPins` (`:1895`) beside pin 1, reading the SAME set built at `:1905`.
3. `access: 'required'` on a field of type `explanation`, `record-link`, or `attachment` ⇒ 400
   `APPROVAL_NODE_REQUIRED_FIELD_UNSUPPORTED_TYPE`, `{ nodeKey, fieldId, fieldType }` (OD-L7B-9). This is
   a cross-reference against the form schema and therefore belongs with the other publish-time schema
   cross-checks, not in the shape normalizer.

Each of the three is a REJECTION, never an accepted-inert value (M7): the pre-slice behaviour is pinned
first so the change is visible on the SAVED graph (the Lock-7 G-12 pattern), and each message carries
identifiers only — never a form value.

### 1.3 L7B-C — the submit-time check

Ordering inside the `handle` branch (`:8819`…), which is one transaction (Lock-3 §3):

1. `opinionRequired` 422, unchanged (`:8829-8836`).
2. `applyHandlerFieldWrites` merges this actor's writes (`:8857`), with every Lock-7 refusal intact.
3. **NEW** — the required-at-node check, computed on the EFFECTIVE snapshot (the frozen create snapshot
   with this submit's writes merged over it), against the FROZEN version form schema:
   - candidates = the fields marked `required` at THIS node, resolved through
     `fieldAccessAtNodes(graph, [nodeKey], fieldId)` (`RED:107-113`) — the single-node read, so multi-node
     precedence is unobservable here, exactly as Lock-7 G-1a states for the write mask;
   - **skip** any candidate absent from `getVisibleFormFieldIds(frozenSchema, effectiveSnapshot)`
     (`AGE:367-372`) — the same skip `validateApprovalFormData` applies at create (`AGE:807-809`). A field
     whose own `visibilityRule` is unsatisfied is not renderable, and must not deadlock the node;
   - for each surviving candidate, `isEmptyValue(effectiveSnapshot[fieldId])` ⇒ **422
     `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`**.
4. Everything after (seat deactivation, quorum tally, audit row, dispatch) is unchanged.

**会签 (`handlerMode === 'all'`) — the obligation attaches to the SUBMIT, not to the node's completion
`[R]`.** Step 3 sits BEFORE seat deactivation and the partial-handle branch (`:8867`,
`handlerMode === 'all' && remainingAssignments > 0`), so the check fires on EVERY `handle` submit, including
a partial 会签 one: with three seats, the first seat cannot exit while the field is empty. This is a stated
decision, not a consequence of line ordering. The rejected arm is "evaluate only on the COMPLETING submit":
the completing seat is whichever seat happens to go last, so that arm attaches a mandatory-fill obligation
to a nondeterministic actor, and it lets every earlier seat exit having been shown a 必填 mark that did
nothing to them (M8). In 或签 (`any`) the two arms are indistinguishable — the first submit is the
completing submit.

Because the check runs at step 3 and not at step 2, a value the REQUESTER already filled satisfies it with
an empty `fieldWrites: {}` payload: the node guarantees the field IS filled, not who filled it (OD-L7B-5).

**Error metadata.** `{ nodeKey, fieldId }`, where `fieldId` is the FIRST empty candidate in
`formSchema.fields` declaration order (deterministic, mirroring pin 3's deterministic node key at
`:1942-1944`). This deviates from `APPROVAL_HANDLER_OPINION_REQUIRED`'s `{ nodeKey }`-only shape, and the
deviation is deliberate: Lock-7's own field-scoped refusals already carry `fieldId` (`:10482`, `:10485`,
`:10508`), and by OD-L7B-1 a `required` field can never be `hidden` at that node, so its id discloses
nothing the actor cannot already see on the form. It stays values-free — an identifier, never a value. The
alternative (`{ nodeKey }` only, an exact mirror of the opinion 422) is recorded here as the arm being
rejected, so an owner can flip it without re-deriving the argument.

The transaction rolls back as a unit: a 422 here leaves zero snapshot change, zero revision row, zero audit
row, zero assignment change, and an unchanged `version` — including the writes step 2 already applied
(G-9). That is the atomicity Lock-7 G-7 asserts, extended to one more failure point.

## 2. Cross-cutting invariants

**2.1 Widen-only.** Every stored graph is re-normalized on read and on dispatch, so the admission set may
only GROW. Nothing that publishes today may fail after this slice; nothing that dispatches today may fail
after this slice. Every rejection in §1.2 targets a value that CANNOT exist in a stored graph today,
because `NODE_FIELD_ACCESS_VALUES` (`:563`) rejects `'required'` at every entry point at this baseline.
That is what makes the new rejections safe to apply unconditionally — including on the dispatch
re-normalize path, unlike Lock-7's D-1 guard, which had to be exempted there for pre-existing graphs.

**2.2 The carrier choice BREAKS the write mask unless the predicate is converted.**
`applyHandlerFieldWrites` refuses on `access !== 'editable'` (`:10485`). With `required` as a fourth
member, a field marked 必填 becomes NON-writable — the handler cannot fill the field the author just made
mandatory, and the node deadlocks on its own obligation. The predicate MUST become set membership over a
named writable set `{ 'editable', 'required' }`, defined once and exported from the same module as the
enum. G-5 asserts it in both directions. The publish pin's equality test (`:1911`,
`permission.access === 'editable'`) takes the same treatment for the same reason — a driver marked
`required` would otherwise slip past the pin. That second change is **defense-in-depth only**: the actual
escalation stays closed by the matrix-INDEPENDENT runtime driver guard at `:10482`, which refuses a write
to any driver field whatever the matrix says, and by OD-L7B-4's publish rejection. Both are stated so that
neither is mistaken for the fix.

**2.3 One silent-drop site, one compiler-guarded site — know which is which.** `NODE_FIELD_ACCESS_RANK`
(`RED:5-9`) is typed `Record<NodeFieldAccess, number>`: adding a member to the alias FAILS THE BUILD until
the table is extended. Further down the same module, `resolveFieldAccessAtNodes` filters with an inline literal chain
(`RED:91`); a fourth member is dropped there **silently**, and the field then falls back to absent ≡
`editable` — a template's 必填 mark would vanish at runtime with no error anywhere. The fix is OD-L7B-10's
mechanical enumeration (`NODE_FIELD_ACCESS_VALUES.has(candidate)`), NOT an appended
`|| candidate === 'required'`: the appended-arm form passes every test written for this slice and
reproduces the identical defect for the fifth member. G-2 fails a compliant-looking implementation that
took the appended-arm route.

On the rank table: ranks are RELATIVE ORDER ONLY (nothing reads their absolute values). `required` is
inserted immediately above `editable` and below `readonly` — `hidden` ≻ `readonly` ≻ `required` ≻
`editable`. The rank is observable ONLY on the multi-node read path (the DTO map and the redaction union);
the submit check and the write mask both pass exactly `[nodeKey]`, where precedence is unobservable — the
fact Lock-7 G-1a already states in as many words, cited here rather than re-litigated. G-4 asserts that
shipped multi-node behaviour is byte-identical.

**2.4 The read DTO and the wire enum are in scope, not a non-goal.** OD-L7-10 DID land: the detail read
emits `fieldAccess` (`ApprovalBridgeService.ts:683-695`, typed at `approval-bridge-types.ts:43-51`) and the
OpenAPI response schema publishes `enum: [editable, readonly, hidden]` (`base.yml:3887`). A fourth member
is an ADDITIVE but client-visible widening of a response enum, so it is named as an in-slice site, with the
disclosure that a strict client validating that enum sees a value it has never seen. Swept at this
baseline: `fieldAccess` has **no consumer in `apps/web/src`** today (the DTO field is produced and typed,
not yet rendered), so the widening breaks no shipped FE code path — a fact to be re-swept in the
implementing slice, never assumed from this line.

**2.5 The linear editor's round-trip classifier must be widened, or it silently downgrades templates.**
`isBackendDroppedFieldPermission` (`templateAuthoring.ts:1001-1008`) treats an out-of-enum `access` as a
value the backend would drop, and routes such a template to the read-only / preserve-verbatim path so that
nothing is flattened (M4). If `isNodeFieldAccess` (`:536-538`) is not widened in the SAME change, a
canvas-authored handler node carrying `required` makes the whole template classify as non-linear-editable.
That is fail-closed (no data loss) but WRONG, and it is invisible to the compiler. It is named as a census
site (C-7) with its behavioural consequence, not merely as a literal to update.

**2.6 Two different obligations at two different times — do not conflate them.** Form-level
`FormField.required` (S-9) is a CREATE-time obligation on the requester, enforced by
`validateApprovalFormData`. Node-level `required` (this lock) is a SUBMIT-time obligation at a handler
node, enforced once per node visit. Prose here says "form-level required" and "required-at-node", never the
bare word for the other. They interact in exactly one already-shipped place: Lock-7 pin 3 / G-5
(`:1919-1956`) rejects a form-level `required` field that is `hidden` at every write-capable node. That pin
is NOT re-opened, NOT re-derived, and NOT extended here — a required-at-node mark is not `hidden`, so it
can only make a field MORE fillable, never less, and pin 3's unfillability arithmetic is unchanged.

**2.7 Open questions this document does not settle.** (i) Whether the obligation should also be evaluated
on a return / 回退 into the node, or on any dispatch path other than `handle` — v1 says no, because
`handle` is the only path with a write surface (OD-L7-3), and any other answer needs the approval-node
write surface first. (ii) Whether the FE should surface the obligation before submit (a client-side hint
computed from `fieldAccess`) — presentation only, no enforcement value, deliberately out of scope while
`fieldAccess` has no FE consumer at all (§2.4). (iii) Detail sub-columns stay excluded exactly as OD-L7-12
excludes them: `fieldId.columnId` is not a top-level id, so it can no more be marked `required` than it can
be marked `hidden`.

## 3. Acceptance gates

Every absence assertion carries a positive control; every row names the mutation that turns a specific test
red, and asserts that the anchor was actually hit. A gate whose mutation reds nothing FAILS — an
ineffective mutation and a useless test look identical from the outside.

| # | Gate | Assertion | Positive control / discriminating negative (mandatory) |
|---|---|---|---|
| G-1 | 必填 × hidden is unrepresentable, and the MECHANISM is asserted | a named test publishes a node whose matrix carries TWO entries for the same `fieldId` (`required` + `hidden`) and asserts the 400 from `:1616-1618` by exact error, not merely "not 200" | neuter `seen.has(fieldId)` ⇒ that test reds AND a companion test asserting one state per field on the SAVED graph reds. If the mutation reds nothing, the unrepresentability claim is unasserted and this gate FAILS. Positive control: two entries for DIFFERENT fields at the same node publish normally |
| G-2 | The fourth member is admitted MECHANICALLY, not by an appended literal arm | delete `'required'` from `NODE_FIELD_ACCESS_VALUES` (`:563`) ⇒ the publish-admission test, the `resolveFieldAccessAtNodes` test AND the write-mask test all red from that ONE mutation | with the member present all three are green. **Anti-gate:** an implementation that instead appends `\|\| candidate === 'required'` at `RED:91` FAILS this gate even with every test green — the assertion is on the mechanism (a single enumeration source, verified by reading the diff), not on the outcome |
| G-3 | The silent-drop site is actually closed | a stored graph carrying `access: 'required'` resolves to exactly `'required'` through `resolveFieldAccessAtNodes` — asserted by MAP-VALUE EQUALITY, never by `!== 'editable'` | the same fixture run against the SHIPPED filter yields `'editable'` (the absent-key default), proving the fixture exercises the drop path rather than passing vacuously. "Not editable" is not an outcome assertion |
| G-4 | Multi-node read behaviour is byte-identical | the full shipped redaction suite passes unchanged with the rank table extended; a parallel-region fixture with `required` at node A and `hidden` at node B active together resolves `hidden` on the read axis | the SAME fixture's submit check at node A is asserted UNAFFECTED (it reads `[nodeKey]`); and a rank flip between `hidden` and `readonly` reds its own named multi-node test while both single-node tests stay green |
| G-5 | A `required` field is WRITABLE at its node | a handler write to a `required` field at the actor's node succeeds and lands in `form_snapshot` | revert the mask to `access !== 'editable'` (`:10485`) ⇒ a named test reds with 403 `APPROVAL_FIELD_WRITE_FORBIDDEN`. Positive control in the SAME fixture: a `readonly` field at that node is still refused — the widening is member-selected, not blanket |
| G-6 | Publish rejects `required` on an approval node | `required` on an approval node fails publish at every entry point that reaches the normalizer, values-free, carrying `{ nodeKey, nodeType, fieldId }` and no value | the pre-slice behaviour is pinned FIRST by asserting the SAVED graph, so the change from accepted to rejected is visible rather than assumed; positive controls: the same field marked `readonly` on that approval node still publishes, and marked `required` on a handler node in the same graph publishes |
| G-7 | Publish rejects `required` on a routing driver, via the SHARED helper | for EACH driver kind — a `form_field_user` source field, a `ConditionRule.fieldId`, a condition-formula operand — `required` on a handler node fails publish | mutate `collectRoutingDriverFieldIds` ALONE ⇒ BOTH the shipped Lock-7 pin-1 test AND the new required-driver test red, proving one derivation. If only one reds, a second derivation exists and this gate FAILS. Positive control: a NON-driver field marked `required` on that node publishes |
| G-8 | Publish rejects `required` on a type that can never hold a value at a handler node | `explanation`, `record-link` and `attachment` each fail publish in their own case, `{ nodeKey, fieldId, fieldType }` | a `text` field marked `required` on the same node publishes; and for `record-link` / `attachment` a companion assertion pins the reason — a direct handler write to them is refused at `:10508` — so the rejection is tied to the live refusal rather than to a remembered one |
| G-9 | Submit 422 when a required field is empty after writes, atomically | handler submits with the field empty ⇒ 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`, `{ nodeKey, fieldId }`, AND zero snapshot change, zero revision row, zero audit row, zero assignment change, unchanged `version` | the success path in the same fixture changes all five, so the rollback is not asserted against a no-op; and the 422 is asserted by exact code, never by "not 200" |
| G-10 | Satisfaction is snapshot-selected, not writer-selected | (a) the requester pre-filled at create and the handler submits `fieldWrites: {}` ⇒ 200, node advances; (b) the handler fills it in the same submit ⇒ 200; (c) neither ⇒ 422 | move the check BEFORE the write merge ⇒ case (b) reds while case (a) stays green — the ordering is asserted, not assumed. Three cases in one fixture make the check emptiness-selected rather than payload-selected |
| G-10b | The obligation is per-submit under 会签, on the real multi-seat path | a `handlerMode === 'all'` node with TWO seats: field empty, the FIRST seat submits ⇒ 422 (the node does not record a partial handle); field then filled, the first seat submits ⇒ 200 partial with the node still pending, and the second seat completes it | move the check AFTER the partial-handle branch (`:8867`) ⇒ the first case reds while every single-seat case in G-10 stays green — which is exactly why G-10 alone does not cover this: all three of its cases are single-seat and never enter `handlerMode === 'all'`. Positive control: the same two-seat fixture with NO `required` entry records both partial and completing handles unchanged |
| G-11 | Emptiness is the create-time definition, holes included | `''`, `null`, `[]` and an absent key each 422 at the node; a companion test RECORDS that `0`, `false`, a whitespace-only string and `{}` are treated as NON-empty at BOTH create and node | mutate `isEmptyValue` (`AGE:205-210`) ⇒ the create-time required test AND the node-required test both red from that one mutation. If only one reds, a second definition was minted and this gate FAILS |
| G-12 | Invisible fields do not deadlock the node | a field marked `required` at the node whose own `visibilityRule` is unsatisfied on the effective snapshot is NOT enforced — the submit succeeds | the discriminating pair: with the rule SATISFIED, the same empty field 422s in the same fixture. Removing the visibility skip reds the first case only |
| G-13 | Legacy graphs are byte-identical | a template with no `required` entry behaves byte-identically before and after: handler submit outcomes, echoed `formSnapshot` bytes, `fieldAccess` payload bytes, saved graph bytes | a template WITH a `required` entry diverges in the same fixture, so the default is default-selected rather than accidentally global; and a pre-slice graph corpus round-trips save → publish → dispatch → version-diff → restore unchanged |
| G-14 | Census by exact set, including the wire enum | the EIGHT §0.4 sites are asserted equal by exact set — not count, not subset — and the site LIST itself is asserted, so a ninth copy added later fails the census rather than passing unnoticed | dropping the member from any ONE site reds a distinct named test; the test names which sites the compiler would have caught (C-3 plus the two aliases) and which six it would not, so the census is not mistaken for redundant with type-checking. The count is swept at `a0edbe39a4` (§0.4), not inherited from Lock-7 R-1's five |
| G-15 | Both authoring surfaces move together, and the option is ABSENT where unsupported | the fourth option renders on a handler node in the canvas control (`ApprovalGraphNodeConfigEditor.vue:1033-1035`); on an approval node the control renders EXACTLY three options and no disabled fourth exists in the DOM (M7); the linear editor (`TemplateAuthoringView.vue:1037-1039`) renders three everywhere | adding the option to only one surface, or rendering it disabled on approval nodes, reds a named test (Lock-0 L0-6 one-change rule plus M7). Positive control: a handler node authored through the canvas round-trips its `required` entry through save → reload → publish unchanged, INCLUDING through `isBackendDroppedFieldPermission` (§2.5) — asserted by the template staying linear-editable, not by a comment |

## 4. Owner ratification block

```text
Decision:
Owner:
Date:
Document SHA:
Decisions recorded:
Independent review:
Runtime authorization:
```

<!-- INTENTIONALLY BLANK. This document is a DRAFT: no decision above is ratified, no arm is settled, and
     nothing here authorizes implementation, a flag change, a deployment, or a completion label. The ten
     OD rows in §1.0 are RECOMMENDATIONS awaiting the owner's own record. -->
