# 多维表开发项目 · 收尾总规划与排序（全自动执行锚）— 2026-07-07

> owner 指令（AFK，全自动）：规划排序 + 并行 + 完成本项目所有开发 + 交设计/验证 MD + 按难度自动选模型。
> 本文是**执行锚 + 自动化红线**：既定"我会自动做完什么"，也明确"我绝不无人值守替你做什么"。
> 状态标记：✅ 已落 · ⬜ 自动可做 · 📝 起草即就绪（等 ratify）· 🔒 卡 owner 输入/决策（我不替你做）。

## 0. 自动化红线（保护 owner，任何一条不破）

1. **不自 ratify 你的设计锁**——ratify = 替你拍板产品方向。#3796 / #3681 / #3673 + 本轮新起草的锁，全部停在 PROPOSED 等你。
2. **不翻生产 AI env / 不发 live 请求**——AI 点亮 L1 需要你给 canary 环境 + cap 数值，且花你的钱 + 不可逆。永远等你显式输入。
3. **不动权限/安全语义、不碰 central rbac/auth**（K3 锁）。
4. **可自动落地（self-merge）的只有**：presentation-only 迁移（emit 集合逐字节守恒 + 交互/卫生测试全绿 + CI 5/5 + 我对抗 gatekeeper 过）、docs。behavior/runtime 变更 → 开 PR + 交验证 MD，**不自合**、等你审。
5. **分支保护**：落地用"一瞬 strict-off squash + 立即恢复"，全程 trap 保恢复。
6. 不确定是否授权 → 当未授权，记下、停、报你。

## 1. 已落（本会话成果闭环）

W1-3 runtime(决A) · G-8 A′ 安全 · LOCK-12 批次 · W3-5a/b batchId · UI-P0/P1/P1b · **UI-P2 锁 + P2-1a 原语 + P2-1b overlays + P2-1c MetaToolbar 全 6 刀迁移闭环**。

## 2. Lane A —— UI-P2-1c 迁移大扫除（⬜ 自动可做，presentation-only，self-merge）

**面**：57 个多维表组件仍有 bespoke 按钮 / 硬编码 hex；目标=统一到共享原语（MtButton/MtIconButton/MtMenu/MtPopover/MtBadge），消 64-SFC 各写各的重复。
**标准（每刀，owner 已 PASS 6 次的 bar）**：emit() 集合逐字节守恒 · runnable 交互测试(点击→同一 emit) · 测试卫生(mounts 数组 + afterEach 全卸载 + .meta-toolbar/.mt-popover 残留守卫) · 原生按钮键盘可操作 · 复杂 builder 只包壳 MtPopover 保留内容 · token-only · 既有 spec 若 root 查 teleport 面板改 document(断言不弱化)。
**排序（按可见度/价值）**：
- ⬜ A1 **feature-row**（MultitableWorkbench 13 管理按钮，最可见）→ MtButton；变体 `--attention`/`--active` 保留为附加 class，`data-action`/徽章/@click/v-if 全保。
- ⬜ A2 **高频 manager/dialog**：MetaApiTokenManager · MetaAutomationManager · MetaBulkEditDialog · ConditionalFormattingDialog · MetaCommentsDrawer/Composer/Reactions · HistoryCenterModal · MetaConfigHistoryModal（每批 ≤3 SFC，一批一 PR）。
- ⬜ A3 **视图/其余**：MetaCalendarView · MetaDashboardView · MetaBasePicker · MetaAttachmentList · MetaAutomation* 家族 · 其余长尾（低可见，最后批量）。
- 🔒 **不在本 lane**：MetaViewTabBar 标签（tab 非 button，属 P2-2 左侧栏结构刀）· 字段类型字形（Aa/#/fx 语义,不迁）。
**模型**：机械迁移 = Sonnet（额度可用时）/ 主循环 Fable（额度受限时）;每刀我对抗 gatekeeper。

## 3. Lane B —— 补齐剩余设计锁（📝 起草即就绪，PROPOSED 等 ratify）

把整个项目"缺锁"的口都补上，填满你的 ratify 队列（这也是"设计 MD"交付）：
- 📝 已起草待 ratify：**#3796 AI 点亮阶梯** · **#3681 S3 staleness 血缘** · **#3673 S4 cost 露出**。
- ⬜→📝 本轮新起草：
  - **S5 normalize-kind**（AI 输出规整 + classify→select rider）设计锁。
  - **UI-P2-2 左侧导航栏**细化设计锁（consumer 枚举 + 迁移策略,§P2-2 结构性,Opus 审前置）。
  - **W3-6 仪表盘非图表 widgets**——先做 browser-gated 语义解锁分析，够解锁就转设计锁。
  - **AI-L0.5 tenant-scoped live gate**（仅当你要 per-tenant 点亮的 runtime 前置，见 #3796 §3）——设计锁。
  - **S1b 真批次回滚**（restore 面 batchId 入口 + per-record 前置版本定位）设计锁。
**模型**：设计 = Fable（我）。

## 4. Lane C —— 卡 owner，我不替你做（🔒 列示 + 就绪，等你一句话）

| 项 | 卡在 | 你给了就自动做 |
|---|---|---|
| ratify #3796 / #3681 / #3673 + Lane B 新锁 | 你拍板 | 落地 docs + 起对应 runtime |
| **AI 点亮 L1** | canary 环境 + cap 数值（只有你能给） | 隔离环境开 E-12 + telemetry + 四项验证 + kill-switch 演练 + 验证 MD |
| S3 / S4 / S5 / S1b **runtime** | 对应锁 ratify | Sonnet 实现 + 验证 MD |
| GW grouped 无限滚动 + 跨页分组数据模型 | 需求门（#3591 §6 独立 slice） | 设计 → 实现 |
| 明确不做（各自独立立项） | — | 移动端 / 模板市场 / 离线 / delete_record UI / Yjs GA |

## 5. 执行序与并发

清 W0 无 → **Lane A 迁移作为主吞吐**（额度可用时 Sonnet 并行批,受限时主循环串行）+ **Lane B 锁并行起草**（Fable，docs 无碰撞）→ 每刀双 MD 入你的审阅/ratify 队列 → Lane C 待你解锁即接。并发上限守 ≤2 build + 1 起草。落地=每 PR 绿后一瞬 strict-off，串行不并叠迁移。

## 6. 诚实的"完成"定义

我能**自动完成**的 = Lane A 迁移全扫 + Lane B 全锁起草就绪。**卡你的** = Lane C（ratify + AI 点亮输入 + runtime-behind-lock）——这些不是"写代码"能完成的，是你手里的决策/输入。所以"完成所有开发"落到：**代码侧全推平 + 决策侧全推到你一键可拍**。你回来把 ratify 队列一清、给 AI canary+cap，剩下的 runtime 我照 Lane C 自动接完。
