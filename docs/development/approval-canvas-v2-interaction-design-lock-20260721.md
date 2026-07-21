# Approval Canvas V2 Interaction Design Lock (D0, 2026-07-21)

**Status:** PROPOSED — owner ratification required (G0) before D3-D6 (D6-f1 excepted) and D6-f2 start
**Plan item:** D0 of `docs/development/approval-canvas-v2-development-plan-20260720.md` ("the plan")
**Review baseline:** `3ade0d685bbad1605cf71803b228f9aac27d0842`
**Phase-1 implementation checkpoint:** `eb107032d` (command/preview/backend guards only; no D3+ authorization)
**Authoritative runtime model:** existing `ApprovalGraph` plus backend `normalizeApprovalGraph`
**Scope of this document:** interaction and visual contract for the ordinary-user, canvas-first approval
authoring surface — flow canvas, inspector, form builder, version lifecycle, route preview, states,
accessibility, and acceptance evidence. It decides how people interact; it does not change what the graph means.

This lock authorizes **development direction only**. Runtime flags, merge, UAT, and production enablement
remain owner-gated exactly as the plan states (§4.3, §9 Human merge authority, §13). Nothing here turns
anything on.

---

## 1. Authority and hard boundaries

1. **`ApprovalGraph` is the only business model.** The canvas renders a derived render model. Every user
   edit becomes a typed graph command that passes through the existing graph edit/normalization path and,
   at save/publish, backend `normalizeApprovalGraph`. The backend remains the final arbiter; frontend
   validation is advisory feedback only (plan I1, I2).
2. **No new runtime node semantics.** This lock defines authoring interactions for the six shipped node
   types (`start`, `approval`, `cc`, `condition`, `parallel`, `end`) and the shipped configuration surface
   only: assignee sources, approval modes, empty-assignee policy, auto-approval policy, node field
   permissions, node timeout (wired effects only), condition rules/formulas with branch order as priority,
   parallel fork/join with `all`/`any` join, cc targets. It does not authorize a handler/processing node,
   within-node ordered approvers, new assignee sources, or readonly/editable runtime enforcement — each of
   those needs its own ratified design lock (plan §2, §5 D7, G3 optional-runtime rule).
3. **No persisted coordinates.** Node positions are derived by deterministic layout from graph identity and
   viewport class. No x/y value, slot index beyond graph topology, or viewport state ever enters the
   `ApprovalGraph` payload (plan I4). The v1 unsaved free-drag sidecar is removed, not carried forward
   (plan D1).
4. **No user-visible internals.** Ordinary users never see JSON, form-schema JSON, field IDs, edge keys,
   raw user/role IDs, or internal enum values anywhere in this surface (plan I3, H1/H2). All selection is
   through typed pickers with business labels.
5. **Version isolation.** Publish creates an immutable version; running instances stay pinned; restore
   always creates a new draft and never rewrites a published version (plan I6, V1–V4, O8).
6. **Existing capabilities are reused, not rebuilt.** Route preview/dry-run reuses the shipped RP-1..RP-3
   path including its stale-result guard and wire contract. Version read/diff/restore reuses the D8-a
   backend contract. Nothing in this lock rebuilds a parallel preview or version service.

## 2. Information architecture: one canvas-first surface

The ordinary-user authoring journey lives in one screen with three regions and one mode switch:

- **Header bar (operational, not hero):** template name (inline editable text), draft/published status
  chip, undo/redo buttons, route-preview toggle, version-history entry, and Save draft / Publish actions.
  No marketing banner, no illustration, no gradient.
- **Mode switch:** `表单` (Form) / `流程` (Flow) segmented control. Form mode shows the form builder
  (§10); Flow mode shows the canvas (§3). Both edit the same draft; switching modes never loses state and
  never requires a save.
- **Canvas region:** the vertical tree canvas. It is the primary and sufficient surface for all flow
  authoring — an ordinary user can complete every supported edit without opening any list, JSON, or
  raw-ID surface.
- **Inspector region:** contextual property editor, docked right on desktop, compact at 1024, bottom sheet
  at 390 (§5).

The structured list editor is **not** the primary ordinary-user journey and is never required to configure
a supported node. Until S12 proves equivalent assistive-technology authoring, however, an explicit
"辅助编辑模式" entry remains available to ordinary users who need the accessible structured alternative
(§12). Only after S12 and the G6-C fallback window pass is that ordinary-user entry removed; the editor may
then remain temporarily behind an internal support/debug capability gate (plan O2/O12).

Route entry points (`/approval-templates/new`, `/approval-templates/:id/edit`) are unchanged. Behind
`approvalCanvasV2` = off, the current surface serves unchanged (plan I8).

