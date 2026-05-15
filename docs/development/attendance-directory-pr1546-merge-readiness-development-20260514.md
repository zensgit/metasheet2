# Attendance and Directory PR 1546 Merge Readiness Development

## 背景

PR #1546 已经完成上游对齐、live acceptance readiness 记录和远端 CI 验证。本轮继续执行收口建议：推进 PR 合并准备，确认是否可以直接 merge，若被仓库保护规则或分支状态阻塞，则留下可追溯证据。

PR:

```text
https://github.com/zensgit/metasheet2/pull/1546
```

## 本轮执行

本轮先复核 PR 状态：

- `state`: `OPEN`
- `mergeable`: `MERGEABLE`
- `reviewDecision`: `REVIEW_REQUIRED`
- 已有 GitHub checks：全部 `SUCCESS`
- PR commit 数：2

随后尝试普通 squash merge，不使用 `--admin` 或绕过权限：

```bash
gh pr merge 1546 --squash --delete-branch --subject "docs(attendance): record upstream delivery reconciliation" --body "Docs-only closeout for attendance/directory upstream reconciliation and live acceptance readiness."
```

GitHub 拒绝 merge，原因是 head branch 不在最新 base branch 上：

```text
X Pull request zensgit/metasheet2#1546 is not mergeable: the head branch is not up to date with the base branch.
To have the pull request merged after all the requirements have been met, add the `--auto` flag.
To use administrator privileges to immediately merge the pull request, add the `--admin` flag.
```

本轮没有使用 `--admin`。随后执行正常 rebase：

```bash
git fetch origin main
git rebase origin/main
```

结果：rebase 成功，无冲突。

## 当前策略

本轮采用普通分支更新和 review/auto-merge 路径：

- 不使用管理员 bypass；
- 不绕过 review requirement；
- 将分支更新到最新 `origin/main`；
- 追加本开发/验证说明；
- 推送后重新等待 GitHub checks；
- 若 GitHub 允许，设置 auto-merge；否则保留为 `REVIEW_REQUIRED` 阻塞。

## Auto-Merge

分支更新后，执行普通 auto-merge 设置：

```bash
gh pr merge 1546 --squash --delete-branch --auto --subject "docs(attendance): record upstream delivery reconciliation" --body "Docs-only closeout for attendance/directory upstream reconciliation, live acceptance readiness, and PR merge readiness."
```

该命令不使用 `--admin`，不会绕过 review requirement。GitHub 接受 auto-merge 请求后，PR 会在 CI 和 review/branch protection 全部满足后自动 squash merge。

## 非目标

本轮不新增功能代码、不修改 schema、不修改测试逻辑、不移动原工作区未跟踪文件。

## 后续动作

PR #1546 合并前仍需要：

- 分支更新后的 CI 全绿；
- 满足仓库 review/branch protection；
- 真实 live/staging acceptance 在具备后端、短期 admin JWT、真实 importer 账号和真实 DingTalk 目录数据后另行执行。

## 结论

PR #1546 的功能和文档范围已经收口。本轮发现并修复了 merge 前的 stale-head 状态；剩余合并条件是 GitHub 保护规则和最新一轮 CI。
