# TODO — Visual drag-and-drop authoring (canvas) · gated checklist

Companion to `docs/design/approval-visual-authoring-canvas-design-lock-20260624.md`.
Discipline: each phase is a SEPARATE opt-in. 🔒 = gated (needs explicit go); ⬜ = ready when its
predecessor lands; ✅ = shipped. Nothing past D-0 starts without the design-lock RATIFIED + a per-phase go.

## D-0 — design-lock
- ⬜ Ratify scope / principles / phasing (this doc + the design-lock). **Awaiting owner ratification.**

## D-1 — visual canvas render  ✅ (bespoke SVG/HTML; library spike decided = bespoke for testability)
- ✅ `graphLayout.ts` longest-path layered layout (pure) → positioned node boxes + SVG edges, topology
  toolbar on canvas nodes. `nodePositions` drag sidecar never reaches the saved graph (§6). 6 layout
  unit + 2 mounted canvas tests.
- 🔒 The raw mouse-drag GESTURE (node reposition / draw-edge) — manual/E2E QA, not jsdom-unit-testable.

## D-2 — topology engine + clickable add/remove/insert  ✅ (engine + non-drag surface)
- ✅ `graphTopologyEdit.ts` (appendApprovalNode / removeLinearNode + branch ops) + the
  `applyTopologyToComplexDraft` bridge + a clickable node-row toolbar. 12 unit + 1 mounted test.
- 🔒 The drag-from-palette GESTURE (part of the interactive canvas, D-1).

## D-3 — condition / parallel branch authoring  ✅ (engine + surface)
- ✅ Add/remove condition + parallel branches via the engine + the "添加分支" toolbar buttons, reusing
  the G-2/G-3 config panels; backend validates on save; anti-flatten preserved.

## D-4 — form-field reorder  ⚙️ (logic ✅, drag gesture gated)
- ✅ `moveItemToIndex` drag-to-position logic + native-drag wiring (logic unit-covered).
- 🔒 The drag GESTURE (manual/E2E QA) · field-type palette · sections.

## D-5 — live validation preview  ✅
- ✅ `graphValidityIssues` (dangling edge / unreachable / no-successor) surfaced as a live canvas alert;
  backend stays final arbiter on save. Unit + mounted (no-false-positive) tested.

## D-6 — canvas ⇄ list parity  ✅
- ✅ 结构列表 ⇄ 画布视图 toggle on one template; fail-closed (#3129) + sentinel hint (#3141) unchanged.
- 🔒 Inline node-config editing ON the canvas (config currently via the list view through the toggle).

## Out of scope (v1 — reopen-only, see design-lock §5)
- 🔒 No canvas build in D-0 · no new node types / runtime / validator changes · no deletion of the
  structured editor · no nested parallel / arbitrary graphs beyond `normalizeApprovalGraph` ·
  undo-redo / copy-paste subgraphs / templates gallery / mobile parity (named later investment).
