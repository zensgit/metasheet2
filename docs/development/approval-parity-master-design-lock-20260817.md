# Approval Parity Master Design Lock (2026-08-17)

**Status:** RATIFIED (2026-08-17 — see §9; ratification approves the design program only and grants
no runtime, UAT, deployment, or flag authorization; every Lock-0..8 and phase gate keeps its own owner decision)
**Baseline:** `origin/main@d33a6a0fa120452b721ea76d449dfa1463727463`
**Scope:** ordinary-user approval form authoring, process authoring, enterprise assignee semantics,
node policies, member experience, version governance, and approval-to-multitable data closure
**Non-effects:** this document does not merge runtime code, deploy or restart any environment, run
tenant UAT, enable a feature flag, or declare product FINAL

## 0. Authority and document hierarchy

This document is the program-level index. It orders existing locks and defines missing lock
boundaries; it does not silently rewrite a ratified contract.

| Authority | Current role |
|---|---|
| `approval-canvas-v2-interaction-design-lock-20260721.md` | RATIFIED interaction authority; bespoke deterministic canvas retained; Vue Flow / ELK deferred |
| `approval-canvas-data-closure-owner-handoff-20260808.md` | owner UAT and staged-flag authority; product FINAL remains blocked |
| PR #4866 @ `80d33cbefa` (`approval-form-builder-parity-delta-design-20260811.md`) | PR-local PROPOSED form-builder delta; it is not present on main and must be range-diffed and refreshed against this baseline before ratification |
| Existing FWB, durable-delivery, attachment, version, and graph locks | runtime authorities for their bounded surfaces; independent flags and gates remain intact |
| This document | dependency graph, capability inventory, phase order, and cross-lock acceptance |
| `approval-parity-execution-ledger-20260817.md` | mutable execution truth: PRs, SHAs, checks, reviews, flags, and decisions |
| `approval-parity-final-verification-20260817.md` | completion evidence template; stays NOT RUN until exact merged-main verification |

Scratchpad research and competitor screenshots are evidence inputs, not authority. Absence from a
reference manual is not proof that another product lacks a capability.

### 0.1 Review baseline and method

This revision was produced only after reading the complete 2026-08-16 parity proposal and checking
its claims against the pinned baseline. The review traced the following production seams rather than
inferring capability from screenshots or test names:

- authoring shell, form palette, preview drop handlers, inspector bindings, graph editor, member
  detail, approval center, template center, and version detail;
- frontend/backend approval contracts, graph normalization/execution, assignee resolution, field
  projection, node actions, timeout handling, FWB, attachments, and feature-flag defaults;
- RATIFIED Canvas D0 and owner-handoff locks, the PR #4866 proposed delta, required-web scripts, and
  approval CI path filters;
- the offline Feishu administrator/member reference corpus captured on 2026-08-16. The corpus proves
  documented Feishu behaviors; it does not prove the absence of undocumented behavior.

No runtime test, browser test, tenant UAT, deployment, or flag change was performed for this document
revision. Source and CI-file inspection therefore qualifies the plan, not the product.

### 0.2 Reconciliation of the 2026-08-16 proposal lineage

The proposal lineage (the 2026-08-16 drafts and their same-day REV-2) contains useful product
direction but also stale statements and internal contradictions. Several rows below correct statements
that the lineage's own final revision had already superseded; they are dispositioned here so no stale
form of the proposal can be quoted as authority. This table is the authoritative disposition before
any implementation starts.

