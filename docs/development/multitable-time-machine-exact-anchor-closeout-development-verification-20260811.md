# 多维表 Time Machine（exact-anchor Revert/Reset）开发线收口 — 开发与验证记录（2026-08-11）

> 载体 PR **#4654** `codex/tm-closeout-integration-20260728`；收口净增量 head `ad8d56c36f`（在 carrier 追平当前 main 的 `5af9e04a6` 之上 9 个 commit）。
> **安全边界（全程不变）**：所有 recovery flag **default-OFF**；authority triggers 出厂 **DISABLED**；本记录只覆盖**开发收口**，不含 O-2 启用阶梯 / staging cutover / 生产开关——那是独立的 owner/ops 决策，本轮**未**触碰。

## 0. 背景与本轮定位

这条线（让多维表能把一张表恢复到某个精确操作锚点，含记录数据 + 权威链接）此前是**四层 Draft 栈** #4472→#4474→#4478→#4519（以及更早的冻结栈 #4417/#4445/#4446）。两轮独立对抗审 + owner 复核在真 PostgreSQL 上**构造证明**了一组缺陷（三类死锁、FK 语义、marker 面、containment 失明、no-oracle 两接口未拆等）。#4654 是把这些收口到 **current main** 的单一 carrier；本轮工作 = 在 #4654 上**闭合门禁与 owner 复核确认的全部缺陷**，把它做到「默认关闭、可落地」，并按代码难度分派 Fable5/Sonnet5/Opus5 执行。

**范围三分（决定"完结"的确切含义）**：
- **合入阻断集**（必修才能默认关闭干净落地）：两接口拆分(治理BLOCK)、fail-closed 假绿、containment 假绿、死代码/假绿测试、marker golden。
- **启用加固集（O-2，触发器出厂 DISABLED ⇒ 合并时打不到）**：40001 平台分类、foreign-fence 可用性、饥饿。**本轮交付了其中代表性 + 数据完整性最关键的部分**，其余枚举留启用相位。
- **Phase D（未启动）**：retention 后归档 / 大批量异步恢复 / 完整 T-state 浏览 / 跨表恢复 / 删除记录精确复活。

## 1. 收口净增量：9 个 commit（各带模型分派与证据）

| # | commit | 内容 | 模型 | 证据 |
|---|---|---|---|---|
| 1 | `b4da2fae82` | containment helper 强制 `meta_links.foreign_record_id` **无任何 FK** 不变量（conrelid/conkey/attnum，不看名/目标/ON DELETE）+ 变异；workflow 注释与 SHA/sentinel 同步 | Fable5 | 真库三态：干净 PASS / NO ACTION FAIL / CASCADE FAIL / 移除 PASS；变异证承重 |
| 2 | `5ba2f03823` | golden：authority substrate `'unavailable'`（出厂 DISABLED 姿态）⇒ recovery **fail-closed 零写** | Sonnet5 | 真实机制（强制 9 触发器 DISABLED）+ **正控**（ENABLE 时同场景四表真被改）+ 变异（去守卫→完整破坏性写入放行 RED） |
| 3 | `9f325a34f8` | 平台写路径 40001 → 可重试 409（admin-users 6 处）；AuthService 有界重试 + 注册不静默丢角色 + 回填不伪造内存权限 | Sonnet5 | 4 新测试 + 4 变异 RED（含「注册成功但无角色」bug 钉死）；复用既有判别函数非新造 |
| 4 | `92bbf77829` | **两接口拆分** `preliminaryFullRead`(不取锁)/`finalLockedFullRead`(锁证据绑定)（owner 已裁形状，此前只交付行为半边）| Sonnet5 | 行为保持 56/56·148/148·70/70·tsc 干净；真库 drift guard；**advisor 复核后自纠**「arity 非对称编译保证」过强声明，改以真库测试为护栏 |
| 5 | `f439500a05` | golden：automation lock/unlock marker operation 可被选作 `anchorOperationId`；空 op 密封不留幻影 endpoint | Fable5 | 幻影锚前提经查已被 operation-ledger 空 op 跳过消解（未造第二道同类闸）；G1/G2 + 变异打 backstop RED |
| 6 | `820fe4bd4e` | **foreign-fence**：统一 fence 所有涉及 sheet（source+foreign）按 id 全序、任何行锁前一次取完 ⇒ foreign 写者不再把 recovery 误判 preview-drift | Opus5 | 构造竞态：source-only 6/6 abort→foreign fence 0/6；三类死锁正控 no-40P01；**强制 source-first→40P01 复现**（全序承重）；source-hunk cp-revert→生产 apply preview-drift |
| 7 | `a043acb985` | 跨切片修复：failclosed golden 的 applyExactAnchorRecovery input 改用两接口字段 | 主循环 | 修复 P2-1(旧 base 接口)与 P2-5(改名)的集成断裂；由 P2-2 报告发现 |
| 8 | `1fc4595700` | CI 三点接线：3 新真库 golden 进 vitest 排除 + plugin-tests 真库步 + wiring 守卫白名单 | 主循环 | wiring 守卫 `node --test` 19/19；防「被触发≠被验证」的手动-only golden |
| 9 | `ad8d56c36f` | 删死判据 `isLiveLinkTargetForeignKeyViolation` + 合成约束单测（FK 已从 schema 移除、调用点不可达）| Sonnet5 | fresh schema 查 pg_constraint 无该 FK；保留 live projection/retryable-conflict/`link-integrity`；tsc 干净、真库 296/296 |

## 2. 七类历史缺陷收口对照（本轮针对的靶子）

