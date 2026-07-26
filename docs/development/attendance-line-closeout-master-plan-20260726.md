# 考勤整线收尾总计划（vNext Wave 5 + issue #4556 W4-W8）

> Status: **PLAN**（docs-only）。**不授予授权、不改任何 runtime、不构成开工或合并。**
>
> Date: 2026-07-26 · 对象：当前所有在飞的考勤交付面 + 至 issue #4556 关闭的全部剩余工作
>
> 本文回应 owner 指令「规划及计划……按代码难度选择模型……完成整条考勤开发线收尾」。
> **owner 闸位以 🔒 标注——那些步骤本车道不得自行推进。**

## 0. 一页现状（全部经 API/读码核实，非记忆转述）

| 面 | 载体 | head / SHA | 状态 |
| --- | --- | --- | --- |
| **vNext Wave 5 收官** | PR #4582 | `2b3d2de987978b82fc395b043428f0ec534053e1` | owner 07-24 七项裁决**已逐条执行**；CI **14/14 CLEAN**；guard run-list 854/854 ⇒ **🔒 等 owner 裁收官** |
| W4 治理链 | #4588 / #4592 / #4595 / #4600 | 锁 `a3e5765727…`、修订 `3fa1ae3421…` | RATIFIED（修订的 RATIFY 由 owner 于 07-26 给出，**不倒签**） |
| W4C-0 | #4606 已合 | `d4dc12d8a` | 在 main（技术门满足；**授权门瑕疵已记录**，见 provenance 勘误） |
| W4C-1 | #4607 已合 | `aebac4f8b` | 在 main（同上） |
| **W4C-2** | PR #4612（Draft + ⛔HOLD） | `8dd01fcba070609c5b808576c011a2b617d199df` | 第二轮门审 **REQUEST_CHANGES**：1 P1 净新 + 2 P2；两条承重腿已补 |
| **(b2) amendment** | PR #4617（Draft，PROPOSED） | `ea10a66fd91c30e191f566d07689a910fc1c9c98` | 875 行，**🔒 等 owner RATIFY**——RATIFY 前 P1-2 不得实现 |
| provenance 勘误 | PR #4613（Draft） | — | **🔒 等 owner 裁是否合入** |
| W4 开发及验证记录 | PR #4615（Draft，3 文件） | — | **🔒 等 owner 裁是否合入** |
| follow-up | issue #4616 | — | 已重写为「(b2) 之后重估 per-record 粒度」 |
| W4C-3a / 3b / 3c / 4 / 5 | — | — | **未开工**（串行合同；W4C-5 另有 🔒） |
| 章程 Wave 6+ / issue 关闭 | — | — | **🔒 owner 终裁** |

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
| B3 | **W4C-2 P2-2 处置**：caller 枚举已证唯一入口且已守；**🔒 是否补事务内 RBAC 复核 = owner 裁** | Sonnet（若裁定补） | 无 | 已披露：事务内复核函数从不查权限表 |
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
| 事务内复核不查权限表 | `w4c0-authorization.ts:284-327` | 已披露；路由门是唯一屏障且已证承重；🔒 B3 |
| W4 快照落地后 Wave 5 posture 上限过期 | 跨车道 | 已写入 W4 锁 §10.3 follow-up；B11 时在 Wave 5 车道修订，**不单方面改** |
| `HANDOFF-W4C0.md` 混入 main | 已在 main（随 #4606） | 独立清理票（未开，本计划记录） |

## 6. 交叉引用

- W4 锁 `attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md`（§12 串行合同 / §14 执行序）
- identity 修订 `…-w4c0-identity-proof-amendment-20260725.md`
- (b2) amendment `…-w4c2-scheduled-run-identity-amendment-20260726.md`（PR #4617）
- provenance 勘误 `…-w4-authorization-provenance-erratum-20260726.md`（PR #4613）
- 开发及验证记录 + W4C-2 修复设计 + 剩余切片计划（PR #4615 三文件）
- Wave 5 锁 `attendance-vnext-wave5-explainability-data-contract-lock-20260722.md`（§10 已含 owner 07-24 窄 amendment）
