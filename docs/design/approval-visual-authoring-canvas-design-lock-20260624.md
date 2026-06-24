# Design-lock: Visual drag-and-drop authoring for approval flows + forms (可视化拖拽编排)

**Status:** PROPOSED (design-lock FIRST — this doc locks scope/principles/phasing; it does NOT open a
canvas build. Each implementation phase below is a separate, gated opt-in.) Brand-neutral: this states
MetaSheet's own authoring goals; external-product benchmarking stays in internal research, not here.

## 0. Why now (the gap, grounded in what's already shipped)

The approval **engine** already runs the full graph model — `start / approval / cc / condition /
parallel(fork-join) / end`, with 会签/或签 join modes and amount-style condition routing executing in
production. The graph is a locked `{ nodes, edges, config }` shape that the backend
`normalizeApprovalGraph` is the sole arbiter of (node uniqueness, edge integrity, reachability,
assignee rules, the unknown-key fail-closed). And the **config** of every node type is already
authorable: the G-1..G-5 structured editors (condition rules, parallel join-mode, cc targets, approval
source), plus the form-field list editor (types incl. detail/sub-form) and the starter presets.

What's missing is purely the **visual/topology layer**. Today's editor is a *structured list*: it
load-preserves a graph and edits node **configs**, but topology (add/remove nodes, draw edges,
add/remove branches) is **read-only**, and the form-field editor reorders with up/down buttons, not
drag. So the foundation a visual builder needs — model, runtime, validation, config editors — is in
place; the gap is the authoring **surface**, not the engine.

## 1. Goal

Lower the authoring bar from "structured list a power-user tolerates" to "drag elements onto a canvas /
form" — so a non-technical admin composes an approval flow and its form by **dragging flow nodes and
form fields**, the same mental model mainstream low-code authoring tools use. The output is the SAME
locked `{ nodes, edges, config }` + form schema the engine already validates and runs. No new runtime.

## 2. Scope — two surfaces, one model

- **(A) Flow canvas** — a visual graph editor: a node palette (drag to add), edge drawing (drag to
  connect), branch add/remove for condition/parallel, optional auto-layout. It authors **topology**;
  it reuses the G-1..G-5 editors as the per-node **config** panels (it does not re-implement them).
- **(B) Form-field drag-drop** — a form builder: a field-type palette (drag to add), drag-to-reorder,
  sections/columns. The field model + types already exist; this replaces the list/up-down UX.

Both emit exactly the model the backend already validates. The canvas is a new *authoring view* over
the existing data — not a new data model.

## 3. Principles (the non-negotiables for every phase)

1. **The backend stays the sole validity arbiter.** The canvas can produce a structurally-invalid
   graph mid-drag (dangling edge, unreachable node); a live FE preview surfaces it, but `normalize
   ApprovalGraph` remains the gate. The FE never relaxes a backend rule. (Same discipline as G-1..G-5.)
2. **Reuse, don't rebuild, the config editors.** A node's config panel on the canvas IS the G-2/G-3/
   G-4/G-5 editor. The canvas adds topology authoring around them.
3. **Anti-flatten survives.** Loading an existing complex template into the canvas and saving it
   untouched must round-trip **byte-identical** (the G-1 floor), and the unknown-key fail-closed
   (#3129) still applies. A canvas that silently drops a preserved node/edge is a release blocker.
4. **The structured editor stays.** The canvas is additive; the list editor remains as a fallback and
   for accessibility/automation. We do not break or delete it to ship the canvas.
5. **Incremental + gated.** Each phase below is a separate opt-in with its own scope-gate; we ship a
   usable read-only render before any drag-edit, and topology-edit before branch-edit. No big-bang.
6. **Library-assisted, not bespoke physics.** A canvas (node layout, edge routing, pan/zoom, drag) is
   a solved problem; adopt a maintained graph-editor library over hand-rolling, IF its license fits
   (ALv2/MIT) and it can be driven from our model. The decision is a D-1 spike, not assumed here.

## 4. Phasing (each a separate gated opt-in; titles are the future PR lanes)

- **D-0 — this design-lock.** Scope/principles/phasing. No code.
- **D-1 — canvas render (read-only) + layout spike.** Render an existing graph on a canvas
  (nodes/edges/branches), reusing the G-1 preserved-graph data. Evaluate a graph-editor library vs
  build. Still read-only; proves the round-trip + the layout before any editing. Gate: anti-flatten
  byte-identical render.
- **D-2 — node palette + add/remove approval/cc nodes + connect edges.** First topology authoring;
  the backend validates on save. Gate: a canvas-built linear+cc graph normalizes + round-trips.
- **D-3 — condition / parallel branch authoring on the canvas.** Add/remove branches, set the gate,
  wire the join — the topology the structured editor keeps read-only. Reuses the G-2/G-3 config panels.
- **D-4 — form-field drag-drop builder.** Palette + drag-reorder + sections, on the existing field
  model. Independent of D-1..D-3; can run in parallel.
- **D-5 — live validation preview.** Surface dangling-edge / unreachable / duplicate-key as you drag
  (the backend already computes validity; the FE mirrors the high-value checks, backend stays final).
- **D-6 — canvas ⇄ list parity + cohesion.** Switch between surfaces on one template without drift;
  the starter-preset sentinel hint and the fail-closed surface behave identically on the canvas.

## 5. Boundaries / non-goals (v1 — reopen-only)

- **No canvas build in this doc.** D-0 is design only; D-1+ are separate opt-ins.
- **No new node types, no runtime/validator changes.** The canvas authors the existing model.
- **No deletion of the structured editor.** Additive only.
- **No nested parallel / no free-form arbitrary graphs** beyond what `normalizeApprovalGraph` accepts —
  the canvas cannot author a graph the engine would reject; it guides toward valid shapes.
- **Polish tail is explicitly out of v1:** undo/redo, copy/paste subgraphs, templates gallery, mobile
  parity. Named so they're a conscious later investment, not a silent gap.

## 6. Open decisions (to resolve at D-1, not assumed)

- Graph-editor library vs bespoke (license + model-drivability is the gate).
- Auto-layout vs manual node positions (and whether positions persist — they are NOT part of the
  runtime graph, so they'd need a separate `layout` sidecar that never reaches `normalizeApprovalGraph`).
- How aggressively the FE mirrors backend validity live vs on-save.
