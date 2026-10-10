# 考勤 QA 问题修复设计 — 2026-10-10

## 状态与依据

2026-10-10，用户已明确批准恢复目标、推送公开分支、创建 Draft PR 与运行 CI。[Draft PR #6300](https://github.com/zensgit/metasheet2/pull/6300) 已发布，最终提交上的远端 CI 待结果。PR 合并、部署及真实数据操作仍需另行批准。

本文记录针对 QA 问题（#5986、#5990、#5558）的有限修复范围。依据包括冻结的本地验收回执 [`artifacts/attendance-qa-fix-20261009/verification.json`](../../artifacts/attendance-qa-fix-20261009/verification.json)、既有[今日状态设计](attendance-no-historical-today-fallback-design-20260923.md)，以及规范员工总览交互的[任务优先 design-lock](attendance-employee-overview-task-first-design-lock-20260716.md)。

首轮代码基线为 `a16a12aca35d46b6b621ae12f49b380b50b95b48`，修复提交为 `62d6801c5f`。当前正常合并固定 main 快照 `00caf5f639`（#6296，合并提交 `703c3c233e`）；考勤源码与已审阅的 #6285 对齐树保持不变，required-web 的这次改动仅为注释，测试入口与并集无丢失。最新证据见验证文档的“#6296 对齐后的当前代码”及 [`approval-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/approval-main-alignment.json)。#6285 的模板/样式兼容性与关键函数保护见 [`attendance-main-alignment.json`](../../artifacts/attendance-qa-goal-20261010/attendance-main-alignment.json)。这份设计不代表所有 QA 项已通过，也不代表已部署或获得业务验收。代码、本地验证、远端 CI、原 QA 环境验收及真实历史处理分别记录。

## 问题与成功标准

QA 包同时包含当前 UI 与请求流程缺陷、历史数据观察、环境配置和性能问题。修正向前执行的代码，不能证明旧记录已修复，也不能证明原环境运行的是修复后的构建。本切片的代码成功标准限定为以下行为：

1. 今日考勤状态只由当前会话用户、组织和规则时区工作日期对应且成功读取的记录决定。历史筛选与记录仍可使用，但不影响今日时钟、时间线或 CTA。
2. 历史报表到申请表的预填保留事件身份、源时间戳、工作日时区和已加载的组织/用户范围。过期或含糊的事件数据保持不可用，不得重新标记成另一用户或日期的数据。
3. 新打卡若会生成上班/下班顺序颠倒的配对，必须以稳定错误码和 HTTP 409 原子拒绝；原始事件和日汇总均不能提交。
4. 本地 QA/运维验收可通过封闭的合成数据夹具和严格授权跑通请假、加班、换班；只读历史诊断只输出代码和计数。
5. 跨午夜时，旧日期的后台刷新响应不得覆盖新日期的本人今日状态。切日期后发起的新 self-today 读取必须保持日期与会话绑定；旧响应迟到时应被丢弃。

以上不包含回写历史考勤、缺少原始规则和记录时对策略相关指标做定性、测量原环境延迟或批准生产部署。第 5 项由 Astra 独立复现：旧刷新结束与审批后的 `loadRecords` 是两个可达入口。最窄修复分别记录调用开始的时刻，在读取今日前用最终生效规则时区计算该时刻的日期；若已跨日，则禁止复用旧历史快照，重新读取当前本人今日。不能只保存初始今日键，因为初次加载规则前该键可能为空。

## 修复范围

### 今日状态与申请默认日期

今日键依据生效的考勤规则时区计算。历史行不得替代今日行。只有历史结果属于当前会话用户与组织、包含今日，并且结果完整到足以判定今日记录时才能复用；否则单独读取本人今日，同时不改用户的历史筛选条件。读取中/失败、时区无效、会话过期、日期变化或迟到的旧响应都不能被解释成“未打卡”。跨日的旧调用必须重新读取今日；独立今日读取继续检查版本、工作日和会话，拒绝失效响应。

请假、加班和换班申请以规则时区的今日键为默认日期。补卡在存在合格异常时使用异常工作日期，否则回退到今日键。只有用户尚未编辑历史日期区间时，系统才扩展默认区间以包含规则时区的今日。

代码定位：纯选择器和日期辅助函数位于 `apps/web/src/views/attendance/attendanceTodayWorkbench.ts`，包括 `selectTodayAttendanceRecord`、`canReuseAttendanceHistoryForToday`、`buildHeroTodayTimeline`、`alignDefaultHistoryRangeToRuleToday`（约 L15-L95）；页面读取和申请默认值位于 `apps/web/src/views/AttendanceView.vue`，今日状态约 ~L13336、`loadRecords` / `loadTodayAttendanceRecord` 约 ~L22431-L22470、`refreshAll` 约 ~L22950、申请默认值约 ~L17528-L17653。`AttendanceView.vue` 是大型文件，行号仅作近似定位。

### 历史报表预填

历史时间线读取真实报表路由。单次预填保留用户选中的源事件及其精确时间戳。用户编辑时间时，使用该记录持久化的工作日时区转换；时区跳跃与重复时间策略必须显式处理。历史为空、接口失败、时区缺失、事件用户不匹配、查询范围变化或请求过期时，不得捏造事件或跨组织/用户标记。

代码定位：`apps/web/src/views/attendance/attendanceRecordRequestPrefill.ts` 与 `apps/web/src/views/AttendanceView.vue` 的时间线/预填接入（`recordTimelineItems` 和 `resolveRecordTimelineRequestDraft`，约 ~L17301-L17335）。这是向前修复，不会重建缺失的历史原始打卡。

### 实时打卡顺序原子保护

保护逻辑在可选合并计算后检查最终 legacy 实时投影，并在事务完成前执行。如果下班早于上班，则在同一事务中抛出 `ATTENDANCE_PUNCH_ORDER_CONFLICT`（409）。原始打卡事件和日投影一起回滚。现存颠倒记录不由这个写保护修复，需另行调查。

代码定位：`plugins/plugin-attendance/lib/attendance-live-punch-order.cjs`（`hasReversedLivePunchOrder`，约 L5）和 `plugins/plugin-attendance/index.cjs`（`applyLivePunchProjectionLegacyV1`，约 ~L23004；冲突边界约 ~L23158）。

### QA 夹具、运维检查与只读历史

本地夹具验证器只使用一次性合成数据和正常 RBAC。封闭用户集合包含一个启用的请假类型、一个启用的加班规则和两条已发布的手工单日排班，使请假、加班和换班都能提交、持久化、核对并取消。夹具还验证管理员读取被拒绝。种子可幂等重复执行，不发放或修改请假余额。

历史对账器只做观察：通过限定范围的只读查询比较现有记录与原始事件，并只输出不含业务值的代码/计数；不会合成打卡、回填或修复记录。入口为 `scripts/ops/attendance-selfservice-fixture-verify.mts` 与 `scripts/ops/attendance-history-reconcile.mjs`。运维契约、CI wiring 和合成数据库证明分别见验证记录。

## 范围边界

- 本修复不新增 schema 或 migration。
- 未读取、改动或修复生产/客户数据。
- 未使用 QA 压缩包中的凭证。
- 本设计不授权部署、生产写入或向外部系统写回。
- 零分钟配对、极大迟到/早退值、零余额、会话数量或字段配置 degraded 均不能单独认定为代码缺陷；须用原策略和原记录核实。
- 性能验收需在目标环境测量；UI 回归通过不能证明延迟达标。

## 验收门

本地代码与合成夹具证据记录于[考勤 QA 修复验证](attendance-qa-remediation-verification-20261010.md)。成功必须同时包含可达反例修复前失败、相同反例修复后通过、受影响前端与邻近回归通过、类型/构建通过，以及测试接入两处 required web 链。最终提交上的远端 required CI、原 QA 构建/配置识别、真实历史调查、性能测量与业务验收须分别完成，不能由本地通过推定。
