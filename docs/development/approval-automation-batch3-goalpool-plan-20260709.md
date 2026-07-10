# 审批及流程自动化 · 余下开发（batch-3 目标池）· 规划与排序 — 2026-07-09

> 来源阶梯：`docs/research/approval-automation-operation-ux-benchmark-20260704.md` §4 batch-3（「需后端/独立 gate 的 14 项，每项独立 opt-in」）。
> 前序：batch-1/batch-2（28 项）、RP 路由预览线（RP-0..RP-3 = B3-04/05/06）、UF 前端地基线、一键执行 A-1..A-5 均已收官落地。
> 纪律：只陈述 MetaSheet 自身原则，不出现外部产品名。

## 0. 池子现状对账（ground truth，2026-07-09）

无门（batch-1/2）与 RP 线**全部落地**；本目标池 = batch-3 剩余 + 深层 T 项。batch-3 已落：**B3-04**（目录端点+真实选人器 #3664/#3672/#3804）、**B3-05**（RP-2 #3881）、**B3-06**（RP-3 #3923）。

**剔除（活跃并行线，勿碰）**：DingTalk 交互卡片 Slice-B / stream gate / A5 UAT（#3999/#3991 刚落，另有会话在推）——本线不重开钉钉卡片面。

## 1. 分级（gate 判定）

### A. 立即可建（本节奏并行，additive/只读为主，无新存储/安全面、无战略围栏）
- ✅门槛：扩展既有已发运底座、纯增量查询/读模型/前端；**不新增能力线**。

### B. 设计锁先行（PROPOSED，runtime 待 owner ratify 才建）
- 🔒新存储/安全面 或 须继承既有治理底座。

### C. owner 菜单（战略围栏，**不自动启动**，须点名 opt-in）
- 🔒深层可见性/签名强制/产品口径决策。

## 2. 车道（车道=文件独占，champion 串行落地）

| 车道 | 项 | 一句话 | 后端 | 前端 | 模型 | gate |
|---|---|---|---|---|---|---|
| **L1 收件箱完整性** | B3-01 + B3-02 + B3-03 | 「我已处理」第5 tab · 行级未读 · 模板/时间筛选+看板钻取 | 扩展 approvals list（actor 反查 processed / LEFT JOIN approval_reads 出 isRead / templateId+createdFrom-To 过滤） | ApprovalCenterView tab+筛选条 · ApprovalMetricsView 计数→router-link | Sonnet | ⬜ A |
| **L2 模板治理** | B3-08 + B3-09 | 模板停用/启用+用量 · 版本历史+发布说明 | template status published↔archived · versions 列表端点+publish note | TemplateCenter/Authoring/Detail | Sonnet | ⬜ A |
| **L3 自动化可观测** | B3-11（仅） | 监控行补 ruleName/sheetName（只读向后兼容） | A2 序列化器只读字段 | AutomationExecutionsView | Sonnet | ⬜ A |
| **L4 前端打磨组** | B3-13（精选） | 骨架/空态 CTA · 撤回策略感知（policy.allowRevoke 已在 DTO）· 按动作 loading · 打印/复制 | — | ApprovalDetailView + 新建共享空态组件（**避开 MetaAutomation*/ApprovalCenterView**） | Fable | ⬜ A |
| **L5 死代码清理** | B3-14 | 删 521 行未路由 ApprovalInboxView（先评估其乐观冲突 reconcile 是否值得移植） | — | 删除 + 路由核对 | Sonnet | ⬜ A |
| **LK 设计锁** | B3-07 · B3-10（含 B3-12） | 附件上传管线锁 · 自动化重试/样本试运行治理锁 | 只出 PROPOSED 设计锁，不建 runtime | — | Opus | 🔒 B |

> **B3-12 重分类（advisor 抓）**：`automation-service.ts:2951 testRun` **真执行规则**（会 fire 写/通知/webhook 等真实动作）——接受真实 recordId = 真副作用打真实数据。故 B3-12 从 A 档降为 **B 档 lock-first**，并入 B3-10 治理锁（同一 replay/幂等/confirmSideEffects 家族）。

## 3. owner 菜单（C 档，不自动启动）

- 🔒 **T36-3** 中间节点/抄送 的行级可见性（Plan B，T3-6 深层）
- 🔒 **T3-3-ENF** 签名强制（需 vote）
- 🔒 **T3-2** 日历-SLA org-mapping degenerate + double-signal（产品口径）
- 🔒 **T1-4b** 字段权限后续 · **T3-5-FU** 跨库回写后续

