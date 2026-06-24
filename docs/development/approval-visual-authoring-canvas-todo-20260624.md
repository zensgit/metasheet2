# TODO — Visual drag-and-drop authoring (canvas) · gated checklist

Companion to `docs/design/approval-visual-authoring-canvas-design-lock-20260624.md`.
Discipline: each phase is a SEPARATE opt-in. 🔒 = gated (needs explicit go); ⬜ = ready when its
predecessor lands; ✅ = shipped. Nothing past D-0 starts without the design-lock RATIFIED + a per-phase go.

## D-0 — design-lock
- ⬜ Ratify scope / principles / phasing (this doc + the design-lock). **Awaiting owner ratification.**

## D-1 — canvas render (read-only) + library spike  🔒 (until D-0 ratified)
- 🔒 Render an existing complex graph on a canvas (nodes/edges/branches) from the G-1 preserved-graph.
- 🔒 Spike: maintained graph-editor library (ALv2/MIT, model-drivable) vs bespoke — decide here.
- 🔒 Gate: load→render→save round-trips **byte-identical** (anti-flatten floor); read-only only.

## D-2 — node palette + add/remove + connect  🔒
- 🔒 Drag approval/cc nodes from a palette; draw edges; the backend validates on save.
- 🔒 Gate: a canvas-built linear+cc graph normalizes + round-trips; structured editor untouched.

## D-3 — condition / parallel branch authoring  🔒
- 🔒 Add/remove branches, set the condition gate, wire the parallel join (the topology the list editor
  keeps read-only); reuse the G-2/G-3 config panels.

## D-4 — form-field drag-drop builder  🔒 (parallel to D-1..D-3)
- 🔒 Field-type palette + drag-reorder + sections, on the existing field model + types.

## D-5 — live validation preview  🔒
- 🔒 Surface dangling-edge / unreachable / duplicate-key live as you drag (backend stays final arbiter).

## D-6 — canvas ⇄ list parity + cohesion  🔒
- 🔒 Switch surfaces on one template with no drift; sentinel hint (#3141) + fail-closed surface (#3129)
  behave identically on the canvas.

## Out of scope (v1 — reopen-only, see design-lock §5)
- 🔒 No canvas build in D-0 · no new node types / runtime / validator changes · no deletion of the
  structured editor · no nested parallel / arbitrary graphs beyond `normalizeApprovalGraph` ·
  undo-redo / copy-paste subgraphs / templates gallery / mobile parity (named later investment).
