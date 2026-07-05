# 考勤半天假辅助（display-only）design-lock — 2026-07-05

> **Status: PROPOSED（delegated-execution）** —— humanization 微切片（v3 §3 backlog
> "half-day 定义辅助"），范围硬锁 **frontend-only / 纯预填与提示 / 默认行为不变 / 零新 wire**。
> owner 可回溯修订；凡需要新 wire 字段的变体一律进 §5 deferred。
> 依据：2026-07-05 现状审计（§1 锚点）。

## 1. 现状（审计实证）

- **请假时长今天是"裸三件套"**：两个自由 `datetime-local`（开始/结束）+ 一个自由分钟数
  `input[type=number]`（`AttendanceView.vue` ~L918-944），quick-draft 只预填
  `workDate`+`requestType`（~L15415-15425），时长全手填；**半天/上午/下午 零命中**。
- **后端按 verbatim 分钟记账**：请假分钟 = `metadata.minutes` 原样（index.cjs ~L6059，
  汇总 ~L11850），窗口时间不参与计算；"半天"的唯一数值定义在年假扣减路径
  （`requestedUnits = minutes / defaultMinutesPerDay`，0.5 = 半天，~L17085-17110）。
- **FE 已有的数据（零新 wire 的弹药）**：生效班次窗口 `workStartTime/workEndTime`
  （`/api/attendance/rules/me` → ~L12915-12916）；每假种 `defaultMinutesPerDay`
  （leaveTypes 已在 wire，~L10609，默认 480）。
- **不在员工 wire 上的**：org 级 `annualLeavePolicy.standardDayMinutes`（仅 admin 路径）。
- **结构注意**：员工实际看到的表单是 `AttendanceView.vue` **内联**表单；
  `AttendanceRequestCenterSection.vue` 是已抽取但**未挂载**的孪生（仅 parity spec 引用）。

## 2. 范围（两个纯前端 affordance）

| # | 改动 | 口径 |
|---|---|---|
| G1 | **快捷预填按钮**：请假类型选中时，时长三件套上方出现「全天 / 上午半天 / 下午半天」三枚按钮——用 `requestForm.workDate` + 生效班次 `workStartTime/workEndTime` 预填 `requestedInAt/requestedOutAt`（全天 = 整窗；半天 = 窗口中点切分），`minutes` 同步预填（全天 = 选中假种 `defaultMinutesPerDay`；半天 = 其一半，非整除时四舍五入到分钟并在 hint 里如实显示）。按钮**只做预填**——三个输入保持自由可改，预填后用户编辑不回弹（一次性 seed，非双向绑定）。班次窗口缺失（无 rules/me 数据）时按钮隐藏，不猜默认 | 纯预填；零 wire 变化 |
| G2 | **折算提示**：分钟输入下方实时 hint「≈ N 天（按该假种标准日 X 分钟）」，N = `minutes / defaultMinutesPerDay` 保留一位小数；minutes 为空/非法时不显示 | 纯展示；口径**明示是假种基准**（`defaultMinutesPerDay`），不冒充 org `standardDayMinutes`（不在 wire → §5） |

**parity**：实现落在**内联表单**（唯一活表单）；未挂载的 `AttendanceRequestCenterSection.vue`
孪生**本刀不改**（它不渲染给任何用户，避免无谓扩散），在其文件头注释追加一行"半天快捷预填
仅在内联表单——若未来挂载本组件需先补齐 parity"。

## 3. 硬边界

- 零后端/路由/settings/schema 改动；零新 wire 字段；不改 `validateRequestForm` 的校验语义
  （minutes 仍非必填——本刀不收紧校验，收紧是产品决策 → §5）。
- 半天切分 = 班次窗口**时间中点**（不扣午休——午休结构不在 rules/me wire 上，→ §5 如实注明）。
- 文案 zh/en 走 `tr()`；testid 走 `data-*` 约定；enum-strict 不适用（无枚举分支）。

## 4. 完成口径

- 纯逻辑抽独立模块（如 `apps/web/src/views/attendance/halfDayLeaveHelper.ts`：
  `buildLeaveQuickFill(kind, workDate, shiftWindow, leaveType)` 纯函数）+ web 测试：三按钮
  预填值精确断言（含奇数分钟窗口的中点/取整）、无班次窗口时按钮隐藏、预填后可自由改、
  G2 折算 hint 数值与空值分支；**mutation 自检**：改中点切分公式 → 半天用例翻红。
- 新 spec 接入 attendance-web-guard（run 列表 + 双 path-filter）。
- Opus 对抗审阅 0 P1/P2 后合并；display-only 不设 staging 门。

## 5. Deferred（owner 决策/新 wire，各自独立 gate）

- org `standardDayMinutes` 上员工 wire（`rules/me` 或 `leave-balances/me`）→ 余额卡
  "剩余 ≈ N 天" 与 org 基准折算（审计选项 c）；
- 午休感知的半天切分（需班次午休结构上 wire）；
- 请假表单校验收紧（minutes/窗口必填、窗口∩班次一致性）；
- 未挂载孪生组件的挂载/淘汰决策。