## 4. 节奏与排序

- **Wave 0（并行, Opus, doc-only）**：LK = B3-07 + B3-10 两份 PROPOSED 设计锁 → 快速解锁 owner ratify。
- **Wave 1（并行, worktree 隔离, 模型分派）**：L1-L5 建实现 + 跑测试 + 提交分支。
- **落地闸门（advisor 抓）**：batch-3 每项独立 opt-in 是本线红线；整池 re-open = **池 opt-in ≠ 逐项 ratify**。故 build+PR+复审全部并行推进（可逆、不浪费），但 **merge 闸在 owner 确认本排序计划**后才逐车道落。B/C 档只出锁/不碰。
- **落地**：主循环逐车道 adversarial-reviewer（Opus）复审 → 修 → 开 PR（**不 arm auto-merge**）→ owner ack 后 **champion 串行 rebase 落地**。
- **收尾**：设计+验证 MD（本文 as-built 回填 + 逐项 RED-before/mutation 证据）。

## 5. 纪律红线（沿用 §5 + 本线记忆）

1. batch-3 每项独立 opt-in——本轮 owner 已把整池 opt-in（固定节奏总目标池）；但 **B/C 档仍分别把关**：B 只出锁不建 runtime，C 不碰。
2. client filter 必镜像服务端谓词（B2-17 教训）；非判别式金测比没金测更危险，守卫须 mutation-RED 验证。
3. 附件（B3-07）落地前**诚实禁用**已在 B2-28 做；本锁只规划管线，不解禁。
4. B3-10 重试**不得裸 re-execute**，须过 confirmSideEffects + 幂等 ledger + flow-governance 双门。
5. 触发式/后端改动跑全 changed-service unit 套件；web spec 须同步 `run-required-web-tests.sh` + 对应 guard。

## 6. 进度（as-built 回填, 2026-07-09/10）

- ✅ Wave 0 · LK-B3-07 锁 — `claude/b3-07-attachment-lock`（PROPOSED；HYBRID 存储复用判定 + G1-G10 验收门 + 12 项 RED-before 清单 + 7 个 ratify 问题）
- ✅ Wave 0 · LK-B3-10 锁 — `claude/b3-10-retry-testrun-lock`（PROPOSED；含 B3-12；per-action applied-ledger + test-run dry-run 默认；**顺带发现 test 路由今日无能力门（仅 FE confirm）→ 锁 G8 关闭**）
- ✅ Wave 1 · L1 收件箱完整性 — `claude/b3-inbox-completeness`（backend 341f/4550 + web 109f/1599 + lint/build 绿；processed 反查钉死 authenticated-actor-only，敌意 actorId/userId 参数不可改向）
- ✅ Wave 1 · L2 模板治理 — `claude/b3-template-governance`（RED-before 7/7 · 归档门/版本路由守卫双 mutation 判别 · backend 342f/4588 + web 110f/1584 + lint/build 绿）
- ✅ Wave 1 · L3 自动化可观测 — `claude/b3-11-automation-monitor-fields`（构建中自抓真 bug：首版误 join 旧 `sheets` 表，实为 `meta_sheets`；诚实降级 id 回退双层 mutation 判别）
- ✅ Wave 1 · L4 前端打磨 — `claude/b3-13-fe-polish`（allowRevoke 严格 fail-closed · per-action loading · AsyncStateBlock 组合 UF-8 EmptyState · 复制/打印；web 1589 绿）
- ✅ Wave 1 · L5 死代码清理 — `claude/b3-14-remove-legacy-inbox`（reconcile 逻辑早已独立成 `approvalInboxFeedback.ts` 且被 live PlmProductView 依赖 → 不迁移只删视图）
- 🔄 对抗审阅（逐车道）→ 开 PR（不 arm auto-merge）→ owner ack 后 champion 串行落地
- ⬜ 收尾验证 MD

**过程记录**：session 限额三次打断（两轮 wipeout + 一次 finisher 中断）；对策=每子项增量 commit+push（第二轮起每次死亡至多损失一个子项）+ 主循环接管收尾（L2 B3-09 / L1 终验由主循环完成）。CI filter 行 L1↔L4 双改 → 落地时 union 解。
