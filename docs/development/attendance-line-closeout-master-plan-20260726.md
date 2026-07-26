# 考勤整线收尾总计划（vNext Wave 5 + issue #4556 W4-W8）

> Status: **PLAN**（docs-only）。**不授予授权、不改任何 runtime、不构成开工或合并。**
>
> Date: 2026-07-26 · 对象：当前所有在飞的考勤交付面 + 至 issue #4556 关闭的全部剩余工作
>
> 本文回应 owner 指令「规划及计划……按代码难度选择模型……完成整条考勤开发线收尾」。
> **owner 闸位以 🔒 标注——那些步骤本车道不得自行推进。**

## 0. 一页现状 —— **闭集票据表**

> **枚举方法（写成规则；方法本身必须可证闭合）**
> 本表由 **API 全量查询**生成（`gh pr list --state all --limit 200`，标题正则 `attendance|考勤|4556|W4C|W5-|Wave 5`，命中 **55** 张），**再逐张分类**——不是「列出我正在推进的票」。
> **静默缺席不是本文档的做法**：任何命中该查询的票若未出现在本表，即为**缺陷**。
> **本表两次因方法不闭合而被外部复核抓到**，如实留痕：①初版用「我在推进的票」⇒ 漏 #4584/#4585/#4586/#4608；②二版只**补上被发现的那四张**、方法未改 ⇒ 仍漏 **Wave 5 的四张 runtime PR**（#4557/#4562/#4564/#4576），而文档标题恰恰写着「vNext Wave 5 + …」。**「补上发现的」不等于闭集枚举**——本版改由查询驱动。
> **状态新鲜度**：已合条目为不变的 merge SHA；在飞条目的 head **会因 rebase 变化**，本表在**每次合入前刷新**（免责声明不能替代刷新——此为外部复核点名的纪律）。本表状态锚定 **2026-07-26 本次刷新时刻**。

### 0.1 在关键路径上

| 面 | 票 | SHA | 状态 |
| --- | --- | --- | --- |
| **vNext Wave 5 — W5-0 六只读端点** | #4557 MERGED | `beef6c13402a24a4ced30dfa4a2f607144d1167b` | 已合 |
| **W5-7 前置小票（comp_time 参数化）** | #4562 MERGED | `ebe798d47c666ec32077e18ea7136ea9d457ed6d` | 已合 |
| **W5-1 决策轨迹双面** | #4564 MERGED | `9d6ab3e1c3195ac40ee9bf37321da28920af2a29` | 已合 |
| **W5-2 上下文帮助** | #4576 MERGED | `e10816380eb26d63b196ba076477b230804aaaee` | 已合 |
| **Wave 5 收官验证 MD** | #4582 OPEN | head `809471035ab20317cb6eb05dbf975bcf237015ae` | Ready，CI 绿，等合（owner 已裁「合」） |
| W4 锁 PROPOSED 合入 | #4588 MERGED | `a3e5765727ca608e8c49c7a44a025e6e4aae5d40` | 已合 |
| W4 锁 RATIFY 状态持久化 | #4592 MERGED | `d6ac495b947c0b42ed7bee66d9531fbe25a486ca` | 已合 |
| W4C-0 identity 修订 | #4595 MERGED | `3fa1ae3421744fcec9a18c4f87153281c59ec6b2` | 已合（owner RATIFY 于 07-26，**不倒签**） |
| 修订状态持久化 | #4600 MERGED | `b5ff168e9411c556ff5eb055ce559859f9aeba8b` | 已合 |
| **W4C-0 contracts & durable storage** | #4606 MERGED | `d4dc12d8a8cde38c8f04f1952b3ba0b8b317265f` | 已合（**授权门瑕疵已记录**，见 #4613） |
| **W4C-1 pure calculator** | #4607 MERGED | `aebac4f8bef344b3ff3443ee045439c789a569a1` | 已合（同上） |
| **W4C-2 live/scheduled shadow** | #4612 OPEN | head `09f2e9b29c40ebd9d2d65b41fe7b8c87566733b7` | **Draft + ⛔HOLD**；fingerprint 半边未完成、P1-2 被 #4617 阻挡 |
| **(b2) §7.1a amendment** | #4617 OPEN | head `ea10a66fd91c30e191f566d07689a910fc1c9c98` | **Draft/PROPOSED**；四镜审 **5 P1 / 4 P2 发现完成、修订未完成**；远端仍为原 head |
| 授权 provenance 勘误 | #4613 **MERGED** | `df610db9ab6c403da6233a9c5dae2579941a6275` | **已合** |
| W4 记录 + 计划（本文，**4 文件**） | #4615 OPEN | head `24e0a42d0133ff9b74baf06169f0e21a81d67e5b` | **Ready**，待合 |

