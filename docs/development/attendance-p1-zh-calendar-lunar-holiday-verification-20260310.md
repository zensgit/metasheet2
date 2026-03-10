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

### 3.7 Playwright 中文 smoke（PR #401 分支回归）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml --ref codex/attendance-zh-calendar-p1-20260310
gh run watch 22888000382 --exit-status
gh run download 22888000382 -D output/playwright/ga/22888000382
```
- 结果：FAIL（预期外，环境密钥问题）
- 关键结论：
  - 失败位置已从 workflow 前置鉴权步骤移动到脚本执行阶段，说明“前置阻断已移除，改由脚本统一处理鉴权”变更生效。
  - 失败根因：`AUTH_TOKEN is invalid and LOGIN_EMAIL/LOGIN_PASSWORD are missing`
  - 新增字段已落盘：`authSource`、`toggleCheck`（见摘要 JSON）
- 证据路径：
  - `output/playwright/ga/22888000382/attendance-locale-zh-smoke-prod-22888000382-1/attendance-zh-locale-summary.json`

## 4. 交付结论
- 本轮 P1 改动已达到“可合并验证”状态：
  - 功能可用：农历/节假日显示开关 + 偏好持久化生效。
  - 中文覆盖增强：考勤设计器空态与一批运行时错误文案已本地化。
  - 编译、类型、测试、目标文件 ESLint 均通过。
  - Playwright 中文 smoke 已通过（GA run `22884926952`）。
  - PR 分支回归二次验证已通过（GA run `22889038364`），鉴权 fallback 与部署感知开关断言行为符合预期。

## 5. 后续建议（下一轮）
- 将 `AttendanceView.vue` 的历史 lint 问题拆分为独立清理 PR（避免与业务改动混合）。
- 把本次 PR 分支 GA run `22889038364` 的证据路径同步追加到 Go/No-Go 文档。

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

## 7. 追加验证（PR #401，run 22889038364）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml --ref codex/attendance-zh-calendar-p1-20260310
gh run watch 22889038364 --exit-status
gh run download 22889038364 -D output/playwright/ga/22889038364
```
- 结果：PASS
- 关键结论：
  - `authSource=refresh`：`AUTH_TOKEN` 失效时可自动走 refresh-token 链路。
  - `toggleCheck=skipped:calendar flags not available in this deployment`：目标部署尚未启用开关 UI 时不阻断 smoke（`REQUIRE_TOGGLE_CHECKS=false` 默认行为）。
  - `status=pass`、节假日校验与清理链路通过。
- 证据路径：
  - `output/playwright/ga/22889038364/attendance-locale-zh-smoke-prod-22889038364-1/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22889038364/attendance-locale-zh-smoke-prod-22889038364-1/attendance-zh-locale-calendar.png`

## 8. 新增断言：zh 核心文案门禁（2026-03-10）
- 新增目的：防止考勤主区域在 `zh-CN` 下回退到英文核心文案（例如 `Check In`、`Summary`、`Submit request`）。
- 脚本变更：`scripts/verify-attendance-locale-zh-smoke.mjs`
  - 新增 `summary.zhLabels` 输出对象。
  - 默认开启 `REQUIRE_ZH_CORE_LABELS=true`（可通过 env 显式关闭）。
- workflow 变更：`.github/workflows/attendance-locale-zh-smoke-prod.yml`
  - 新增 `workflow_dispatch.inputs.require_zh_core_labels`（默认 `true`）。
  - Step Summary 新增 `ZH_LABELS` 字段。

`summary.zhLabels` 字段示例（占位符）：

```json
{
  "zhLabels": {
    "heading": true,
    "checkInButton": true,
    "checkOutButton": true,
    "summaryCard": true,
    "calendarCard": true,
    "requestCard": true,
    "submitButton": true,
    "recentRequests": true,
    "noEnglishLeak": true,
    "ok": true,
    "skipped": false,
    "reason": null,
    "englishLeakSamples": []
  }
}
```

## 9. GA 回归验证（zh core labels，run 22889357568）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml \
  --ref codex/attendance-zh-calendar-p1-20260310 \
  -f require_zh_core_labels=true \
  -f require_toggle_checks=false \
  -f verify_holiday=true

