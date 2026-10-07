# Comment-Affordance 系统治理 — 短设计锁 (PROPOSED)

> **性质**：owner OD-T5b 裁决的落地设计锁（docs-only，零 runtime）。T5 把 comment 从按钮迁移里**剥离**（`MetaRecordDrawer.vue` 的 comment 保持原样，未随 T5-safe 迁 `MtButton`），改为**单独治理整个 comment-affordance 系统**。owner 明令：**comment-active 用专用 token，不得拿 warning token 冒充**。ratify 后实施。
> **前情**：T5-safe（watch+workflow+permissions+dup/del/unlock → MtButton）**已在 main**；本锁只处理被剥离的 comment 面。[[project_ui_foundation_uf_arc]]（tokens.css `--ms-*` = 全站单一真源）。

## §0 缺口（primary-source）
- **无专用 comment-active token**：`git grep comment-active|--ms-comment` 于 apps/web = **零命中**。comment 的「有评论/激活」态目前**没有语义 token**，各处很可能借用 warning 或临时色——正是 owner OD-T5b 要禁的（warning≠comment）。
- **comment affordance 散落 ~14 处**（枚举，§2），已有一个**共享组件** `MetaCommentAffordance.vue` + `MetaCommentActionChip.vue`，但各视图是否都经它、是否同 token/同交互契约 **未被任何测试锁死** ⇒ 漂移风险。

## §1 设计
### 1.1 专用 comment-active 语义 token（OD-T5b 核心）
- 在 tokens.css `--ms-*` 体系新增**语义 token**：`--ms-comment-active`（+ 必要的 hover/muted 派生），**独立于 `--ms-warning`/`--ms-color-warning`**。暗色/亮色两态定义（[[project_ui_foundation_uf_arc]] §8 暗色是独立 gate）。
- **单一真源**：token 定义只在 tokens.css；组件**只引用**，不硬编码颜色。
### 1.2 单一 affordance 组件
- `MetaCommentAffordance.vue` 为**唯一** comment 按钮/角标渲染点；§2 枚举的视图**都经它**（或至少都用 `--ms-comment-active` + 同交互契约 `onOpenComments`/`hasComments`/count）。
- comment 计数/激活态：统一「有评论 ⇒ active 色（comment-active token）+ count 角标」。

## §2 组件枚举（consistency 测试对象 — owner「9 组件一致性测试」）
comment-affordance 出现处（primary-source grep）：
1. `MetaRecordDrawer.vue`（被 T5 剥离的那个）· 2. `MetaGridTable.vue` · 3. `MetaKanbanView.vue` · 4. `MetaGalleryView.vue` · 5. `MetaCalendarView.vue` · 6. `MetaHierarchyView.vue` · 7. `MetaTimelineView.vue` · 8. `MetaFormView.vue` · 9. `MetaCommentActionChip.vue`
（+ 共享 `MetaCommentAffordance.vue` 本体；`MetaCommentComposer/Reactions/Drawer` 是 comment 内容面非 affordance 入口，附带核对但不在「入口一致性」主集。）**实现阶段以 grep 复核最终清单，不硬编个数。**

## §3 一致性测试（实现阶段，对齐 UF arc 的 guard 风格）
- **token 一致性**：枚举 §2 的 affordance 入口，断言 active 态都解析到 **`--ms-comment-active`**，**无一** resolve 到 warning token（突变：把某组件改回 warning → 测红）。
- **交互契约一致性**：都用同一 `onOpenComments`/`hasComments`/count props 契约（无自造）。
- **单一真源 grep 断言**（UF arc 风格）：仓库内 comment-active 颜色**只**来自 `--ms-comment-active`；硬编码 comment 色 = 红。
- 暗色两态 DOM 快照（token 在暗色下正确）。

## §4 边界 / OD
- 零 runtime；不改 T5-safe（已 main）；不实现，待 owner ratify。
- **OD-CA1**：token 名 = `--ms-comment-active`？（或 owner 偏好命名）
- **OD-CA2**：所有视图**强制**经 `MetaCommentAffordance.vue`（重构收敛），还是**只强制同 token + 同契约**（更轻，不动结构）？建议后者（轻，先锁 token 一致性，收敛为后续）。
- **OD-CA3**：comment 内容面（Composer/Reactions/Drawer）是否纳入本锁的一致性主集，还是只核对入口？建议只入口。

**收官口径**：design-only；专用 comment-active token + 9(±)组件一致性测试待 owner ratify OD-CA1..3 后实施。**T5-safe 已落 main，本锁是 OD-T5b 剥离出的独立治理。**
