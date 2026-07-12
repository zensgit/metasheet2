# 多维表 UI-P2-1c · 尾巴解决 · 设计锁（RATIFIED）

> 状态：**RATIFIED（owner directive 2026-07-11）**。docs-only。
> **RATIFIED — owner directive 2026-07-11**（批 12 把 merge-tree-clean 锁）。header 状态由 owner 决定翻转、Claude 机械执行(非自我批准)。锁内 per-tier owner 子决定(如变体/env-cap/storage opt-in)仍各自留待 owner。
> 前置：P2-1c 干净 MtButton sweep **已完成 16 个**（见 `multitable-ui-p2-1c-completion-verification-20260707.md` / PR #3864）。
> 本锁定形本轮**被 defer 的尾巴**如何收——每一档给出**推荐 + 需 owner 拍板的裁决**，ratify 后即可按既有"主循环迁→adversarial-reviewer gate(mutation红)→串行落"机制执行（impl=Sonnet；结构性=Opus 审）。
> 模型分档：设计=Fable/Opus；实现=Sonnet。**不自 ratify、不碰行为/权限**（同 red line）。

## 1. 原则
干净 sweep 只迁了"通用 action-button/footer 且变体无视觉变"的。尾巴不是"不能迁"，而是**各需一个前置决定**（新原语 / 变体裁决 / 测试 harness）。本锁把这些前置一次定清，避免逐个再纠结。

## 2. 尾巴档 + 推荐（每档一个 owner 决定）

### T1 — close-× 字形按钮 → **MtIconButton**（原语已存在）
现状：大量组件的 header close-×（`&times;` + aria-label，@click emit('close')/dismiss）留 bespoke。`MtIconButton` **已在** `ui/` barrel——可迁。
- **需 owner 定**：× 字形保留为文本，还是用 el-icon `Close`？（影响像素/对齐）
- **推荐**：MtIconButton 内部渲染 `&times;` slot（保字形，零视觉变），仅收敛 padding/hover/焦点环到 token。
- 范围（ratify 后各自 slice）：MetaLinkedRecordPopover · MetaMentionPopover · MetaBulkEditDialog · MetaExportDialog · MetaPersonPicker · MetaLinkPicker · CF/Scale/ConfigHistory/RestorePreview/RestoreBatch dialog · MetaCommentsDrawer · 各 manager header。每个：emit('close')/dismiss 字节等价 + mount 测 + 无新 hex。

### T2 — soft-tinted create 按钮 → **变体裁决**
现状：MetaGalleryView/Kanban/Timeline 的 create 按钮是 `#ecf5ff` 浅蓝底 + `#2563eb` 蓝字（软色）。MtButton 无对应变体。
- **需 owner 三选一**：
  - **(A) 给 MtButton 加 `plain`/`tinted` 变体**（浅色底+主色字，= --ms-color-primary 的低强度版）→ 零视觉变，最忠实。**← 推荐**（可复用于其他软色场景）。
  - (B) 映射到现有 `ghost`（无底）→ 接受"去底"视觉变（sanctioned，但 create 是主动作，去底偏弱）。
  - (C) 映射到 `primary`（实填）→ create 变醒目（与 Hierarchy/Gantt 的实填 create 一致，但比原软色强）。
- ratify(A) 后：MtButton 加 `variant="plain"`（Opus 审，因是原语扩展）→ 再迁 Gallery/Kanban/Timeline create（+ empty-action/placeholder-action）。

### T3 — link-styled 按钮 → **新原语 MtLink**（或归入 T2 plain）
现状：MetaNotificationBell `__mark-all`（无边框蓝字）、MetaExportDialog/FilterGroup 的 select-all/clear/add 内联链接、MetaViewManager `__btn-inline`(filter/sort add) 是**文字链接样**〔**⚠ MetaViewManager 这一处事实有误——见下方勘误**〕。MtButton 任何变体都会加 padding/边框 → link→button 突变。
- **需 owner 定**：加 `MtLink` 原语（原生 `<button>` 但零 padding/边框、主色字、hover 下划线，token 化），还是接受映射到 T2 的 `plain`？
- **推荐**：**加 MtLink**（link 与 button 是不同强度语义，混用会乱）。additive 新原语，走 P2-1a 同法（结构锁 + Opus 审）。
- 范围：mark-all-read · select-all/clear-all · addFilter/addSort inline · MetaFilterGroup add-condition/add-group。

