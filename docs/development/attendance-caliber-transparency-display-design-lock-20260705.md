# 考勤口径透明（display-only）design-lock — 2026-07-05

> **Status: PROPOSED（delegated-execution）** — owner 2026-07-05 授权的自主执行窗口内推进的
> humanization 微切片；范围被硬性锁定为 **display-only / 默认行为不变 / 零 wire 变更**。owner
> 回来后可修订或追认；任何超出本锁范围的想法一律进 §6 deferred，不随本切片实现。
> 依据：benchmark refresh v3 §3.8（口径可信）+ 2026-07-05 现状审计（file:line 见 §2）。

## 1. 问题

考勤数字（应出勤天数、严重迟到、旷工迟到、可用人数等）在多个 surface 展示，但**口径定义
只在个别地方可见**：字段目录的 `description` 只在 Report-fields 管理段渲染；records 表头、
汇总卡片均为裸数字。用户看到"这个数字为什么不对"时没有就地解释。团队可用性段是现有最佳
实践（hint + legend + tooltip 三层），应作为全线蓝本。

## 2. 现状锚点（2026-07-05 实证）

- 字段目录自带口径文案：`plugins/plugin-attendance/index.cjs` ~L831-1270（如
  `expected_attendance_days` "按排班、工作日和节假日规则计算的应出勤天数。" ~L1036；
  `severe_late_count` ~L1155；`absence_late_count` ~L1175）。
- 已渲染 description 的唯一 UI：`AttendanceReportFieldsSection.vue` ~L1064。
- 裸数字面：records 表头 `AttendanceView.vue` ~L1323-1325（`recordReportColumns`
  构建于 ~L11652，spread `...field`）；汇总卡片 ~L519-548（Trend / Management Metrics）。
- 蓝本 idiom：TA 段 `AttendanceTeamAvailabilitySection.vue` ~L12-17 hint + ~L90-93 legend +
  `:title` tooltip；"Status guide" 定义列表卡 `AttendanceView.vue` ~L404-427
  （`attendance__status-guide`，label + code + 描述段落，文案 map ~L14925）。
- `availableFormal = scheduled + pendingLeaveTentative`（`index.cjs` ~L40072；待审批**不减**
  可用数，`teamAvailability.ts` ~L28 JSDoc 已写明）。

## 3. 范围（三个 display-only 附着点）

| # | 附着点 | 改动 | 文案来源 |
|---|---|---|---|
| G1 | records 表头 | `recordReportColumns` 携带 `description`，`<th :title="column.description">`（无 description 的列不加 title 属性） | **零新增文案**：复用字段目录 description |
| G2 | TA legend | 现有 legend 补一句口径等式：可用(正式) = 已排班 + 待审批（暂定，不扣减）；排除项 = 已批请假/休息/未排班 | 与 ~L28 JSDoc / ~L40060 注释一致，zh/en 双语走 `tr()` |
| G3 | 报表洞察区"口径说明"卡 | 克隆 Status-guide 定义列表卡结构，列 应出勤天数/出勤天数/严重迟到/旷工迟到/加班三段 的一句话定义 | 优先复用字段目录 description；缺失的最小新增（zh/en） |

**实现前置校验（G1）**：确认 records 视图消费的字段列表响应里 `description` 已在客户端可得
（Report-fields 段能渲染即大概率同源）。**若该响应不含 description，G1 收窄到 description
可得的 surface，并在 PR body 里记录——绝不为此新增后端字段暴露**（那是 wire 变更，越界）。

## 4. 硬边界

- 零 route/wire/settings/schema 变更；零后端行为变化；不改任何数字的计算。
- 不展示**阈值数值**到新 surface（per-group 阈值属配置信息，向员工面暴露是信息披露决策
  → §6）；本切片只解释"数字是什么口径"，不解释"阈值是多少"（self-rules 卡已有的除外）。
- 文案不承诺能力、不写竞品名；沿用 `attendance__hint` / `attendance__field-hint` /
  `attendance__status-guide` / `:title` 既有 idiom 与 `data-*` testid 约定。

## 5. 完成口径

- 前端实现 + web 测试：G1 断言 title 从目录 description 流到表头（有→有、无→无属性）；
  G2 断言 legend 含口径等式关键词；G3 断言卡片渲染条目 + 稳定 testid。
- **新 spec 必须接入 `attendance-web-guard.yml`**（run 列表 + 两处 path-filter）。
- 对抗审阅 0 P1/P2 后合并。display-only FE 切片不设 staging 门（与 MP-5/#3543 同档）。

## 6. Deferred（owner 决策，不随本切片）

- 阈值数值在员工/团队 surface 的展示；
- 字段目录 description 的内容修订/补全（后端文案变更）；
- 口径文案抽进 i18n 模块体系（多维表 17 模块那套是 multitable 线的，考勤线未建）。