## 3. Canvas contract: one vertical tree

### 3.1 Shape

- One vertical tree, top to bottom: `start` at top, `end` at bottom, flow direction downward. No
  horizontal-flow mode, no free-form whiteboard.
- Branches (condition, parallel) fork horizontally within a bounded branch lane and rejoin into the single
  vertical spine. The spine is always visually continuous: a user can trace the main path top to bottom
  without scrolling sideways.
- Layout is deterministic: the same graph at the same viewport class produces the same layout. Node
  heights are measured by the renderer; edge routing must not assume fixed card height and must never
  cross a card (plan I4, G1).

### 3.2 Node rendering (business summary only)

Each node is a single restrained card — flat background, 1px border, 8px radius, no shadow stack, no
gradient, no nested cards. Contents, top to bottom:

1. **Type label + name line:** small uppercase-free type tag in text form ("审批", "抄送", "条件",
   "并行", "开始", "结束") followed by the user-editable node name. One line, truncated with ellipsis and
   full text on hover/focus and in the inspector.
2. **Summary lines (max 2, truncated):** business-readable configuration summary —
   - approval: approver description ("直属上级", "角色：财务主管", "3 名指定成员") + mode ("任一通过" /
     "全部通过" / "单人审批" / threshold when the FE type catches up, see §16 finding F-2).
   - cc: target description ("角色：全体主管" / "2 名成员").
   - condition: branch count and default-branch presence ("3 个分支 · 含默认分支").
   - parallel: branch count + join mode ("3 个并行分支 · 全部完成后合并").
   - start/end: no summary line.
3. **Validation marker:** when the node carries a live validation issue, a single left-border accent plus
   an inline icon with accessible text; details live in the inspector and the validation list (§11), not
   in stacked badges on the card.

No button clusters on nodes (plan §4.1). Node-level actions live in the inspector and one context menu
(right-click / long-press / keyboard `Shift+F10`).

### 3.3 Edges

- Directional connectors, top-out/bottom-in, with an arrowhead into the target. Straight or simple
  orthogonal routing; no decorative curves that cross cards.
- Every edge that can accept an insertion carries an **insertion control**: a small `+` affordance
  centered on the edge, keyboard-focusable, with an accessible label ("在「部门经理审批」之后插入节点").
- Branch lanes label their exit edges with business text, never edge keys: condition branches show their
  rule summary or "默认分支"; parallel branches show "分支 1", "分支 2"… with an editable branch name where
  the model supports one.

### 3.4 Insertion and semantic drag

Two equivalent ways to add or move a node; drag is never the only path (G0 touch requirement):

1. **Insertion menu (primary, all input types):** activating an edge `+` (click, tap, Enter/Space) opens
   an insertion menu listing the node types valid at that slot. Choosing one performs the typed add
   command and selects/focuses the new node with the inspector open at its first field.
2. **Semantic drag (pointer enhancement):** dragging a palette item or an existing node highlights only
   **valid slots** — edge insertion points, branch-add positions, and reorder positions — computed from
   the same validity predicates as the command layer (plan I5). Invalid regions show no target affordance
   at all (not a red target): there is nothing to drop onto.

Slot validity is decided **before mutation** by the command layer's predicate (reject cycles, orphans,
invalid fork/join, illegal placement such as nodes after `end`, branches below minimum count, nested
parallel). A drop on a valid slot executes the typed command; a drop released anywhere else is a no-op
with rollback feedback (§7.3). There is no "drop to free space" concept anywhere in the surface.

## 4. Node-type contracts

### 4.1 Condition: priority and default

- Branches render left to right in evaluation order. Branch order **is** priority; the UI calls it
  priority ("优先级 1 最高") and never exposes the array-index mechanic as such, and never shows edge keys.
- The default branch renders as the rightmost lane, labeled "默认分支（其他情况）", visually de-emphasized,
  and excluded from rule editing. It cannot be deleted while it is the only default; deleting another
  branch never silently changes the default (existing topology edit protections carry over).
- Reordering branches (drag between branch slots or keyboard "提高/降低优先级" actions in the branch
  inspector) is a typed reorder command that preserves branch identity, rules, and the default mapping
  (plan C2).
- The inspector branch list shows, per branch: priority number, rule summary in business language
  ("金额 大于 10000", "部门 是 财务部"), and conjunction ("且"/"或") or "公式" for formula branches.
  Rule editing uses typed field/operator/value controls driven by the form schema — operators from the
  shipped set (`eq/neq/gt/gte/lt/lte/in/isEmpty`) presented as words, values via the field-type-appropriate
  picker. Formula entry keeps the existing formula editor with its dry-run (as-built), labeled as an
  advanced option; formula and rules remain mutually exclusive as the backend enforces.
