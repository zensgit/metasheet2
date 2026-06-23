# Design-lock: Approval complex-graph node author UI (复杂图节点作者 UI)

**Status:** PROPOSED (owner-sequenced 2026-06-23 via /goal — design-lock first, then a v1
**structured editor**, not a free canvas). The approval **runtime** already executes all six
node types (start / approval / cc / condition / parallel / end) including parallel fork-join,
but the template-authoring UI is **linear-only** and **fail-closes** (read-only) on any
cc / condition / parallel node. This locks the scope of a structured author UI that unlocks
those nodes without flattening existing complex templates. Brand-neutral (external OA /
mainstream approval platforms; no vendor names).

Grounded in code (explorer-verified 2026-06-23):
- Node model — `ApprovalNodeType` (6 types) + `ConditionNodeConfig` / `ParallelNodeConfig` /
  `CcNodeConfig` in `packages/core-backend/src/types/approval-product.ts:134/163/151` (mirrored
  FE `apps/web/src/types/approval.ts`).
- Graph persistence — `approval_template_versions.approval_graph` JSON; validator
  `normalizeApprovalGraph` (`ApprovalProductService.ts:~641`) checks node-key uniqueness, edge
  integrity, per-type config shape, condition branch edgeKeys, parallel join + **v1 safety
  (no nested parallel, no cross-branch assignee dupes)** + reachability.
- Runtime — `ApprovalGraphExecutor` executes ALL six types (condition eval, cc dispatch,
  parallel fork/join state machine). **Runtime is ready; the gap is purely UI.**
- Current authoring — `templateAuthoring.ts:65` `UNSUPPORTED_GRAPH_NODE_TYPES = {cc, condition,
  parallel}`; `unsupportedTemplateAuthoringReason()` opens such templates **read-only** (save
  disabled), tests lock "blocks unsupported constructs instead of flattening".

## 0. Problem + the flatten risk (the fact the design must respect)
- Authors can't build conditional / parallel / cc approval flows even though the engine runs
  them — the single biggest authoring gap after detail/sub-form.
- **Flatten risk (THE safety fact):** the linear authoring path projects the graph to
  approval-only *steps* — `draftFromTemplate` drops non-approval nodes from `steps`, and
  `buildApprovalGraph` rebuilds a **linear** start→approval*→end. If a complex template ever
  reached save through this path, its condition/parallel/cc nodes + edges would be **lost**.
  Today this is mitigated by the read-only block; v1 must keep that guarantee while opening the
  nodes — i.e. the editor operates on the **full graph**, never the linear projection.

## 1. v1 scope — which nodes are editable, which stay read-only
- **Editable (all runtime-ready):** `condition` (branches: rules `{fieldId, operator, value}` +
  `conjunction` and/or, + `defaultEdgeKey`), `parallel` (branch edgeKeys + `joinNodeKey` +
  `joinMode`), `cc` (`targetType` user/role + `targetIds`). Plus the existing `approval` node
  config (unchanged).
- **Read-only / structural (never hand-edited):** `start` / `end` (auto-managed), and node
  `key`s / `edge`s identity (the editor manages topology through structured controls, not raw
  key editing). Legacy `assigneeType`/`assigneeIds` config is shown read-only (the editor
  authors `assigneeSources`).
- **Still fail-closed (read-only template) in v1:** any construct the structured editor does
  not yet support — e.g. `parallel.joinMode='any'` (type says v1='all'), nested parallel
  (the validator rejects it anyway), or a graph shape the structured model can't represent.
  Unsupported ⇒ the template stays viewable read-only, **never flattened** (§3).

## 2. The editor — structured, NOT a free canvas
- A **node list** (ordered, with branch nesting shown as indentation/grouping) + a **per-node
  config panel** (condition → branch/rule rows; parallel → branch list + join target + mode;
  cc → target picker reusing the existing approval user/role picker) + a **validation preview**
  (inline errors/warnings before save). No drag canvas, no free edge drawing — topology is
  expressed through structured controls (add branch, set join target), which the builder turns
  into nodes + edges. This fits TemplateAuthoringView's evolution and is far more testable.

## 3. Anti-flatten — full-graph round-trip (the keystone)
- The editor's draft model carries the **whole graph** (all nodes + edges + every node's
  config), not the linear `steps` projection. Loading a complex template **preserves** every
  node/edge/config byte-for-byte for types it doesn't actively edit (pass-through), exactly the
  anti-flatten discipline used for detail sub-field metadata (spread-original-first).
