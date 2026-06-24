# Approval complex-graph node author UI (复杂图节点作者 UI) — gated TODO

> Date: 2026-06-23 · Status: **TRACKER** · 配套设计锁:
> `docs/design/approval-complex-graph-author-ui-design-lock-20260623.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被决策/前置阻塞)
> 纪律:每个 phase 独立 opt-in(staged-lineage)。设计锁未 ACCEPT 前,G-1..G-4 全部 🔒。
> 不变量:UI-only —— 不改 `ApprovalGraphExecutor` / `normalizeApprovalGraph` / graph 类型;
> 不支持的构造一律 read-only,**永不拍平**。

## Phase G — design-lock
- ✅ Land the design-lock doc (landed in #3102, docs-only).
- ✅ Owner ACCEPT of the §1 editable set + the 4 §8 decisions (G-1 opted in 2026-06-23). **Gate
  for G-1 — opened.** G-2..G-4 remain separate per-phase opt-ins (still 🔒 below).

## Phase G-1 — load-preserve + read-only structured view (✅ shipped)
- ✅ Authoring draft model carries the FULL graph (`TemplateAuthoringDraft.preservedGraph`), not
  the linear `steps` projection; complex types pass through byte-for-byte — `draftFromTemplate`
  captures `preservedGraph` when `isComplexApprovalGraph`, `buildApprovalGraph` re-emits it
  UNCHANGED (no rebuild from `steps`).
- ✅ Render a complex graph as a READ-ONLY structured node list (condition branches+rules /
  parallel branches+joinNodeKey+joinMode / cc targetType+targetIds / approval assignees shown,
  not just "unsupported"). No editing yet. New `graphReadOnlyReason` flags the read-only graph
  while keeping the form/metadata editable and SAVE enabled; truly-unsupported (attachment field
  / unknown node type / extra config keys) still fully read-only + save-disabled.
- ✅ Anti-flatten round-trip test: load a condition / parallel / cc template → save untouched → the
  `approvalGraph` is byte-identical (no node/edge/config dropped) —
  `apps/web/tests/approval-template-authoring-graph-preserve.test.ts` (one round-trip per complex
  type; wired into `approval-web-guard.yml`). Existing "blocks unsupported / refuses to save /
  opens read-only" tests updated for the changed cc/condition/parallel behaviour (now
  save-preserving, graph read-only); the attachment / extra-key fail-closed tests stay green.

## Phase G-2 — condition editor (✅ shipped)
- ✅ Author condition `branches` LOGIC (each branch's `rules` `{fieldId, operator, value}` add/remove
  + `conjunction` and/or) and the node `defaultEdgeKey`, in a structured editable panel
  (`TemplateAuthoringView` condition rows reuse Element Plus selects/inputs). Branch/edge TOPOLOGY
  (which branches exist, their edgeKeys/targets) is NOT editable — that is a later slice. parallel /
  cc stay READ-ONLY summaries (G-3 / G-4). The whole structured render was already there from G-1.
- ✅ Edit model: `TemplateAuthoringDraft.conditionEdits: Record<nodeKey, ConditionNodeEdit>`, seeded
  1:1 from `preservedGraph`'s condition nodes (`conditionEditsFromGraph`). On save,
  `buildApprovalGraph` calls `applyConditionEditsToGraph(preservedGraph, conditionEdits)` — returns a
  COPY of the graph with ONLY each condition node's `config` rebuilt from the edits; every other node
  + the full edge list are deep-cloned byte-for-byte. Pure logic in `approvals/conditionEdit.ts` (no
  `.vue` import — runs under the vitest gate).
- ✅ Topology-preservation tests (the gate): edit a rule/conjunction/defaultEdgeKey → only the one
  condition node config changes, all other nodes + ALL edges byte-identical (deepEqual asserted);
  an UNTOUCHED condition graph (with and without branch conjunctions) round-trips byte-identical (no
  spurious seed diffs); parallel/cc graphs unaffected (still byte-identical-preserved). Validation
  preview: rule `fieldId` must reference a form field; `defaultEdgeKey` (when set) must be an
  OUTGOING edge of the node (the fall-through edge — runtime resolves it via the graph edge list, NOT
  a branch edgeKey). `apps/web/tests/approval-template-authoring-condition-edit.test.ts` (wired into
  `approval-web-guard.yml`). Backend `normalizeApprovalGraph` stays the sole arbiter (FE never
  relaxes it). G-1 round-trip + `approvalTemplateAuthoring.spec` stay green.

## Phase G-3 — parallel editor (✅ shipped — joinMode ONLY)
- ✅ Author a parallel node's `joinMode` in a structured editable control. **PRE-CHECK SUPERSEDES
  design-lock §8c/§7's `'all'`-only deferral:** the backend `normalizeApprovalGraph` ACCEPTS BOTH
  `'all'` and `'any'` — `PARALLEL_JOIN_MODES = new Set(['all', 'any'])`
  (`ApprovalProductService.ts:289`), the validation at `:940` only rejects values OUTSIDE that set
  and writes `joinMode` VERBATIM (`:948`, no coercion to `'all'`), and the runtime
  `ApprovalGraphExecutor` executes `'any'` = first-wins (`:3691`; `loadParallelState` accepts
  `'any'` at `:1523`). The design-lock's premise "(validator/type say 'all')" is **factually false**
  (the set is `{'all','any'}`, the FE/BE type union is `'all'|'any'`). So the editor offers **both**
  modes — UI must not produce backend-rejected graphs, and here `'any'` is NOT rejected. **Owner
  ratification flag:** §8(c) said 'any' deferred; this ships it because the empirical pre-check
  overrides the stale doc-default. `branches` (fork edgeKeys) + `joinNodeKey` are TOPOLOGY: shown
  read-only, preserved byte-for-byte on save (NOT editable — a later slice). condition stays
  G-2-editable; cc stays read-only (G-4).
- ✅ Edit model: `TemplateAuthoringDraft.parallelEdits: Record<nodeKey, ParallelNodeEdit>`, seeded
  1:1 from `preservedGraph`'s parallel nodes (`parallelEditsFromGraph`). On save,
  `buildApprovalGraph` COMPOSES `applyConditionEditsToGraph` (G-2) THEN
  `applyParallelEditsToGraph` (G-3) onto a COPY of the graph — the two passes touch DISJOINT node
  types (condition vs parallel) and each deep-clones everything else, so both edits land and every
  other node + the full edge list stay byte-identical. `applyParallelEditsToGraph` spread-and-
  overwrites ONLY `joinMode` (`{ ...originalConfig, joinMode }`) so an untouched edit is identity and
  key order stays `branches, joinMode, joinNodeKey`. Pure logic in `approvals/parallelEdit.ts` (no
  `.vue` import — runs under the vitest gate).
- ✅ Topology + cross-phase preservation tests (the gate): edit joinMode → only that one parallel
  node's `config.joinMode` changes, all other nodes + ALL edges byte-identical (deepEqual); editing a
  condition rule (G-2) AND a parallel joinMode (G-3) in the same graph both land, everything else
  byte-identical; an UNTOUCHED parallel / parallel+condition / condition / cc graph round-trips
  byte-identical (no spurious seed diffs); validation preview = joinMode ∈ `{'all','any'}` (an
  out-of-set value → preview error; both seeded 'all' and 'any' pass).
  `apps/web/tests/approval-template-authoring-parallel-edit.test.ts` (wired into
  `approval-web-guard.yml`). Backend `normalizeApprovalGraph` stays the sole arbiter (FE never
  relaxes it). G-1 round-trip + G-2 + `approvalTemplateAuthoring.spec` stay green.

## Phase G-4 — cc editor + close-out ✅ (shipped; this PR)
- ✅ cc `targetType` (user/role) + `targetIds` editable in TemplateAuthoringView; pure logic in
  `ccEdit.ts` (`applyCcEditsToGraph` composes after condition + parallel — three disjoint passes,
  every non-cc node + all edges byte-identical). Matches the backend cc rule (targetType ∈
  {user,role}, non-empty targetIds). Close-out: all three complex node types now editable in one
  structured view; the FE preview surfaces all three edit types; topology stays read-only.
- ✅ 13 cc tests (topology-preservation + condition×cc compose + untouched round-trip + validation),
  wired into approval-web-guard. The complex-graph author UI render+edit set is complete.

## Phase G-5 — approval-node editor ✅ (post-arc slice; unlocks #3114 amount-tier preset runtime)
- ✅ approval node's **approver SOURCE only** (`assigneeSources`) editable in a preserved complex
  graph; pure logic in `approvalNodeEdit.ts` (`applyApprovalNodeEditsToGraph` = the FOURTH disjoint
  pass after condition/parallel/cc — every other node + all edges byte-identical; spread-original-first
  so the edited node's own `approvalMode` / `emptyAssigneePolicy` / `autoApprovalPolicy` survive).
  Legacy nodes (no `assigneeSources`) aren't seeded → cloned verbatim, read-only.
- ✅ **SCOPE (honest):** approver-source editing only; `approvalMode` / `emptyAssigneePolicy` are
  PRESERVED, not yet editable (a later slice). View is a compact per-kind source control (ID-typed,
  not the rich directory picker yet); multi-source nodes edit the primary source + preserve extras.
- ✅ 13 tests (topology + WITHIN-NODE preservation + legacy round-trip + FOUR-phase compose +
  form_field_user→top-level-user validation), wired into approval-web-guard. This is the #3114
  Decision-4 prerequisite (admins can now tune "which role/person approves at a threshold").

## Out of scope (v1 — reopen-only, see design-lock §7)
- 🔒 Free-canvas / drag-edge editor · new node types · runtime/validator changes · nested
  parallel · any flatten of unsupported constructs · W7 approval-result write-back (own scope-doc,
  pending a concrete scenario).
- ⚠️ **`joinMode='any'` authoring was listed here / in design-lock §7 as deferred, but G-3 SHIPS it**
  because the empirical backend pre-check (above) shows `'any'` is accepted + runtime-executed; the
  doc's deferral premise was factually wrong. Re-scoped OUT of "out of scope" — pending owner
  ratification (see the G-3 PR body). The OTHER parallel limits (nested parallel, editing
  branches/joinNodeKey topology) remain out of scope.
- ✅ **FOLLOW-UP DONE — cc / condition / parallel config unknown-key fail-closed.**
  `complexNodeConfigHasBackendDrop` generalises the approval shape-check to EVERY node type: cc →
  `{targetType, targetIds}`, parallel → `{branches, joinMode, joinNodeKey}`, condition → recurses
  config → `branches[].{edgeKey, conjunction, rules}` → `rules[].{fieldId, operator, value}` (the
  rule `value` is a free leaf, NOT shape-checked), start/end → `{}`. Any unknown key — top-level or
  nested — on ANY complex node now → unsupported (read-only, save disabled), never silently flattened
  on save. 11 tests; the whole complex graph-save surface is fail-closed for unknown keys.