- Evaluation-order hint copy lives once, in the condition inspector header: "分支按优先级从上到下依次判断，全部不满足时走默认分支。"

### 4.2 Parallel: all/any and merge visualization

- A parallel fork renders as one fork card, N branch lanes, and one explicit **merge (join) node**
  rendered on the spine where branches rejoin. The join node is a real selectable element showing the
  join mode: "全部完成" (`all`) or "任一完成" (`any`).
- The fork card and join node are a matched pair (same accent border color, linked selection: selecting
  one highlights the other). The join mode is edited once — on the join node or fork inspector, same
  control — and both reflect it.
- Branch add/remove keeps the shipped ≥2-branch invariant; removing down to 2 is allowed, below that is
  rejected pre-mutation with the reason surfaced (plan C3).
- Every configured branch must contain at least one body node before the paired join. A direct
  fork-to-join edge is invalid because `joinMode=any` could otherwise advance without a real branch
  assignment. Delete, move, and branch-removal commands must preserve this invariant before mutation;
  backend normalization repeats the same check at save/publish. Complex or shared branch shapes that
  cannot be proven safe are refused rather than heuristically rewritten.
- Summary copy on the join node states the consequence plainly:
  - all: "所有分支都完成后继续"
  - any: "任一分支完成后继续，其余分支自动跳过"
- Nested parallel is not offered in insertion menus inside a parallel branch; drag validity likewise
  excludes it (backend rejects it; the UI prevents rather than errors).

### 4.3 Approval, cc, start, end

- Approval node inspector exposes exactly the shipped configuration: assignee source picker (§10.3),
  approval mode radio with plain-language labels, threshold N-of-M control only when threshold mode is
  selected and only where the type/validation surface supports it, empty-assignee policy, auto-approval
  policy checkboxes with plain labels, node field permissions, timeout (wired effects only —
  `auto_approve`/`auto_reject` terminal effects are not offered, matching publish-time rejection).
- Cc node: target type (成员/角色) + typed picker. Start/end: name only; end carries no outgoing
  insertion slot.

## 5. Inspector contract (three viewport classes)

One inspector implementation, three presentations. Same fields, same order, same validation, same
commands — only geometry changes.

| Viewport | Presentation | Geometry |
|---|---|---|
| 1440×900 (desktop) | Right-docked panel | Fixed 360px width, full height below header, independent scroll; canvas occupies the remainder, never underlaps the panel |
| 1024×768 (compact) | Right overlay panel | 320px, overlays the canvas with a scrim-free flat boundary; opening it shifts nothing on canvas, closing returns focus to the node |
| 390×844 (narrow) | Bottom sheet | Two detents: half (≈55% viewport height) and full; drag handle plus explicit 收起/展开 buttons (drag never the only control); canvas remains visible and pannable above the half detent |

Common behavior:

- Opens on node/branch/join selection; content is contextual to the selection. Empty selection shows the
  flow-level summary (node counts, validation list entry, publish checklist state).
- Dirty fields apply through the same typed commands as canvas edits (one undo history, §7.1). There is
  no separate inspector "apply" button; invalid field values block with inline messages and never write
  a partially valid node config.
- Focus management: opening moves focus to the inspector heading; closing or deleting the node returns
  focus to the canvas node or, if removed, to the nearest surviving neighbor (plan §8 a11y row).
- The inspector is the only place multi-field configuration happens; the canvas never grows inline forms.

## 6. Selection, focus, keyboard, touch

### 6.1 Selection model

- Single primary selection (node, edge, branch lane, or join). Selection is render-model state, never
  persisted.
- Canvas supports click/tap select, `Esc` clears selection and closes transient menus, `Delete`/`Backspace`
  on a selected deletable node opens the delete confirmation (destructive, focus-returning).

### 6.2 Keyboard contract (complete authoring without pointer)

| Key | Action |
|---|---|
| Arrow Up/Down | Move focus along the spine to previous/next element |
| Arrow Left/Right | Move focus across sibling branch lanes; onto/off edge insertion controls |
| Enter / Space | Activate focused element: select node, open insertion menu on an edge `+`, toggle a control |
| `Tab` / `Shift+Tab` | Move between canvas region, header actions, and inspector in DOM order |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `Shift+F10` / long-press | Context menu for the focused element |
| `Esc` | Close menu/sheet, then clear selection |

Every insertion control, node, branch, and join is keyboard reachable with a visible focus ring (2px,
contrast ≥ 3:1 against adjacent colors) and an accessible name that includes type and user-given name
(plan G2-a).

### 6.3 Touch contract

