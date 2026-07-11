# 多维表 UI-P2-1c · MtButton 迁移 · 完成 + 验证 MD（2026-07-07）

> 状态：**验证记录 / 完成对账**。docs-only。P2-1c = 把 multitable SFC 里散落的 bespoke `<button>` 收敛到共享
> `MtButton` 原语（消费 UF-1 `--ms-*` token）。本文对账本轮 sweep 的**完成范围、精选判据、defer 尾巴（含理由）、验证方法**。
> 前置锁：`multitable-ui-p2-structure-designlock-20260706.md`（RATIFIED #3742）§2 P2-1；token 源 = `tokens.css`（#3696/#3697）。

## 1. 一句话
本轮把**所有可干净迁移**的 multitable 组件（16 个）收敛到 `MtButton`——每个都过独立 `adversarial-reviewer` gate（mutation 红证明 @click 载荷）+ 既有 spec 回归绿 + 串行落。**其余组件全部有明确、可辩护的 defer 理由**（bespoke-by-design / 变体歧义待 owner 定 / behind-flow 需管线 mock / shared-class 且兄弟 behind-flow）。这是"精选迁移"，非 57 个机械 swap。

## 2. 已落 16 个（全部 gated + mutation-verified）
| # | 组件 | PR | 迁移面 |
|---|---|---|---|
| 1 | MetaChartLoadError | #3823 | retry → MtButton |
| 2 | MetaBulkEditDialog | #3826 | cancel/apply(primary) |
| 3 | MetaCommentComposer | #3828 | submit(primary) |
| 4 | MetaExportDialog | #3832 | cancel/confirm(primary) footer |
| 5 | RestorePreviewDialog | #3833 | cancel/execute(primary) footer |
| 6 | RestoreBatchDialog | #3834 | cancel/confirm/done footer |
| 7 | MetaPersonPicker | #3835 | cancel/confirm footer |
| 8 | MetaLinkPicker | #3836 | cancel/confirm footer |
| 9 | ConditionalFormattingDialog | #3842 | **全 6 个 cf-dlg__btn**（shared-class 全迁） |
| 10 | MetaTemplateCard | #3844 | detail(ghost)/install(primary) |
| 11 | ScaleFormattingDialog | #3850 | **全 6 个 scf-dlg__btn**（shared-class 全迁） |
| 12 | ResetToPointPicker | #3852 | Refresh(ghost) |
| 13 | MetaHierarchyView | #3854 | Add-root(primary) |
| 14 | MetaGanttView | #3856 | Add-task(primary) |
| 15 | MetaConditionalRuleBuilder | #3859 | Add/Save(ghost) |
| 16 | MetaViewManager | #3861 | **全 2 个 __btn-add**(primary, shared-class 全迁) |

（另：早期 MetaToolbar 6 slice #3781/#3783 等已 MtPopover/MtMenu 迁移，不在本 MtButton 计数内。）

## 3. 精选判据（哪些迁、哪些留）
**干净目标 = 通用 action-button/footer，且变体映射无（或 sanctioned 微小）视觉变**：cancel/confirm/apply/submit/save/retry/add/create。bespoke 填充 #2563eb → `variant="primary"`（token 精确匹配）；neutral 边框白 → `ghost`（sanctioned 掉边，同 batch-1）；danger → `danger`。

**留 bespoke（勿强套 MtButton）**——各有理由：
- **chip / palette / glyph**（表情反应 chip、颜色 swatch、close-× 字形）——领域控件，非通用按钮。
- **el-button**（MetaAutomationManager/RuleEditor）——Element-Plus 皮肤有意保留，不在 native-`<button>`→MtButton 范围。
- **cell-editor 内部**（MetaCellEditor：rating star / link-person picker / ai-run）——字段类型分支控件。
- **context/inverse-styled**（MetaToast `__action`：彩色 toast 背景上的白字白框）——MtButton token 调色板在彩色面上会错。
- **link-styled**（MetaNotificationBell `__mark-all`：无边框蓝字；MetaExportDialog/FilterGroup 的 select-all/add 链接）——link→button 会加 padding/边框，视觉突变（需 MtLink 原语另议）。
- **soft-tinted**（MetaGalleryView/Kanban/Timeline 的 `#ecf5ff` 浅蓝底蓝字 create）——MtButton 无"软色"变体，primary(实填)/ghost(无底)皆是可见变化 + 主观选择 → **待 owner 定变体**。
- **shared-class 且多数兄弟 behind-flow**（MetaImportModal `meta-import__btn`×13、MetaAiBulkFillDialog `ai-bulk__btn`×11、MetaApiTokenManager `__btn`×22、MetaRecordDrawer `__btn`×8）——部分迁保留 shared 类会**双重样式**（Vue scoped 父样式落到 MtButton 根）；全迁又因多数兄弟 behind-flow（多步管线）不可干净 mount 测 → **defer**。
- **behind-flow**（TrashModal / MetaConfigHistoryModal / MetaRecordPermissionManager / MetaFormShareManager / MetaCommentsDrawer / MetaSheetPermissionManager；MetaFormView Submit=`type=submit` 与 MtButton 的 `type=button` 不字节等价）——action 藏在 API 驱动/多步流程后，mount 测需 mock 管线。

