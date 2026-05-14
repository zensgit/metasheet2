# Attendance Report Fields Live Acceptance Harness Development

日期：2026-05-14

## 背景

`#1529` 已把考勤统计字段目录接入多维表底座，管理端可以查看字段分类、字段编码、同步状态和多维表 backing 信息。下一步需要一个可复跑的 live acceptance harness，用于在本地、staging 或后续上线前验证：

- 字段目录 API 可读且可显式同步。
- 记录查询、JSON 导出、CSV label 导出和 CSV code-header 导出使用同一份字段目录配置。
- CSV 响应头携带字段指纹、字段数量、字段编码和多维表 backing 证据。
- 验收报告可直接归档，同时不泄漏 token 或本机私有路径。

## 实现内容

新增脚本：

```bash
scripts/ops/attendance-report-fields-live-acceptance.mjs
scripts/ops/attendance-report-fields-live-acceptance.test.mjs
```

新增 package 命令：

```bash
pnpm run verify:attendance-report-fields:live
pnpm run verify:attendance-report-fields:preflight
pnpm run verify:attendance-report-fields:live:test
```

`verify:attendance-report-fields:live` 会执行完整链路：

1. `GET /api/health`
2. token 解析与 `/api/auth/me`
3. `GET /api/attendance/report-fields`
4. `POST /api/attendance/report-fields/sync`
5. 再次读取字段目录并校验六类字段
6. `GET /api/attendance/records`
7. `GET /api/attendance/export?format=json`
8. `GET /api/attendance/export?format=csv`
9. `GET /api/attendance/export?format=csv&header=code`

`verify:attendance-report-fields:preflight` 只检查后端可达性，不要求 token，也不会调用同步接口。

## 认证输入

支持三种方式，优先级如下：

1. `AUTH_TOKEN` / `TOKEN`
2. `AUTH_TOKEN_FILE` / `TOKEN_FILE`
3. `ALLOW_DEV_TOKEN=1`

`AUTH_TOKEN_FILE` 路径增加安全守卫：

- 必须是普通文件。
- 文件权限必须是 owner-only，例如 `0600` 或 `0400`。
- group/other 有任意权限时阻断为 `AUTH_TOKEN_FILE_INVALID`。
- token 文件位于 `$HOME` 下时，artifact 中显示为 `~/...`，不记录真实 home 路径。

`scripts/multitable-auth.mjs` 增加可选 `tokenSource` 参数，仅用于验收 check 记录来源；默认仍为 `AUTH_TOKEN`，保持既有调用兼容。

## 证据输出

脚本固定输出：

```text
output/attendance-report-fields-live-acceptance/<timestamp>/report.json
output/attendance-report-fields-live-acceptance/<timestamp>/report.md
```

Markdown 报告包含：

- overall pass/fail
- blocker code 和 next actions
- check 明细
- Evidence Summary
- 字段指纹、字段数量、字段编码、CSV backing 低敏摘要

报告详情采用 allowlist 渲染，不把任意 request header、Bearer token、异常对象或 token 内容写入 Markdown。

## 设计边界

- 不修改考勤插件业务 API。
- 不修改多维表字段目录结构。
- 不触发同步，除非 live mode 同时提供 token 和 `CONFIRM_SYNC=1`。
- 不把真实 token 写入 `report.json` 或 `report.md`。
- 不替代浏览器 UI 验收；该 harness 是 API/导出/证据链验收入口。

## 推荐运行

真实环境：

```bash
AUTH_TOKEN_FILE=/tmp/metasheet-attendance-admin.jwt \
CONFIRM_SYNC=1 \
API_BASE=https://<staging-host> \
ORG_ID=default \
FROM_DATE=2026-05-01 \
TO_DATE=2026-05-14 \
OUTPUT_DIR=output/attendance-report-fields-live-acceptance/staging-20260514 \
pnpm run verify:attendance-report-fields:live
```

前置检查：

```bash
API_BASE=https://<staging-host> \
pnpm run verify:attendance-report-fields:preflight
```
