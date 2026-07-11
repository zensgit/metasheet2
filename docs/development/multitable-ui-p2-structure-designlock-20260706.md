# 多维表 UI 升级 P2 — 结构与共享原语 · 设计锁（RATIFIED）

> 状态：**RATIFIED 2026-07-07**（owner ratified via #3742; P2-1a primitives landed via #3744）。本锁只定原则与分档边界，不含实现。
> 前置：UF-1 设计令牌（`apps/web/src/styles/tokens.css`，RATIFIED #3697）+ 多维表 UI P0/P1/P1b 已落 main（tokens/减负/全图标 SVG）。
> 模型分档：设计裁量 = Fable 5；实现切片 = Sonnet 5；共享原语大重构的对抗审阅 = Opus。

## 1. 原则（为什么要 P2）

P0–P1b 把**表层观感**拉齐了（令牌化、外壳减负、图标统一）。但页面的**结构质感**仍落后于一线多维表产品，根因是两条：

1. **导航是"标签条"而非"持久信息架构"**：当前 base 下的表与视图挤在一条水平 tab 条里（`MetaViewTabBar`），表多、视图多时无处安放，也无法一眼看清"这个 base 有哪些表 / 这张表有哪些视图"。数据工作台的心智模型是**一棵持久可见的 表→视图 树**，不是一排会溢出的标签。
2. **每个组件各自重造按钮/面板/徽章**：64 个多维表 SFC 各写各的 scoped CSS 重新实现 button/dropdown/badge/panel（仓库里 `src/components/` 只有 1 个共享组件）。这让令牌化收益无法复利——改一次交互样式要改 N 处，且细节必然漂移。

**P2 的两根支柱**：(A) 一套**共享 UI 原语**收口重复；(B) 一个**左侧导航栏**替代标签条。二者都必须**只消费 UF-1 `--ms-*` 令牌**（§8 独立线纪律，不得新建令牌词汇）。

## 2. 分档与边界

### P2-1 — 共享 UI 原语（additive，先做，风险低-中）
建立 `apps/web/src/multitable/ui/` 下的一组无状态展示原语，全部消费 UF-1 令牌 + P1 的 `@element-plus/icons-vue` 图标：
- `MtButton`（primary/ghost/danger 变体 + 尺寸 + loading/disabled）
- `MtIconButton`（图标按钮 + tooltip 插槽）
- `MtMenu` / `MtMenuItem`（复用既有 `ContextMenu.vue` 或在其上封装）
- `MtBadge`（计数/状态点，复用 P1b 评论 badge 语义）
- `MtPopover` / `MtPanel`（下拉/浮层容器，Teleport-safe，统一投影 `--ms-shadow-*`）

**边界**：纯展示原语，**不含业务逻辑、不含数据获取**；不改任何现有组件的行为。落地方式=**先建原语 + 建立用法样例**，再**逐组件迁移**（每次迁移一个 SFC 的 button/panel 到原语，presentation-only，行为不变，`@click`/emit 计数守恒）。迁移是多个独立 Sonnet 切片。

### P2-2 — 左侧导航栏（structural,后做,风险中-高,需对抗审阅）
将"base → 表 → 视图"重构为一个**持久左侧栏**（可折叠），替代 `MetaViewTabBar` 的水平标签模型：
- 顶部 base 名 + 切换；其下表列表；当前表展开显示其视图（Grid/表单/看板/…，用 P1b 的视图图标）；"+ 新建表 / + 新建视图"就位。
- 主区让给数据网格（配合 P0 的圆角卡片容器）。
- **响应式**：窄屏折叠为抽屉/图标条。

**边界与风险**：这是**布局重构不是 presentation-only**。必须：(a) 完整枚举 `MetaViewTabBar` 的现有 props/emits/consumers，行为等价迁移（视图切换、personal-views slice-3 的 reset-to-shared 入口、i18n 标签）；(b) 不碰权限/数据路径；(c) Opus 对抗审阅：refute-first 检查有无丢失的 emit/交互、有无破坏既有 e2e。**P2-2 在 P2-1 落稳后才起**。

### 明确不做（各自独立立项，非本锁）
- 多标签页/多 base 并列工作区、拖拽重排表/视图的持久化、移动端新页型、暗色主题（UF §8 独立线）。

## 3. 门禁（TODO-checklist）

- 🔒 **P2-1a** 原语骨架（MtButton/MtIconButton/MtBadge）+ 用法样例 — 待本锁 ratify；Sonnet 5。
- 🔒 **P2-1b** MtMenu/MtPopover/MtPanel（Teleport-safe）+ 迁移 1 个样板 SFC 证明模式 — P2-1a 后；Sonnet 5。
- 🔒 **P2-1c…** 逐组件迁移批（每批 ≤3 个 SFC，presentation-only，计数守恒）— 滚动；Sonnet 5。
- 🔒 **P2-2** 左侧导航栏 — P2-1 落稳 + 本项单独 design-lock 细化（consumers 枚举）后；Fable 设计 → Sonnet 实现 → Opus 审阅。

## 4. 验证纪律（每切片双 MD）

- 原语切片：Storybook/样例页 + type-check + 计数守恒断言（迁移前后 `@click`/`<button>`/emit 不变）。
- 左侧栏切片：`MetaViewTabBar` consumer 行为等价的真交互测试（视图切换、reset-to-shared、i18n）+ 响应式折叠 + 无权限/数据路径改动的 diff 证明。
- 全程只消费 `--ms-*`；新硬编码 hex = 缺陷（UF §3.1）。

## 5. 一句话
表层已齐（P0–P1b）；P2 补**结构**——把重复的按钮/面板收口成一套令牌化原语，把溢出的标签条升级为持久的 表→视图 导航——页面从"令牌化的旧结构"变成"一线水位的信息架构"。additive 的 P2-1 先行、结构性的 P2-2 后随且单独细化+对抗审阅。