- Tap selects; tap an edge `+` opens the insertion menu; long-press opens the context menu; two-finger
  pan and pinch zoom are enhancements only.
- Semantic drag exists on touch but is **never required**: every drag-achievable outcome (insert, move,
  reorder branch, reorder field) is achievable through insertion menu + context-menu "移动到…" /
  "提高/降低优先级" actions that present valid slots as a list (G0: drag is never the only narrow-screen
  action).
- Minimum target size 40×40px on canvas controls, 44×44px in the bottom sheet.

## 7. Undo/redo and invalid-drop rollback

### 7.1 One command history

- All topology edits, branch reorders, inspector field commits, and form-builder operations are typed
  commands with explicit inverses in a single per-draft undo stack (plan D2-b). Undo restores both the
  normalized graph and the selection/focus context of the moment before the command (C4, G2-b).
- Undo/redo buttons in the header show disabled state at stack bounds; keyboard shortcuts per §6.2.
  Stack clears on draft switch or restore-to-new-draft (a restore is a new draft, not an undoable in-place
  mutation).

### 7.2 Optimistic render, authoritative save

- Commands render optimistically. Save/publish failures roll the draft back to the last server-acknowledged
  state only for the failed save's conflicts — local unsaved edits are preserved and the conflict state
  (§11) explains what happened. Local undo history is not destroyed by a failed save.

### 7.3 Invalid-drop rollback

- A pointer drag that ends outside a valid slot snaps the dragged element back to its origin (no
  animation theatrics; ≤150ms return), announces "该位置不能放置此节点" via a polite live region plus a
  transient inline hint near the origin, and leaves the graph untouched. Because validity is checked
  pre-mutation, there is no partial-mutation cleanup path (plan I5, C5).
- A drop that passes the frontend predicate but would fail backend normalization at save is caught by
  live validation (§11) immediately, attributed to the node, and is undoable as one command.

## 8. Version lifecycle: timeline, diff, restore

### 8.1 Version timeline

- Entry from the header. A vertical, chronological list (newest first) of versions: version number,
  published-at time, publish note, and status. The current draft pins to the top as "当前草稿".
  Restrained list rows — no cards-in-cards.
- Selecting a version opens a read-only canvas view of that version (`ApprovalVersionCanvas`), with a
  "与当前草稿对比" action per row.

### 8.2 Side-by-side diff

- Two synchronized read-only canvases, left = historical version, right = current draft (or second chosen
  version), sharing scroll and zoom, each laid out independently with stable node identity matched across
  them (plan G4). Never two relaid-out graphs ambiguously overlaid.
- Change encoding is text-plus-outline, not color alone: added nodes get an "新增" tag and outline on the
  right; removed nodes render as read-only ghosts on the left with a "已删除" tag; changed nodes get a
  "已修改" tag on both.
- Selecting a changed pair opens a before/after inspector: a two-column property table with explicit
  before and after values in business language (assignee labels, rule text, join mode), never config
  JSON or IDs.

### 8.3 Restore to new draft

- "恢复为新草稿" on any historical version opens a restore preview (the side-by-side view above) with a
  confirm action. Confirm calls the D8-a backend restore, which creates a **new draft** with provenance
  ("恢复自 v3") and never mutates the published row (V2).
- Stale-base conflicts (template changed since the restore preview loaded) fail closed with the conflict
  state (§11) and an offer to reload the preview (V3). Permissions for read/diff/restore are backend
  enforced; the UI hides nothing as a substitute for authorization (I7, V4).

## 9. Route preview (dry-run), inline

- A header toggle opens the route-preview panel in the inspector region (same three presentations as §5).
  It invokes the **existing** template-author dry-run endpoint (RP-1..RP-3) with representative form
  values; it creates no approval instance and no parallel preview service (plan §6.1, S7).
- Input: a compact representative-data form rendered from the form schema with typed controls; requester
  selection via the typed user picker.
- Output: the resolved route as a vertical list of steps with resolved assignee labels ("张三（直属上级）"),
  branch decisions with the matched rule in business language, skipped branches noted, and empty-assignee
  fallback outcomes shown where they occur. The resolved path also highlights on the canvas (outline, not
  color-only) while the panel is open.
- The as-built stale-result guard (generation counter) is preserved verbatim; slow responses show the
  loading state (§11), failures show the error state with the backend's values-free message.
- Requester-perspective field visibility (G-B2-21) and hidden-field exclusion (G3-d1) apply to preview
  output exactly as on main; preview never reveals hidden fields to unauthorized viewers.

## 10. Form builder and typed pickers

### 10.1 Form builder (Form mode)