### 0.2 命中查询但**不在**关键路径（逐张标注理由，不静默省略）

| 组 | 票号 | 不在线的理由 |
| --- | --- | --- |
| **#4556 W0-W3 切片本身** | #4558 · #4560 · #4561 · #4563 · #4566 · #4567 · #4568 · #4569 · #4570 · #4571 | 本文标题范围是 **W4-W8**；W0-W3 已于 2026-07-23/24 由 Codex 车道落地并各自记录 |
| **W1-W3 合并后审计的修复** | #4584 `78b4133bac153ba39a3dff682d137bfdc26ae947` · #4585 `e0defbe26d7f2e1747e74aa908ca710422812bf7` · #4586 `c81b3bc39202fe347d18ab58520671af3c706def` | 修的是 W1-W3 的遗留（flag-OFF 遏制击穿 / guard 检查名稳定化 / 时间线守卫）；**#4585 是 `attendance-web-guard` 升 required 的前置，该治理动作已完成** |
| **W4C-0 的 test-infra 修复** | #4608 `d75d3b8285cba2b69a2442c1a8b5cf184c5266a4` | test-infra；解掉了连续两次打断 W4C-1 的「753 全绿却 exit 1」57P01 flake |
| **vNext Wave 0-4 全部票据** | #4488 · #4492 · #4494 · #4501 · #4502 · #4504 · #4508 · #4509 · #4513 · #4514(CLOSED) · #4522 · #4541 · #4542 · #4543 · #4544 · #4546 · #4548 · #4554 | Wave 0-4 已各自收档；本文范围自 **Wave 5** 起 |
| **S7 动态审批人线** | #4453 · #4471 · #4476 · #4480 · #4481 · #4483 | 不同交付线（S7），与本文范围无依赖 |
| **考勤运维 / 其它** | #4422 · #4549 | RD-4/5 smoke 与 DingTalk UAT 前置，不属本线 |

## 1. 关键路径（唯一合法顺序）

```
【A 轨：Wave 5，已到终点】
  #4582 ──🔒owner 裁收档──▶ Wave 5 CLOSED

【B 轨：#4556 W4，串行】
  W4C-2 修 P1(时区错配) + P2-1(resolved golden) + P2-2 处置
        └─ 与 (b2) 无依赖，可立即做 ✅已授权
  #4617 ──🔒owner RATIFY──▶ 实现 P1-2（(b2) run 身份 + outbox union）
        └─ 二者汇合 ──▶ 新 exact-head 独立门审 ──🔒owner 裁合并──▶ W4C-2 合入
  ──▶ W4C-3a ──▶ W4C-3b ──▶ W4C-3c ──▶ W4C-4     （每片：fresh-main PR + 独立门 0P1/P2 + 🔒合并裁决）
  ──▶ 🔒W4C-5 staging soak（单独授权 + ≥7 日历日）
  ──▶ W5 flex / 🔒W6（备料亦需授权）/ W7 cutover / W8 收口
  ──▶ 🔒issue #4556 关闭（锁 §14-10 另行终裁）
```

**并行窗口（仅两处）**：① W4C-2 的非 P1-2 修复 ∥ #4617 的 owner 审阅；② W4C-5 的 7 日历日 soak ∥ W5/W6 开发（锁允许，各自门）。**其余一律串行**——锁 §12 逐字要求「前序先合」。

## 2. 逐步任务与模型分配

