# 考勤剩余开发执行计划（2026-06-22）

> **定位**：这是 `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` 的执行型补充，不替代 tracker。tracker 继续作为唯一状态账本；本文只回答“剩余开发量怎么排、哪些可并行、每条怎么验收”。
> **Grounding**：`origin/main` @ `4af6bb6fa`，并核对 PR 状态到 2026-06-22。
> **输入文档**：主 tracker、`docs/research/dingtalk-attendance-benchmark-refresh-v3-20260621.md`、`attendance-leave-cancellation-reversal-designlock-20260621.md`。

## 1. 当前结论

当前不是“考勤大盘未开发”，而是：核心主干、年假引擎、通知渠道、排班高级能力已经大面积闭环；剩余是几条明确的对标增强弧线。

已完成或基本完成：

- **#1 年假 / 法定假余额引擎**：L0–L6 staging-proven，含 employee `/me` 自助余额、admin UI、L5c 操作与 L6 smoke。
- **#3 通知渠道扩展**：S1 SMTP email channel #3018 已合并，S2 producer routing #3033 已合并。
- **#7 销假 / 余额反冲**：design-lock #3034 已合并；实现 PR #3044 已开，当前 head `186b7a9f1c0fda6b858d03cc1c4fda487657f80f`，CI 全绿，仍需最终 mergeability / rebase / merge 窗口。

仍需开发的主线：

1. **Wave 0**：关闭 #7 实现 PR #3044。
2. **Wave 1**：#4 补卡结构化、#2 员工自助统一入口。
3. **Wave 2**：#5 报表分级、#6 待审批假期 overlay + 团队可用性。
4. **Wave 3**：#8 夜班 / 跨午夜深化。

粗估剩余开发量：#3044 合并后约 **25–45 工程日**。若多会话并行，合理日历周期约 **3–6 周**；如果单线推进，约 **5–8 周**。

## 2. 执行原则

- 每条 arc 继续遵守：**design-lock → owner 拍板 → 小 PR 切片 → 子智能体审阅 → CI → staging/closeout → tracker 回填**。
- 不把多个热核 arc 混进一个 PR；特别是 #5/#6/#8 都会触碰 effective-calendar / record-compute 热路径，必须串行或非常窄地分层。
- 开工前必须 live-main 查重：`git fetch origin main` + `git log origin/main` + grep 目标 symbol；不从计划快照直接断言状态。
- PR 状态必须用 `gh pr view` / `gh pr checks` 核对；不能用“正在 landing”替代 `MERGED`。
- 对员工余额、审批撤销、报表口径、跨日计算这类会影响真实数据的路径，优先补 **real-DB integration**，再谈 staging。

## 3. Wave 0 — #7 销假 / 余额反冲

| 项 | 状态 | 开发量 | 交付口径 |
|---|---|---:|---|
| #3044 implementation | OPEN，CI 已绿，待最终 merge window | 0.5–1 天 | rebase/update branch → fresh green → merge；tracker 回填 |

### 已锁行为

- 销假不是删除原请假事实，而是写 balance reverse 事件恢复可恢复余额。
- 已过期的被扣 lot 不恢复为 active；`unrecoverableExpired` 作为 response immediate signal，durable audit 由 `deduct - reverse` 缺口推导。
- 需要覆盖 authority 403、idempotency、expired lot、approve/deduct/cancel/reverse 全路径。

### 合并后动作

- 回填 tracker 对 #7 的状态。
- 若 staging 有能力，跑一条 owner smoke：approve leave → cancel → balance restored / expired gap surfaced → residue=0。

## 4. Wave 1 — 可并行第一波

### 4.1 #4 补卡结构化

| 维度 | 计划 |
|---|---|
| 目标 | 从 generic `time_correction` / `missed_check_in/out` 走向专用补卡请求与规则强约束 |
| 预估 | 5–8 工程日 |
| 并行性 | 可与 #2 并行；避免与 #5/#6/#8 同时改 record-compute |
| 首个 PR | design-lock：补卡类型、次数/时限、审批通过写入的 event/source、报表计数口径 |

建议切片：

1. **MKA-0 design-lock**：补卡类型、窗口、次数、审批写入、idempotency、报表字段。
2. **MKA-1 backend request model**：专用 create/update/approve guard，generic `/requests` 伪造拒绝。
3. **MKA-2 final approval writer**：审批通过写入真实 attendance event/record，并保留 source/provenance。
4. **MKA-3 admin/employee UI**：员工申请入口 + 管理审批可读详情。
5. **MKA-4 staging smoke**：缺卡 → 申请 → 审批 → record/report 变化 → 反向/重复/权限。

### 4.2 #2 员工自助统一入口

| 维度 | 计划 |
|---|---|
| 目标 | 把请假、加班、补卡、外勤、调休、换班等员工侧入口收成统一申请中心 |
| 预估 | 3–6 工程日 |
| 并行性 | 前端为主，可与 #4 并行；若 #4 未完成，补卡入口可先显示为 gated/pending |
| 首个 PR | design-lock：入口 IA、每类 request 的 route、不可承诺的 deferred 项 |

