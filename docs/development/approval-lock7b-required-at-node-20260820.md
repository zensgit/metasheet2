# Lock-7B — Node-Level REQUIRED Field Tier (必填) (2026-08-20)

**Status:** RATIFIED 2026-08-20 — §4 records the owner decision under goal-set provenance, and §5 records
the disposition of the independent review that preceded it. Design authority ONLY: no runtime code, no
flag, no UAT, no deployment, and no completion label is authorized here. Every contract below still needs
its own PR, required checks, an independent adversarial gate, and a ledger row.
**Review round:** an independent opus refute-first review returned REQUEST-CHANGES against draft head
`b85987d3ed77bf09866ffd63b39d89a6d185ae77` (2 P1, 4 P2, 5 P3, 4 NIT). The text below is the POST-review
text: every P1/P2 is closed in a contract or a gate, every P3/NIT is dispositioned, and the one place the
review is itself corrected is recorded in §5 with its evidence.
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
Lock-7**. Its twelve ODs are swept ONE BY ONE below rather than dismissed in bulk: an unqualified
"re-opens none of them" would be an absolute claim over a domain the reader never saw swept, which is
exactly what the review's P2-3 caught. **OD-L7-1** (shipped carrier) BINDING and reused — §1.1 widens that
carrier and mints no second vocabulary. **OD-L7-2** (the tri-state collapse) CITED, not re-opened: its
question is how 编辑-without-可读 is REPRESENTED, and that state stays UNREPRESENTABLE here — `required` is
`editable` PLUS an obligation (§1.1), never a read/write split — so OD-L7-2(a) stands unamended. Enum
ARITY is a different question from the collapse, and OD-L7-2's own rejection rationale for its arm (c)
says in as many words that "an enum widening is safe" while a per-entry SHAPE change is the narrowing it
refuses; this lock takes the widening and makes no shape change (§2.1). **OD-L7-3** (handler-only write
surface v1) BINDING — it is why OD-L7B-3 rejects `required` on approval nodes. **OD-L7-4** (field
permissions on approval + handler node types only) BINDING. **OD-L7-5** (one derivation, instance-scoped
read + actor-single-node write) BINDING. **OD-L7-6** (in-place `form_snapshot` UPDATE plus revision rows)
untouched — this lock adds no write. **OD-L7-7** (values-free audit) untouched, and honoured by every new
error's metadata. **OD-L7-8** (routing-driver publish pin over a shared helper) BINDING — OD-L7B-4 reuses
the same helper. **OD-L7-9** (absent ≡ `editable`) BINDING and unchanged. **OD-L7-10** (actor-scoped
`fieldAccess` DTO map) BINDING, and widened in-slice (§2.4). **OD-L7-11** (内容变更 per-edit marker)
untouched. **OD-L7-12** (detail sub-columns excluded) BINDING (§2.7 iii). No Lock-7 OD is re-opened,
amended, or contradicted — and this sweep, not that sentence, is the evidence for it.
`approval-lock3-handler-node-20260817.md` (RATIFIED, on main) §2.2/§3 — the handler submit transaction and
its `opinionRequired` 422 precedent; and **OD-L3-1(a)** (a handler node is FORBIDDEN inside a parallel
region and as a join node, publish-time 400 `APPROVAL_HANDLER_IN_PARALLEL`, `:2135`), which is a
load-bearing PRECONDITION of OD-L7B-2 rather than a background fact — §2.7 (iv) records the loan and its
reopen condition. `approval-lock8-field-vocabulary-20260817.md` A-1 — `explanation`
carries no submitted value. `approval-lock0-d0-interaction-delta-20260817.md` L0-6 — the one-change rule
across the two authoring surfaces.
**Non-effects:** no migration, no flag change, no tenant UAT, no deployment, no completion label. The
contract below still needs its own PR, required checks, an independent adversarial gate, and a ledger row —
and, per §0.4, a `generate:sdk` regeneration without which that PR is CI-red.

## 0. Shipped surfaces, and two premise corrections

### 0.1 What is already on main (read at baseline)

| # | Shipped surface | Anchor | Relevance here |
|---|---|---|---|
| S-1 | `NodeFieldAccess = 'editable' \| 'readonly' \| 'hidden'` + `NodeFieldPermission { fieldId, access }`, with the P1-C semantics comment above them | `packages/core-backend/src/types/approval-product.ts:82-103` | the carrier this lock widens (OD-L7B-1) |
| S-2 | Publish-time value admission: `NODE_FIELD_ACCESS_VALUES` + `normalizeNodeFieldPermissions` | `:563`; `:1595-1623` (enum check `:1612-1613`) | where a fourth member is admitted |
| S-3 | **One state per field per node**: a duplicate `fieldId` inside a node's matrix is a hard publish failure | `:1616-1618` (`seen.has(fieldId)` → `failValidation`) | the entire OD-L7B-1 unrepresentability argument rests on THIS line |
| S-4 | D-1 publish choke: `fieldPermissions` on a non-write-capable node type → 400 `APPROVAL_NODE_FIELD_PERMISSIONS_UNSUPPORTED_NODE_TYPE` | `:2668-2678` (code `:2675`) | the precedent for fail-closed publish validation, reused by OD-L7B-3 |
| S-5 | `collectRoutingDriverFieldIds` — the SHARED driver derivation, consumed by the publish pin and by the runtime write guard | `:1860-1893`; publish pin 1 `:1905-1917` (equality test `:1911`); runtime guard `:10469`, `:10482` | OD-L7B-4 reuses it; no second derivation |
| S-6 | `applyHandlerFieldWrites` — the handler write surface (Lock-7 P4-B): unknown field 400, driver 403 `APPROVAL_FIELD_WRITE_DRIVER_FORBIDDEN`, mask 403 `APPROVAL_FIELD_WRITE_FORBIDDEN`, unwritable type 400 `APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE`, then an in-place `form_snapshot` merge | `:10436` (signature); `:10469`; `:10482`; mask `:10484-10488`; type refusal `:10508` | the write step OD-L7B-5 enforces AFTER |
| S-7 | Handler submit: the `handle` branch, and the `opinionRequired` 422 `APPROVAL_HANDLER_OPINION_REQUIRED` with values-free `{ nodeKey }` | `:8819`; throw `:8829-8836`; field writes applied at `:8857` | the shape OD-L7B-5's 422 mirrors, and the ordering constraint |
| S-8 | Access resolution: `NODE_FIELD_ACCESS_RANK` (a `Record<NodeFieldAccess, number>`), `resolveFieldAccessAtNodes`, `fieldAccessAtNodes`, `collectHiddenFieldIds` | `RED:5-9`; `RED:71-100` (value filter `RED:91`); `RED:107-113`; `RED:122-131` | the silent-drop hazard of §2.3 |
| S-9 | Create-time required validation: `validateApprovalFormData` skips fields invisible under `getVisibleFormFieldIds`, then rejects `field.required && isEmptyValue(value)` | `AGE:798-826` (visibility skip `AGE:807-809`, required check `AGE:811-813`); `AGE:367-372`; `AGE:205-210` | the definition OD-L7B-5 reuses verbatim |
| S-10 | Lock-7 G-5 / pin 3: a form-level `required` field carrying a `visibilityRule` and `hidden` at EVERY write-capable node fails publish as unfillable | `:1919-1956` (deterministic node key `:1942-1944`) | a DIFFERENT obligation from this lock's (§2.6); not re-opened |
| S-11 | Actor-scoped DTO channel `fieldAccess: Record<string, NodeFieldAccess>` on the DETAIL read, plus its published wire enum | `ApprovalBridgeService.ts:681-695`; `approval-bridge-types.ts:43-51`; `packages/openapi/src/base.yml:3882-3894` (enum `:3887`) | OD-L7-10 DID land; a fourth member is client-visible (§2.4) |
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
`{}` and `{ recordId: '' }` are all NON-empty today at create,
and stay non-empty at a node. That inheritance is DISCLOSED and asserted (G-11), never implied fixed — the
Lock-7 G-6 precedent for the MS-3 fail-open. `isEmptyValue` is currently module-private; the implementation
obligation is to EXPORT the one definition, never to re-implement it. (`{}` is named as a raw JSON shape
only: `validateFieldType` refuses `{}` for a `date_range` field, which must be exactly `{ start, end }`
(`AGE:553-559`), so `{}` is not a reachable create-time value for a VISIBLE `date_range` — the review's
NIT-3, accepted. The `isEmptyValue` hole itself is unaffected: the predicate never sees a type.)

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
mirrors are G-14's business). It finds **nine** sites, FOUR of which — C-3, C-4, C-8 and C-9 — R-1's five do not obviously cover.
C-9 was added by the independent review (P2-1): the first sweep missed it, and the count is therefore
stated as a swept result at `a0edbe39a4`, not as a figure this document defends:

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
| C-9 | `:1613` — the publish-rejection MESSAGE `` `${entryPath}.access must be editable, readonly, or hidden` `` | user-facing message literal | no — and it is the one site whose staleness is read BY AN AUTHOR: left unwidened, the product would accept `required` while telling authors the only legal values are the three (M8) |

