# Lock-0 — D0 Interaction Delta (2026-08-17)

**Status:** PROPOSED — owner ratification required before any implementation PR cites this document
**Baseline:** `origin/main@5b31cb43496c5aaf11b4f821254ed63a345c11e1` (the master lock pins the older
`d33a6a0fa120452b721ea76d449dfa1463727463`; every anchor below is read at this baseline)
**Parents:** `approval-canvas-v2-interaction-design-lock-20260721.md` (RATIFIED D0 — this document deltas
named clauses of it and rewrites nothing else); `approval-canvas-g0-ratify-20260815.md` (G0 RATIFY,
deltas "(none)" — this document is the vehicle for the first post-G0 delta);
`approval-parity-master-design-lock-20260817.md` §3 Lock-0 row, §P1-A, M4, M7, M8, §4 UI-0/UI-1.
**Non-effects:** no runtime capability authorized, no flag changed, no tenant UAT scheduled or recorded,
no merge implied, no completion label claimed. `approvalCanvasV2` stays default OFF. Ratifying this
authorizes P1-A *design* only; each implementation slice still needs its own PR, required checks, and
named human approval.

## 1. Delta inventory

Six deltas. Nothing outside this list is changed by this document.

### L0-1 — Inspector gains three named presentations (tabs)

**Parent clause modified.** §15 `ApprovalFlowInspector.vue` (lines 444-446): "Parts: heading (node type +
name), **contextual section stack per §4/§10**…". Shipped anchor for what is replaced:
`apps/web/src/approvals/components/ApprovalCanvasNodeInspector.vue:162-163` — one flat `节点设置` label
plus a single `<slot />`, no sectioning.

**New contract.** The contextual section stack — the node-selection context only; the empty-selection
flow summary and validation list are untouched and get no tabs — renders as a tab strip, in this order:

| Tab | Content | Gate |
|---|---|---|
| `审批人设置` | assignee source cards, approval mode, empty-assignee policy, self-approval policy (`ApprovalGraphNodeConfigEditor.vue:336-482`) | always present on `approval` nodes |
| `表单权限` | per-node field-permission rows (`ApprovalGraphNodeConfigEditor.vue:483-505`) + L0-6 honesty copy | always present on `approval` nodes |
| `操作权限` | per-node transfer / add-sign / reduce-sign / return policy | **MUST NOT render** until Lock-5 lands ≥1 functional server-enforced per-node policy |

Preserved invariants, stated so no reviewer has to infer them:

- **One implementation, three viewport presentations** (§5 lines 191-192: "Same fields, same order, same
  validation, same commands — only geometry changes") holds because tab set, tab order, and per-tab
  content are **viewport-invariant**: docked 360px / overlay 320px / bottom sheet render the same tabs.
- **Commit model unchanged** (§5 lines 204-206: "Dirty fields apply through the same typed commands as
  canvas edits (one undo history, §7.1). There is no separate inspector 'apply' button"). Tabs add NO
  Save/Cancel transaction, NO per-tab dirty buffer, NO confirm-on-tab-switch; switching tabs is
  presentation state producing zero history entries. NO scrim at any viewport (§5 compact row, line 197:
  "scrim-free flat boundary").
- Tab-strip membership is **derived from the L0-2 registry**, not hand-written, so the `操作权限` gate is
  mechanical: a registry with no ratified operation policy for the node type yields exactly two tabs in
  the DOM. Master §P1-A names the three presentations and calls an empty tab theater; deriving the strip
  enforces that absence with M4's fail-closed mechanism.

### L0-2 — Capability-registry-driven assignee roster

**Parent clause modified.** §10.3: "**One picker component** listing the shipped sources with plain
labels and a configured summary echo". Shipped anchor: a single `el-select` over
`APPROVAL_NODE_SOURCE_KINDS` (`ApprovalGraphNodeConfigEditor.vue:336-352`; table at `:609-618`).

**New contract.** The one picker component may present its roster as a radio grid: §10.3 constrains the
picker to be *one component* with plain labels and does not constrain that component's internal control
shape, so a radio grid needs no further delta. The roster is registry-driven, per master M4 verbatim:

> The node inspector renders a new source, mode, policy, or action only when its capability is ratified,
> implemented end to end, and present in the registry for that node type. The registry must also enumerate
> the complete currently shipped `ApprovalAssigneeSourceKind` union so a persisted shipped source is not
> hidden as "unratified". Unknown persisted values remain round-trip safe and read-only; they are never
> flattened to a default.

At this baseline the complete shipped union is **exactly eight** — `static_user`, `static_role`,
`requester`, `form_field_user`, `direct_manager`, `dept_head`, `continuous_managers`, `manager_at_level`
— and frontend (`apps/web/src/types/approval.ts:18`) and backend
(`packages/core-backend/src/types/approval-product.ts:15`) agree. The exact-set gate is therefore a
**pinning** test freezing an already-correct set, not a repair; it still earns its place because parent
§16.4 F-2 records `ApprovalMode` as a live precedent where the frontend copy of a backend union lagged.
Unratified kinds (groups, requester choice, prior-node approver, department-field routing — master §2)
are not rendered; a persisted value outside the registry renders as a read-only labelled row that
round-trips unchanged on save. Without an enumerated registry, "render what we support" drifts both
ways: an unlisted shipped kind disappears from the editor, and an unshipped kind is one line from
rendering.

### L0-3 — Header live validation-issue count

**Parent clause modified.** §11 validation-issues row ("A flow-level validation list in the
empty-selection inspector aggregates live issues; each row links focus to the offending node. Publish
remains gated by the as-built pre-flight checklist (B2-03)"); §2 header-bar clause (lines 54-56) has no
count.

**New contract.** The header carries a live count ("N 项不完善" form) fed by the **same** validators
already backing the publish preflight — `publishFormFieldIssues`, `publishApprovalFlowIssues`,
`publishPlaceholderRoleIssues`, composed into `publishChecklist` at
`apps/web/src/views/approval/TemplateAuthoringView.vue:2417-2443`. No second validator is written and no
validator is relaxed to shrink the count. Two clarifications, because the shipped shapes do not support
the naive reading:

1. **Focus target.** `publishFormFieldIssues` (`:2417`) and `publishApprovalFlowIssues` (`:2423`) are
   `string[]`; only `publishPlaceholderRoleKeys` (`:2432`) carries node keys. This delta therefore
   requires those validators to be refactored to return a typed issue record
   (`{ code, message, target?: { kind: 'node' | 'field' | 'section', key: string } }`) — a shape change
   **inside** the existing validator set, not a second validator. Until a validator carries a `target`,
   clicking its issue focuses the owning authoring section; node-level focus is offered exactly where a
   key exists. Section-level focus is acceptable to ship; fabricated node attribution is not.
2. **Relationship to the existing error surface.** `validationErrors` / `validationSummaryRef` (`:76-93`,
   focused at `:3095`) is the existing save-blocking surface and stays as-is. The count derives from the
   preflight arrays, not from `validationErrors`; neither surface is merged into or deleted here. "No
   second validator" refers to the count's data source.

Publish gating is unchanged; the count is advisory display over checks that already gate publish (parent
§1.1: "frontend validation is advisory feedback only"). Master §2 lists the live validation count as a
UI-0 gap; any other data source would create two truths about whether a template is publishable.

### L0-4 — Delayed fifth-step activation

**Parent clause modified — with an explicit correction.** The parent lock has **no step-count clause**:
§2 describes a canvas-first shell with a `表单`/`流程` mode switch, not a wizard. The four-step stepper is
a shipped-surface construct — `AuthoringSectionId` literal union at
`apps/web/src/views/approval/TemplateAuthoringView.vue:1554`, `authoringSections` at `:1555-1564`
(`基础信息`/`表单设计`/`流程设计`/`测试发布`). This delta records the step contract for the current UI-0
shell and does **not** alter the parent's mode-switch IA. It is named as a formal delta so no later
reading can treat a step-count change as unrecorded drift from D0.

**New contract.**

- The wizard stays **4 steps** with `测试发布` fourth until ≥1 ratified, server-enforced global policy
  exists (master M7: "The five-step wizard is authorized only when at least one ratified global policy
  has a functional, server-enforced control… Unavailable switches are not rendered as disabled theater").
- On activation `更多设置` becomes step 4 and `测试发布` becomes step 5.
- **Ordering invariant:** `测试发布` is always last at any step count; nothing is ever inserted after it.
- Activation is a typed change to the `AuthoringSectionId` union and the `authoringSections` array — not
  a runtime config flip and not a flag read. A disabled or empty `更多设置` step is never rendered.
  (Master P3-B mounts More-settings only after the first functional global policy; naming the change here
  means the activation PR modifies a ratified contract instead of retroactively justifying its shape.)

### L0-5 — Parent §9 inline header route-preview toggle: acknowledged contract debt

**Parent clause affected (not modified).** §9 line 305: "A header toggle opens the route-preview panel in
the inspector region (same three presentations as §5)"; §2 line 55 likewise lists "route-preview toggle"
in the header bar.

**Status and contract.** Not delivered at this baseline: the shipped 试运行 surface is a section inside
the `测试发布` step (`apps/web/src/views/approval/TemplateAuthoringView.vue:1013-1203`), not a header
toggle opening an inspector-region panel. The clause is **not dropped and not weakened** — it is recorded
here as open contract debt and **this document assigns it to the UI-0 authoring-shell slice**. Master §4's
UI-0 row enumerates only typed basic-information controls, the live validation count, and the conditional
More-settings step; it does not currently list route preview, so that row must be extended when this
document is ratified. Ratifying Lock-0 does not discharge the debt, and no document may cite Lock-0 as
evidence that §9 was satisfied. (Master M11 evidence discipline: an unrecorded parent clause the delta
walks past is how a RATIFIED contract erodes without a decision.)

### L0-6 — Field-permission honesty copy carries over verbatim

**Parent clause modified.** §16.4 F-3: "`readonly`/`editable` field permissions are contract-stable but
runtime-inert. The inspector shows them as configuration with no claim of enforcement (G3-d1 honesty)."
Master M8 sharpens it: "The canvas inspector must not silently lose the linear editor's honesty copy."

**New contract.** The canvas field-permission presentation renders the linear editor's honesty copy
**character-for-character, including the `（T1-4b）` marker**:

```text
只读将在后续版本（T1-4b）生效，当前保存但暂不强制
```

Shipped source of truth: `apps/web/src/views/approval/TemplateAuthoringView.vue:999`, testid
`approval-step-field-readonly-hint`. This delta does **not** authorize dropping or paraphrasing the
`（T1-4b）` reference; a future slice retiring that marker must retire it in both surfaces in one change,
and the acceptance spec pins the exact string so a one-sided edit fails. Render condition matches the
linear editor: shown when the selected access for a field is `readonly`. The copy is mandatory until
Lock-7 lands server-enforced `readonly`/`editable` semantics for a named edit surface; only that lock may
remove it. Master M8: "UI configuration cannot claim a security property the runtime does not enforce" —
the same three-way selector without the notice is a strictly stronger implied claim than the surface it
replaces.

## 2. Explicit non-deltas

Everything in the parent not named in §1 stands as ratified. Named explicitly because these are the most
likely to be re-litigated under cover of "the tabs changed things":

- **Colored title bands remain rejected.** Parent §3.2 flat-card grammar (flat background, 1px border,
  8px radius, no shadow stack, no gradient, no nested cards) and text type labels stand; master §0.2 and
  P1-D are unchanged — shipped per-type ribbons are replaced by the flat-card grammar, not colored bands.
- **Accessible structured fallback retention unchanged.** Parent §2/§12: the ordinary-user `辅助编辑模式`
  entry remains until S12 equivalence and the G6-C window pass. Tabs do not count toward, substitute for,
  or accelerate that equivalence.
- Graph model, `normalizeApprovalGraph`, publish pre-flight authority, and instance version pinning are
  untouched (parent §17); no new node semantics, no new assignee kinds, no `readonly`/`editable` runtime
  enforcement, no auto-approve/auto-reject timeout terminal effects (parent §1.2, §17); Lock-1..Lock-8
  remain NOT DRAFTED.
- No persisted coordinates, no free-form whiteboard, no Vue Flow / ELK (parent §1.3; G0 O3 = DEFER).
  Threshold/timeout compatibility stays master P1-C / D3-p, outside this delta. Flags stay default OFF.

## 3. Acceptance gates

All specs land in the **required** web lane (`apps/web/scripts/run-required-web-tests.sh`), extending the
already-required `approval-template-authoring-canvas-inspector` (`:158`) and
`approval-canvas-inspector-a11y` (`:152`) rather than adding an ungated file. Every absence assertion
carries a positive control; an absence test without one is green against nothing.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| A-1 | Tab presentation | Mounted inspector renders tabs named exactly `审批人设置` and `表单权限` on an `approval` node; per-tab content matches the L0-1 table | a registry fixture that *does* declare a ratified operation policy renders a third `操作权限` tab — proving two tabs is the registry's doing, not a dead path |
| A-2 | `操作权限` absence | With the shipped (Lock-5-absent) registry, no `操作权限` element exists in the DOM | the A-1 fixture; without it A-2 passes against a component that can never render the tab |
| A-3 | Registry exact set | Roster equals the eight-member `ApprovalAssigneeSourceKind` union by exact set equality against the type's member list — not by count, not by subset | drop one kind and add an unshipped kind as two separate mutations; each must fail |
| A-4 | Unknown persisted value | A node persisting a kind outside the registry renders read-only and round-trips unchanged through save | a known kind in the same fixture renders editable — proving the branch is value-selected, not blanket |
| A-5 | Count parity with preflight | Header count equals failing `publishChecklist` items from the same validators (`TemplateAuthoringView.vue:2417-2443`) across ≥3 fixtures: all-valid, one failing category, several | a fixture failing only `validationErrors` and not the preflight must NOT change the count |
| A-6 | Count → focus | Activating the count focuses the offending node where the issue carries a `target` key, and the owning section otherwise | targeted and untargeted fixtures must reach different focus destinations |
| A-7 | No-scrim negative | No scrim/overlay-mask element present at 1024 with the inspector open (parent §5: "scrim-free flat boundary") | spec first asserts the inspector is mounted and visible at 1024 |
| A-8 | No Save/Cancel negative | No Save/Cancel/Apply control; a field edit then a tab switch commits with no confirm and yields exactly one undo entry | the same edit *without* a tab switch also yields exactly one — pins "tabs add zero entries" |
| A-9 | Honesty copy | `readonly` renders exactly `只读将在后续版本（T1-4b）生效，当前保存但暂不强制`, asserted by full-string equality against the linear editor's shipped copy, not substring | `editable` and `hidden` must not render it |
| A-10 | Step count | `authoringSections` has 4 entries with `review` last; an activation fixture yields 5 with `review` last | the 5-step fixture is the ordering-invariant control; both directions asserted |
| A-11 | a11y reachability | Every tab keyboard-reachable with a visible focus ring (parent §6.2, §14 V-6); tab strip uses the `tablist` roving-tabindex pattern | — |
| A-12 | a11y widget collision | The tab strip and the existing `role="toolbar"` topology bar (`ApprovalCanvasNodeInspector.vue:74-76`) are two arrow-key widgets in one panel. Pin the axes: `tablist` owns Left/Right within the strip, the toolbar owns Left/Right within itself, `Tab` moves between them; one arrow keypress never crosses the two | assert at each widget boundary in both directions |
| A-13 | Browser check | Real-browser (not jsdom) at 1440×900, 1024×768, 390×844: strip visible and operable in all three; identical tab set and order in all three (L0-1 viewport-invariance); no horizontal page scroll at 390 | — |

Parent §14 rows V-2/V-3/V-4/V-6/V-8 continue to apply to the inspector region; A-13 does not replace them.

## 4. Owner ratification record

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision: NOT RECORDED
Owner:
Date:
Document SHA:
Deltas accepted (L0-1..L0-6):
Deltas rejected:
Runtime authorization: NONE
```
