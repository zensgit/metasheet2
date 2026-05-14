# Attendance and Directory Live Acceptance Readiness Development

## 背景

上一轮已经确认考勤统计字段、导入员权限和 DingTalk 组织镜像能力在最新 `origin/main` 上有等价实现，并创建了 docs-only PR #1546 记录上游对齐结论。本轮继续执行建议中的下一步：进入真实验收准备，而不是继续开发重复功能代码。

## 本轮范围

本轮只做验收准备和证据补齐：

- 复核 PR #1546 的 GitHub 状态；
- 检查本地是否具备真实验收所需环境变量；
- 检查默认本地后端 `http://127.0.0.1:8900` 是否可达；
- 使用现有 `attendance-report-fields-live-acceptance` 脚本执行 preflight；
- 记录真实验收的待办、阻塞项和安全执行方式。

本轮不改功能代码、不改 schema、不读取或打印任何 token 内容。

## PR 状态

PR:

```text
https://github.com/zensgit/metasheet2/pull/1546
```

当前状态：

- State: `OPEN`
- Draft: `false`
- Mergeable: `MERGEABLE`
- Review decision: `REVIEW_REQUIRED`
- CI: 已全部通过

通过的 GitHub checks 包括：

- `contracts (strict)`
- `contracts (dashboard)`
- `contracts (openapi)`
- `pr-validate`
- `DingTalk P4 ops regression gate`
- `K3 WISE offline PoC`
- `test (18.x)`
- `test (20.x)`
- `after-sales integration`
- `coverage`

## 环境准备结论

本轮安全检查只确认变量是否存在，不输出值。当前本地未设置：

```text
BASE_URL
API_BASE
AUTH_TOKEN_FILE
TOKEN_FILE
AUTH_SOURCE
ORG_ID
USER_ID
DINGTALK_APP_KEY
DINGTALK_APP_SECRET
JWT_SECRET
```

默认后端探测：

```text
http://127.0.0.1:8900/api/health
```

结果：不可达，连接被拒绝。

## Preflight 执行

执行命令：

```bash
PREFLIGHT_ONLY=1 API_BASE=http://127.0.0.1:8900 OUTPUT_DIR=/tmp/metasheet-attendance-directory-live-preflight-20260514 pnpm run verify:attendance-report-fields:live
```

结果：脚本按预期输出环境阻塞，不进入真实同步或写配置流程。

生成证据：

```text
/tmp/metasheet-attendance-directory-live-preflight-20260514/report.json
/tmp/metasheet-attendance-directory-live-preflight-20260514/report.md
```

阻塞码：

```text
BACKEND_UNREACHABLE
```

## 后续真实验收执行方式

当后端、短期 admin JWT 文件和真实数据准备好后，使用以下模式执行统计字段真实验收：

```bash
chmod 600 /path/to/admin.jwt
BASE_URL=<backend> AUTH_SOURCE=AUTH_TOKEN_FILE AUTH_TOKEN_FILE=/path/to/admin.jwt CONFIRM_SYNC=1 pnpm run verify:attendance-report-fields:live
```

导入员权限验收：

- 使用 importer 账号登录；
- 验证可进入导入入口；
- 验证可预览和提交导入；
- 验证可查看导入批次；
- 验证不能进入规则和系统设置。

DingTalk 组织镜像验收：

- 使用真实 DingTalk 目录同步数据；
- 验证部门树加载；
- 验证绑定覆盖统计；
- 验证停用部门和非最新批次提示；
- 验证报告复制和部门 ID 回填流程。

## 结论

PR #1546 已具备合入条件中的技术检查部分，剩余是 review 和真实环境验收。真实验收当前被环境阻塞，不是产品代码失败；下一步需要提供可达后端、短期 admin JWT 文件、真实 importer 账号和真实 DingTalk 目录同步数据。