| Proposal statement | Source verdict | Program correction |
|---|---|---|
| The form palette can only be clicked | stale | palette items are already clickable and draggable; the live drop path always appends, ignores the hovered slot, uses a weak transient payload, and is not wired to the existing command algebra |
| A three-region form builder still needs to be created | stale | palette, center preview, and right inspector already exist in the authoring view; P0 extracts and hardens them instead of rebuilding the shell |
| Multi-source assignees require engine work | refuted for shipped kinds | backend normalization/resolution already walks `assigneeSources[]` and identity-dedups; the current editor only owns the first source; net-new kinds still require Lock-1/2 |
| The inspector should use sticky Cancel/Save and a scrim | conflicts with RATIFIED D0 | use immediate typed commands and one undo history; 1024 overlay remains scrim-free |
| UI-1 can enforce readonly fields | false capability claim | `hidden` has runtime behavior; `readonly/editable` remain declared but inert until a named edit surface plus Lock-7 land |
| Canvas cards should use colored title bands | conflicts with RATIFIED D0 and current-state wording | the shipped renderer still uses per-type ribbons; P1-D replaces them with the RATIFIED flat-card, text-label, border, and state/validation-accent grammar |
| Threshold is a new backend capability | stale | backend already persists and executes linear N-of-M; frontend types, allowlists, hydration, summaries, and restore compatibility are incomplete |
| Approval-center summaries and aging are missing | stale | up-to-three-field summaries and create-time aging already exist; the remaining center gap is desktop master-detail and, if desired, node-arrival aging from authoritative data |
| Template gallery and version recovery are missing | stale | a template center plus immutable version compare/restore already exist; the residual is entry-point unification and an editor-header version entry |
| Field permissions can be shown as fully enforced | false | the UI must describe only the exact verified scope; `readonly/editable` enforcement remains Lock-7 work and no document may broaden that claim |

Owner-private release prerequisites are tracked outside this public program. This document records no
private lane identifier, status, implementation detail, or private evidence.

If this master is ratified, its P0 delivery boundary follows the RATIFIED Canvas D0 lock section
10.1: exact-slot drag is required. That decision supersedes only the older owner-handoff section 6
residual that described drag polish as optional; it does not alter any other handoff gate.

## 1. Product outcome and completion levels

An ordinary administrator can complete the following without JSON, raw IDs, or implementation
terminology:

1. Build a typed form by click, keyboard, or semantic drag into an exact insertion slot.
2. Build a linear, conditional, or parallel process on one vertical canvas.
3. Configure enterprise assignees, aggregation mode, fallback, field access, and allowed actions.
4. Preview the route, publish an immutable version, compare versions, and restore to a new draft.
5. Submit, approve, reject, transfer, add/reduce sign, return, revoke, remind, and review history
   according to server-enforced policy.
6. After separate enablement, create or update a multitable record from approved values with durable,
   idempotent delivery and no permission widening.

Two completion labels are deliberately separate:

| Label | Required scope |
|---|---|
| `CORE-PARITY` | P0-P5 implemented, exact merged-main verified, browser/a11y passed, Canvas tenant UAT passed, and explicit owner sign-off recorded |
| `DATA-CLOSURE` | P6 implemented, exact DATA matrix passed on merged main, FWB then attachment tenant UAT passed, and explicit owner sign-off recorded |
| `PRODUCT-FINAL` | both labels plus accepted residuals, staged rollout/rollback evidence, and explicit owner sign-off |

Merged code behind a default-OFF flag is an engineering asset, not a delivered product capability.

## 2. Current capability inventory

Inventory states mean: `implemented` = code exists on main; `partial` = meaningful implementation
exists but ordinary-user authoring, enforcement, or enablement is incomplete; `missing` = no complete
production path.