建议切片：

1. **SS-0 design-lock**：统一入口的信息架构、请求类型映射、权限/空状态。
2. **SS-1 read model / route hygiene**：只读聚合当前可申请类型与已存在申请。
3. **SS-2 frontend shell**：统一申请中心，先接已成熟类型。
4. **SS-3 type-specific forms**：外勤/调休/换班等已建后端能力接入。
5. **SS-4 regression + staging**：确保不破坏现有 quick-draft / overview。

## 5. Wave 2 — 串行中层

### 5.1 #5 报表分级

| 维度 | 计划 |
|---|---|
| 目标 | 把迟到/严重迟到/旷工级迟到等从 meta 透传变成一等规则口径 |
| 预估 | 4–7 工程日 |
| 并行性 | 与 #6/#8 串行，因共享 summary / record-compute |
| 首个 PR | design-lock：阈值、粒度、兼容旧 summary 字段、导出字段 |

建议切片：

1. **RT-0 design-lock**：字段、阈值、默认值、历史兼容。
2. **RT-1 settings + compute**：配置与 record/summary compute。
3. **RT-2 report/export wiring**：报表字段与同步 job。
4. **RT-3 admin UI + tooltip**：规则配置与口径说明。
5. **RT-4 staging smoke**：阈值变化 → summary/report/export 一致。

### 5.2 #6 待审批假期 overlay + 团队可用性

| 维度 | 计划 |
|---|---|
| 目标 | pending leave 不再只存在于审批流，而能进入团队排班/可用性视图 |
| 预估 | 5–8 工程日 |
| 并行性 | 与 #5/#8 串行，因触碰 `resolveEffectiveCalendar` |
| 首个 PR | design-lock：pending 是否影响 capacity、日历如何标记、权限可见性 |

建议切片：

1. **TA-0 design-lock**：pending/canceled/rejected/final approved 的可见性和影响。
2. **TA-1 resolver overlay**：effective-calendar 增加 pending leave item，不改变最终 attendance records。
3. **TA-2 team availability endpoint**：按组/部门/日期读取可用性。
4. **TA-3 UI calendar**：团队可用性视图、口径 tooltip。
5. **TA-4 staging smoke**：pending 可见、reject 消失、approve 转正式 leave。

## 6. Wave 3 — #8 夜班 / 跨午夜深化

| 维度 | 计划 |
|---|---|
| 目标 | 从 shift-level overnight 支持，推进到跨午夜 overtime / multi-slot / report consistency |
| 预估 | 8–15 工程日 |
| 并行性 | 最热核，建议单独 arc |
| 首个 PR | design-lock：跨日归属、工时拆分、OT 分段、报表边界 |

建议切片：

1. **NS-0 design-lock**：跨午夜归属、split strategy、report period、兼容一日一行 records 的红线。
2. **NS-1 helper / projection**：纯函数计算跨日窗口，先不写库。
3. **NS-2 overtime cross-midnight**：解除当前 hard reject 前先做反向矩阵。
4. **NS-3 records/report integration**：records/summary/report/export 对齐。
5. **NS-4 admin/employee copy**：明确跨日口径。
6. **NS-5 staging smoke**：夜班打卡、跨日加班、报表边界、cleanup。

## 7. 并行安排

推荐工作流：

1. **立即**：处理 #3044 merge。
2. **并行 A**：#4 补卡结构化 design-lock + backend。
3. **并行 B**：#2 员工自助统一入口 design-lock + frontend shell。
4. **串行 C**：#5 报表分级，然后 #6 团队可用性。
5. **最后 D**：#8 夜班 / 跨午夜。

可并行的边界：

- #4 与 #2 可以并行。
- #5/#6/#8 不建议彼此并行。
- #7 已在 #3044，不应再开第二条重复实现。
- #3 已完成，不应再按“通知渠道未做”重开。

## 8. 文档账本整理

当前已有开发文件：

- `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`：唯一状态账本。
- `docs/research/dingtalk-attendance-benchmark-refresh-v3-20260621.md`：最新对标研究与剩余候选梯子。
- `docs/development/attendance-leave-cancellation-reversal-designlock-20260621.md`：#7 design-lock。
- 本文：剩余开发执行计划，作为实施排序和估算文件。

建议后续：

- #3044 merge 后更新 tracker，不改本文历史 grounding；必要时追加 “2026-06-xx execution update” 小节。
- 每个新 arc 的 design-lock 单独建文件，不把 design 决策塞进本文。
- 每个 staging closeout 继续写 runbook / verification MD，再回填 tracker。

## 9. 当前下一步

**首要动作**：把 #3044 从“代码完成 + CI 绿”推进到 merged。

之后建议直接开两条：

1. **#4 补卡结构化 design-lock**。
2. **#2 员工自助统一入口 design-lock**。

如果只能单线推进，先做 #4。它补的是高频员工痛点，也能给 #2 的统一入口提供一个更完整的申请类型。