Two further sites read the enum by VALUE rather than mirroring it, and must be re-read rather than merely
widened: the publish pin's equality test `:1911` and the write mask's `access !== 'editable'` at `:10485`
(§2.2).

**Declared scope, and what it deliberately excludes.** The sweep above is over `…/src` trees. FOUR further
`git ls-files`-tracked copies of the wire enum live in GENERATED artifacts and are therefore outside it.
They are OUTPUTS, not sites, and must never be hand-edited:

| Generated artifact | Anchor |
|---|---|
| `packages/openapi/dist/openapi.yaml` | `:4502-4509` |
| `packages/openapi/dist/combined.openapi.yml` | `:4502-4509` |
| `packages/openapi/dist/openapi.json` | `:6089-6098` |
| `packages/openapi/dist-sdk/index.d.ts` | `:16616` |

`.github/workflows/plugin-tests.yml:721-722` runs `pnpm --filter @metasheet/openapi generate:sdk` and then
`git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts`, so the IMPLEMENTING
PR is CI-RED until the generator is re-run and its output committed. That regeneration is a named landing
obligation of the slice. G-14 asserts the NINE source sites by exact set and deliberately does NOT cover
the generated four; G-14b covers them the only honest way, through the CI step that produces them.

### 0.5 Prose carriers that this slice makes FALSE (not enum copies, not census sites)

