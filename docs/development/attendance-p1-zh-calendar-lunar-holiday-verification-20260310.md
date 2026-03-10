# Attendance P1（中文覆盖 + 农历/节假日开关）开发与验证记录（2026-03-10）

## 1. 目标与范围
- 目标：补齐考勤页面中文文案覆盖，并把日历中的农历/节假日显示改为可切换，满足生产可用阶段的前端可运营性要求。
- 范围：仅涉及考勤前端视图层，不改后端 API 语义，不改数据库结构。

## 2. 代码变更
### 2.1 考勤主视图
- 文件：`apps/web/src/views/AttendanceView.vue`
- 变更：
  - 在日历头部新增显示开关：
    - `Lunar / 农历`
    - `Holiday / 节假日`
  - 日历单元格展示逻辑改为受开关控制：
    - `showLunarLabel && day.lunarLabel`
    - `showHolidayBadge && day.holidayName`
  - 新增本地偏好持久化：
    - storage key: `metasheet_attendance_calendar_display`
    - 默认值：`showLunar=true`、`showHoliday=true`
  - 新增移动端样式适配（小屏下日历头部与开关可换行）。
  - 扩充运行时错误文案映射，减少中文环境下英文错误漏出（请假类型/加班规则/管理员权限等）。
  - `setStatus` 在 error 场景统一走 `localizeRuntimeErrorMessage` 归一化。

### 2.2 审批流程设计器（考勤内嵌）
- 文件：`apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- 变更：
  - 将空态文案从硬编码英文改为 `useLocale()` 驱动。
  - 新增中文文案：
    - 标题：`审批流程设计器`
    - 空态：`当前租户未启用流程能力。`

## 3. 验证执行与结果
> 执行目录：`/Users/huazhou/Downloads/Github/metasheet2`

### 3.1 编译与类型检查
```bash
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
```
- 结果：PASS

### 3.2 语言 smoke 校验
```bash
node --check scripts/verify-attendance-locale-zh-smoke.mjs
```
- 结果：PASS

### 3.3 前端测试
```bash
pnpm --filter @metasheet/web test
```
- 结果：PASS（30 files / 123 tests）

### 3.4 ESLint（目标文件）
```bash
pnpm --filter @metasheet/web exec eslint src/views/AttendanceView.vue src/views/attendance/AttendanceWorkflowDesigner.vue
```
- 结果：PASS（历史 8 项已清理完成）
- 本次清理点：
  - 未使用变量改为 `_` 前缀（不改变现有行为）。
  - `RequestInit` 类型改为 `globalThis.RequestInit`，消除 lint 误报。
  - `content-disposition` 文件名解析正则去除无效转义。

### 3.5 Playwright 中文 smoke（远端）
```bash
WEB_URL='http://142.171.239.56:8081/' \
API_BASE='http://142.171.239.56:8081/api' \
AUTH_TOKEN='<ADMIN_JWT>' \
OUTPUT_DIR='output/playwright/attendance-locale-zh-smoke/20260310-lint-fix' \
node scripts/verify-attendance-locale-zh-smoke.mjs
```
- 结果：FAIL（本地 token 失效）
- 失败信息：`API /attendance/holidays?... failed: Invalid token`
- 恢复尝试：执行 `scripts/ops/attendance-resolve-auth.sh`（token/refresh-token/login fallback）后仍返回 `no valid auth token`
- 证据路径：
  - `output/playwright/attendance-locale-zh-smoke/20260310-lint-fix/attendance-zh-locale-calendar-fail.png`

### 3.6 Playwright 中文 smoke（GA 验证）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml --ref main
gh run watch 22884926952 --exit-status
gh run download 22884926952 -D output/playwright/ga/22884926952
```
- 结果：PASS（workflow runId: `22884926952`）
- 关键校验（来自 artifact `attendance-zh-locale-summary.json`）：
  - `status: pass`
  - `locale: zh-CN`
  - `lunarCount: 42`
  - `holidayBadgeCount: 1`
- 证据路径：
  - `output/playwright/ga/22884926952/attendance-locale-zh-smoke-prod-22884926952-1/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22884926952/attendance-locale-zh-smoke-prod-22884926952-1/attendance-zh-locale-calendar.png`

## 4. 交付结论
- 本轮 P1 改动已达到“可合并验证”状态：
  - 功能可用：农历/节假日显示开关 + 偏好持久化生效。
  - 中文覆盖增强：考勤设计器空态与一批运行时错误文案已本地化。
  - 编译、类型、测试、目标文件 ESLint 均通过。
  - Playwright 中文 smoke 已通过（GA run `22884926952`）。

## 5. 后续建议（下一轮）
- 将 `AttendanceView.vue` 的历史 lint 问题拆分为独立清理 PR（避免与业务改动混合）。
- 把本次 GA run `22884926952` 的证据路径同步追加到 Go/No-Go 文档。

## 6. 脚本增强后的新断言字段说明（authSource, toggleCheck）
- 适用范围：`scripts/verify-attendance-locale-zh-smoke.mjs` 增强后输出的日志与摘要字段。
- 安全要求：示例仅使用占位符，不记录真实 JWT、邮箱或密码。

### 6.1 `authSource`
- 含义：本次 smoke 使用的鉴权来源。
- Runbook 约定取值：`token|refresh|login`。
- 典型取值：
  - `token`：直接使用 `AUTH_TOKEN`（或 CI 中的 `ATTENDANCE_ADMIN_JWT`）通过鉴权。
  - `refresh`：`AUTH_TOKEN` 不可用时，通过 `/auth/refresh-token` 刷新并通过鉴权。
  - `login`：token/refresh-token 均不可用时，改走 `LOGIN_EMAIL` + `LOGIN_PASSWORD`（或 CI 对应管理员账号密码）登录成功。
- 作用：用于快速判断失败属于“凭据不可用”还是“业务回归”。

### 6.2 `toggleCheck`
- 含义：日历开关回归断言结果。
- 检查内容：
  - `Lunar` 开关执行 `on -> off -> on`，并校验农历文案显示/隐藏符合预期。
  - `Holiday` 开关执行 `on -> off -> on`，并校验节假日徽标显示/隐藏符合预期。
- 字段结构（对象）：
  - `lunarOffNoBadge` / `lunarOnRecovered`
  - `holidayOffNoBadge` / `holidayOnRecovered`
  - `skipped` / `reason`
- 典型状态：
  - `skipped=false` 且四个布尔值全 `true`：开关断言通过。
  - `skipped=true`：目标环境未部署开关 UI（且未开启 `REQUIRE_TOGGLE_CHECKS=true`），不作为阻断项。
  - `skipped=false` 且任一布尔值为 `false`：开关断言失败（应结合截图与日志定位）。

### 6.3 摘要字段示例（占位符）
```json
{
  "status": "pass",
  "locale": "zh-CN",
  "authSource": "refresh",
  "toggleCheck": {
    "lunarOffNoBadge": true,
    "lunarOnRecovered": true,
    "holidayOffNoBadge": true,
    "holidayOnRecovered": true,
    "skipped": false,
    "reason": null
  },
  "lunarCount": 42,
  "holidayBadgeCount": 1
}
```