- A node type or construct the v1 editor cannot represent keeps the template **read-only**
  (the existing `unsupportedTemplateAuthoringReason` fail-closed path) — it is never silently
  dropped. The existing "blocks unsupported constructs instead of flattening" + "opens
  unsupported graphs read-only and refuses to save" tests MUST stay green; new tests assert a
  loaded condition/parallel/cc graph round-trips through save **unchanged** when untouched.

## 4. Save + validation
- A new **full-graph builder** emits `{ nodes, edges }` with the structured configs (replacing
  `buildApprovalGraph`'s linear-only output for supported graphs). The backend
  `normalizeApprovalGraph` stays the **sole arbiter** (node uniqueness, edge integrity, config
  shape, condition edgeKeys, parallel safety, reachability) — the FE never relaxes it.
- A FE **validation preview** mirrors the high-value checks (dangling edges, a condition branch
  with no edgeKey, a parallel join target that isn't reachable, an empty assignee) and blocks
  save with inline messages — UX only; the backend re-validates and is final.

## 5. Runtime-exists boundary
- `condition` / `parallel` / `cc` runtimes are **shipped** (`ApprovalGraphExecutor`). v1 is
  **UI-only**: NO change to the executor, `normalizeApprovalGraph`, or the graph types. The UI
  produces graphs the engine already runs.

## 6. Phasing (each a separate opt-in — staged-lineage discipline)
- **G · design-lock (this doc).** Owner review → accept.
- **G-1 · load-preserve + read-only structured view.** Carry the full graph in the draft;
  render complex graphs as a read-only structured node list; prove round-trip-no-flatten (the
  user's "先保证加载复杂图不拍平、不丢字段"). No editing yet. Tests: load condition/parallel/cc →
  save untouched → graph byte-identical.
- **G-2 · condition editor.** Author condition branches/rules + default edge; full-graph build;
  FE preview. 
- **G-3 · parallel editor.** Author parallel branches + join (v1 `joinMode='all'`); respect the
  backend's no-nested / no-cross-branch-dupe rules in the preview.
- **G-4 · cc editor.** Author cc targets (reuse the approval picker).
- The structured-graph editor is the form-schema-adjacent surface the detail arc stabilized
  first (goal sequencing: C 明细 done → graph UI now).

## 7. Boundaries / non-goals (v1 — all reopen-only)
- **No free-canvas / drag-edge editor** (structured controls only).
- **No new node types**, no runtime changes, no `normalizeApprovalGraph` changes.
- **No nested parallel**, no `joinMode='any'` authoring in v1 (validator/type say 'all') — both
  stay fail-closed read-only.
  > **CORRECTION (G-3, 2026-06-23):** the parenthetical "(validator/type say 'all')" is **factually
  > wrong**. The backend `normalizeApprovalGraph` ACCEPTS both — `PARALLEL_JOIN_MODES =
  > new Set(['all', 'any'])` (`ApprovalProductService.ts:289`), validated at `:940`, written
  > verbatim at `:948`; the FE/BE type union is `'all' | 'any'`; and the runtime executes `'any'`
  > (first-wins, `:3691`). G-3 therefore makes `joinMode` editable with BOTH options (the mandatory
  > pre-check found 'any' is not backend-rejected, so per the "UI must not produce backend-rejected
  > graphs" rule there is no reason to withhold it). Nested parallel and editing
  > branches/joinNodeKey topology REMAIN out of scope. Pending owner ratification — see the G-3 PR.
- **No flatten, ever** — unsupported constructs stay read-only, never dropped.
- **No W7** approval-result write-back (its own gated scope-doc, pending a concrete scenario).

## 8. Owner decisions needed (defaults chosen; flag to override)
- (a) v1 editable set = `condition` + `parallel` + `cc` (default), phased G-2/G-3/G-4 after the
  G-1 load-preserve foundation. Override to a narrower first set if wanted.
- (b) Phasing order — default condition → parallel → cc (most-common-first). Confirm or reorder.
- (c) `parallel.joinMode='any'` authoring = deferred (default; v1 'all' only). Confirm.
  > **SUPERSEDED (G-3, 2026-06-23):** the deferral rested on the §7 premise that the validator/type
  > only allow 'all', which the code disproves (set `{'all','any'}`, accepted + runtime-executed).
  > G-3 ships both modes; this decision now needs owner ratification rather than confirmation.
- (d) Whether G-1 (load-preserve + read-only structured render) ships before any editor, or is
  folded into G-2 — default = G-1 standalone (proves anti-flatten before editing).
