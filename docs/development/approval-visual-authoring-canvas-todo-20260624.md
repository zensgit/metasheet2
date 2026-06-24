# TODO — Visual drag-and-drop authoring (canvas) · gated checklist

Companion to `docs/design/approval-visual-authoring-canvas-design-lock-20260624.md`.
Discipline: each phase is a SEPARATE opt-in. 🔒 = gated (needs explicit go); ⬜ = ready when its
predecessor lands; ✅ = shipped. Nothing past D-0 starts without the design-lock RATIFIED + a per-phase go.

## D-0 — design-lock
- ⬜ Ratify scope / principles / phasing (this doc + the design-lock). **Awaiting owner ratification.**

## D-1 — interactive canvas render + library spike  🔒 (gated for spike + manual/E2E QA)
- 🔒 Interactive free-drag canvas (visual layout, drag-to-position, draw-edges) + graph-editor library
  spike (ALv2/MIT vs bespoke). NOT unit-verifiable in the jsdom/DOM-stub harness → gated. The topology
  ENGINE it would drive is BUILT (D-2/D-3), so this is de-risked. Layout positions = a separate
  `layout` sidecar that never reaches `normalizeApprovalGraph` (design-lock §6).

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

## D-5 — live validation preview  🔒
- 🔒 Live dangling-edge / unreachable as you drag (pairs with the canvas; `validateTemplateDraft`
  already surfaces errors on save).

## D-6 — canvas ⇄ list parity  🔒 (only meaningful once the interactive canvas exists)
- 🔒 Switch surfaces with no drift; sentinel hint (#3141) + fail-closed (#3129) identical on canvas.

## Out of scope (v1 — reopen-only, see design-lock §5)
- 🔒 No canvas build in D-0 · no new node types / runtime / validator changes · no deletion of the
  structured editor · no nested parallel / arbitrary graphs beyond `normalizeApprovalGraph` ·
  undo-redo / copy-paste subgraphs / templates gallery / mobile parity (named later investment).
