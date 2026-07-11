# 多维表项目 · 设计 + 验证状态台账（项目级）— 2026-07-08

> 状态：**as-built 对账 / 设计 + 验证状态记录**。docs-only。
> 用途：以**项目级**记录多维表窗口的三态——**已交付并验证** · **已建成但按治理门禁保持关闭** · **已设计待 ratify**——并固化本项目的验证纪律与"完成"口径。
> 口径纪律：本文只陈述 **MetaSheet 自身的能力与原则**，不作任何外部产品对标。
> 接地：origin/main @ 2026-07-08；引用的 PR# 均已 MERGED（除明确标注 PROPOSED/OPEN 者）；文件路径相对 `metasheet2/` 仓库根。前置：UI-P2-1c 迁移大扫除的逐组件对账见 `multitable-ui-p2-1c-completion-verification-20260707.md`（本文是其项目级上位台账）。

---

## 1. 已交付并验证（Shipped + verified）

每一面记录**交付了什么**与**如何验证**（golden / mount 交互测试 / 真实-DB 集成 / 独立对抗审阅门 / mutation 红证明）。

| 能力面 | 已交付 | 验证方法与证据 |
|---|---|---|
| **9 种视图** | grid/kanban/gallery/gantt/timeline/hierarchy/calendar/form/dashboard | 组件落于 `apps/web/src/multitable/components/Meta{Grid,Kanban,Gallery,Gantt,Timeline,Hierarchy,Calendar,Form,Dashboard}*.vue`；dashboard 过真实-DB oracle（`tests/integration/multitable-dashboard-level-filter-realdb.test.ts`、`multitable-dashboard-filterinfo-oracle.test.ts`）。⚠ 本台账"shipped"依据 = 组件文件 + 对应 PR 已落，非逐一驱动渲染核实。 |
| **公式 / lookup / rollup 字段** | formula-over-lookup 弧闭合；写路径重算落在 REST spine（`record-write-service.ts` Step 4c：物化回写 + 响应/实时补丁刷新），restore 亦经 canonical spine 触发重算 | 弧闭合 `#2450 / #2464 / #2465`；typed-query 真实-DB `tests/integration/multitable-typed-query-numeric-view.test.ts` |
| **D3 权限矩阵** | row × field × base 维度的注解富、enforcement-thin 权限层（4 个真实 deny-gate）；从不触碰 central rbac/auth（K3 锁） | `#1820 / #1822 / #1827 / #1831`；真实-DB 字段掩码 golden `tests/integration/multitable-person-summary-field-mask.test.ts`、审计授权 `multitable-history-audit-grant-realdb.test.ts` |
| **全局历史线** | 记录级修订、批次分组、还原预览、inline-diff、config 历史（读侧）；HistoryCenter 只读呈现 | 剩余 code-gate 闭合 `#3749`；goldens + harness + inline-diff；LOCK-12 一批一 batch_id 真实-DB `tests/integration/multitable-lock12-partialsuccess-shared-batch-realdb.test.ts`（`#3745`） |
| **条件 / 色阶格式** | 条件规则 builder + 色阶格式 dialog | `ConditionalFormattingDialog.vue` / `ScaleFormattingDialog.vue` / `MetaConditionalRuleBuilder.vue`；条件格式设计锁 `conditional-format-scale-designlock-20260615.md` |
| **模板 / 评论 / 导入** | 模板安装（dry-run）、评论 + 表情反应 + @提及 + 收件箱、xlsx/CSV 导入 | 模板 dry-run 单测 `tests/unit/multitable-template-dryrun-routes.test.ts`；导入集成 `tests/integration/multitable-xlsx-routes.test.ts`；评论真实-DB per-sheet 读隔离 `#3732`（G-8 A′） |
| **共享 UI 原语（P2-1a/1b）** | `ui/{MtButton,MtIconButton,MtBadge,MtMenu,MtMenuItem,MtPanel,MtPopover}.vue`，全部只消费 UF-1 `--ms-*` token，Teleport-safe | 结构设计锁 RATIFIED `#3742`；原语落地 `#3744`（1a）/`#3761`（1b）；原语单测 `apps/web/tests/multitable-ui-p2-1-primitives.spec.ts` |
| **UI-P2-1c 迁移大扫除** | 把散落的 bespoke `<button>`/dropdown 精选收敛到共享原语（MtButton/MtPopover/MtMenu）；24 个 `*-migration.spec.ts` 在 main；curated（非机械 swap），未迁项均有可辩护的 defer 理由 | 每刀：`git diff` 证 emit()/@click/:disabled **字节等价** + runnable mount 交互测试（点击→同 emit/payload）+ 无新 hex + `vue-tsc` 干净；**每 PR 过独立 `adversarial-reviewer` 门 + mutation 红证明**（剪 @click → 断言必红）。落于 `#3773/#3777/#3780/#3781/#3783`（MetaToolbar 6 刀）+ `#3823…#3861`（MtButton 组件刀）；对账 MD `multitable-ui-p2-1c-completion-verification-20260707.md`（`#3864`, OPEN） |
| **性能基线 / grouped 窗口化** | flat 路径性能基线固化；grouped 视图行窗口化（offset-table） | 基线 `#3582`；GW 设计锁 `#3591` + runtime `#3648`（MERGED），含 jsdom golden + 真浏览器前后数字 |
| **AI 字段 S1/S2 治理 runtime** | 写入血缘 + 一批一 batch_id 分组（S1）；prompt-config 历史呈现（S2） | S1 runtime `#3584` + 真实-DB `tests/integration/multitable-ai-write-provenance-batch-grouping-realdb.test.ts`；S2 runtime `#3643`；路由单测 `tests/unit/multitable-ai-routes.test.ts` 等（见 §2） |
| **i18n strict-zero** | 全窗口字符串走 typed label 模块 | 弧 CLOSED；尾项 ResetToPointPicker `#3867` |