| Surface | State at baseline | Boundary |
|---|---|---|
| Authoring wizard and basic information | partial | four steps exist; key/name/category/SLA/description/visibility/revoke exist, but icon, curated group, typed requester scope, process-admin chips, live validation count, and a functional More-settings step do not |
| Three-region form shell | partial | palette, preview, and inspector shell exist; live palette drop is append-only, transient drag state is weak, generated IDs are length-derived, and inspector property edits bypass structural history |
| Form command substrate | implemented but unmounted | insert-after/append, opaque supplied identity, collision, reference-aware delete, and keyboard/drag command logic is unit-tested; production authoring does not import or call it, has no start/between/end slot API, and has no authoritative allocator/reference provider |
| Form field vocabulary | partial | text/textarea/number/select/multi-select/date/datetime/user/detail/record-link are authorable; attachment exists in contracts but not the palette; department/contact/explanation/formula/formatted-number authoring are absent |
| Linear/condition/parallel canvas | implemented, flag OFF | Canvas V2 requires tenant UAT and staged enablement |
| Route dry-run and requester preview | implemented | preserve stale-result and hidden-field guards |
| Version diff and restore-to-new-draft | implemented | editor-header timeline entry remains incomplete |
| Template gallery | implemented | common presets and Template Center exist; avoid rebuilding the gallery, and unify entry/governance only if user testing proves confusion |
| Assignee source array and resolver dedup | implemented | runtime traverses all sources; current editor owns only `assigneeSources[0]` |
| Assignee source vocabulary | partial | requester, static user/role, form user, manager/dept head, continuous managers, and manager-at-level exist; groups, requester choice, prior-node approver, and department-field routing do not |
| Approval modes and timeout | partial | backend supports `single/all/any/threshold` and timeout effects; frontend omits threshold/timeout fields from compatibility allowlists and can flatten unsupported mode state, so affected templates become read-only rather than safely editable |
| Empty/self/merge policies | partial | error/auto-approve empty behavior plus `mergeWithRequester`, `mergeAdjacentApprover`, and `dedupeHistoricalApprover` execute in the backend; the frontend exposes only `mergeWithRequester`, and the broader enterprise fallback/dedup matrix is missing |
| Node field permissions | partial | the presentation must remain scope-qualified; `readonly/editable` are contract-stable but runtime-inert and require Lock-7 before any enforcement claim |
| Handler/business-operation node | missing | requires a separate runtime lock and graph-walk coverage |
| Per-node operation permissions | missing | transfer/add-sign/reduce-sign/return availability is not authored and enforced per node |
| Member action surface | partial | approve/reject/transfer/revoke/comment/return/add-sign/reduce-sign/remind exist; add-sign is before/parallel only, while after-sign, action attachments, live signature, per-node opinion policy, and richer policy are missing |
| Approval detail | partial | form plus parallel-aware timeline and core dialogs exist; there is no shared action-dialog grammar, history table/tabs, or desktop record projection switch |
| Approval center | partial | tabs, badges, filters, field summary, create-time aging, batch approve/reject, failure retry, and optional mobile cards exist; desktop master-detail remains missing |
| Attachments | implemented, independent flag OFF | authoring and tenant UAT remain separate from Canvas |
| FWB create/update/decision values | implemented, independent flag OFF | number target mapping remains fail-closed |
| Exact monetary/number writeback | missing by decision | `exact_number_mapping_unavailable` remains the honest production boundary |

### 2.1 Capability comparison against the offline Feishu corpus

| Capability family | Feishu corpus evidence | MetaSheet baseline | Delivery decision |
|---|---|---|---|
| Form builder | component palette, center form, property configuration | three-region shell and drag affordance exist, but exact-slot/identity/history integration is incomplete | P0 before visual expansion |
| Flow topology | linear and conditional routing | linear, conditional, and parallel graph plus constrained semantic move exist behind Canvas flag | preserve graph model; UAT before product claim |
| Assignee selection | managers, department heads, groups, requester choice/self, prior-node and field-derived sources | shipped eight-kind resolver and multi-source backend exist; editor and vocabulary are incomplete | P1 existing sources, then Lock-1/2 new semantics |
| Aggregation | all, any, sequential | single/all/any plus hidden threshold; no within-node ordered queue | compatibility first; ordered mode stays Lock-1 |
| Field and operation permissions | field matrix plus node operation policy | field-permission presentation is scope-limited, readonly/editable inert, operation policy absent | Lock-7, then Lock-5 |
| Handler/business node | documented handling node | absent | Lock-3 |
| More settings | requester, dedup, fallback, quick/bulk, forwarding and related settings | selected runtime policies exist, but no coherent server-backed settings step | Lock-4/6; never mount an inert shell |
| Member actions | action dialogs, transfer/sign/return/comment/urge and related member flows | most core actions exist, but dialog grammar and several capability subsets differ | P5 after policy semantics |
| Version governance | reference corpus is not the authority for our implementation | immutable versions, compare, and restore-to-new-draft exist | keep backend; add editor entry and round-trip tests |
| Data closure | not used as a competitor-absence claim | durable FWB and attachments exist behind independent flags; number mapping is unavailable | separate DATA-CLOSURE and UAT |

