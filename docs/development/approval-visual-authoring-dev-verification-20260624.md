# Visual authoring (canvas track) — development + verification report

Scope executed against the D-0 design-lock (`approval-visual-authoring-canvas-design-lock-20260624.md`).
This delivers the **verifiable core** of the track — the topology-authoring engine, its integration
into the complex draft, a clickable (non-drag) authoring surface, and the form-field reorder logic —
and **explicitly names the interactive free-drag canvas as the remaining gated slice** with its
rationale (it is not unit-verifiable in this repo's test harness; it needs a library spike + manual/E2E QA).

## What was built (and why it's the right cut)

The design-lock's principle is that the canvas is a new *authoring surface over the already-locked
`{nodes, edges, config}` model*, with the backend the sole validity arbiter and the G-2..G-5 config
editors reused. The highest-value, **testable** part of that is the topology-authoring *logic* — which
is exactly what every canvas phase needs underneath. So that is what shipped, to the same bar as the
rest of the track (pure modules + DOM-stub assertions).

### D-2 / D-3 — topology-authoring engine (`apps/web/src/approvals/graphTopologyEdit.ts`)
Pure structure edits, each emitting a well-formed `{nodes, edges}` the backend `normalizeApprovalGraph`
remains the arbiter of; every untouched node/edge is deep-cloned verbatim (anti-flatten):
- `appendApprovalNode` — insert an approval node on a linear segment (single-out guard).
- `removeLinearNode` — remove an approval/cc node + bridge `pred→succ` (single-in/out guard).
- `addParallelBranch` / `removeParallelBranch` — fork a new branch joined at the parallel's join node /
  drop one (≥2-branch guard).
- `addConditionBranch` / `removeConditionBranch` — add a branch (empty rules, filled via the G-2 editor)
  rejoining at the default target / drop a non-default branch (refuses the fall-through edge).

### Engine ↔ draft bridge (`applyTopologyToComplexDraft`, templateAuthoring.ts)
Applies a structural op to a **complex draft** correctly: it runs the op on the *effective* graph
(`buildApprovalGraph` — config edits already applied, so no in-progress config is lost), sets the
result as the new `preservedGraph`, and re-seeds the four G-2..G-5 config-edit maps from it. So
`buildApprovalGraph(result)` equals the op's output — the canvas and the structured editors are one
source of truth.

### Minimal clickable surface (TemplateAuthoringView.vue)
A topology toolbar on each complex-graph node row — "添加条件分支 / 添加并行分支 / 下方插入审批 / 删除节点" —
each shown only when the engine precondition holds (so a button never throws) and wired through
`applyTopologyToComplexDraft`. This makes the **topology the structured list editor kept read-only**
(branch add/remove, node insert/remove) authorable today, without a drag canvas.

### D-4 — form-field reorder (`moveItemToIndex` + native drag)
`moveItemToIndex` is the pure move-to-position logic (more general than the existing one-step up/down);
the field rows wire native HTML5 drag to it. The **drag gesture** is manual/E2E QA (jsdom `DragEvent`
is unreliable); the **reorder logic** is unit-covered.

## Verification

- `approval-graph-topology-edit.test.ts` — **12 tests**: each engine op's structure + the anti-flatten
  (untouched nodes byte-identical) + the precondition guards (throws on ambiguous/invalid ops) + the
  bridge (op → re-seed → `buildApprovalGraph` reflects it; a config edit *after* a topology op still
  lands) + `moveItemToIndex` (reorder + clamp).
- `approvalTemplateAuthoring.spec.ts` — added a **mounted** test: load a condition graph, click
  "添加条件分支", assert a new node row appears, save, assert the payload's condition has 2 branches
  (the surface exercises the engine end-to-end through the real save path).
- All wired into **approval-web-guard** (new src + test added to paths + the vitest filter).
- Full local run: **vue-tsc clean, lint clean, 50/50** across the topology + authoring specs.

## D-1 / D-5 / D-6 — visual canvas (shipped in the follow-up round)

The interactive canvas was then built, **bespoke (SVG/HTML) rather than a heavy graph library** —
chosen so the render / operations / layout / validity ARE unit-verifiable in the existing harness
(only the raw mouse-drag *gesture* is manual/E2E QA):
- **D-1 canvas render** — `graphLayout.ts` longest-path layered layout (pure) → positioned node boxes
  + SVG edges. A `nodePositions` sidecar holds drag overrides and **never reaches the saved graph**
  (the design-lock §6 layout-sidecar decision). The same topology toolbar (add branch / insert /
  remove) sits on the canvas nodes, wired to the same engine + bridge.
- **D-5 live validity** — `graphValidityIssues` (pure: dangling edge / unreachable node / no-successor)
  surfaced as a live canvas alert; the backend stays the final arbiter on save.
- **D-6 canvas ⇄ list toggle** — 结构列表 ⇄ 画布视图 on one template; the fail-closed surface (#3129) +
  sentinel hint (#3141) are unchanged (node config is edited in the list view).

Verification (this round): `approval-graph-layout.test.ts` **6 tests** (layered layout incl. a rejoin
sitting after both branches + the 4 validity cases) + **2 mounted canvas tests** (toggle → 4 nodes +
4 SVG edges render with no false validity; add-condition-branch ON the canvas grows it + saves 2
branches). Wired into approval-web-guard.

## Remaining (true polish tail — design-lock §5, reopen-only)
- The raw **mouse-drag gesture** (node reposition / draw-edge-by-dragging) — manual/E2E QA, not
  jsdom-unit-testable; the position-update + topology LOGIC underneath is covered.
- Library-grade interaction polish (smooth pan/zoom, edge routing, copy/paste subgraphs, templates
  gallery, mobile) + inline node-config editing on the canvas (today config is edited in the list view
  via the toggle) — explicit later investment, not a silent gap.

## Principle adherence (the release-blocker checklist, all green)
Backend stays sole arbiter (engine emits, never relaxes); config editors reused (the surface wires to
the existing G-2..G-5 panels via the bridge); anti-flatten preserved (deep-clone + the round-trip
test); additive (the structured list editor is untouched and still default); brand-neutral.