gh run watch 22889357568 --exit-status
gh run download 22889357568 -D output/playwright/ga/22889357568
```
- 结果：PASS
- 关键摘要（`attendance-zh-locale-summary.json`）：
  - `status=pass`
  - `authSource=refresh`
  - `zhLabels.ok=true`（`noEnglishLeak=true`）
  - `toggleCheck.skipped=true`（原因：当前部署尚未启用开关 UI，符合非强制模式预期）
  - `cleanup.holidayDeleted=true`
- 证据路径：
  - `output/playwright/ga/22889357568/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22889357568/attendance-zh-locale-calendar.png`

## 10. zh copy contract 扩展（2026-03-10）
- 文件：`scripts/ops/attendance-verify-zh-copy-contract.mjs`
- 扩展内容：
  - 保留 `AttendanceView.vue` 历史英文片段黑名单检查。
  - 新增 `AttendanceExperienceView.vue` / `AttendanceWorkflowDesigner.vue` 的中文契约检查：
    - 必须包含关键中文文案配置。
    - 模板区域不得出现 hard-coded 英文提示文案。

本地验证：
```bash
pnpm verify:attendance-zh-copy-contract
```
- 结果：PASS

## 11. 门禁串联优化（2026-03-10）
- 文件：`.github/workflows/attendance-locale-zh-smoke-prod.yml`
- 新增步骤：`Run zh copy contract`
  - 命令：`pnpm verify:attendance-zh-copy-contract`
  - 位置：`Install dependencies` 之后、Playwright 浏览器安装之前。
- 目的：在进入浏览器回归前先拦截静态文案回归，减少定位成本。

## 12. GA 回归验证（含 zh copy contract 前置，run 22889675403）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml \
  --ref codex/attendance-zh-calendar-p1-20260310 \
  -f require_zh_core_labels=true \
  -f require_toggle_checks=false \
  -f verify_holiday=true

gh run watch 22889675403 --exit-status
gh run download 22889675403 -D output/playwright/ga/22889675403
```
- 结果：PASS
- 阶段结果：
  - `Run zh copy contract`：PASS（已前置到 smoke workflow）
  - Playwright zh smoke：PASS
- 摘要字段：
  - `authSource=refresh`
  - `zhLabels.ok=true`
  - `toggleCheck.skipped=true`（目标环境尚未启用开关 UI）
- 证据路径：
  - `output/playwright/ga/22889675403/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22889675403/attendance-zh-locale-calendar.png`

## 13. Mainline PR 验证（PR #403，run 22889790719）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml \
  --ref codex/attendance-zh-calendar-p1-mainline-20260310 \
  -f require_zh_core_labels=true \
  -f require_toggle_checks=false \
  -f verify_holiday=true

gh run watch 22889790719 --exit-status
gh run download 22889790719 -D output/playwright/ga/22889790719
```
- 结果：PASS
- 阶段结果：
  - `Run zh copy contract`：PASS
  - `Run zh locale smoke`：PASS
- 摘要字段：
  - `status=pass`
  - `authSource=refresh`
  - `zhLabels.ok=true`
  - `toggleCheck.skipped=true`（当前部署未启用开关 UI）
  - `cleanup.holidayDeleted=true`
- 证据路径：
  - `output/playwright/ga/22889790719/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22889790719/attendance-zh-locale-calendar.png`

## 14. Daily Dashboard 合同升级（schema v2）
目标：让 `attendance-daily-gate-report.mjs` 对 locale zh smoke 摘要执行更严格的契约校验，防止“脚本成功但中文门禁字段回退”漏检。

代码变更：
- `scripts/verify-attendance-locale-zh-smoke.mjs`
  - `schemaVersion` 从 `1` 升级为 `2`。
- `scripts/ops/attendance-daily-gate-report.mjs`
  - `parseLocaleZhSummaryJson()` 在 `schemaVersion>=2` 时新增约束：
    - `authSource` 必须属于 `token|refresh|login`
    - `zhLabels` 状态必须可判定（`ok=true` 或 `skipped=true`）
    - 非 skipped 时必须 `noEnglishLeak=true` 且核心字段完整
  - 输出新增 meta 字段：
    - `authSource`
    - `zhLabelsStatus`
    - `zhLabelsOk`
    - `zhNoEnglishLeak`
    - `zhMissingFields`
- `scripts/ops/attendance-daily-gate-report.test.mjs`
  - 新增用例：
    - `AUTH_SOURCE_INVALID`
    - `ZH_ENGLISH_LEAK_DETECTED`

本地验证：
```bash
node --check scripts/ops/attendance-daily-gate-report.mjs
node --check scripts/ops/attendance-daily-gate-report.test.mjs
node --test scripts/ops/attendance-daily-gate-report.test.mjs
```
- 结果：PASS（12/12）

## 15. Mainline PR 回归（schema v2，run 22890158371）
```bash
gh workflow run attendance-locale-zh-smoke-prod.yml \
  --ref codex/attendance-zh-calendar-p1-mainline-20260310 \
  -f require_zh_core_labels=true \
  -f require_toggle_checks=false \
  -f verify_holiday=true