## 3. Child-lock registry and program decisions

The identifiers below are planning handles, not existing approvals. A row cannot authorize runtime
work until its named lock is drafted, reviewed, and explicitly ratified by the owner.

| Lock | One-line scope | Current status | Owner |
|---|---|---|---|
| Lock-0 | D0 interaction delta: named inspector tabs, validation count, and delayed fifth-step activation | **RATIFIED 2026-08-17** (`approval-lock0-d0-interaction-delta-20260817.md` §4) | owner |
| Lock-1 | enterprise assignee kinds and resolution semantics | NOT DRAFTED | owner |
| Lock-2 | organization controls, field-derived assignees, and department routing | RATIFIED — `approval-lock2-org-controls-field-routing-20260817.md` §4 (2026-08-17, goal-set provenance; eight ODs per document recommendations) | owner |
| Lock-3 | handler/business-operation node and its mutation boundary | NOT DRAFTED | owner |
| Lock-4 | automatic decisions, fallback, dedup, and same-person flow policy | NOT DRAFTED | owner |
| Lock-5 | per-node operation and member-action policy | NOT DRAFTED | owner |
| Lock-6 | requester and global approval/document policy | NOT DRAFTED | owner |
| Lock-7 | server-enforced readonly/editable field semantics for a named edit surface | NOT DRAFTED | owner |
| Lock-8 | bounded additional field vocabulary, excluding department/contact, exact money, and number FWB | RATIFIED — `approval-lock8-field-vocabulary-20260817.md` §4 (2026-08-17, goal-set provenance; nine ODs per document recommendations) | owner |

### M1 - No graph or renderer rewrite

Keep `ApprovalGraph`, backend normalization, the bespoke deterministic renderer, existing command
algebras, durable outbox, and restore-to-new-draft. Do not adopt free-form coordinates, arbitrary edge
reconnection, Vue Flow, or ELK without a new owner decision backed by measured failure at scale.

### M2 - Correctness precedes visual parity

The form builder's normal delete-then-add duplicate-ID path, fake exact-position drop, stale drag
state, and direct mutation outside the command history are P0 delivery blockers. Inspector or palette
polish may not bypass them.

### M3 - One command path and opaque identity

All structural and property authoring flows through one production adapter over a single command path:

- **Mount the existing algebra** for palette click, palette drag, slot insertion, field reorder, and
  reference-aware delete (`addFormField` / `moveFormField` / `moveFormFieldByOffset` /
  `removeFormField`).