- Left: field palette listing the currently authorable field types (text, textarea, number, date,
  datetime, select, multi-select, user, detail/sub-form — exactly the shipped `AuthorableFieldType` set;
  attachment stays excluded until its own lane lands, F3). Palette items are added by click/tap
  ("添加到表单") or semantic drag into an insertion slot in the field list. No JSON, no ID entry.
- Right/main: the field list as a vertical sequence with insertion slots between fields. Reorder by
  semantic drag or by keyboard/context "上移/下移" — one action per step, not repeated clicking (G2-f).
- Selecting a field opens the field inspector: label, required, placeholder/help text, options editor for
  select types (business labels; option values generated, never typed), detail-column editor for
  sub-forms, visibility rules (typed condition rows over other fields), and node-level field permissions
  link. Field IDs are never displayed or requested (H1/H2, F1).
- Moving a field preserves its visibility/assignee/condition/permission/detail/mapping references or
  explicitly rejects the move with a named reason; no silent reference rewrite (F2).

### 10.2 Typed pickers (global rule)

Every person/role/field/department reference in the surface resolves through a typed picker backed by the
existing directory endpoints, showing business labels with search. The manual raw-ID text path is removed
from the ordinary-user surface; if retained for support it is capability-gated and unreachable here
(H2). No control in this lock accepts or displays a raw ID.

### 10.3 Assignee source picker

One picker component listing the shipped sources with plain labels and a configured summary echo:
指定成员 / 指定角色 / 发起人本人 / 表单中的成员字段 / 直属上级 / 部门负责人 / 连续多级上级（层数 N）/
指定层级上级（第 N 级）. Each choice expands only the controls that source needs (user/role picker, form
user-field picker, level number stepper). Empty/unresolved handling copy matches the chosen
empty-assignee policy and is preview-verified in §9 (G3-c1, D7-c1 parity — no new sources, no broadened
fallback authorization).

## 11. States (empty, loading, error, permission, conflict, long-label)

All states are flat, text-first, single-illustration-free. One inline icon, one heading line, one
explanation line, at most two actions. No empty-state marketing art.

| State | Where | Contract |
|---|---|---|
| Empty flow | Canvas (new template) | `start`—`end` spine pre-rendered with one insertion control between them; hint line "点击 + 插入第一个审批节点"; no blank whiteboard |
| Empty form | Form mode | Palette visible, field list shows one insertion slot and hint "从左侧添加字段，或点击此处" |
| Empty version history | Timeline | "还没有已发布的版本" with publish entry |
| Loading | Canvas, preview, timeline, diff | Skeleton rows matching final geometry (no spinner-only waits >300ms); preview keeps the stale-result guard; loads >10s offer 重试 |
| Error (load/save/preview) | Region-scoped inline banner | Values-free message, 重试 action, and preservation statement ("您的修改未丢失") for save failures; no raw error codes or stack text |
| Permission denied | Whole surface or action | Read-only surface with banner "您没有编辑此模板的权限，当前为只读查看" when view is allowed; hard denied shows a plain 403 page state. Client hiding never substitutes for backend authorization (I7) |
| Conflict (stale draft / stale restore) | Modal-less blocking banner | "此模板已被他人更新" with 查看最新 / 以我的修改另存为新草稿 where the backend contract supports it; restore conflicts fail closed per V3 |
| Long labels | Node cards, branches, pickers, timeline | Truncate with ellipsis at component limits (§14); full text on hover/focus tooltip, in the inspector, and in accessible names. Longest supported labels must fit without layout break (G0) |
| Validation issues | Node marker + flow-level list | A flow-level validation list in the empty-selection inspector aggregates live issues; each row links focus to the offending node. Publish remains gated by the as-built pre-flight checklist (B2-03) — canvas issues feed that checklist, never bypass it (I2) |

## 12. Accessibility decision and fallback

**Decision:** the V2 canvas is built to be fully keyboard- and screen-reader-operable for every authoring
command (insert, move, reorder, configure, delete, undo/redo, preview, version restore), per §6 and the
live-region announcements in §7.3/§11. **Until S12 proves equivalent assistive-technology authoring on
exact-head evidence, the accessible structured alternative remains available through the ordinary-user
"辅助编辑模式" entry.** After S12 and the G6-C fallback window pass, that entry is removed and the legacy
editor may remain temporarily support/debug-only (plan O2/O12, G6-C). This lock therefore commits to:

- Canvas-first for ordinary users **and** a retained accessible alternative until equivalence is proven —
  not canvas-only from day one, and not list-as-permanent-parallel-surface.
- Semantic announcements: selection changes, command results ("已在「直属上级」之后插入审批节点"), undo/redo
  results, validation issue counts, preview completion, all via one polite live region; assertive only
  for error/conflict states.