模型判据（owner 指令「按代码难度」+ 外部复核修正）：
**Sonnet 5** = 正确性风险最高、需稳定长链推理（canonical boundary / 身份授权 / 事务与 outbox 语义 / rollback 语义）；
**Fable 5** = 机械面广、体量大（collector / fixture / CI 接线 / 读面与 OpenAPI / 文档同步）；
**Opus 5** = 门禁与裁量（每片独立对抗审、设计锁审、语义漂移深读、跨车道影响判定）。

| # | 任务 | 模型 | 前置 | 备注 |
| --- | --- | --- | --- | --- |
| B1 | **W4C-2 P1**：时区错配（`deriveLegacyLivePunchAttributionV1` 从 `args.timezone` 重算，而路由已把它覆写为班次 tz）。**先写零并发复现腿并跑红，再修** | **Sonnet** | 无 ✅ | 客户端一跳可达；修法二选一须读码定论 |
| B2 | **W4C-2 P2-1**：补 `resolved` 姿态 golden fixture；**复跑门审 M10 验必红** | **Fable** | B1 不冲突 | 现两份 fixture 都是 `unresolved`，红线从未覆盖有排班用户 |
| B3 | **W4C-2 P2-2 处置**：caller 枚举**以双语法静态 grep + 人工通读**得出「唯一入口且已守」（**方法有界：非覆盖率插桩**，实现方已自报此限）；**🔒 是否补事务内 RBAC 复核 = owner 裁** | Sonnet（若裁定补） | 无 | 已披露：事务内复核函数从不查权限表 |
| B4 | 重写 P1-3 不可达论证文本（错误前提已被门审证伪） | **Fable** | 无 | 正确理由是路由先行 throw，非 SERIALIZABLE 快照 |
| B5 | **🔒 #4617 RATIFY** → 实现 P1-2（scheduled-run row / 最终化事务 / outbox union / 两事件入闭集 / 迁移回滚） | **Sonnet** | 🔒 | 全线最难实现项 |
| B6 | W4C-2 新 exact-head 独立门审 | **Opus** | B1-B5 | 旧判定不延展 |
| B7 | 🔒 owner 裁 W4C-2 合并 | — | B6 | |
| B8 | **W4C-3a** import/integration/rollback | **Sonnet** 实现 + **Fable** fixture + **Opus** 门 | B7 | 数据面最险：rollback 语义 / 恰 5000-5001 / 三 transport 等价 / 导入指标禁覆盖 canonical 段结果 |
| B9 | **W4C-3b** approval/correction/outdoor/cancel | **Sonnet** + **Opus** | B8 | 跨插件权限泄漏最险：P17/P26 + 携 `published_definition_id` 的对抗实例 |
| B10 | **W4C-3c** manual/recompute/operator/最终清单 | **Sonnet** + **Fable**（collector 硬执行） + **Opus** | B9 | 收口片：「最终债务集为空」硬门会暴露前片遗留 |
| B11 | **W4C-4** shadow ledger / dual-host detail / OpenAPI | **Fable** + **Opus** | B10 | 触 vNext Wave 5 解释面 ⇒ **不得单方面改其合同**，须在 Wave 5 车道另修 posture 上限 |
| B12 | 🔒 **W4C-5** staging soak | Fable（runbook/helpers） + **Opus**（门） | 🔒 单独授权 | ≥7 日历日；预期差异清单必须带上 W4C-1 的 `correction-applied ⇒ adjusted` |
| B13 | W5 flex / 🔒W6 workspace / W7 cutover / W8 收口 | 按各片性质同上 | 逐片 | W6 备料亦需 owner 授权 |
| B14 | 🔒 issue #4556 关闭终裁 | — | B13 | 锁 §14-10 |

## 3. 每片不变的门禁（锁 §12 + 本线累积房规）

**锁 §12 逐字**：独立 fresh-main PR · 前序先合 · 独立对抗审 **0 P1/P2** · exact-head 测试与 mutation · 不启用任何组织。cut-over 片额外须证 `legacy_projection_only` 下**字节不变**。

