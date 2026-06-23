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