> **勘误（2026-07-12，owner 裁定）**：本档原把 MetaViewManager 的 `__btn-inline`（+Add filter/+Add sort）列为「文字链接样」——**事实有误**。核实其原 CSS 为 `padding:4px 10px; border:1px dashed #cbd5e1; background:#fff; color:#475569`（灰色虚线框 action），非文字链接。#4131 据此把这两个按钮迁成 MtLink 后，同一个 `__btn-inline` class 的另 2 个 sharer（reloadLatestConfig / dismissLiveRefreshNotice）仍是虚线框原样 → 同 class 两种外观，语义不干净。**owner 裁定改用 `MtButton variant="plain"`**（T2 的 plain 变体，#4156 已落 main），见 fix-forward PR。T3 本档其余三处——MetaExportDialog select-all/clear · MetaFilterGroup add-condition/add-group · MetaNotificationBell mark-all——**核实确为文字链接样，MtLink 迁移判断正确、维持不变**。本勘误只订正 MetaViewManager 这一处的事实前提，不改本锁的 RATIFIED 状态，也不重开 MtLink 原语本身的裁决。

### T4 — behind-flow managers → **共享 mock-client 测试 harness**
现状：TrashModal · MetaConfigHistoryModal · MetaRecordPermissionManager · MetaFormShareManager · MetaCommentsDrawer · MetaSheetPermissionManager · MetaImportModal · MetaAiBulkFillDialog 的通用 action 按钮藏在 API 驱动/多步流程后，mount 测需 mock 管线——故 defer。
- **需 owner 定**：同意建一个**共享测试 harness**（`tests/helpers/mount-behind-flow.ts`：注入 mock client + 驱动到目标 phase）？
- **推荐**：建 harness（一次性投入，解锁一整档）。ratify 后每个 manager：用 harness 挂到目标态 → 迁其通用 action 按钮（shared-class 的全迁，见 T5）+ mutation 测。
- ⚠ 严格：这些是权限/删除/AI 相邻组件——迁移**仅动按钮元素+CSS**，绝不碰权限/删除/AI 逻辑（red line）。close-× 走 T1。

### T5 — shared-class managers → **全 sharer 迁移**
现状：MetaApiTokenManager `meta-api-mgr__btn`×22、MetaRecordDrawer `meta-record-drawer__btn`×8——单一 base 类跨多按钮（含 stateful toggle：watch--watching / comment / unlock）。部分迁保留类=双重样式。
- **需 owner 定**：同意"全 sharer 一次迁"？其中 **stateful toggle**（有 active 态类）映射到 MtButton 的哪个变体 + 如何保 active 态？**emoji-prefixed** 标签按钮是否也迁？
- **推荐**：分两步——(a) 纯文本 action（save/cancel/duplicate/delete/new-token）→ MtButton；(b) glyph/toggle → MtIconButton（保 active 态用 class + aria-pressed）。两步同 PR 删 base 类 CSS。因涉 stateful 语义，**Opus 审前置**。

## 3. 门禁（TODO-checklist，分档，全部待本锁 ratify）
- 🔒 **T1** close-×→MtIconButton（× slot 保字形）— Sonnet，逐组件 slice。
- 🔒 **T2** MtButton `plain` 变体（Opus 审）→ soft-tinted create 迁移 — 待 owner 选 A/B/C。
- 🔒 **T3** MtLink 原语（结构锁 + Opus 审）→ link-styled 迁移 — 待 owner 定 MtLink vs plain。
- 🔒 **T4** behind-flow 测试 harness → 8 manager 通用按钮迁移 — 待 owner 同意 harness。
- 🔒 **T5** shared-class manager 全 sharer 迁移（Opus 审，stateful 语义）— 待 owner 定 toggle/emoji 处理。
- 🔒 **不做（各自立项）**：MetaFormView Submit（`type=submit` 与 MtButton `type=button` 不字节等价——需 @click 改写，非 presentation-only）· el-button（MetaAutomationManager/RuleEditor，Element 皮肤有意保留）· cell-editor 内部控件。

## 4. 验证纪律（承接 sweep）
每 slice：emit/@click 字节等价 + runnable mount 测（mutation 红）+ 无新 hex + 既有 spec 回归 + 独立 adversarial-reviewer gate + required-checks-only 串行落。新原语(T2 变体/T3 MtLink)= Opus 对抗审前置 + 自己的 mount 测。

## 5. 一句话
干净 sweep 完成后，尾巴分 5 档（close-×→MtIconButton · soft-tinted→MtButton plain 变体 · link→MtLink 新原语 · behind-flow→共享 mock harness · shared-class manager→全 sharer 迁），每档只差**一个 owner 前置决定**；ratify 后即可按既有 gated 机制逐 slice 收尾，全程不碰行为/权限、不自 ratify。