---

## 2. 已建成但按治理门禁保持关闭（Built, gated by design）

**AI 字段 runtime 已完整建成，但整条处于 DARK（不发任何 live 请求）——这是一个刻意的治理姿态，不是缺口。**

- **规模**：`packages/core-backend/src/routes/multitable-ai.ts`（1733 行）+ `multitable-button.ts`（705 行）。covered by `tests/unit/multitable-ai-routes.test.ts`、`multitable-ai-suggest-formula-routes.test.ts`、`multitable-ai-shortcut-routes.test.ts`、`multitable-button-routes.test.ts`。
- **fail-closed live 闸**：live provider 调用被 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（E-12）进程级 double-confirm 门锁死（`packages/core-backend/src/services/ai-provider-client.ts:190-195`：`confirm !== '1'` → 直接返回 `ok:false`，不发请求）。readiness 解析器（`ai-provider-readiness.ts`）**从不消费 E-12**——env 设与不设，报告字节一致；即"契约就绪"永不等于"授权花钱"。
- **provider 白名单**：仅 anthropic / openai（P-1 ratified）；其它一律阻断、不 fallback。
- **成本真相**：reserve-then-settle usage ledger（先预留、后按 provider 实际用量结算）；cap 触顶 = fail-closed（预留超 cap → 拒绝，不透支）。
- **写入隔离**：AI 输出恒走「不可信写入源」路径（不绕过字段掩码/权限/校验）——设计锁 `multitable-ai-output-untrusted-write-source-designlock-20260705.md`。
- **人工闸**：bulk-fill 走 preview → review → commit，批量写入前人工复核。

**治理姿态结论**：AI 的审计/血缘/成本/隔离底座**已造齐并已测**；唯一未做的是"点亮"（发 live、花真钱、不可逆外呼），而这被有意保留为 owner 逐档显式拍板的动作，默认安全 = DARK。

---

## 3. 已设计待 ratify（Forward pipeline — PROPOSED design-locks）

以下均为 **PROPOSED**（等 owner ratify），构成本项目的前向管线。每行：**规定什么 → ratify 后解锁什么**。