- Contrast ≥ 4.5:1 for text, ≥ 3:1 for focus indicators and change-encoding outlines; nothing encoded by
  color alone (diff tags, validation markers, route highlight all carry text/outline).
- Reduced-motion: snap-back and sheet transitions collapse to instant under `prefers-reduced-motion`.

## 13. Copy principles

1. Business words only: 审批人, 分支, 优先级, 默认分支, 全部完成/任一完成. Never: node, edge, key, ID,
   JSON, graph, enum, config.
2. State consequence, not mechanism: "任一分支完成后继续，其余分支自动跳过", not "joinMode=any".
3. One idea per line; sentences ≤ 20 Chinese characters where possible; labels ≤ 6 characters.
4. Errors say what happened, what was preserved, and the next action — no codes, no blame.
5. Empty states say what to do first, in one line.
6. Destructive actions name the object: "删除节点「财务主管审批」".
7. All user-facing strings follow the existing locale structure; this lock defines principles and
   semantics, final wording ships with implementation review.

## 14. Measurable visual acceptance

Verified by Playwright screenshots plus DOM measurements at exact-head, at 1440×900, 1024×768, and
390×844 (plan §8). "Pass" requires every applicable row; Kimi K3 performs a separate visual critique
(plan §8 Visual row).

| # | Criterion | Measurement |
|---|---|---|
| V-1 | No overlap/clipping | Zero intersections between any two node-card bounding boxes; zero edges crossing a card; zero clipped interactive controls, all viewports, including the 100-node mixed fixture (S11, G1) |
| V-2 | Desktop geometry (1440×900) | Inspector panel 360±2px; canvas region ≥ 1000px wide; header ≤ 56px; spine vertical within ±1px across the graph |
| V-3 | Compact geometry (1024×768) | Inspector overlay 320±2px; canvas fully usable with overlay closed; insertion controls ≥ 40×40px |
| V-4 | Narrow geometry (390×844) | Bottom sheet half detent leaves ≥ 320px canvas visible; all sheet targets ≥ 44×44px; no horizontal page scroll |
| V-5 | Long-label fitness | 80-character node names, 40-character branch labels, and 3-line assignee summaries truncate with ellipsis, keep card width fixed, and expose full text on hover/focus and in `aria-label` — no wrap-driven card growth breaking V-1 |
| V-6 | Touch/keyboard reachability | Every insertion control, node, branch, join, and header action is reachable by keyboard alone and has a visible 2px focus ring at ≥ 3:1 contrast; insertion-menu flow completes a linear + condition + parallel build with zero pointer input (S12 keyboard half) |
| V-7 | Change encoding | Diff added/removed/changed, validation markers, and route-preview highlight each carry a non-color channel (text tag or outline) verified in the DOM |
| V-8 | Restraint audit | Computed styles contain no CSS gradient, no box-shadow beyond the single 1px-equivalent elevation token on overlays/sheets, no nested card (a bordered container inside a bordered container) anywhere in the authoring surface; screenshot diff confirms no hero/banner region above the header |
| V-9 | State coverage | Screenshots exist for every row of §11 at 1440×900, and for empty/loading/error/permission at 390×844 |
| V-10 | Determinism | Two consecutive renders of the same fixture at the same viewport produce identical layout coordinates (DOM-read), and no coordinate appears in the save payload (network capture) (G1) |

## 15. Component anatomy (exact)

Component/module names follow plan §4.1. "Part" = rendered region; "Emits" = typed intents only.

**ApprovalFlowCanvas.vue**
- Parts: header slot (name/status/undo/redo/preview/versions/save/publish), viewport (pan/zoom/fit),
  node layer, edge layer, insertion controls, live region, validation banner host.
- Owns: render model, selection/focus state, drag session state machine (§16), viewport state.
- Emits: `insert(slot, type)`, `move(nodeKey, slot)`, `reorderBranch(...)` etc. — all to the command
  layer; never mutates the graph directly.

**ApprovalFlowNode.vue (+ typed variants Start/Approval/Cc/Condition/Parallel/End)**
- Parts: type tag, name line (truncated), up to 2 summary lines, validation marker, focus ring host.
- Variants add: Condition → branch-lane headers with priority number and rule summary/default tag;
  Parallel → fork card + matched join element with join-mode summary.
- No action buttons on the card.

**ApprovalFlowEdge.vue**
- Parts: connector path, arrowhead, insertion control (button, accessible label), branch label slot.
- Emits: `insert(slot)` on activation.

**InsertionMenu (popover)**
- Parts: valid node-type list for the slot (pre-filtered by command predicates), each with one-line
  business description; keyboard-navigable; `Esc` returns focus to the invoking control.