**本线累积房规（每片任务书都要带）**：
1. 负例 stub 的失败点必须落在**被测守卫之内**（W4C-0 P2-1：stub 在 try 之外爆、catch 从未进入）；
2. 点名「fails independently」逐条**独立判别腿**；
3. **多门互相掩护**要分别 neuter 求排他失败（共享代码变体亦算）；
4. **fixture 自然形状**（W4C-1 P2-1：三值全同刻 ⇒ 断言名声称的行为不可观测）；
5. 「断言不发生」必配**正控**；
6. **TOCTOU 必须构造真并发**（双连接、双 commit 序）；
7. **mutate 后核对命中真代码行**（本片曾误中注释致 5/5 假绿）；
8. 真库一律**自建全新库**（残留库两次造成假红）；
9. 测试文件**禁裸控制字节**（NUL 使 grep 判 binary，破坏审计）；
10. SHA 一律 `rev-parse` 直贴，**严禁手工补全缩写**；
11. **合并前回读授权来源本身**——授权活在授权发生的位置，不在被授权动作的产物里；
12. **合同欠账 ≠ 分类勘误**：门审引锁原文判「未实现」时，禁用「重读锁文」覆盖；实现侧闭集漏项默认是 inventory 缺陷，不是合同意图。

> 第 11、12 两条是本线两次实质失误的产物（越过 HOLD 合入两片；(c)-plus 与 Wave 5 `grounded` 两次「重读覆盖原文」）。它们是本计划里**最不可省**的部分。

## 4. owner 闸位清单（🔒，共 8 处）

1. **#4582** Wave 5 收档裁决（已就绪，CI CLEAN）
2. **#4617** (b2) amendment RATIFY —— P1-2 的硬前置
3. **#4613** provenance 勘误是否合入
4. **#4615** W4 开发及验证记录（3 文件）是否合入
5. **B3** 是否补事务内 RBAC 复核
6. **B7** W4C-2 合并裁决
7. **B12** W4C-5 staging soak 单独授权（+ **W6 备料授权**）
8. **B14** issue #4556 关闭终裁

**另有逐片合并裁决**（B8-B11、B13 各自一次）——按 owner 07-26 的口径，恢复授权**不含**后续切片，每片合并均需单独裁。

## 5. 风险登记（本车道已知，非推测）

| 风险 | 载体 | 缓解 |
| --- | --- | --- |
| W4C-0/W4C-1 授权门瑕疵 | 已在 main | provenance 勘误 #4613 如实记录；不倒签；保留≠洗白 |
| W4C-2 的 P1 时区错配 | PR #4612 | B1 先写腿跑红再修 |
| `resolved` 分支从未被字节红线覆盖 | PR #4612 | B2 补 fixture + 复跑 M10 |
| 事务内复核不查权限表 | `w4c0-authorization.ts:284-327`（已改名 `recheckAttendanceActorLivenessInTransactionV1`，消除假不变量命名） | 已披露；路由门是**目前已知的**唯一屏障，其承重性已由「删 `withPermission` ⇒ 负例翻红」证明；**但唯一性的证据是静态枚举而非插桩** ⇒ W4C-3b 扩 caller 时须重估；🔒 B3 |
| W4 快照落地后 Wave 5 posture 上限过期 | 跨车道 | 已写入 W4 锁 §10.3 follow-up；B11 时在 Wave 5 车道修订，**不单方面改** |
| `HANDOFF-W4C0.md` 混入 main | 已在 main（随 #4606） | 独立清理票（未开，本计划记录） |
| **strict required checks 下 `main` 每次前进都会让在飞 PR 变 BEHIND** | 全部在飞 PR | **这是复发性条件，不是一次性事实**：每次合并前须重新 rebase + 等 fresh checks。已在本线多次触发（#4582 连续两次、#4612/#4615 各一次）。**收窄记录而非撤回**——「本次已刷」不等于「此条已消」 |

## 6. 交叉引用

- W4 锁 `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`（§12 串行合同 / §14 执行序）
- identity 修订 `…-w4c0-identity-proof-amendment-20260725.md`
- (b2) amendment `…-w4c2-scheduled-run-identity-amendment-20260726.md`（PR #4617）
- provenance 勘误 `…-w4-authorization-provenance-erratum-20260726.md`（PR #4613）
- 开发及验证记录 + W4C-2 修复设计 + 剩余切片计划（PR #4615 三文件）
- Wave 5 锁 `attendance-vnext-wave5-explainability-data-contract-lock-20260722.md`（§10 已含 owner 07-24 窄 amendment）
