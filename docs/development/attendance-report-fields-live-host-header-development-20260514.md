# Attendance Report Fields Live Host Header Development

日期：2026-05-14

## 背景

`#1530` 合入后，考勤统计字段 live acceptance harness 已经可以覆盖字段目录同步、记录查询、JSON/CSV 导出和字段证据链。但在 142 环境运行时发现一个部署层细节：

- `http://142.171.239.56:8081/api/health` 使用默认 `Host: 142.171.239.56:8081` 会被反代直接断开，表现为 empty reply。
- 同一地址使用 `Host: localhost` 或 `Host: metasheet.local` 可以正常返回 `/api/health`。

原 harness 使用 Node `fetch()`，不能可靠覆盖 `Host` header，因此无法在这类按 Host 分流的 staging 入口上完成 live acceptance。

## 改动

- `scripts/ops/attendance-report-fields-live-acceptance.mjs`
  - 新增 `API_HOST_HEADER` / `HOST_HEADER` 配置。
  - 新增 host header 格式校验，只允许 `host` 或 `host:port`，拒绝带协议、路径或凭据的值。
  - 将内部请求实现从 `fetch()` 切换为 `node:http` / `node:https`，保留原返回结构：`res.ok`、`res.status`、`res.headers.get()`、`json`、`text`。
  - `requestJson()`、preflight、auth helper dev-token fallback 和完整 live 链路都复用同一 host header。
  - Markdown 报告记录 `Host header`，便于复盘反代分流配置。
- `scripts/ops/attendance-report-fields-live-acceptance.test.mjs`
  - 新增非法 `API_HOST_HEADER=http://...` 配置拒绝用例。
  - 新增 preflight host header 透传用例，mock server 断言收到 `Host: metasheet.local`。
  - 保持既有 token-file、权限守卫、home 路径脱敏、CSV evidence 用例。

## 设计边界

- 不改变考勤业务 API。
- 不改变字段目录同步、记录查询或导出契约。
- 不把 token 或 Authorization header 写入报告。
- `API_HOST_HEADER` 是可选项；默认行为仍按 URL host 发送。
- 不自动修改 `/etc/hosts`，不要求本机 DNS 配置。

## 142 运行方式

```bash
AUTH_TOKEN_FILE=/tmp/metasheet-142-main-admin-72h.jwt \
CONFIRM_SYNC=1 \
API_BASE=http://142.171.239.56:8081 \
API_HOST_HEADER=localhost \
ORG_ID=default \
OUTPUT_DIR=/tmp/metasheet-attendance-report-fields-live-142-20260514 \
pnpm run verify:attendance-report-fields:live
```
