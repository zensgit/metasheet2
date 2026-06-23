# Approval complex-graph node author UI (复杂图节点作者 UI) — gated TODO

> Date: 2026-06-23 · Status: **TRACKER** · 配套设计锁:
> `docs/design/approval-complex-graph-author-ui-design-lock-20260623.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被决策/前置阻塞)
> 纪律:每个 phase 独立 opt-in(staged-lineage)。设计锁未 ACCEPT 前,G-1..G-4 全部 🔒。
> 不变量:UI-only —— 不改 `ApprovalGraphExecutor` / `normalizeApprovalGraph` / graph 类型;
> 不支持的构造一律 read-only,**永不拍平**。

## Phase G — design-lock
- ⬜ Land the design-lock doc (this PR, docs-only).
- 🔒 Owner ACCEPT of the §1 editable set + the 4 §8 decisions. **Gate for G-1.**

## Phase G-1 — load-preserve + read-only structured view (🔒 until G accepted)
- 🔒 Authoring draft model carries the FULL graph (all nodes + edges + every config), not the
  linear `steps` projection; complex types pass through byte-for-byte (spread-original-first).
- 🔒 Render a complex graph as a READ-ONLY structured node list (condition/parallel/cc shown,
  not just "unsupported"). No editing yet.
- 🔒 Anti-flatten test: load a condition / parallel / cc template → save untouched → the
  `approvalGraph` is byte-identical (no node/edge/config dropped). Keep the existing
  "blocks unsupported / refuses to save / opens read-only" tests green.

## Phase G-2 — condition editor (🔒 until G-1)
- 🔒 Author condition `branches` (rules `{fieldId, operator, value}` + `conjunction`) +
  `defaultEdgeKey`; build the full graph; FE validation preview (branch needs an edgeKey;
  rule fieldId must reference a form field). Backend `normalizeApprovalGraph` stays arbiter.

## Phase G-3 — parallel editor (🔒 until G-2)
- 🔒 Author parallel `branches` + `joinNodeKey` (v1 `joinMode='all'`); preview enforces the
  backend rules (no nested parallel, no cross-branch assignee dupes) before save.

## Phase G-4 — cc editor (🔒 until G-3)
- 🔒 Author cc `targetType` + `targetIds` (reuse the approval user/role picker).

## Out of scope (v1 — reopen-only, see design-lock §7)
- 🔒 Free-canvas / drag-edge editor · new node types · runtime/validator changes · nested
  parallel · `joinMode='any'` authoring · any flatten of unsupported constructs · W7
  approval-result write-back (own scope-doc, pending a concrete scenario).
