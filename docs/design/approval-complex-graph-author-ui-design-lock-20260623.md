# Design-lock: Approval complex-graph node author UI (复杂图节点作者 UI)

**Status:** RATIFIED + SHIPPED (2026-06-23). The initial arc is complete on main — design-lock
#3102, G-1 load-preserve #3103, G-2 condition #3104, G-3 parallel join-mode #3105, G-4 cc #3106.
The G-5 follow-up adds approval-node config editing inside preserved complex graphs, satisfying
the amount-tier preset Gate A without changing graph topology.
**As-built scope** (refined from the original proposal below): the editor edits **condition
logic** (branch rules / conjunction / default edge), **parallel `joinMode`** (`all`/`any` — both
backend-accepted), **cc targets** (`targetType` / `targetIds`), and **approval-node config**
(`assigneeSources`, `approvalMode`, `emptyAssigneePolicy`, and
`autoApprovalPolicy.mergeWithRequester`). All graph **topology** (parallel branch edgeKeys +
`joinNodeKey`, condition branch edges, every edge) is **read-only, preserved byte-identical**;
**parallel topology / branch add-remove editing is explicitly OUT of scope** (a later slice).
Brand-neutral (external OA / mainstream approval platforms; no vendor names).

---

> **⟨HISTORICAL PROPOSAL — as-written 2026-06-23, superseded by the As-built status above⟩**
> Everything below this line is the **original design proposal**, kept for rationale. Where it
> differs from the As-built status, **the As-built status governs.** In particular, DO NOT read
> these as current guidance:
> - **(1) Parallel is `joinMode`-only.** §1's "`parallel.joinMode='any'` fail-closed (type says
>   v1='all')", §2's "parallel → branch list + join target + mode" / "add branch, set join target",
>   and §4's "a parallel join target that isn't reachable" preview are **NOT as-built** — branch
>   edgeKeys, `joinNodeKey`, and ALL topology are read-only (G-3 edits `joinMode` only).
> - **(2) `joinMode='any'` shipped** (not fail-closed) — see the §7/§8c RATIFIED notes.
> - **(3) A complex graph is load-preserved + save-ENABLED.** The "Current authoring …
>   `UNSUPPORTED_GRAPH_NODE_TYPES` … save disabled" line below describes the **pre-G-1** state.
> - **(4) Approval-node config is editable in the G-5 follow-up.** §1's "Plus the existing
>   approval node config (unchanged)" line described the pre-G-5 state. G-5 edits approval-node
>   sources and strategy fields while preserving topology and unsupported config fail-closed.
>
> The runtime / validator / node-model facts below remain accurate.