- **Author a new typed update/retype command** — it does not exist in `approvalFormCommands.ts` at this
  baseline (PR #4866 F3 already plans it). Its contract must define: reference-aware refusal on retype
  (visibility, condition/formula, permission, graph, mapping, and detail-column references),
  detail-column retype semantics, ID preservation across retype (never re-mint), and exactly one
  undo/history entry per logical edit.
- Committed inspector property edits ride the same history.

New field and detail-column identities must come from one durable opaque allocator and be independent of
array length or visible suffix. A pure helper test is substrate evidence only; it does not prove the live
authoring view uses that path.

PR #4866 must resolve two interfaces against the code now on main before ratification:

1. whether complete identity history remains a required provider or the opaque allocator itself is
   the sole collision authority; and
2. which external references are authoritative for delete/retype refusal. Until the owner ratifies a
   smaller complete set, production integration stays fail-closed on an incomplete reference inventory.

### M4 - Capability registry is fail-closed

The node inspector renders a new source, mode, policy, or action only when its capability is ratified,
implemented end to end, and present in the registry for that node type. The registry must also enumerate
the complete currently shipped `ApprovalAssigneeSourceKind` union so a persisted shipped source is not
hidden as "unratified". Unknown persisted values remain round-trip safe and read-only; they are never
flattened to a default.

### M5 - Existing and new assignee work are different slices

Editing all existing `assigneeSources[]` entries and exposing an already-shipped source is frontend
parity work. New source kinds or new directory semantics require a capability lock. Source order is
display order; runtime identity dedup remains authoritative.

### M6 - Shipped timeout and threshold require a compatibility slice

Before showing N-of-M or editing persisted timeout behavior, the frontend type, edit model, validator,
serializer, summary, version diff, and restore path must preserve `timeout`, `threshold`, and
`approvalThreshold`. Authoring must express the linear-only restriction and handle dynamic resolved-M
fail-closed; a radio button alone is not completion. `signaturePolicy` remains unknown/read-only until
Lock-5 unless the owner explicitly includes it in this compatibility slice.

### M7 - No empty "More settings" step

The five-step wizard is authorized only when at least one ratified global policy has a functional,
server-enforced control. Before then, the current test/publish step remains the fourth visible step.
Unavailable switches are not rendered as disabled theater.

### M8 - Configuration and enforcement must be honest

Field-permission behavior may be presented only with scope-qualified copy backed by the exact tested
surface. `readonly/editable` must retain the existing not-yet-enforced copy until the handler/edit path and
Lock-7 server enforcement land. The canvas inspector must not silently lose the linear editor's
honesty copy. UI configuration cannot claim a security property the runtime does not enforce.

### M9 - Action attachments are a capability, not dialog chrome

The first unified action dialog standardizes title, reason, validation, focus, and buttons. Image or
file attachments require a separate action-attachment contract covering upload ownership, binding,
authorization, retention, download, audit, and failure semantics. Form attachments are not implicitly
reused.

### M10 - Formatted number is not exact money

Currency symbol, grouping, uppercase display, and declared precision may enhance an existing number
field only when labeled "formatted number". The product must not call it exact monetary storage or
enable number FWB. Exact decimal/money and number writeback remain a separate D0-D4 design line.

### M11 - Evidence language is scoped

Use "the reference corpus did not evidence" rather than "the competitor does not have". Use
"implemented behind a default-OFF flag" rather than "delivered" until tenant UAT and enablement pass.

## 4. Development phases

### P0 - Form-authoring correctness

**P0-A: refresh and ratify the form-builder delta**

- Range-diff PR #4866 @ `80d33cbefa` against the program baseline current at refresh time (this
  document's Baseline header, re-pinned if main has advanced) and refresh it for the current
  three-region palette, preview, and inspector shell.
- Retain semantic insertion anchors, opaque identity, reference-aware delete/retype, and committed
  inspector history.
- Remove superseded statements that the palette or inspector shell does not exist.
- Reconcile the proposed identity-history and external-reference-provider contracts with the command
  module already on main; do not weaken either guard merely to simplify the adapter.

**P0-B: F0-F4 implementation**

1. Extract the current flag-OFF fallback from the hot authoring view without behavior change.
2. Mount the existing command substrate through a narrow adapter and add its authoritative opaque
   identity allocator and reference provider.
3. Replace append-only palette drop with exact start/between/end slots and an application-specific,
   type-limited drag codec. Clear transient drag state on drop, drag end, Escape, navigation, and
   read-only transition.
4. Route inspector commits through the same history and make delete/retype fail closed on every
   authoritative visibility, condition, permission, graph, mapping, and detail-column reference.
   Delete mounts the existing reference-aware command; retype is the NEW typed command from M3 /
   PR #4866 F3 — scope and price it as new command work, not a mount.
5. Mount the new builder behind Canvas V2 only after both halves pass mounted and browser tests.

**Exit:** delete-middle-add remains valid and unique; cancelled drag is a no-op; click/drag/keyboard
produce the same draft and history; old templates round-trip without semantic drift.

### P1 - Inspector and shipped capability parity

**P1-A:** ratify a small D0 interaction delta for the three named presentations `审批人设置`, `表单权限`,
and `操作权限`, plus validation count and delayed five-step activation. `操作权限` remains absent until
Lock-5 has at least one functional policy; an empty tab is theater. The inspector remains one
implementation in three viewport presentations and uses immediate typed commands with no independent
Save/Cancel transaction. The canvas field-permission presentation must preserve the linear editor's
not-yet-enforced notice.

**P1-B:** remove the linear editor's single-source restriction and expose all existing assignee sources
as editable source cards, preserving array order and runtime dedup. Seed the registry from the shipped
source-kind union; do not create duplicate runtime kinds for requester or existing manager sources.

**P1-C:** complete shipped `timeout` plus `threshold` frontend compatibility before rendering controls.
This is not merely a missing control: both linear/complex allowlists intentionally place affected
templates in a read-only state, and that read-only gate is what currently prevents any actual flatten —
backend-normalized graphs always carry `approvalThreshold`/`timeout` (the backend preserves both keys),
so the latent linear-hydration branch that would map an unsupported mode to `single` is unreachable for
contract-valid data. Before lifting the read-only gate, this slice must delete that latent flatten
branch and correct the stale frontend comments that claim the backend silently drops these keys. The slice
must cover frontend mode/node types, `buildStepConfig`, both config allowlists, node-edit conversion,
summaries, version diff, restore, linear-only threshold placement, and dynamic resolved-M failure.
Keep persisted `signaturePolicy` round-trip-safe and read-only until its declared owner slice. This is
the existing D3-p/G1-p bounded owner-decision gate, not a new Lock-N.

**P1-D:** add condition priority copy, default-branch explanation, branch copy, insertion affordance
polish, and editor-header version entry without changing graph semantics. Replace the shipped per-type
ribbons with the RATIFIED flat-card grammar and text labels; do not import the superseded colored-title-
band proposal.

**Exit:** source cards round-trip all entries; timeout and threshold graphs open/save/compare/restore;
unknown capabilities remain read-only; no raw IDs are exposed.

### P2 - Enterprise assignee semantics and organization fields

Ratify and implement user groups, requester choice, prior-node approver, department/contact form
controls, department-field routing, continuous department-head routing, and any approved
upward/downward level semantics. Define snapshot versus live directory resolution, tenant/corp
scoping, transfer behavior, empty resolution, and audit metadata before implementation.

**Exit:** each new kind has save/publish/preview/execute parity, multi-corp negative controls, directory
change tests, and values-free errors.

### P3 - Flow policy and More settings

**P3-A:** preserve the shipped merge flags and ratify only the missing Lock-4 semantics: automatic
pass/reject node behavior, expanded empty-assignee fallback, additional same-person policy, and departure
fallback. Do not rebuild `mergeWithRequester`, `mergeAdjacentApprover`, or
`dedupeHistoricalApprover`.

**P3-B:** select and ratify one bounded Lock-6 global policy. Mount "More settings" only after P3-A plus
that first functional global policy; later Lock-5 per-node controls do not block the shell.

**Exit:** every visible switch changes server-enforced behavior; removing its enforcement fails a
discriminating test; no inert controls exist.

### P4 - Handler node and field edit enforcement

Add the handler/business-operation node through all graph walks, normalization, step counting, preview,
versioning, return/jump, parallel restrictions, and audit. Lock-7 may be designed independently, but
its enforcement lands only with a named field-edit mutation surface; the handler is the first planned
consumer. Every such surface needs server-enforced node-scoped `readonly/editable` boundaries.

**Exit:** field edits and approval decisions use the ratified transaction boundary; hidden/readonly
permissions cannot be bypassed by HTTP calls; old graphs remain byte-compatible.

### P5 - Node operations and member experience

Implement per-node transfer/add-sign/reduce-sign/return policy, an authoring switch for the shipped
reject-comment requirement, approved
after-sign semantics, and owner-ratified requester controls. Standardize action dialogs and add detail
tabs/record projection and approval-center master-detail only from existing authoritative data.

Do not rebuild already shipped center behavior: up-to-three-field summary, create-time aging, batch approve,
batch reject, and failure retry remain as-is. If product wants "arrived at current node" aging, add a
server-authoritative timestamp first; do not relabel instance creation time.

Action attachments, handwritten signature, group chat, second-level approval markers, printing, and
efficiency diagnostics stay separate optional slices until their capability locks are ratified.

**Exit:** UI availability and backend authorization agree for every role/action; mobile and keyboard
alternatives remain complete; audit rows are the only history source.

### P6 - Field vocabulary and data closure

Prioritize date range, explanatory text, formatted number, and later attachment-authoring refinements.
Department/contact controls belong to P2 and are not repeated here. Formula fields require a
deterministic evaluation and dependency lock. Exact number/money and number FWB are not included unless
their independent design is ratified.

P6 completes implementation only. P7 runs FWB and attachment UAT independently after Canvas acceptance.
Preserve same-transaction mutation, revision, claim, and outbox composition and sink-side
net-effect-once behavior.

### P7 - Integrated acceptance and staged release

First run exact merged-main tests, browser geometry/a11y, real-DB races, and upgrade migration. Then run
tenant UAT and enable one capability family at a time with independent rollback, preserving the owner
handoff order:

1. Canvas V2
2. Durable delivery plus FWB, only after writeback UAT records both required flags
3. Attachments, only after attachment UAT

Number writeback remains unavailable unless separately delivered.

### Cross-phase UI delivery map without duplicate construction

The original UI-1 through UI-9 list is retained only after subtracting what already exists:

| UI slice | Actual remaining work | Not part of the slice |
|---|---|---|
| UI-0 authoring shell | typed basic-information controls, live validation count, conditional More-settings step, and the parent-D0 §9 header route-preview toggle (Lock-0 L0-5 debt) | rebuilding the four-step wizard, common presets, or Template Center |
| UI-1 node inspector | three named presentations, capability registry, all existing source cards, field-permission honesty, shipped compatibility | sticky Save/Cancel, scrim, runtime readonly enforcement, or unratified operations |
| UI-2 organization fields | department/contact controls and field-derived routing after Lock-2 | inventing directory semantics in Vue |
| UI-3 canvas residual | priority/default/copy affordances, edge polish, editor version entry | renderer rewrite, free wiring, colored title bands, new minimap/undo |
| UI-4 More settings | only controls backed by landed Lock-4/6 behavior | empty disabled switch gallery |
| UI-5 member dialogs | shared reason/focus/validation grammar for already-authorized actions, then capability-specific additions | treating files/signature as decoration |
| UI-6 detail | tabs and audit-derived table/projection | replacing the existing parallel-aware timeline |
| UI-7 center | desktop master-detail and optionally authoritative node-arrival aging | up-to-three-field summary, batch reject, create-time aging, or failure retry |
| UI-8 fields | approved Lock-8 types and properties | department/contact duplication, exact money, or unratified formula evaluation |
| UI-9 entry governance | editor version entry and template-entry consistency | a second gallery implementation |

### Reviewed baseline source anchors

These anchors describe the reviewed baseline and must be refreshed when `origin/main` changes:

| Evidence | Baseline source |
|---|---|
| three-region form shell, palette drag, append-only drop, direct inspector bindings, four-step wizard | `apps/web/src/views/approval/TemplateAuthoringView.vue` |
| insert-after/append and reference-aware command substrate | `apps/web/src/approvals/approvalFormCommands.ts`; required tests under `apps/web/tests/approval-form-commands.test.ts` |
| structural form history | `apps/web/src/approvals/approvalFormAuthoringHistory.ts` and its required test |
| deterministic graph, insertion menu, semantic drag, undo/redo, minimap | `apps/web/src/approvals/components/ApprovalFlowCanvas.vue` and `apps/web/src/approvals/approvalCanvasCommands.ts` |
| single-source inspector presentation | `apps/web/src/approvals/components/ApprovalGraphNodeConfigEditor.vue` plus the authoring view's first-source bindings |
| version compare/restore | `apps/web/src/views/approval/TemplateDetailView.vue` |
| center/detail shipped behavior | `apps/web/src/views/approval/ApprovalCenterView.vue` and `ApprovalDetailView.vue` |
| multi-source resolver and backend graph capability | `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`, `ApprovalProductService.ts`, and `types/approval-product.ts` |
| required web collection | `.github/workflows/web-tests.yml` invoking `apps/web/scripts/run-required-web-tests.sh`; `.github/workflows/approval-web-guard.yml` is a separate path-filtered canary |
| default-OFF boundaries | frontend feature-flag store plus backend Canvas/FWB/attachment flag readers |

Source anchors prove code shape only. They are not a substitute for the matrices in the final
verification document.

## 5. Dependency and parallel-work rules

```text
P0-A lock refresh ----> P0-B form correctness
D0 delta docs --------> P1-A inspector presentation
P1 existing source cards and P1 timeout+threshold compatibility may proceed independently
P1 existing source cards -------> P2 new assignee kinds
P2 organization fields and P4 handler are independent capability locks
P3 policy runtime --------------> More settings controls
P4 handler ---------------------> readonly/editable enforcement
P5 runtime policies ------------> matching member chrome
P0-P5 merged -------------------> exact CORE matrix -> Canvas UAT
P6 bounded fields --------------> exact DATA matrix
Canvas UAT + exact DATA matrix -> durable+FWB UAT -> attachment UAT -> staged flags
capability-relevant private prerequisites -> that capability's UAT or production enablement
```

Parallel work is allowed only with disjoint write sets and named ownership. The following are serial
hot surfaces unless extracted first:

- `TemplateAuthoringView.vue`
- `ApprovalGraphNodeConfigEditor.vue`
- frontend/backend approval type contracts
- `ApprovalProductService.ts`
- approval routes and action request contracts

Visual review, browser screenshots, a11y review, pure helper tests, and independent adversarial review
may run in parallel with implementation after their target SHA is fixed.

## 6. PR and model discipline

- One behavioral slice per PR; no phase-wide mega-PR.
- Locks and owner decisions precede new runtime semantics.
- Locks/concurrency/authz/transactions and every adversarial gate use the strongest available reasoning
  model; bounded component extraction and typed UI wiring may use a mid-tier implementation model.
- External model output is not evidence. Codex independently inspects the exact diff, runs the required
  checks, constructs negative probes, and records the reviewed SHA.
- A model name or unavailable alias is never recorded as a completed review unless an actual result is
  captured.
- No agent self-ratifies, self-enables a flag, or turns CI green into release authorization.

## 7. Verification doctrine

Every behavioral guard needs a positive control and a discriminating negative or mutation:

- form identity: delete-middle-add, detail-column equivalents, collision retry;
- drag: exact slot, cancelled drag, stale anchor, malformed MIME payload, read-only transition;
- history: one logical edit = one entry; rejected/no-op = zero entries;
- assignees: all sources, duplicate identity, delegation, corp scope, empty resolution;
- timeout/threshold: timeout round-trip and execution, N reached, N impossible after dynamic resolution,
  re-entry epoch, return, parallel reject;
- policy: UI hidden plus direct HTTP denial; unknown persisted values round-trip;
- handler/field edit: transaction rollback, stale version, hidden/readonly bypass;
- version: immutable published versions, stale restore conflict, restore-to-new-draft;
- FWB/attachments: authorization, idempotency, crash windows, bind/GC interleavings.

Required CI, local tests, exact-head review, merged-main composition, tenant UAT, and flag enablement are
separate ledger entries. None implies the next.

## 8. Non-goals

- free-form graph coordinates or arbitrary edge drawing;
- Vue Flow / ELK adoption without a new owner decision;
- mobile-native process authoring;
- exact decimal/money or number FWB in this program baseline;
- ordered-within-node approval as a `CORE-PARITY` requirement without an independent capability lock;
- action attachments through the form-attachment contract;
- removing the accessible structured fallback before S12 equivalence and the owner window;
- staging or production changes while another program's protected soak window is active.

## 9. Owner ratification record

```text
Decision: RATIFY
Owner: zensgit — explicit in-session instruction on 2026-08-17 to execute the recorded
  recommendation (owner requested execution twice and merged #4935 personally), following
  Codex + independent Grok review, Claude independent adversarial review (APPROVE-with-nits;
  nits resolved in the REV-2 fix round), and the owner's own REQUEST-CHANGES round
  (2 P2 + 2 P3, all applied before this ratification).
Date: 2026-08-17
Document SHA: reviewed single-commit 217b56137e28729c15f671ff4984908e275a8406, landed on main
  as squash 5b31cb4349 (#4935); all three documents verified blob-identical between the
  reviewed and merged SHAs.
Deltas: (none)
Runtime authorization: NONE — no runtime capability, tenant UAT, deployment, or feature-flag
  change is authorized by this ratification. Lock-0..8 and every phase gate retain their own
  owner decisions.
```