## 4. 关键工程发现（复用于未来 sweep）
- **shared-class 陷阱**：同一按钮类名跨"迁移+不迁"多按钮时，保留该类 → 其 bespoke CSS 经单根 class-fallthrough + Vue scoped 父样式落到 MtButton 根 = 双重样式。修法：**全迁该类所有 sharer 后删类 CSS**（CF #3842 / Scale #3850 / ViewManager #3861 即此），或若多数 sharer behind-flow 则 **整组件 defer**。
- **layout-only 保留**：迁移删 bespoke 视觉 CSS，但保留 MtButton 不提供的**布局属性**（MetaTemplateCard `flex:1 1 auto`、MetaGanttView `align-self:end`）。
- **shade 归一**：#409eff(Element 蓝) → --ms-color-primary(#2563eb) 是设计锁 §4 授权的 token 收敛（sanctioned NIT，非回归）。
- **GATE 必用独立 `adversarial-reviewer` agent（非主循环自审）**——author≠reviewer；每 PR mutation-test（剪 @click → click/emit 断言必红）证明 spec 非空。
- **workflow 迁移 agent 频繁 mid-stream stall**（多 pair ~100% 失败，与模型无关）→ 迁移改**主循环手工**（自身工具调用不 stall），gate agent 仍可靠。

## 5. 验证方法（每个 PR）
1. `git diff origin/main` 证 emit()/@click/:disabled **字节等价**（仅 `<button>`→`<MtButton>` tag 变）。
2. runnable mount 交互 spec：断言原生 `<button>` + 点击触发**同 emit/handler + 同 payload**；hygiene（mounts 数组 + afterEach 卸载 + residue 卫兵；teleport 用 `document.querySelector`）。
3. **无新 hex**（`git diff '^+' | grep '#hex'` 空，仅 `var(--ms-*)` + fallback）。
4. `vue-tsc` 干净；既有同组件 spec 回归绿（真正的行为锚）。
5. **独立 adversarial-reviewer gate**：refute-first + **mutation 红**（剪 @click → 断言红→复原）+ 复核 shared-class/双重样式/layout/shade。
6. 落：仅 5 个 **required** check 绿（contracts×3/pr-validate/test-20.x；coverage/e2e=非 required 且 flaky，勿因其红 bail）后，brief strict-off squash（trap 保证复原 strict）。

## 6. CI 覆盖（收尾）
16 个 `*-migration.spec.ts`（+6 toolbar）此前**不在任何 CI run-list**（web-guard 是显式清单，无 full-suite web job）→ 落时 spec 惰性。**PR #3853（OPEN，待 owner）** 加单个 `migration` 位置 token（只匹配这 18 个 UI spec，本地 18 文件/95 测试 ~2s 绿）+ paths glob，回溯性 gate 全部迁移 spec + 未来自动覆盖。

## 7. 尚待 owner（非本 sweep 可自动完成）
- ratify 9 个 PROPOSED design-lock（#3796/#3805/#3808/#3814/#3816/#3817/#3818/#3681/#3673）。
- AI L1 canary-env + cap 值（生产 AI env 未翻、无 live 调用——red line）。
- soft-tinted create 按钮的 MtButton 变体裁决（或 MtLink/soft 原语立项）。
- merge #3853（CI 覆盖，CI-config 故未自 merge）。

## 8. 红线对账（全程守住）
无 lock 自 ratify · 无生产 AI 翻转/live 调用 · 无碰权限/security/central rbac · 仅 presentation-only 迁移自 merge（且过独立 gate）· CI-config(#3853) 开 PR 不自 merge · strict-off burst 永远复原 strict · ≤2 并发 build agent + 串行落。
