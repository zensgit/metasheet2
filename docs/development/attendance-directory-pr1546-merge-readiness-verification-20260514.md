# Attendance and Directory PR 1546 Merge Readiness Verification

## 验证环境

- 日期：2026-05-14
- Worktree：`<repo-worktree>`
- 分支：`codex/attendance-directory-delivery-20260514`
- PR：`https://github.com/zensgit/metasheet2/pull/1546`

## 初始状态检查

执行：

```bash
git status --short
gh pr view 1546 --json number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,commits,baseRefName,headRefName
```

结果：

- worktree 干净；
- PR `OPEN`；
- PR 非 draft；
- `mergeable` 为 `MERGEABLE`；
- `reviewDecision` 为 `REVIEW_REQUIRED`；
- 所有已返回 checks 均为 `SUCCESS`。

## Merge 尝试

执行：

```bash
gh pr merge 1546 --squash --delete-branch --subject "docs(attendance): record upstream delivery reconciliation" --body "Docs-only closeout for attendance/directory upstream reconciliation and live acceptance readiness."
```

结果：未合并。GitHub 返回：

```text
X Pull request zensgit/metasheet2#1546 is not mergeable: the head branch is not up to date with the base branch.
```

结论：这是分支未同步最新 base 的 merge gate，不是文档内容或测试失败。

## Rebase 验证

执行：

```bash
git fetch origin main
git rebase origin/main
```

结果：

```text
Successfully rebased and updated refs/heads/codex/attendance-directory-delivery-20260514.
```

rebase 后最近提交：

```text
d3b5fe515 docs(attendance): record live acceptance readiness
c0c26c23b docs(attendance): record upstream delivery reconciliation
1f9061f56 test(multitable): add phase3 real smtp gate (#1544)
```

## Auto-Merge 验证

执行：

```bash
gh pr merge 1546 --squash --delete-branch --auto --subject "docs(attendance): record upstream delivery reconciliation" --body "Docs-only closeout for attendance/directory upstream reconciliation, live acceptance readiness, and PR merge readiness."
gh pr view 1546 --json autoMergeRequest,mergeable,reviewDecision,state,statusCheckRollup
```

结果：

- auto-merge 请求被 GitHub 接受；
- merge method 为 `SQUASH`；
- commit headline 为 `docs(attendance): record upstream delivery reconciliation`；
- `mergeable` 仍为 `MERGEABLE`；
- `reviewDecision` 仍为 `REVIEW_REQUIRED`；
- PR 保持 `OPEN`，等待剩余 CI 和 review/branch protection。

## 本轮文档验证

本文件和对应 development 文件新增后，执行：

```bash
git diff --check -- docs/development/attendance-directory-pr1546-merge-readiness-development-20260514.md docs/development/attendance-directory-pr1546-merge-readiness-verification-20260514.md
rg -n "(eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]|xox[baprs]-|gh[pousr]_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|SEC[0-9A-Za-z_-]{10,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=|-----BEGIN [A-Z ]*PRIVATE KEY)" docs/development/attendance-directory-pr1546-merge-readiness-development-20260514.md docs/development/attendance-directory-pr1546-merge-readiness-verification-20260514.md
```

结果：

- whitespace 检查无输出；
- sensitive pattern scan 无命中。

## 当前结论

本轮完成了 merge-readiness 复核、普通 merge 尝试和 stale-head 修正。PR #1546 仍应通过正常 review/branch protection 流程合并；不建议使用 admin bypass。