These are not hand copies of the enum, so they are correctly outside §0.4 — but the first is cited by S-1
as the carrier this lock widens, and the fourth is a CONTRACT statement rather than a comment. All five
are landing obligations of the slice (the review's P3-4), and G-16 says which one is behaviourally
assertable and which four are documentary.

| # | Carrier | What becomes false |
|---|---|---|
| PC-1 | `types/approval-product.ts:88-97` (the S-1 semantics comment) | "Only `hidden` is enforced at runtime … `readonly`/`editable` … have NO runtime effect yet … do not wire them" — already falsified by Lock-7 P4-B at `:10485`, and further by this lock |
| PC-2 | `types/approval-product.ts:216-217` | "`readonly`/`editable` are inert (forward-stable contract only)" — same drift, second copy |
| PC-3 | `apps/web/src/types/approval.ts:184-185` | "`readonly`/`editable` are runtime-inert" — and it CONTRADICTS `:162-165` of the same file, which is already correct |
| PC-4 | `approval-bridge-types.ts:47` | "a field reported `editable` here is exactly a field the write path accepts" — a CONTRACT statement, not a comment: after §2.2 the accepted set is `editable ∪ required`, so the sentence is false unless rewritten. G-16 asserts the underlying property behaviourally |
| PC-5 | `packages/openapi/src/base.yml:3890` | the published description prose enumerates the three members alongside C-8's enum |

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
| OD-L7B-5 | Enforcement point + emptiness | **(a)** at handler SUBMIT (the `handle` action), AFTER `applyHandlerFieldWrites` has merged the actor's writes: every field marked `required` at that node, and visible per the create-time visibility rule, must be non-empty in the EFFECTIVE snapshot. A value already filled by the requester SATISFIES it. Emptiness = `isEmptyValue` (`AGE:205-210`) verbatim, holes and all (§0.2). Violation ⇒ 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`. The visibility evaluation point is OD-L7B-12; the schema load that makes this check reachable at all is OD-L7B-11 | **(b)** enforce per-field at write time, or mint a per-type emptiness definition — rejected: write-time enforcement cannot see a field the actor did not send (the empty case is exactly the absent case), and a second emptiness definition guarantees that create and node disagree about the same value |
| OD-L7B-6 | `hidden` ⊄ writable | **(a)** restate and ASSERT the shipped invariant: a field `hidden` at a node is not writable there (`:10484-10488` refuses everything outside the writable set), and `required` at that same node is unrepresentable (OD-L7B-1) | **(b)** treat `required` as implying visibility, overriding a `hidden` mark — rejected: at one node there is no `hidden` mark to override, and across nodes OD-L7B-2 governs |
| OD-L7B-7 | Authoring surface | **(a)** the fourth option renders ONLY on handler nodes, in the canvas node-config field-permission control; on approval nodes it is **absent, not disabled-greyed** (M7). The linear editor authors approval steps only and therefore gains NO fourth option | **(b)** render it everywhere, disabled, with a tooltip — rejected: M7 forbids disabled theater; an unrendered capability is honest, a greyed one invites "when does this turn on?" |
| OD-L7B-8 | Non-goals | **(a)** no DDL (`fieldPermissions` is graph JSON inside the published definition), no new action verb (`handle` is unchanged), no bootstrap-version bump, no feature flag: the tier is config opt-in, and an absent `required` entry leaves behaviour byte-identical | **(b)** ship behind a flag — rejected: there is no default-ON behaviour change to gate, so a flag adds a second inert state to test without reducing risk. NOTE the deliberate exception in §2.4: the DTO / OpenAPI enum widening IS in scope of the slice |
| OD-L7B-9 | Unsatisfiable BY TYPE | **(a)** publish REJECTS `required` on a field whose type can never acquire a value at a handler node: `explanation` (carries no value at any time, Lock-8 A-1) and `record-link` / `attachment` (refused at `:10508` **pending binding + authz** — a temporary refusal, so the REOPEN CONDITION is recorded: when either type's handler write support lands, this rejection is revisited in THAT slice, since it rejects an unsatisfiable MARK and says nothing about the field type itself) | **(b)** allow them and rely on a create-fill analysis à la Lock-7 G-5 — rejected: that mints a SECOND guaranteed-filled-at-create analyzer, and it leaves a template where the handler is told to fill a field the write surface refuses. Widening rides each type's write support |
| OD-L7B-10 | How the fourth member is added | **(a)** ONE mechanical enumeration over `NODE_FIELD_ACCESS_VALUES` replaces the `RED:91` literal chain; the §0.4 census is asserted by exact set over the NINE source sites, including the OpenAPI SOURCE enum (`base.yml:3887`) and the author-facing publish message (`:1613`), whose text is DERIVED from the same enumeration rather than hand-rewritten; the four GENERATED copies (§0.4) are regenerated by CI, never edited | **(b)** hand-edit the nine copies and rely on review — rejected: seven of the nine are invisible to the compiler and one of those fails silently. The discipline is a mechanical enumeration, never "add one more `\|\|` arm" |
| OD-L7B-11 | Where the frozen form schema is loaded | **(a)** the `SELECT form_schema` at `:8849` is HOISTED out of the `hasOwnProperty(request, 'fieldWrites')` guard (`:8848`) and re-gated on `fieldWrites` present **OR** a non-empty `required` candidate set at this node, resolved through `resolveFieldAccessAtNodes` (never through a literal chain — §2.3). A legacy graph issues no extra query and stays byte-identical (G-13); an opted-in template pays exactly one `SELECT` it does not pay today | **(b)** leave the load inside the guard — rejected: `fieldWrites` is detected by key PRESENCE (`types/approval-product.ts:876`), so omitting ONE JSON key would skip the load, skip the check, and discharge every 必填 obligation at the node — a zero-cost client bypass of this lock's only enforcement surface · **(c)** hoist it unconditionally — rejected: it charges every handle submit an extra read including graphs that never opt in, and it widens the reachability of the 409 `APPROVAL_FROZEN_SCHEMA_NOT_FOUND` (`:8855`) to templates with no `required` entry at all (§2.1 residual 2) |
| OD-L7B-12 | Which snapshot the visibility skip reads | **(a)** the UNION: a candidate is enforced when it is visible on the PRE-write frozen snapshot **OR** on the post-write effective snapshot, and skipped only when invisible on BOTH. One predicate (`getVisibleFormFieldIds`, `AGE:367-372`) evaluated at two points — a second CALL, never a second definition | **(b)** post-write only — rejected: `visibilityRule` drivers are NOT routing drivers (`collectRoutingDriverFieldIds`, `:1860-1893`, collects only `form_field_user` / `ConditionRule.fieldId` / condition-formula operands) and `applyHandlerFieldWrites` performs no visibility check (`:10475-10525`), so the actor could write the driver to hide the very field they were shown as 必填 and exit clean: the obligation would be discardable by the actor it binds · **(c)** pre-write only — rejected: a field the actor's OWN write reveals would then escape the obligation entirely · **(d)** publish-REJECT `required` on any field whose `visibilityRule` references a field writable at the same node — rejected WITH its computation, so it is not re-proposed as "the stricter option": under OD-L7-9 absent ≡ `editable`, so nearly every driver is writable at a handler node unless the author explicitly marks it `readonly`/`hidden` there; the rule would refuse nearly every conditional 必填 field, and it would kill the natural 办理 pattern (the handler answers a question, the answer reveals a follow-up field, the follow-up is mandatory) that arm (a) supports exactly |
| OD-L7B-13 | Binding under 会签 / 或签 | **(a)** the obligation attaches to the SUBMIT: the check sits BEFORE seat deactivation and the partial-handle branch (`:8867`), so it fires on EVERY `handle` submit, including a partial 会签 one | **(b)** evaluate only on the COMPLETING submit — rejected: the completing seat is whichever seat happens to go last, so (b) attaches a mandatory-fill obligation to a nondeterministic actor and lets every earlier seat exit having been shown a 必填 mark that did nothing to them (M8). Handler modes are exactly two (`normalizeHandlerMode`, `AGE:174-176`: `'any'` for `'any'`, `'all'` for everything else), so the dichotomy is complete; in 或签 the two arms are indistinguishable |

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
- On the read axis `required` hides nothing and redacts nothing: `collectHiddenFieldIds` (`RED:122-131`)
  keys on `'hidden'` alone and is unchanged.

### 1.2 L7B-B — what publish must newly reject (all fail-closed, all values-free)

At the existing publish / normalize chokes, in addition to everything Lock-7 already rejects:

1. `access: 'required'` on an **approval** node ⇒ 400 `APPROVAL_NODE_REQUIRED_FIELD_UNSUPPORTED_NODE_TYPE`,
   metadata `{ nodeKey, nodeType, fieldId }` (OD-L7B-3). Every other non-handler node type is ALREADY
   rejected wholesale by S-4 (`:2668-2678`) for carrying `fieldPermissions` at all, so this new rejection
   is exactly the approval-node case and nothing wider.
2. `access: 'required'` on a field in `collectRoutingDriverFieldIds(approvalGraph.nodes)` ⇒ 400
   `APPROVAL_NODE_REQUIRED_FIELD_DRIVER_UNSUPPORTED`, `{ nodeKey, fieldId }` (OD-L7B-4). Placed inside
   `validateFieldEditEnforcementPins` (`:1895`) beside pin 1, reading the SAME set built at `:1905`.
   **Ordering pin:** this check runs BEFORE pin 1's own (widened) test (§2.2). Both reject the same input
   once pin 1 becomes set membership over `{ 'editable', 'required' }`, and without a stated order the
   message an author sees would be decided by whichever line happens to be written first. The order is
   part of the contract: a driver field marked `required` always yields
   `APPROVAL_NODE_REQUIRED_FIELD_DRIVER_UNSUPPORTED`, never pin 1's generic message. G-7 asserts the code
   by exact match and therefore asserts the order.
3. `access: 'required'` on a field of type `explanation`, `record-link`, or `attachment` ⇒ 400
   `APPROVAL_NODE_REQUIRED_FIELD_UNSUPPORTED_TYPE`, `{ nodeKey, fieldId, fieldType }` (OD-L7B-9). This is
   a cross-reference against the form schema and therefore belongs with the other publish-time schema
   cross-checks, not in the shape normalizer — and it is PUBLISH-only for that same reason: the dispatch
   re-normalize path has no form schema in scope (§2.1).

Each of the three is a REJECTION, never an accepted-inert value (M7): the pre-slice behaviour is pinned
first so the change is visible on the SAVED graph (the Lock-7 G-12 pattern), and each message carries
identifiers only — never a form value.

### 1.3 L7B-C — the submit-time check

Ordering inside the `handle` branch (`:8819`…), which is one transaction (Lock-3 §3):

0. **NEW — the frozen-schema load MOVES (OD-L7B-11).** Today the only `SELECT form_schema` in the whole
   handle transaction is at `:8849`, INSIDE `if (Object.prototype.hasOwnProperty.call(request, 'fieldWrites'))`
   (`:8848`), and `fieldWrites` is "Detected by key PRESENCE" (`types/approval-product.ts:876`, verbatim).
   The frozen `FormSchema` object is in scope by no other route: the executor constructed at `:8202` takes
   `(runtimeGraph, formData, options)` and carries no schema. Step 3 needs that schema twice — for
   `getVisibleFormFieldIds` and for the declaration-order determinism rule below — so leaving the load
   where it is would let a client discharge every 必填 obligation at the node by OMITTING ONE JSON KEY.
   The `SELECT` is therefore hoisted out of the guard and re-gated on: `fieldWrites` present **OR** a
   non-empty `required` candidate set at this node (step 3). A legacy template — no `required` entry, no
   `fieldWrites` key — issues no extra query and stays byte-identical (G-13). G-10c asserts the bypass is
   closed; G-9b asserts the fail-closed behaviour when the schema row is unreachable (§2.1 residual 2).
1. `opinionRequired` 422, unchanged (`:8829-8836`).
2. `applyHandlerFieldWrites` merges this actor's writes (`:8857`), with every Lock-7 refusal intact.
3. **NEW** — the required-at-node check, computed on the EFFECTIVE snapshot (the frozen create snapshot
   with this submit's writes merged over it), against the FROZEN version form schema:
   - candidates = the fields marked `required` at THIS node, read from
     `resolveFieldAccessAtNodes(runtimeGraph, [nodeKey])` (`RED:71-100`) — the MAP-returning form, because
     `fieldAccessAtNodes` (`RED:107-113`) resolves one field id and cannot enumerate (and rebuilds the
     whole map on every call, `RED:112`). A single-node read, so multi-node precedence is unobservable
     here, exactly as Lock-7 G-1a states for the write mask;
   - the EFFECTIVE snapshot is RECONSTRUCTED by the caller: `applyHandlerFieldWrites` returns
     `{ changedFieldIds, revisions }` (`:10446`) and no merged object — the merge itself is a server-side
     jsonb `||` inside the UPDATE at `:10530` — so the check composes `revisions[].after` over
     `formSnapshot` rather than re-reading the row inside its own transaction. Asserted (G-9c), not assumed;
   - **skip** any candidate invisible under `getVisibleFormFieldIds` (`AGE:367-372`) on BOTH the pre-write
     frozen snapshot AND the post-write effective snapshot — the UNION rule of OD-L7B-12. A field whose
     own `visibilityRule` the AUTHOR left unsatisfied is not renderable and must not deadlock the node; a
     field the ACTOR made invisible with this very submit is NOT thereby discharged;
   - for each surviving candidate, `isEmptyValue(effectiveSnapshot[fieldId])` ⇒ **422
     `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`**.
4. Everything after (seat deactivation, quorum tally, audit row, dispatch) is unchanged.

**Reuse, stated precisely (M8).** `isEmptyValue` is reused VERBATIM and `getVisibleFormFieldIds` is the
same function `validateApprovalFormData` calls at create (`AGE:807-809`) — no second definition of either
is minted. The one asymmetry is deliberate and is a STRENGTHENING: create evaluates visibility ONCE, the
node check evaluates the SAME predicate at two points and unions them (OD-L7B-12), so the node enforces a
superset of what either single evaluation would. Said plainly so that "we reuse the create-time rule" is
not read as "the two rules are identical".

**会签 (`handlerMode === 'all'`) — the obligation attaches to the SUBMIT, not to the node's completion
(OD-L7B-13).** Step 3 sits BEFORE seat deactivation and the partial-handle branch (`:8867`,
`handlerMode === 'all' && remainingAssignments > 0`), so the check fires on EVERY `handle` submit,
including a partial 会签 one: with three seats, the first seat cannot exit while the field is empty. This
is a ratified decision, not a consequence of line ordering. The rejected arm is "evaluate only on the
COMPLETING submit": the completing seat is whichever seat happens to go last, so that arm attaches a
mandatory-fill obligation to a nondeterministic actor, and it lets every earlier seat exit having been
shown a 必填 mark that did nothing to them (M8). Handler modes are exactly two — `normalizeHandlerMode`
(`AGE:174-176`) yields `'any'` for `'any'` and `'all'` for everything else, and the authoring surface
offers 会签 / 或签 only — so the dichotomy is complete and no third mode is left unruled. In 或签 (`any`)
the two arms are indistinguishable: the first submit IS the completing submit.

Because the check runs at step 3 and not at step 2, a value the REQUESTER already filled satisfies it —
with an empty `fieldWrites: {}` payload, and equally with NO `fieldWrites` key at all (the two payload
shapes are behaviourally identical here by OD-L7B-11, which is exactly what G-10c pins): the node
guarantees the field IS filled, not who filled it (OD-L7B-5).

**Error metadata.** `{ nodeKey, fieldId }`, where `fieldId` is the FIRST empty candidate in
`formSchema.fields` declaration order (deterministic, mirroring pin 3's deterministic node key at
`:1942-1944`) — the second of the two reasons step 0 exists, since that order lives in the frozen schema.
This deviates from `APPROVAL_HANDLER_OPINION_REQUIRED`'s `{ nodeKey }`-only shape, and the deviation is
deliberate: Lock-7's own field-scoped refusals already carry `fieldId` (`:10482`, `:10485`, `:10508`), and
by OD-L7B-1 a `required` field can never be `hidden` at that node, so its id discloses nothing the actor
cannot already see on the form. It stays values-free — an identifier, never a value. The alternative
(`{ nodeKey }` only, an exact mirror of the opinion 422) is recorded here as the arm being rejected, so an
owner can flip it without re-deriving the argument.

The transaction rolls back as a unit: a 422 here leaves zero snapshot change, zero revision row, zero audit
row, zero assignment change, and an unchanged `version` — including the writes step 2 already applied
(G-9). That is the atomicity Lock-7 G-7 asserts, extended to one more failure point.

## 2. Cross-cutting invariants

**2.1 Widen-only, stated by CONTEXT rather than by baseline.** Every stored graph is re-normalized on
read and on dispatch, so the admission set may only GROW. Nothing that publishes today may fail after this
slice; nothing that dispatches today may fail after this slice. Every rejection in §1.2 targets a value
that CANNOT exist in a stored graph at this baseline, because `NODE_FIELD_ACCESS_VALUES` (`:563`) rejects
`'required'` at every entry point today — but that argument EXPIRES the instant the slice ships, so it is
not what the rule rests on. The rule is: **all three §1.2 rejections run on the authoring / publish path
only (`context !== STORED_RUNTIME_CONTEXT`), exactly the exemption the shipped D-1 choke already takes at
`:2668`.** Rejection 3 is publish-only by construction anyway — it is a form-schema cross-check and the
dispatch re-normalize path has no schema in scope — so the exemption is a live statement about rejections
1 and 2. On the stored-runtime path a `required` entry normalizes THROUGH unchanged, which is the entire
point of the tier; an unsatisfiable one surfaces as §1.3's actionable 422 at submit rather than as an
undispatchable instance.

DISCLOSED residual (1): a hand-edited or defensively-constructed stored graph carrying `required` on a
field the write surface refuses — a routing driver, an `explanation` — yields a 422 the actor cannot
clear at that node. No legitimately published graph can reach that state (publish rejects all three
shapes), and the fix is republish; recorded rather than argued away.

DISCLOSED residual (2), the one OD-L7B-11 bounds: `approval_instances.template_version_id` is NULLABLE
(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_version_id UUID REFERENCES
approval_template_versions(id) ON DELETE SET NULL`, migration
`zzzz20260411120100_approval_templates_and_instance_extensions.ts:107`), while the runtime graph is read
from `approval_published_definitions` via `published_definition_id` (`:8180`, `:8193`) — an INDEPENDENT
column. An instance can therefore carry a `required` entry in its runtime graph and a NULL
`template_version_id`; the frozen-schema `SELECT` returns zero rows and the existing 409
`APPROVAL_FROZEN_SCHEMA_NOT_FOUND` (`:8855`) becomes reachable on a submit that carries no `fieldWrites`
key, where today it is not. That is why OD-L7B-11 scopes the load to opted-in templates: the new exposure
is bounded to templates that use the tier, and it stays FAIL-CLOSED — a 409, never a silent discharge of
the obligation (M8). Per M11: the column PERMITS NULL; whether any live instance carries one is UNSWEPT
and this document does not answer it. G-9b asserts both the fail-closed behaviour and the opt-in bound.

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

**Three shared artifacts on the access axis, and no fourth.** After this slice the implementation must
end with exactly three: (i) the enum plus `NODE_FIELD_ACCESS_VALUES` (`:563`), (ii) the WRITABLE set
`{ 'editable', 'required' }` exported from the same module and consumed by both `:10485` and `:1911`, and
(iii) `resolveFieldAccessAtNodes` (`RED:71-100`) as the single access resolver. Any fourth hand-maintained
list of members — a second writable set local to the publish pin, a local copy of the member list in the
canvas editor — is the drift class OD-L7B-10 exists to prevent, and it is a review-diff failure even if
every test is green.

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

**C-4 is load-bearing for ENFORCEMENT, not only for the read DTO.** Under OD-L7B-11 the frozen-schema
load — and therefore §1.3 step 3 in its entirety — is keyed on the node carrying at least one `required`
candidate, and that candidate set is resolved through `resolveFieldAccessAtNodes`. If an implementer
leaves the `RED:91` literal chain in place, the candidate set is EMPTY for every template, the schema
never loads, and the check never runs — the review's P1-1 bypass reproduced behind its own fix, and
silently. The appended-arm form (`|| candidate === 'required'`) hides the same failure one member later:
it works for `required` and reproduces exactly this bypass for the fifth member, with every test written
for THIS slice still green. G-3's second arm asserts the coupling directly.

**2.3a Fail-open audit of every consumer that reads the enum by value.** The point of the table is that
exactly ONE consumer fails open, and it is the one whose failure is invisible.

| Consumer | Behaviour on a member it does not know | Direction |
|---|---|---|
| `normalizeNodeFieldPermissions` enum check (`:1612-1613`) | publish 400, with the C-9 message | fail-CLOSED, self-reporting |
| `resolveFieldAccessAtNodes` inline filter (`RED:91`, C-4) | entry skipped ⇒ field falls back to absent ≡ `editable` (OD-L7-9) | **FAIL-OPEN, and SILENT — the only one** |
| `collectHiddenFieldIds` (`RED:122-131`) | derived over the resolver; an unknown member is simply not `hidden` | fail-open on the READ axis, and harmless: it can only make a field more visible, never leak a `hidden` one |
| `applyHandlerFieldWrites` write mask (`:10484-10488`) | `access !== 'editable'` ⇒ 403 `APPROVAL_FIELD_WRITE_FORBIDDEN` | fail-CLOSED — which is precisely why §2.2 must convert it: fail-closed here means the 必填 field is unwritable |
| `validateApprovalNodeEdits` (`approvalNodeEdit.ts:456`, C-6) | 「字段权限类型无效」 at save | fail-CLOSED, author-visible (§2.5) |
| `isBackendDroppedFieldPermission` / `isNodeFieldAccess` (C-7) | entry treated as a backend-drop ⇒ template preserved verbatim, read-only path (M4) | fail-CLOSED, no data loss |
| a strict client validating `base.yml:3887` (C-8) | outside this repository's control | UNDEFINED — disclosed in §2.4, not asserted |

Read as an obligation: after this slice, the second row must no longer exist as a hand-maintained literal.
Every row above is a consumer of ONE enumeration, and OD-L7B-10 is what makes that true mechanically.

**2.4 The read DTO and the wire enum are in scope, not a non-goal.** OD-L7-10 DID land: the detail read
emits `fieldAccess` (`ApprovalBridgeService.ts:681-695`, typed at `approval-bridge-types.ts:43-51`) and the
OpenAPI response schema publishes `enum: [editable, readonly, hidden]` (`base.yml:3887`). A fourth member
is an ADDITIVE but client-visible widening of a response enum, so it is named as an in-slice site, with the
disclosure that a strict client validating that enum sees a value it has never seen. Swept at this
baseline: `fieldAccess` has **no consumer in `apps/web/src`** today (the DTO field is produced and typed,
not yet rendered), so the widening breaks no shipped FE code path — a fact to be re-swept in the
implementing slice, never assumed from this line.

**2.5 The linear editor's round-trip classifier: a census site with NO behavioural consequence — claim
RETRACTED.** The draft of this document asserted that unless `isNodeFieldAccess` (`templateAuthoring.ts:536-538`)
is widened in the SAME change, a canvas-authored handler node carrying `required` would make the whole
template classify as non-linear-editable. **That claim is withdrawn; it was false in both halves**, and
it is recorded here rather than deleted so it is not re-derived:

- `isBackendDroppedFieldPermission` (`:1002-1008`) never sees a handler node's ENTRIES. Its three call
  sites are `:709` (linear hydrate of approval steps), `:1071` (inside `complexApprovalConfigHasBackendDrop`,
  reached only from `case 'approval'` at `:1112`) and `:1270` (the linear-path approval-node check). The
  complex dispatcher's handler arm (`:1113-1120`) returns `hasKeyOutside(config, BACKEND_HANDLER_CONFIG_KEYS)`
  and, since `fieldPermissions` is inside that allowlist, the KEY passes and the entries are never
  inspected. `required` is handler-only (OD-L7B-3), so the classifier never receives a `required` entry.
- A handler graph is ALREADY non-linear-editable, unconditionally:
  `COMPLEX_GRAPH_NODE_TYPES = new Set(['cc', 'condition', 'parallel', 'handler'])` (`:342`) consumed by
  `isComplexApprovalGraph` (`:351-354`), per Lock-3 R-22. Such a template was never linear-editable, so
  the "downgrade" had nothing to downgrade.

What survives: C-7 stays in the §0.4 census as HYGIENE — one literal chain, widened by the same mechanical
enumeration as every other site (OD-L7B-10) — with no behavioural consequence claimed for it.

**The real one-change coupling is C-6.** `validateApprovalNodeEdits` runs
`if (!(['editable', 'readonly', 'hidden'] as const).includes(permission.access))` and pushes
「…的字段权限类型无效」 (`approvalNodeEdit.ts:456`), and that validator covers HANDLER nodes as well as
approval nodes (`:451-458`). If the canvas offers `required` while `:456` lags, the author is blocked at
SAVE with a message telling them the value they were just offered is invalid — the Lock-0 L0-6 one-change
rule, with a live failure attached. G-15's positive control is asserted there.

**2.6 Two different obligations at two different times — do not conflate them.** Form-level
`FormField.required` (S-9) is a CREATE-time obligation on the requester, enforced by
`validateApprovalFormData`. Node-level `required` (this lock) is a SUBMIT-time obligation at a handler
node, enforced once per node visit. Prose here says "form-level required" and "required-at-node", never the
bare word for the other. They interact in exactly one already-shipped place: Lock-7 pin 3 / G-5
(`:1919-1956`) rejects a form-level `required` field that is `hidden` at every write-capable node. That pin
is NOT re-opened, NOT re-derived, and NOT extended here — a required-at-node mark is not `hidden`, so it
can only make a field MORE fillable, never less, and pin 3's unfillability arithmetic is unchanged.

**2.7 Open questions this document does not settle, and one borrowed precondition.** (i) Whether the
obligation should also be evaluated on a return / 回退 into the node, or on any dispatch path other than
`handle` — v1 says no, because `handle` is the only path with a write surface (OD-L7-3), and any other
answer needs the approval-node write surface first. (ii) Whether the FE should surface the obligation
before submit (a client-side hint computed from `fieldAccess`) — presentation only, no enforcement value,
deliberately out of scope while `fieldAccess` has no FE consumer at all (§2.4). (iii) Detail sub-columns
stay excluded exactly as OD-L7-12 excludes them: `fieldId.columnId` is not a top-level id, so it can no
more be marked `required` than it can be marked `hidden`.

(iv) **OD-L7B-2's safety is BORROWED, and the loan is now recorded.** `hidden` at node A together with
`required` at node B is safe partly because the two can never be ACTIVE at the same time with a handler
at B: `collectHiddenFieldIds` (`RED:122-131`) takes the UNION across active nodes, so two concurrently
active nodes would serve the handler at B a snapshot with the 必填 field stripped. That is unreachable
at this baseline only because Lock-3 OD-L3-1(a) forbids a handler node inside a parallel region and as a
join node (publish-time 400 `APPROVAL_HANDLER_IN_PARALLEL`, `:2135`), and `required` is handler-only
(OD-L7B-3) — so a `required` node is never one of two concurrently active nodes. **Reopen condition:**
Lock-3 names arm (b) ("allow inside a parallel region") as the live alternative; the day it ships,
OD-L7B-2's blessed combination becomes exactly the M8 exposure OD-L7B-3 refuses for approval nodes, and
this lock must be re-adjudicated in that slice rather than inheriting a silent pass. G-4's parallel-region
fixture asserts the read axis only and does not, and cannot, discharge this.

## 3. Acceptance gates

Every absence assertion carries a positive control; every row names the mutation that turns a specific test
red, and asserts that the anchor was actually hit. A gate whose mutation reds nothing FAILS — an
ineffective mutation and a useless test look identical from the outside.

| # | Gate | Assertion | Positive control / discriminating negative (mandatory) |
|---|---|---|---|
| G-1 | 必填 × hidden is unrepresentable, and the MECHANISM is asserted | a named test publishes a node whose matrix carries TWO entries for the same `fieldId` (`required` + `hidden`) and asserts the 400 from `:1616-1618` by exact error, not merely "not 200" | neuter `seen.has(fieldId)` ⇒ that test reds AND a companion test asserting one state per field on the SAVED graph reds. If the mutation reds nothing, the unrepresentability claim is unasserted and this gate FAILS. Positive control: two entries for DIFFERENT fields at the same node publish normally |
| G-2 | The fourth member is admitted MECHANICALLY, not by an appended literal arm | delete `'required'` from `NODE_FIELD_ACCESS_VALUES` (`:563`) ⇒ the publish-admission test, the `resolveFieldAccessAtNodes` test AND the write-mask test all red from that ONE mutation | with the member present all three are green. **Anti-gate:** an implementation that instead appends `\|\| candidate === 'required'` at `RED:91` FAILS this gate even with every test green — the assertion is on the mechanism (a single enumeration source, verified by reading the diff), not on the outcome |
| G-3 | The silent-drop site is actually closed, and it is load-bearing for ENFORCEMENT | a stored graph carrying `access: 'required'` resolves to exactly `'required'` through `resolveFieldAccessAtNodes` — asserted by MAP-VALUE EQUALITY, never by `!== 'editable'` | the same fixture run against the SHIPPED filter yields `'editable'` (the absent-key default), proving the fixture exercises the drop path rather than passing vacuously. "Not editable" is not an outcome assertion. SECOND, mandatory arm: reverting `RED:91` to the shipped literal chain must ALSO red G-10c's absent-`fieldWrites` 422 — because under OD-L7B-11 the schema load, and therefore the whole check, is keyed on a candidate set resolved through this function. If only the resolution test reds, C-4 has been treated as a DTO concern and the P1-1 bypass has been reproduced behind its own fix (§2.3) |
| G-4 | Multi-node read behaviour is byte-identical | the full shipped redaction suite passes unchanged with the rank table extended; a parallel-region fixture with `required` at node A and `hidden` at node B active together resolves `hidden` on the read axis | the SAME fixture's submit check at node A is asserted UNAFFECTED (it reads `[nodeKey]`); and a rank flip between `hidden` and `readonly` reds its own named multi-node test while both single-node tests stay green |
| G-5 | A `required` field is WRITABLE at its node | a handler write to a `required` field at the actor's node succeeds and lands in `form_snapshot` | revert the mask to `access !== 'editable'` (`:10485`) ⇒ a named test reds with 403 `APPROVAL_FIELD_WRITE_FORBIDDEN`. Positive control in the SAME fixture: a `readonly` field at that node is still refused — the widening is member-selected, not blanket |
| G-6 | Publish rejects `required` on an approval node | `required` on an approval node fails publish at every entry point that reaches the normalizer, values-free, carrying `{ nodeKey, nodeType, fieldId }` and no value | the pre-slice behaviour is pinned FIRST by asserting the SAVED graph, so the change from accepted to rejected is visible rather than assumed; positive controls: the same field marked `readonly` on that approval node still publishes, and marked `required` on a handler node in the same graph publishes |
| G-7 | Publish rejects `required` on a routing driver, via the SHARED helper | for EACH driver kind — a `form_field_user` source field, a `ConditionRule.fieldId`, a condition-formula operand — `required` on a handler node fails publish | mutate `collectRoutingDriverFieldIds` ALONE ⇒ BOTH the shipped Lock-7 pin-1 test AND the new required-driver test red, proving one derivation. If only one reds, a second derivation exists and this gate FAILS. Positive control: a NON-driver field marked `required` on that node publishes |
| G-8 | Publish rejects `required` on a type that can never hold a value at a handler node | `explanation`, `record-link` and `attachment` each fail publish in their own case, `{ nodeKey, fieldId, fieldType }` | a `text` field marked `required` on the same node publishes; and for `record-link` / `attachment` a companion assertion pins the reason — a direct handler write to them is refused at `:10508` — so the rejection is tied to the live refusal rather than to a remembered one |
| G-9 | Submit 422 when a required field is empty after writes, atomically | handler submits with the field empty ⇒ 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`, `{ nodeKey, fieldId }`, AND zero snapshot change, zero revision row, zero audit row, zero assignment change, unchanged `version` | the success path in the same fixture changes all five, so the rollback is not asserted against a no-op; and the 422 is asserted by exact code, never by "not 200" |
| G-9b | The schema-load hoist stays FAIL-CLOSED when the frozen schema is unreachable | an instance whose `template_version_id` is NULL (the column is nullable — §2.1) and whose node carries a `required` entry ⇒ 409 `APPROVAL_FROZEN_SCHEMA_NOT_FOUND`, values-free `{ nodeKey }`, transaction rolled back — never a silent skip of the obligation (M8) | positive control in the SAME fixture: the identical NULL-`template_version_id` instance on a template with NO `required` entry and no `fieldWrites` key ⇒ 200, unchanged from the baseline — which asserts that the new 409 exposure is bounded to opted-in templates rather than global, and that the bound is the conditional hoist rather than luck |
| G-9c | The EFFECTIVE snapshot is reconstructed, not assumed | the check reads `revisions[].after` composed over `formSnapshot` (`:10446` returns `{ changedFieldIds, revisions }` and no merged object; the merge itself is the server-side jsonb `\|\|` at `:10530`) — asserted by a fixture where the requester's value is EMPTY and the actor's write is the only thing that satisfies the field, so a check reading the un-merged `formSnapshot` 422s | mutation: feed the check `formSnapshot` instead of the reconstruction ⇒ that fixture reds. Positive control: the reverse fixture (requester filled, actor writes nothing) stays 200 under both, so the gate is not satisfied by a check that simply never fires |
| G-10 | Satisfaction is snapshot-selected, not writer-selected | (a) the requester pre-filled at create and the handler submits `fieldWrites: {}` ⇒ 200, node advances; (b) the handler fills it in the same submit ⇒ 200; (c) neither ⇒ 422 | move the check BEFORE the write merge ⇒ case (b) reds while case (a) stays green — the ordering is asserted, not assumed. Three cases in one fixture make the check emptiness-selected rather than payload-selected |
| G-10b | The obligation is per-submit under 会签, on the real multi-seat path | a `handlerMode === 'all'` node with TWO seats: field empty, the FIRST seat submits ⇒ 422 (the node does not record a partial handle); field then filled, the first seat submits ⇒ 200 partial with the node still pending, and the second seat completes it | move the check AFTER the partial-handle branch (`:8867`) ⇒ the first case reds while every single-seat case in G-10 stays green — which is exactly why G-10 alone does not cover this: all three of its cases are single-seat and never enter `handlerMode === 'all'`. Positive control: the same two-seat fixture with NO `required` entry records both partial and completing handles unchanged |
| G-10c | The check cannot be skipped by OMITTING the `fieldWrites` key (OD-L7B-11) | a handler submit whose payload carries **NO `fieldWrites` key at all** — not `{}`, absent — with an empty `required` field at the node ⇒ 422 `APPROVAL_HANDLER_REQUIRED_FIELD_EMPTY`. This is the shipped pre-Lock-7 payload shape and the dominant one, and it is the case `fieldWrites: {}` does NOT cover: `{}` is key-PRESENT, so the schema load at `:8849` already runs for it | mutation: re-nest the frozen-schema `SELECT` inside `if (Object.prototype.hasOwnProperty.call(request, 'fieldWrites'))` (`:8848`) ⇒ THIS case reds while G-10 (a)/(b)/(c) all stay green — that asymmetry is the whole point of the gate. TWO positive controls: (i) the same key-absent payload on a template with NO `required` entry at that node ⇒ 200, and the test asserts ZERO extra query was issued (the conditional hoist is opt-in, not a global extra read — G-13's byte-identity for legacy graphs); (ii) the same key-absent payload with the required field already filled by the requester ⇒ 200 |
| G-11 | Emptiness is the create-time definition, holes included, asserted ARM BY ARM | `''`, `null`, `[]` and an absent key each 422 at the node; a companion test RECORDS that `0`, `false`, a whitespace-only string and `{}` are treated as NON-empty at BOTH create and node | PER-ARM single deletion of `isEmptyValue` (`AGE:205-210`), never one mutation of the whole disjunction: delete `=== ''` ⇒ the empty-STRING fixture reds at create AND at the node and nothing else does; delete `=== null` ⇒ the null fixture reds at both; delete `=== undefined` ⇒ the absent-key fixture reds at both; delete the `Array.isArray(value) && value.length === 0` arm ⇒ the empty-ARRAY fixture reds at both. Each arm must red its OWN matching pair — an arm whose deletion reds nothing is an inert mutation, and an arm whose deletion reds half the suite (the `null`/`undefined` arms are also load-bearing for the visibility rules at `AGE:308-310`) is over-broad and does not discriminate. If any arm fails to red BOTH the create test and the node test, a second definition was minted and this gate FAILS |
| G-12 | Author-configured invisibility does not deadlock the node | a field marked `required` at the node whose own `visibilityRule` is unsatisfied on BOTH the pre-write frozen snapshot and the post-write effective snapshot — the actor never touching its driver — is NOT enforced; the submit succeeds | the discriminating pair: with the rule SATISFIED at both points, the same empty field 422s in the same fixture. Removing the visibility skip entirely reds the first case only |
| G-12b | ACTOR-induced invisibility does NOT discharge the obligation (OD-L7B-12) | four cases in one fixture, with field Y marked `required` at handler node H and field X driving Y's `visibilityRule`, X writable at H: (a) Y visible pre-write, the actor writes X to HIDE Y and leaves Y empty ⇒ **422** (the union keeps Y enforced); (b) Y invisible pre-write, the actor writes X to REVEAL Y and leaves Y empty ⇒ **422**; (c) same as (b) with Y filled in the same submit ⇒ 200; (d) Y invisible at both points, X untouched ⇒ 200 (that is G-12's case, re-asserted here so the two gates cannot both be satisfied by the same weak fixture) | mutate the union to POST-write only ⇒ case (a) reds and (d) stays green; mutate it to PRE-write only ⇒ case (b) reds and (a) stays green. Each direction must red its own case, which is what makes the union asserted rather than assumed. Positive control: the identical fixture with no `required` entry records 200 in all four cases and writes X exactly as instructed |
| G-13 | Legacy graphs are byte-identical | a template with no `required` entry behaves byte-identically before and after: handler submit outcomes, echoed `formSnapshot` bytes, `fieldAccess` payload bytes, saved graph bytes | a template WITH a `required` entry diverges in the same fixture, so the default is default-selected rather than accidentally global; and a pre-slice graph corpus round-trips save → publish → dispatch → version-diff → restore unchanged |
| G-14 | Census by exact set over the NINE SOURCE sites, including the wire enum and the author-facing message | the NINE §0.4 sites are asserted equal by exact set — not count, not subset — and the site LIST itself is asserted, so a tenth copy added later fails the census rather than passing unnoticed. C-9 (`:1613`) is asserted by the MESSAGE an author actually receives, and that message must be DERIVED from `NODE_FIELD_ACCESS_VALUES` rather than hand-rewritten (OD-L7B-10) | dropping the member from any ONE site reds a distinct named test; the test names which sites the compiler would have caught (C-3 plus the two aliases) and which six it would not, so the census is not mistaken for redundant with type-checking. The count is swept at `a0edbe39a4` (§0.4), not inherited from Lock-7 R-1's five — and the ninth site was found by re-running the sweep, not by trusting the previous one |
| G-14b | The four GENERATED copies are regenerated, never hand-edited | `pnpm --filter @metasheet/openapi generate:sdk` followed by `git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts` (`.github/workflows/plugin-tests.yml:721-722`) is green on the implementing PR's head — i.e. the four artifacts in §0.4 carry the fourth member because the GENERATOR put it there | this gate is discharged by CI, not by a unit test, and it is deliberately not folded into G-14: a hand-edit of `dist/openapi.yaml` would satisfy a text census and still red this step on the next regeneration. Negative control: reverting only `base.yml:3887` (C-8) and re-running the generator reds this step, proving the check reads the source rather than the committed output |
| G-15 | Both authoring surfaces move together, and the option is ABSENT where unsupported | the fourth option renders on a handler node in the canvas control (`ApprovalGraphNodeConfigEditor.vue:1033-1035`); on an approval node the control renders EXACTLY three options and no disabled fourth exists in the DOM (M7); the linear editor (`TemplateAuthoringView.vue:1037-1039`) renders three everywhere | adding the option to only one surface, or rendering it disabled on approval nodes, reds a named test (Lock-0 L0-6 one-change rule plus M7). Positive control — REWRITTEN after the review's P1-2: a handler node carrying `required` round-trips save → reload → publish unchanged, asserted through `validateApprovalNodeEdits` (`approvalNodeEdit.ts:451-458`, the C-6 literal tuple), because that validator covers handler nodes and would otherwise push 「字段权限类型无效」 at save. The earlier form of this control — "asserted by the template staying linear-editable" — is WITHDRAWN: `COMPLEX_GRAPH_NODE_TYPES` (`templateAuthoring.ts:342`) already makes any handler graph non-linear-editable, so that control could only ever fail (§2.5) |
| G-16 | The prose carriers that become FALSE are corrected, and the one that is a CONTRACT is asserted behaviourally | the §0.5 list is corrected in the SAME change. One of the five is behaviourally checkable and is asserted that way: `approval-bridge-types.ts:47`'s promise that "a field reported `editable` here is exactly a field the write path accepts" becomes `editable ∪ required` — a named test asserts that EVERY member the DTO reports as writable is accepted by `applyHandlerFieldWrites` at that node, by iterating the exported writable set rather than by listing members | the iteration is over the EXPORTED set (§2.2), so adding a fifth member later without extending the write mask reds this test. The other four §0.5 entries are DOCUMENTARY: a comment cannot be asserted, and this row says so rather than pretending a regex guard is a behavioural gate — they are landing obligations checked in the diff |

## 4. Owner ratification block

```text
Decision: RATIFY
Owner: zensgit — goal-set in-session instruction (2026-08-20,「这个对标完善」— the owner directed
  completion of the node-level required-field parity item, including the 必填 × hidden ruling), executing
  the recorded recommendations; recorded by the executing session with this provenance; reversible before
  implementation lands.
Date: 2026-08-20
Document SHA: drafted b85987d3ed77bf09866ffd63b39d89a6d185ae77; an independent opus refute-first review
  round returned REQUEST-CHANGES against that exact head; this fold-and-record commit lands on top.
Decisions recorded: all THIRTEEN per this document's recommendations —
  OD-L7B-1  (a) `required` is a FOURTH member of the shipped `NodeFieldAccess` enum; 必填 × hidden is
            unrepresentable by construction via the one-state-per-field dedup guard (`:1616-1618`).
  OD-L7B-2  (a) masks are per node and independent: `hidden` at node A + `required` at node B is LEGAL.
  OD-L7B-3  (a) `required` is satisfiable on HANDLER nodes only in v1; on an approval node publish
            REJECTS it values-free (no inert acceptance, M7/M8).
  OD-L7B-4  (a) publish REJECTS `required` on a routing-driver field, through the SHARED
            `collectRoutingDriverFieldIds` — one derivation, no second one.
  OD-L7B-5  (a) enforcement at handler SUBMIT, AFTER `applyHandlerFieldWrites`; emptiness is
            `isEmptyValue` (`AGE:205-210`) verbatim, holes and all; a requester-filled value satisfies it.
  OD-L7B-6  (a) restate and assert the shipped invariant: `hidden` at a node is not writable there, and
            `required` at that same node is unrepresentable.
  OD-L7B-7  (a) the fourth option renders on handler nodes only, in the canvas inspector; on approval
            nodes it is ABSENT, not disabled-greyed (M7); the linear editor gains nothing.
  OD-L7B-8  (a) non-goals: no DDL, no new action verb, no bootstrap-version bump, no feature flag; the
            DTO / OpenAPI enum widening is the one deliberate in-slice exception.
  OD-L7B-9  (a) publish REJECTS `required` on `explanation` / `record-link` / `attachment`, with the
            recorded reopen condition when each type's handler write support lands.
  OD-L7B-10 (a) ONE mechanical enumeration over `NODE_FIELD_ACCESS_VALUES` replaces every literal chain;
            the §0.4 census is asserted by exact set over NINE source sites; the four generated copies are
            regenerated by CI, never hand-edited.
  OD-L7B-11 (a) the frozen-schema `SELECT` is hoisted out of the `fieldWrites` key-presence guard
            (`:8848`) and re-gated on `fieldWrites` present OR a non-empty `required` candidate set at
            this node — closing the one-key bypass without charging legacy graphs an extra read.
  OD-L7B-12 (a) the visibility skip is evaluated on the UNION of the pre-write and post-write snapshots,
            so the actor cannot discharge the obligation by hiding the field with the same submit.
  OD-L7B-13 (a) under 会签 the obligation binds every SUBMIT, not only the node's completing submit.
Independent review: an independent opus refute-first review returned REQUEST-CHANGES at head
  b85987d3ed (2 P1, 4 P2, 5 P3, 4 NIT). Every P1 and P2 is CLOSED in the text above — P1-1 by OD-L7B-11
  plus G-10c/G-9b, P1-2 by the §2.5 rewrite plus the G-15 control moving to `approvalNodeEdit.ts:456`,
  P2-1 by census site C-9, P2-2 by §0.4's generated-artifact exclusion plus G-14b, P2-3 by the
  one-by-one Lock-7 OD sweep in the Parents block (including OD-L7-2), P2-4 by OD-L7B-12. All five P3s
  and all four NITs are dispositioned in §5, which also records the ONE correction made TO the review
  (its withdrawn 409 sub-argument rested on a false premise; the finding's own verdict is unchanged).
  This field records the review; the decision above is the owner-provenance ratification, not a review
  verdict.
Runtime authorization: NONE. Design authority only. No runtime code, no feature flag, no tenant UAT, no
  deployment, and no completion label is authorized by this document. Every contract above still needs
  its own PR, the repository's required checks, an independent adversarial gate, and a ledger row; the
  implementing PR is additionally CI-red until `generate:sdk` is re-run and its output committed (§0.4).
```

## 5. Independent review disposition (2026-08-20)

The review is REQUEST-CHANGES at draft head `b85987d3ed`. Findings are closed in the text above; this
section records WHERE, and records the one place the review is corrected. No finding is closed by
re-reading the document at itself — each closure names the contract or the gate that now carries it.

| Finding | Disposition | Where it is closed |
|---|---|---|
| **P1-1** — the frozen schema is unreachable on a no-`fieldWrites` submit, so §1.3 step 3 is either a one-key bypass or an unnamed hoist; no gate discriminates | **ACCEPTED, closed.** Re-verified here: `:8849` is the only `SELECT form_schema` in the handle transaction and it sits inside `:8848`'s key-presence guard; `fieldWrites` is detected by key PRESENCE (`types/approval-product.ts:876`) | OD-L7B-11 names the arm (conditional hoist) · §1.3 step 0 · §2.1's disclosed 409 residual · G-10c (absent-key 422, its two controls, and the re-nest mutation) and G-9b |
| **P1-2** — §2.5's FE consequence is derived from a call site `required` cannot reach, and G-15's control is unsatisfiable | **ACCEPTED, closed.** Re-verified: `case 'handler'` (`templateAuthoring.ts:1113-1120`) returns `hasKeyOutside(config, BACKEND_HANDLER_CONFIG_KEYS)` only and never calls `isBackendDroppedFieldPermission`; `COMPLEX_GRAPH_NODE_TYPES` (`:342`) already contains `'handler'`, so a handler graph is never linear-editable | §2.5 rewritten (the behavioural claim is RETRACTED, C-7 demoted to hygiene) · the true coupling named as C-6 `approvalNodeEdit.ts:456` · G-15's positive control moved to that validator |
| **P2-1** — a ninth in-scope census site (`:1613`, the user-facing enum message) was missed, falsifying G-14's "a ninth added later fails the census" | **ACCEPTED, closed** | census row C-9 · §0.4's count corrected to NINE (and to FOUR sites new to Lock-7 R-1) · OD-L7B-10 · G-14 |
| **P2-2** — four tracked generated copies of the wire enum fall outside the declared `…/src` sweep, and CI (`plugin-tests.yml:721-722`) makes the implementing PR red until they are regenerated | **ACCEPTED, closed** | §0.4's "Declared scope, and what it deliberately excludes" (the four artifacts plus the CI step as a named landing obligation) · G-14b · §4's runtime-authorization note |
| **P2-3** — "re-opens none of its twelve ODs" is an absolute claim over an unswept domain; OD-L7-2, whose recommended arm reads "keep the shipped three-state enum", is never cited | **ACCEPTED, closed.** The remedy is the sweep itself, not a softer adjective | Parents block: all twelve Lock-7 ODs swept one by one, with OD-L7-2 cited and argued (arity is a different question from the tri-state collapse; 编辑-without-可读 stays unrepresentable here; OD-L7-2's own arm-(c) rationale states that an enum widening is safe) |
| **P2-4** — the obligation is discardable by the actor it binds: visibility drivers are not routing drivers, and the post-write skip lets the handler hide the 必填 field with the same submit | **ACCEPTED, closed.** Re-verified: `collectRoutingDriverFieldIds` (`:1860-1893`) collects only `form_field_user` / `ConditionRule.fieldId` / condition-formula operands, and `applyHandlerFieldWrites` (`:10475-10525`) performs no visibility check | OD-L7B-12 (the pre ∪ post union) · §1.3 step 3 · G-12b, whose fixture separates author-configured from actor-induced invisibility |
| **P3-1** — two publish rejections cover the same input with the ordering unpinned, so G-7's exact-code assertion is placement-dependent | ACCEPTED | §1.2 item 2 pins the order (OD-L7B-4's check runs BEFORE pin 1's widened test) · G-7 asserts the code and therefore asserts the order |
| **P3-2** — §2.1's "including the dispatch re-normalize path" is over-broad, and its safety argument is baseline-scoped while the rule is permanent | ACCEPTED | §2.1 rewritten by CONTEXT rather than by baseline: all three §1.2 rejections are authoring/publish-path only (`context !== STORED_RUNTIME_CONTEXT`), mirroring the shipped D-1 exemption at `:2668`, with the hand-edited-graph residual disclosed |
| **P3-3** — G-11 mutates a four-arm disjunction once, which cannot discriminate | ACCEPTED | G-11 rewritten to per-arm single deletion, each arm with its own matching positive control and its own create+node pair |
| **P3-4** — stale prose carriers cited as the carrier but scheduled nowhere | ACCEPTED | new §0.5 lists all five and flags `approval-bridge-types.ts:47` as a CONTRACT statement that becomes FALSE rather than merely stale · G-16 asserts the one that is behaviourally checkable and marks the rest as documentary |
| **P3-5** — OD-L7B-2's safety is borrowed from Lock-3 OD-L3-1(a) and uncited | ACCEPTED | Parents block cites OD-L3-1(a) and `APPROVAL_HANDLER_IN_PARALLEL` (`:2135`) · §2.7 (iv) records it as a load-bearing precondition with its reopen condition |
| **NIT-1** — `fieldAccessAtNodes` resolves one id and cannot enumerate | ACCEPTED | §1.3 now names `resolveFieldAccessAtNodes` (`RED:71-100`) |
| **NIT-2** — `applyHandlerFieldWrites` returns no merged snapshot | ACCEPTED | §1.3 reconstructs the effective snapshot from `revisions[].after` over `formSnapshot`; G-9c asserts the reconstruction |
| **NIT-3** — `{}` is not a reachable `date_range` value | ACCEPTED | §0.2's parenthetical replaced with the correction and its anchor (`AGE:553-559`) |
| **NIT-4** — three anchor ranges open one line late or close early | ACCEPTED | S-4 → `:2668-2678`, S-8 → `RED:122-131` for `collectHiddenFieldIds`, S-11 → `ApprovalBridgeService.ts:681-695`; every literal cited inside them was already exact |

**One correction TO the review, with evidence.** The review withdrew a sub-argument inside P1-1 — that
hoisting the schema load would newly expose the 409 `APPROVAL_FROZEN_SCHEMA_NOT_FOUND` (`:8855`) — on the
premise that `form_schema` is `JSONB NOT NULL DEFAULT '{}'` under an FK'd `template_version_id`. That
premise is false in the direction that matters: `approval_instances.template_version_id` is NULLABLE
(`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS template_version_id UUID REFERENCES
approval_template_versions(id) ON DELETE SET NULL`, migration
`zzzz20260411120100_approval_templates_and_instance_extensions.ts:107`), and the runtime graph is read
from `approval_published_definitions` via `published_definition_id` (`:8180`, `:8193`) — an independent
column. So an instance CAN carry a `required` entry in its runtime graph and a NULL
`template_version_id`, the `SELECT` then returns zero rows, and the 409 is reachable. This does NOT
overturn P1-1: its verdict and its remedy stand. It makes the ARM CHOICE load-bearing, which is why
OD-L7B-11 takes the conditional hoist over the unconditional one, why §2.1 discloses the residual, and
why G-9b asserts it fail-closed. Per M11 the column PERMITS NULL; whether any live instance carries one
is unswept and this document does not answer it.