| 锁 / PR | 规定什么 | ratify 后解锁 |
|---|---|---|
| **#3796** AI DARK→GA 点亮阶梯 | L0→L1canary→L2limited→L3GA 逐档放量 + 硬闸门（kill-switch 即时性 / cap fail-closed / 账本=成本真相 / DARK 默认） | AI 从 DARK 转真实价值的**前提**；ratify + 提供 canary-env/cap 后才可开 L1 |
| **#3816** AI L0.5 租户级 live 闸 | per-tenant live allowlist + tenant 级配额主体（现 runtime E-12 为进程级、cap 为 per-caller） | "只给某租户点亮"的能力；**仅当需要 per-tenant 点亮时才需**，L1 canary 不依赖 |
| **#3681** S3 staleness 血缘 | AI 输出源变即"flag 陈旧"、**从不自动重算**（不静默花钱）；read-time 派生 | AI 输出可信度显示；一个窄迁移（gated 子决策） |
| **#3673** S4 cost 露出 | pre-run 成本估算 UI + per-field 成本维度（per-run 成本拆到 gated S4b，因账本暂无 run key） | 成本可见性；ratify 后 Sonnet runtime |
| **#3808** S5 normalize-kind | 按 kind 规整 AI 输出 + classify→select rider | 输出规整/落域；ratify 后 Sonnet runtime |
| **#3814** S1b 真批次回滚 | 在 S1 一批一 batch_id 地基上扩 restore 面（撤销整批 bulk 写）+ per-record 前置版本定位 | 批次级 undo；写操作 → 需 Opus 审 |
| **#3817** UI-P2-2 左侧导航栏 | 表→视图 持久树替代水平标签模型（结构性，非 presentation-only） | 工作台信息架构升级；ratify + **Opus 对抗审阅前置** |
| **#3818** W3-6 仪表盘非图表 widgets | browser-gate 语义解锁分析 + 判定（metric/progress/list 等） | 仪表盘 widget 补齐；ratify 后 Sonnet runtime |
| **#3866** UI-P2-1c tail 收尾 | 5 档视觉/结构裁决（close-× glyph / soft 变体 / link 样式 / behind-flow harness / shared-class manager） | 迁移大扫除的收尾一致性 |
| **#3805** 完成总规划 | 剩余开发的排序 + 自动化红线（不自 ratify / 不翻生产 AI env / 不碰 central rbac / 仅 presentation-only 自合） | 项目收尾的执行锚与红线口径 |

> 邻接开发窗口（历史/恢复 · 审批自动化 · 数据库对接 · 考勤各有独立窗口）不在本台账辖域；其锁与门禁各自记录。

---

## 4. 验证纪律（本项目的门禁方法）

1. **presentation-only 自合 bar**（迁移刀）：emit() 集合逐字节守恒 + runnable mount 交互测试（点击→同 emit/payload）+ 测试卫生（mounts 数组 + afterEach 全卸载 + teleport 残留守卫、teleport 面板用 `document.querySelector`）+ 无新硬编码 hex（只 `var(--ms-*)`）+ `vue-tsc` 干净 + 既有同组件 spec 回归绿。
2. **独立对抗审阅门**：behavior/runtime 变更与每个迁移刀均过独立 `adversarial-reviewer`（author ≠ reviewer），refute-first 逐门对照 design-lock。
3. **mutation 红证明**：关键守卫（如 @click 载荷、deny-gate）须能通过"剪掉该逻辑 → 断言变红 → 复原"证明测试非空转。
4. **真实-DB 集成**：涉序列化/权限/账本的路径用 `describeIfDatabase` 真实-DB golden（fixture ID 文件命名空间化，afterAll 清子行，避免共享-DB PK 碰撞）。
5. **required-checks-only 落地**：仅 required check（contracts×3 / pr-validate / test-20.x）绿即落；非 required 的 coverage/e2e flaky 不作 bail 依据。
6. **strict-off-with-restore**：落地用"一瞬 strict-off squash + trap 立即恢复 strict"，全程保护分支保护。
7. **双 MD 交付**：每项 = design MD（ratify 前）+ verification MD（runtime 落地后，含 golden 结果与非空转证明）。

---

## 5. 完成姿态（Completion posture）

- **核心已完整并验证**：9 视图 + 公式/lookup/rollup + 权限矩阵 + 全局历史 + 条件/色阶格式 + 模板/评论/导入 + 共享 UI 原语 + 迁移大扫除，均已交付且以 §4 纪律验证。
- **AI 底座已建成、按治理保持关闭**：runtime + 血缘 + 成本账本 + 隔离全就绪，DARK 是**刻意的 fail-closed 默认**，点亮保留为 owner 逐档显式动作。
- **扩展项按设计 ratify-gated**：§3 的 PROPOSED 锁不是"未完成的缺口"，而是**治理边界**——每一项都要 owner 拍板产品方向/授权花钱/授权结构性改动后才执行。
- **一句话**：多维表核心 = **已完成且已验证**；其余 = **已推到"owner 一键可拍"的 ratify 队列 + 一条默认安全关闭的 AI 点亮阶梯**。项目的"未完"是**治理性的、不是能力性的**。
