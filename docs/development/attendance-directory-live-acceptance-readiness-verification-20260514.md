# Attendance and Directory Live Acceptance Readiness Verification

## 验证环境

- 日期：2026-05-14
- Worktree：`<repo-worktree>`
- 分支：`codex/attendance-directory-delivery-20260514`
- PR：`https://github.com/zensgit/metasheet2/pull/1546`

## 工作区复核

执行：

```bash
git status --short
```

结果：验证 worktree 在新增本轮文档前为干净状态。

原工作区 `<primary-worktree>` 仍只有此前已知的未跟踪 `.claude/`、`output/` 和历史 integration/K3/staging 文档；本轮未移动、删除或纳入这些文件。

## PR 远端状态

执行：

```bash
gh pr view 1546 --json statusCheckRollup,mergeable,reviewDecision,state,url
```

结果：

- `state`: `OPEN`
- `mergeable`: `MERGEABLE`
- `reviewDecision`: `REVIEW_REQUIRED`
- 所有已返回 GitHub checks 均为 `SUCCESS`

已通过 checks：

```text
contracts (strict)
contracts (dashboard)
contracts (openapi)
pr-validate
DingTalk P4 ops regression gate
K3 WISE offline PoC
test (18.x)
test (20.x)
after-sales integration
coverage
```

## 安全环境检查

执行的是变量存在性检查，不输出变量值：

```bash
node -e "const keys=['BASE_URL','API_BASE','AUTH_TOKEN_FILE','TOKEN_FILE','AUTH_SOURCE','ORG_ID','USER_ID','DINGTALK_APP_KEY','DINGTALK_APP_SECRET','JWT_SECRET']; for (const k of keys) console.log(k+'='+(process.env[k]?'set':'unset'))"
```

结果：上述变量均为 `unset`。

## 后端可达性检查

执行：

```bash
curl -fsS --max-time 3 http://127.0.0.1:8900/api/health || true
```

结果：

```text
curl: (7) Failed to connect to 127.0.0.1 port 8900 after 0 ms: Couldn't connect to server
```

## Preflight 验收

执行：

```bash
PREFLIGHT_ONLY=1 API_BASE=http://127.0.0.1:8900 OUTPUT_DIR=<artifact-dir> pnpm run verify:attendance-report-fields:live || true
```

结果：

```text
[attendance-report-fields-live-acceptance] FAIL
[attendance-report-fields-live-acceptance] ERROR: connect ECONNREFUSED 127.0.0.1:8900
```

脚本生成证据：

```text
<artifact-dir>/report.json
<artifact-dir>/report.md
```

报告摘要：

- Overall: `FAIL`
- Run mode: `preflight`
- API base: `http://127.0.0.1:8900`
- Blocker: `BACKEND_UNREACHABLE`
- Failing checks: `api.health`, `runner.completed`

该失败是环境未就绪，不是功能回归。

## 未执行项

未执行真实 live acceptance。缺少：

- 可达 backend；
- owner-only 短期 admin JWT 文件；
- 真实 importer 账号；
- 真实 DingTalk 目录同步数据。

## 当前结论

本轮完成了 PR 状态复核、CI 状态确认、环境变量安全检查、本地后端探测和 live acceptance preflight。PR #1546 技术检查已绿；真实验收的唯一当前阻塞是环境和凭据未准备。