1. **P1-A recovery↔权限写 ABBA** — carrier 已换模型（shared-writer/exclusive-recovery 租约 + 全局 NOWAIT，无人等待⇒无环）。
2. **P1-B recovery↔recovery 锁序倒置** — foreign-fence(commit-6)统一全序 fence 消除。
3. **P1-C 普通写↔普通写** — 属触发器施加的平台级串行化；40001 分类(commit-3)交付代表性路径映射，全平台清扫留 O-2。
4. **P2 `meta_links` FK** — carrier 已移除 FK 迁移；本轮补 containment 不变量(commit-1)防其以任何形状复现 + 删残留死判据(commit-9)。
5. **P2 marker mint 面** — automation lock/unlock 现传 ledger；commit-5 补 anchor-selectable golden + 幻影锚防护。
6. **containment 失明** — commit-1 让 helper 真查 FK 形状（此前只查 trigger/function）。
7. **no-oracle 两接口** — commit-4 交付结构拆分（治理 BLOCK 解除）。

## 3. 集成验证

- **切片级**：每切片在独立 worktree 本地真库验证 + 变异自证（见 §1 证据列）。
- **跨切片**：唯一集成断裂（P2-1 golden × P2-5 改名）由 P2-2 诚实报告、commit-7 修复。
- **CI 接线守卫**：`node --test multitable-exact-anchor-ci-wiring.test.mjs` = 19/19（3 新 golden 两点接线 + 「waiter matcher 保持 ≥2、拒绝 ≥1 弱化」）。
- **完整 required CI**：首推 `ad8d56c36f` 时 4 红（Sealed-export S5×2 / S5-S6A gate / integration-guard）经逐层查证=**s6a-pin 跨线耦合非 TM 缺陷**（sealed-export `package-provenance.cjs:290` 冻结 `plugin-tests.yml`，我接线 3 golden 改其 run-list ⇒ digest 变；纯 main `0287b250b3` 上 provenance PASS、我的树 FAIL，仅此一处 pin 变）——修=同步重算 `evidenceFiles.pluginTestsWorkflow` `6e6653d6…`→`a698464126…`（commit `4822e512c3`），provenance 转 OK。修复后 required CI 全绿（含 integration-guard 恢复）。
- **独立 Opus 对抗终门 @ `ad8d56c36f`（净增量 9 commit）= CLEAR，0 P1 / 0 P2**：8 个恢复真库套件**一起**跑 142/142；6 个变异各红对应守卫（authorityLease-unavailable / P25 post-lock swap / FK seed / run-list 删项 / register re-throw / empty-op seal）证全部承重非空转；**foreign-fence 三类死锁全 NO-40P01 且 in-test CONTROL 强制 source-first→40P01**（全序承重）；跨切片修复证实（failclosed 在 P25 拆分下通过）；死代码零残留 + live-link 55/55；skip-green 控制 sentinel 抛错非绿跳；CI-wiring 守卫在 required `test(20.x)` 内；对新 main 无 gate-file 漂移。findings 全 P3/NIT（见 §4）。MD=`/tmp/pr4654-regate-claude-20260811.md`。
- **已知 pre-existing 失败**：`multitable-record-form.api.test.ts`（mock harness `Unhandled SQL`，baseline 同样红，不碰 meta_links，非本轮回归；非真库 required 步）。

## 4. 剩余开发（按相位）

**O-2 启用加固（触发器 DISABLED 时打不到；启用前必做）**
- **40001 全平台清扫**：本轮覆盖 admin-users + AuthService 代表性 + 注册数据完整性；剩余枚举写者（`directory/deprovision-*`、`invite-accept-writes`、`user-activate`(mapActivateError)、`attendance-admin`、`spreadsheet-permissions`、`permissions`、`roles`、`directory-sync`、`dingtalk-oauth`、`routes/auth.ts` 注册 handler 塌 500）。
- **foreign-fence 残余（可用性非死锁）**：共享查找表形状（FK KEY SHARE vs 行锁 FOR UPDATE），pre-existing 未拓宽；根治需围栏所有 link-in sheet（无界）或弱化记录锁（drift 检测改动）。
- **饥饿/可用性**：写者持共享租约时 recovery 立即 busy ⇒ 持续普通写下 recovery 可能长期抢不到排他租约（非死锁）；需退避/优先级/维护窗口口径。

**Phase D（未启动，需先立 D1 设计锁；`v3.7 §12` 8–12 pw）**：retention 后不可变归档 + 完整性校验 + 大批量异步恢复 + 进度/重试 UI。

**其它产品能力（未开发）**：完整 T-state 浏览（服务端 `/point-in-time` 只列存活记录=一处路由级改动；前端全仓零消费者=整条读路径从零；#4205 设计锁不在 main）；跨 sheet 原子恢复（无设计）；删除记录精确复活（当前 fail-closed；逻辑可逆运营通常不可逆）。

## 5. 旧栈处置（收口后）

- 七个旧 Draft（#4472/#4474/#4478/#4519 + #4417/#4445/#4446）内容已被 #4654 在 current main 上取代，应标 **superseded** 关闭。
- **#4446 先抽 resurrect 参考件落 main**（77 行 apply + 5 golden + 594 行 realdb + owner 亲抓两处 P1 级修复）——它是本线唯一把 trash 行互斥/锚点态 vs 终态快照/链接重建幂等做对的范例，从未接线，丢的是参考实现非已交付能力。

## 6. 安全边界重申

flags 全 default-OFF · triggers 出厂 DISABLED · 无 flag 翻转 / 无 staging / 无生产开关 / 无 auto-merge。O-2 启用与 staging cutover 是独立 owner/ops 决策。