**ApprovalFlowInspector.vue**
- Parts: heading (node type + name), contextual section stack per §4/§10, flow-level summary +
  validation list when nothing is selected, route-preview panel host (§9), before/after property table
  when in diff mode.
- Presentations: docked 360px / overlay 320px / bottom sheet (§5); same content component.

**ApprovalVersionCanvas.vue**
- Parts: version timeline list, read-only canvas, side-by-side diff host (two synchronized canvases +
  ghost/highlight encoding + before/after inspector), restore-preview confirm.
- Emits: `restore(versionId)` → backend D8-a contract; handles stale-base conflict per §11.

**ApprovalFormBuilder.vue**
- Parts: field palette, field list with insertion slots, field inspector (uses ApprovalFlowInspector
  shell), visibility-rule editor, options editor, detail-column editor.

**Pure modules (no IO, existing convention):** `approvalCanvasAdapter.ts` (graph → render model),
`approvalCanvasCommands.ts` (typed commands + inverses + validity predicates), `approvalCanvasLayout.ts`
(deterministic layered layout), `approvalCanvasValidation.ts` (live diagnostics; backend final),
`approvalFormCommands.ts`.

## 16. Interaction state machines

### 16.1 Canvas surface state machine

```
loading → ready | permission-denied | load-error
ready → saving (on save/publish) → ready | save-error(conflict?) → ready
ready → conflict-banner (on stale detection) → ready (after reload/resolve)
ready → readonly (on permission loss mid-session, backend 403)
```

`ready` is the only state that accepts edit commands. `permission-denied`/`readonly` accept no edit
intents; banners are region-scoped, focus is moved to the banner once on entry.

### 16.2 Drag session state machine

```
idle → dragging (pointer down + move threshold on palette item or node)
dragging → over-valid-slot (slot predicate true: highlight, announce slot)
dragging → over-nothing (no affordance)
over-valid-slot → committed (pointer up: execute command, select result) → idle
over-nothing → rolled-back (pointer up: snap back ≤150ms, announce rejection, graph untouched) → idle
dragging → cancelled (Esc: as rolled-back) → idle
```

A slot predicate flip during drag re-evaluates per frame; there is no "pending mutation" state — mutation
exists only after `committed`.

### 16.3 Selection/focus invariants

- Exactly one primary selection or none; selection survives mode switches and undo/redo (restored).
- Deleting the selected node moves focus to the nearest surviving spine neighbor, announced.
- Inspector open ⇒ selection non-empty; selection cleared ⇒ inspector shows flow summary.

### 16.4 Self-review findings logged against this lock

- F-1: Condition priority — the model has no explicit priority field; **array order is priority**. This
  lock's UI speaks only "优先级" over ordered branches and never invents a stored priority attribute.
  No contradiction with `ApprovalGraph`.
- F-2: Threshold mode — backend `ApprovalMode` includes `'threshold'`; the FE type copy currently does
  not. The inspector must not ship a threshold control ahead of the FE type/validation surface catching
  up via the normal shared-types integration lane; until then threshold graphs load and display
  read-only summaries but are not editable into threshold mode from the canvas. No runtime change is
  implied or authorized here.
- F-3: `readonly`/`editable` field permissions are contract-stable but runtime-inert. The inspector shows
  them as configuration with no claim of enforcement (G3-d1 honesty); `hidden` keeps its server-side
  behavior through canvas/preview/snapshot/history (D7-d1).
- F-4: The v1 canvas's unsaved free-drag sidecar and fixed 150×56 boxes are superseded; nothing in this
  lock depends on them.

## 17. Explicit non-goals

- No new runtime node semantics: no handler/processing node, no within-node ordered approvers, no new
  assignee sources, no readonly/editable runtime enforcement, no auto-approve/auto-reject timeout
  terminal effects. Each requires its own ratified lock (plan O6).
- No persisted or free coordinates; no free-form whiteboard, minimap-less absolute positioning, or
  user-managed layout.
- No rebuild of route preview, version backend, publish pipeline, or directory endpoints.
- No FWB, attachment, or approval-data runtime behavior; those lanes and flags are independent
  (plan §4.3, O9).
- No mobile runtime parity changes; narrow viewport here means narrow **authoring** only (plan §2).
- No visual clone of any other product, and no marketing surface: no hero, no gradients, no orbs, no
  nested cards, no illustration-driven empty states.
- No change to `ApprovalGraph`, `normalizeApprovalGraph`, publish pre-flight authority, or instance
  version pinning.
- No enablement: this document does not flip `approvalCanvasV2` or any other flag, does not merge
  anything, and does not schedule UAT.
- No structured-editor removal: retirement remains gated on G6-C/S12 (O2/O12).