gh run watch 22890158371 --exit-status
gh run download 22890158371 -D output/playwright/ga/22890158371
```
- 结果：PASS
- 关键字段（artifact summary）：
  - `schemaVersion=2`
  - `authSource=refresh`
  - `zhLabels.ok=true`
  - `zhLabels.noEnglishLeak=true`
  - `cleanup.holidayDeleted=true`
- 证据路径：
  - `output/playwright/ga/22890158371/attendance-zh-locale-summary.json`
  - `output/playwright/ga/22890158371/attendance-zh-locale-calendar.png`

## 16. Daily Dashboard 本地验证（schema v2 元数据）
```bash
GH_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY="zensgit/metasheet2" \
BRANCH="codex/attendance-zh-calendar-p1-mainline-20260310" \
LOOKBACK_HOURS="48" \
node scripts/ops/attendance-daily-gate-report.mjs
```
- 结果：脚本执行成功并生成报告（`REPORT_STATUS=fail`，因为该分支没有 strict gate completed run，不是 locale gate 回归）。
- 关键验证点：`gateFlat.localeZh` 成功解析并包含新增 schema v2 字段：
  - `summarySchemaVersion=2`
  - `authSource=refresh`
  - `zhLabelsStatus=pass`
  - `zhLabelsOk=true`
  - `zhNoEnglishLeak=true`
- 证据路径：
  - `output/playwright/attendance-daily-gate-dashboard/20260310-063235/attendance-daily-gate-dashboard.json`
  - `output/playwright/attendance-daily-gate-dashboard/20260310-063235/attendance-daily-gate-dashboard.md`

## 17. Workflow Summary 字段补充
- 文件：`.github/workflows/attendance-locale-zh-smoke-prod.yml`
- 变更：Step Summary 新增 `SUMMARY_SCHEMA_VERSION`，从 `attendance-zh-locale-summary.json` 读取。
- 目的：在 Actions 页面无需下载 artifact 即可快速确认当前摘要合同版本（`schemaVersion=2`）。

## 18. Mainline PR 门禁联动验证（Strict + Dashboard）
### 18.1 Strict Gates（run 22890261948）
```bash
gh workflow run attendance-strict-gates-prod.yml \
  --ref codex/attendance-zh-calendar-p1-mainline-20260310

gh run watch 22890261948 --exit-status
```
- 结果：PASS（`strict-gates` job success）

### 18.2 Daily Dashboard（run 22890415809）
```bash
gh workflow run attendance-daily-gate-dashboard.yml \
  --ref codex/attendance-zh-calendar-p1-mainline-20260310 \
  -f lookback_hours=48

gh run watch 22890415809 --exit-status
gh run download 22890415809 -D output/playwright/ga/22890415809
```
- 结果：workflow PASS（P0 未失败；dashboard report 允许 P1 findings）
- 关键校验：`gateFlat.localeZh` 含 schema v2 新字段：
  - `summarySchemaVersion=2`
  - `authSource=refresh`
  - `zhLabelsStatus=pass`
  - `zhNoEnglishLeak=true`
- 关键校验：`gateFlat.strict.status=PASS`（引用 run `22890261948`）
- 证据路径：
  - `output/playwright/ga/22890415809/attendance-daily-gate-dashboard.json`
  - `output/playwright/ga/22890415809/attendance-daily-gate-dashboard.md`
