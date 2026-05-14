# Attendance Report Fields Live Host Header Verification

日期：2026-05-14

## 范围

本轮验证覆盖：

- `API_HOST_HEADER` 配置解析与非法值拒绝。
- 低层 HTTP/HTTPS requester 的语法与 mock 测试。
- 142 反代 Host 分流场景的 preflight。
- 142 真实 live acceptance：字段目录同步、记录查询、JSON/CSV 导出、字段指纹、字段编码和 CSV backing。

## 本地验证

```bash
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
node --check scripts/ops/attendance-report-fields-live-acceptance.test.mjs
pnpm run verify:attendance-report-fields:live:test
```

结果：

- `node --check`：通过。
- `pnpm run verify:attendance-report-fields:live:test`：`13/13` 通过。

新增覆盖：

- `validateConfig` 拒绝 `API_HOST_HEADER=http://localhost`。
- `renderHelp()` 展示 `API_HOST_HEADER=localhost`。
- preflight mock server 收到 `Host: metasheet.local`。
- Markdown artifact 展示 `Host header: metasheet.local`。

## 142 Preflight

命令：

```bash
API_BASE=http://142.171.239.56:8081 \
API_HOST_HEADER=localhost \
OUTPUT_DIR=/tmp/metasheet-attendance-host-preflight \
TIMEOUT_MS=8000 \
pnpm run verify:attendance-report-fields:preflight
```

结果：PASS。

关键 checks：

```json
[
  ["config.required", true],
  ["api.health", true, 200],
  ["preflight.completed", true],
  ["runner.completed", true]
]
```

## 142 Live Acceptance

命令：

```bash
AUTH_TOKEN_FILE=/tmp/metasheet-142-main-admin-72h.jwt \
CONFIRM_SYNC=1 \
API_BASE=http://142.171.239.56:8081 \
API_HOST_HEADER=localhost \
ORG_ID=default \
OUTPUT_DIR=/tmp/metasheet-attendance-report-fields-live-142-20260514 \
TIMEOUT_MS=15000 \
pnpm run verify:attendance-report-fields:live
```

结果：PASS。

Artifact：

```text
/tmp/metasheet-attendance-report-fields-live-142-20260514/report.json
/tmp/metasheet-attendance-report-fields-live-142-20260514/report.md
```

关键结果：

```json
{
  "ok": true,
  "hostHeader": "localhost",
  "projectId": "default:attendance",
  "sheetId": "sheet_75b4c963aa445cf3f96d29fe",
  "viewId": "view_d1d034d6227e8cfee00460c1",
  "catalogFieldCount": 34,
  "recordsFieldCount": 34,
  "exportFieldCount": 34,
  "csvFieldCount": 34
}
```

通过的关键链路：

- `api.health`
- `api.auth.me`
- `api.report-fields.read-before-sync`
- `api.report-fields.sync`
- `catalog.required-categories`
- `api.records.read`
- `api.export.json`
- `api.export.csv`
- `api.export.csv-code-header`
- `records-export.report-field-codes-match`
- `records-export.report-field-config-match`
- `catalog-records.report-field-fingerprint-match`
- `records-export.report-field-fingerprint-match`
- `export.csv.report-field-codes-match`
- `export.csv.report-field-backing-match`
- `export.csv-code.report-field-codes-match`
- `export.csv-code.report-field-backing-match`

## 安全检查

- 使用 `AUTH_TOKEN_FILE`，未在命令输出、MD 或 Git diff 中写入 token。
- token 文件权限检查通过，脚本记录为 owner-only。
- 报告只保留 token 来源、字段证据、状态码和低敏 metadata。

## 未覆盖项

- 本轮不执行浏览器 UI 点击验收。
- 本轮不验证其它 orgId 或隐藏字段手动切换场景。
- 本轮不部署 142；验证针对当前 142 运行中的服务。
