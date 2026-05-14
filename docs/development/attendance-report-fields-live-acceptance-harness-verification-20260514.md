# Attendance Report Fields Live Acceptance Harness Verification

日期：2026-05-14

## 范围

本轮验证覆盖：

- live acceptance 脚本语法。
- preflight 配置与阻塞分类。
- `AUTH_TOKEN_FILE` 读取、权限守卫、home 路径脱敏。
- 字段目录、记录查询、JSON 导出、CSV label/code 导出的 mock live 链路。
- CSV 字段指纹、字段数量、字段编码和 backing 响应头一致性。
- Markdown Evidence Summary 和敏感信息 allowlist 渲染。
- `scripts/multitable-auth.mjs` 的 `tokenSource` 兼容扩展。

## 命令与结果

```bash
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
node --check scripts/ops/attendance-report-fields-live-acceptance.test.mjs
node --check scripts/multitable-auth.mjs
node --check scripts/multitable-auth.test.mjs
```

结果：通过。

```bash
pnpm run verify:attendance-report-fields:live:test
```

结果：`11/11` 通过。

```bash
node --test scripts/multitable-auth.test.mjs
```

结果：`4/4` 通过。

```bash
OUTPUT_DIR=/tmp/metasheet-attendance-report-fields-live-preflight-20260514 \
TIMEOUT_MS=500 \
pnpm run verify:attendance-report-fields:preflight
```

结果：预期失败。本机 `127.0.0.1:8900` 后端未监听，脚本返回 exit `1`，并写入：

```text
/tmp/metasheet-attendance-report-fields-live-preflight-20260514/report.json
/tmp/metasheet-attendance-report-fields-live-preflight-20260514/report.md
```

关键 artifact 摘要：

```json
{
  "ok": false,
  "blocker": "BACKEND_UNREACHABLE",
  "checks": [
    ["config.required", true],
    ["api.health", false],
    ["runner.completed", false]
  ]
}
```

## 单测覆盖点

- live mode 缺少 `AUTH_TOKEN` / `AUTH_TOKEN_FILE` / `ALLOW_DEV_TOKEN=1` 和 `CONFIRM_SYNC=1` 时配置校验失败。
- preflight mode 不要求认证和同步确认。
- preflight mode 只请求 `/api/health`，不会调用 `/api/auth/me` 或 `POST /api/attendance/report-fields/sync`。
- 不可读、空文件、非普通文件或权限不安全的 `AUTH_TOKEN_FILE` 会归类为 `AUTH_TOKEN_FILE_INVALID`。
- `0644` token 文件会在读取 token 内容前被阻断。
- `$HOME` 下 token 文件路径会在 `report.json` / `report.md` 中显示为 `~/...`。
- mock live acceptance 会完成字段目录同步、记录查询、JSON 导出、CSV label 导出和 CSV code-header 导出。
- CSV label/code 导出会校验字段指纹、字段数量、字段编码和多维表 backing。
- Markdown 报告包含 `## Evidence Summary`。
- Markdown 报告不会渲染测试注入的 Bearer token 或 token 文件内容。
- auth helper 使用 `AUTH_TOKEN_FILE` 来源时，会记录 `api.auth-token` check 的 `source=AUTH_TOKEN_FILE`。

## 未执行项

- 未使用真实 staging/admin JWT 执行完整 live acceptance。
- 未调用真实 `POST /api/attendance/report-fields/sync`。
- 未进行浏览器 UI 点击验收。

这些未执行项是环境/凭据门禁，不是当前脚本单测失败。