## 18. Owner gates preserved

- G0 (this lock) → ratification required before D3/D6-f2 (plan §12: D3–D6 and D6-f2 BLOCKED on D0).
- Merge authority: every implementation PR requires named human owner/reviewer approval on exact-head
  evidence; subagent/Codex verdicts are recommendations only (plan §9).
- `approvalCanvasV2` stays default-OFF; canary only after G5-C; default ON only after owner UAT (G6-C,
  O11). FWB/attachment/optional-runtime flags only after G5-R plus their own UAT.
- Structured-editor ordinary-user entry removal only after the G6-C fallback window closes **and** S12
  assistive-technology equivalence passes.
- Optional D7 runtime items remain OWNER_GATE; a design lock document alone never authorizes runtime.

## 19. G0 checklist (mapped to plan §7 G0)

| G0 requirement | Where decided |
|---|---|
| One-canvas IA and inspector interaction explicit | §2, §3, §5, §15 |
| Node summaries fit the longest supported labels | §3.2, §11 long-label, V-5 |
| Condition, parallel, validation, empty, loading, permission-denied, conflict states shown | §4, §11, V-9 |
| Desktop and narrow layouts defined | §5, V-2..V-4 |
| Touch placement has an explicit insertion-menu alternative; drag never the only narrow action | §3.4, §6.3 |
| Screen-reader authoring reaches every Canvas command or retains accessible structured alternative | §12 (both: full-canvas AT target + retained fallback until S12) |
| Old structured editor retirement and support-only fallback decided | §2, §12, §17, §18 |

## 20. Contradiction self-review (vs `ApprovalGraph` authority)

Checked this lock line-by-line against the shipped model (`ApprovalNode`/`ApprovalEdge`/`ApprovalGraph`,
node configs, `normalizeApprovalGraph` invariants) and plan invariants I1–I9:

- **Typed commands only:** all mutations (insert, move, reorder branch/field, join-mode edit, inspector
  commit) are defined as typed graph commands through the existing topology edit path — §3.4, §4, §7, §15.
  No direct render-model-to-payload writes. Consistent with I1.
- **Backend final:** live validation (§11) and pre-mutation slot predicates (§3.4) are advisory; publish
  still passes `normalizeApprovalGraph` and the as-built pre-flight checklist gates publish — §1.2, §11.
  Consistent with I2.
- **No internals:** no JSON/keys/IDs anywhere; branch identity surfaced as names/priority numbers, not
  edge keys — §1.4, §3.3, §4.1, §10.2. Consistent with I3/H1/H2.
- **No persisted coordinates:** layout derived, V-10 asserts via network capture; the v1 sidecar is
  explicitly superseded — §1.3, §16.4 F-4, V-10. Consistent with I4.
- **Semantic drag only, reject pre-mutation:** §3.4, §16.2; no partial-mutation cleanup exists because
  mutation happens only after predicate success. Consistent with I5/C5.
- **Version isolation:** restore creates a new draft; running instances pinned; stale-base fails closed —
  §8.3. Consistent with I6/V1–V4.
- **No semantic invention:** condition priority = array order (F-1); join all/any = shipped `joinMode`;
  threshold handled as a type-parity gap, not a new feature (F-2); inert field permissions not claimed as
  enforced (F-3); branch ≥2, every branch non-empty, no nested parallel, default-branch protections
  inherited — §4. Consistent
  with the shipped model and G3.
- **No unauthorized capability:** no new node types, sources, or enforcement paths anywhere — §1.2, §17.
  Consistent with plan §2/O6.
- **Dormant rollout:** flag-off path untouched; this lock enables nothing — §2, §17, §18. Consistent
  with I8.

One acknowledged forward dependency, not a contradiction: D2-b has delivered the move/reorder command
algebra with inverses on the integration candidate (§21); D3 must still satisfy the §4.2 library gates including deterministic
layout without persisted positions. If either fails its gate, the affected interaction (semantic move,
drag) degrades to insertion-menu + context-menu actions — which this lock already requires to exist —
rather than to free positioning.

## 21. Implementation checkpoint (non-ratifying)

The integration candidate implements only the pre-visual foundation: ordinary-user raw-ID hygiene,
immutable topology commands, stable form-field ID allocation/sequencing, and the frontend/backend
non-empty-parallel-branch guard. The form command slice does **not** yet provide field update/removal,
inverse history, or mounted undo/redo. D3 renderer, D4 inspector, D5 semantic drag, D6-f2 mounted form
builder, version visuals, responsive/a11y proof, and flag enablement remain unimplemented and blocked by
G0. This checkpoint records evidence; it does not change this document's `PROPOSED` status.