The original proposal (owner-sequenced via /goal — design-lock first, then a v1 **structured
editor**, not a free canvas). The approval **runtime** already executes all six node types
(start / approval / cc / condition / parallel / end) including parallel fork-join; the
template-authoring UI **was** linear-only and fail-closed (read-only) on any cc / condition /
parallel node — **the state BEFORE this arc** — which the design unlocked without flattening
existing complex templates.

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
- Current authoring **[pre-G-1 state — superseded; complex graphs now load-preserve + save]** —
  `templateAuthoring.ts:65` `UNSUPPORTED_GRAPH_NODE_TYPES = {cc, condition,
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
  `conjunction` and/or, + `defaultEdgeKey`), `parallel` (**`joinMode` only** — `all`/`any`;
  branch edgeKeys + `joinNodeKey` are topology, preserved read-only **[as-built]**), `cc`
  (`targetType` user/role + `targetIds`), and `approval` node config
  (`assigneeSources`, `approvalMode`, `emptyAssigneePolicy`,
  `autoApprovalPolicy.mergeWithRequester`) **[as-built G-5 follow-up]**.
- **Read-only / structural (never hand-edited):** `start` / `end` (auto-managed), and node
  `key`s / `edge`s identity (the editor manages topology through structured controls, not raw
  key editing). Legacy `assigneeType`/`assigneeIds` config is shown read-only (the editor
  authors `assigneeSources`).
- **Still fail-closed (read-only template) in v1:** any construct the structured editor does
  not yet support — e.g. ~~`parallel.joinMode='any'` (type says v1='all')~~ **[NOT as-built —
  joinMode='any' shipped in G-3]**, nested parallel
  (the validator rejects it anyway), or a graph shape the structured model can't represent.
  Unsupported ⇒ the template stays viewable read-only, **never flattened** (§3).

## 2. The editor — structured, NOT a free canvas
- A **node list** (ordered, with branch nesting shown as indentation/grouping) + a **per-node
  config panel** (condition → branch/rule rows; parallel → ~~branch list + join target +~~ mode
  **[as-built: joinMode only — branch list / join target are read-only topology]**;
  cc → target picker reusing the existing approval user/role picker) + a **validation preview**
  (inline errors/warnings before save). No drag canvas, no free edge drawing — topology is
  expressed through structured controls (~~add branch, set join target~~ **[as-built: parallel
  topology is read-only; only joinMode/condition-rules/cc-targets/approval-node config are
  editable]**), which the builder turns into nodes + edges. This fits TemplateAuthoringView's
  evolution and is far more testable.

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
  with no edgeKey, ~~a parallel join target that isn't reachable~~ **[not as-built — parallel
  topology isn't editable, so no such preview]**, an empty assignee) and blocks
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
- **G-3 · parallel editor.** Author parallel `joinMode` (`all`/`any`, both backend-accepted);
  branch edgeKeys + `joinNodeKey` are topology, read-only **[as-built — branch add/remove deferred].**
- **G-4 · cc editor.** Author cc targets (reuse the approval picker).
- **G-5 · approval-node config editor.** Author approval-node assignee source + approval mode +
  empty-assignee policy + merge-with-requester inside preserved complex graphs. All node keys,
  all edges, condition configs, parallel configs, cc configs, and non-edited approval nodes remain
  deep-equal; unsupported legacy / multi-source / unknown approval-node config stays fail-closed.
- The structured-graph editor is the form-schema-adjacent surface the detail arc stabilized
  first (goal sequencing: C 明细 done → graph UI now).

## 7. Boundaries / non-goals (v1 — all reopen-only)
- **No free-canvas / drag-edge editor** (structured controls only).
- **No new node types**, no runtime changes, no `normalizeApprovalGraph` changes.
- **No nested parallel**; **no parallel topology editing** (branch add/remove, `joinNodeKey`) — the
  parallel editor edits `joinMode` only; branches/joinNodeKey are preserved read-only **[as-built]**.
  > **RATIFIED (G-3, 2026-06-23 — shipped #3105):** `joinMode='any'` IS backend-accepted —
  > `PARALLEL_JOIN_MODES = new Set(['all', 'any'])` (`ApprovalProductService.ts:289`), validated at
  > `:940`, written verbatim at `:948`; the FE/BE type union is `'all' | 'any'`; the runtime executes
  > `'any'` (first-wins, `:3691`). G-3 ships `joinMode` editable with BOTH options. The original
  > §7/§8c "joinMode='any' deferred (validator/type say 'all')" premise was factually wrong and is
  > superseded as-built. Branch / `joinNodeKey` topology editing REMAINS out of scope.
- **No flatten, ever** — unsupported constructs stay read-only, never dropped.
- **No W7** approval-result write-back (its own gated scope-doc, pending a concrete scenario).

## 8. Owner decisions needed (defaults chosen; flag to override)
- (a) v1 editable set = `condition` + `parallel` + `cc` (default), phased G-2/G-3/G-4 after the
  G-1 load-preserve foundation. Override to a narrower first set if wanted.
- (b) Phasing order — default condition → parallel → cc (most-common-first). Confirm or reorder.
- (c) `parallel.joinMode='any'` authoring = **RATIFIED + SHIPPED** (G-3 #3105). The original
  "deferred" default rested on the §7 premise that the validator/type only allow 'all', which the
  code disproves (set `{'all','any'}`, accepted + runtime-executed); the owner audit (2026-06-23)
  ratified shipping both modes.
- (d) Whether G-1 (load-preserve + read-only structured render) ships before any editor, or is
  folded into G-2 — default = G-1 standalone (proves anti-flatten before editing).
