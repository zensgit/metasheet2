# Attendance and Directory PR 1546 Review Response Development

## 背景

PR #1546 收到 code-assist review，指出新增文档中包含本地绝对路径，建议替换为占位符以保护个人目录信息，并让文档更适合仓库长期保存。

Review 摘要：

```text
replace absolute local file paths with placeholders to protect privacy and maintain documentation neutrality
```

## 本轮改动

本轮只修改 PR #1546 的新增文档，不改功能代码、不改 schema、不改测试逻辑。

替换策略：

- 将个人主工作区路径替换为 `<primary-worktree>`；
- 将本轮验证 worktree 路径替换为 `<repo-worktree>`；
- 将 preflight 产物目录替换为 `<artifact-dir>`；
- 保留命令结构、PR 编号、CI 状态、错误码和真实验收步骤。

## 涉及文件

```text
docs/development/attendance-directory-upstream-reconciliation-development-20260514.md
docs/development/attendance-directory-upstream-reconciliation-verification-20260514.md
docs/development/attendance-directory-live-acceptance-readiness-development-20260514.md
docs/development/attendance-directory-live-acceptance-readiness-verification-20260514.md
docs/development/attendance-directory-pr1546-merge-readiness-verification-20260514.md
```

并新增本 review response 开发/验证说明。

## 非目标

本轮不重新执行真实 live acceptance。真实环境仍缺少可达后端、短期 admin JWT、真实 importer 账号和真实 DingTalk 目录同步数据。

## 结论

code-assist 的隐私/中立性反馈已处理。PR #1546 仍保持 docs-only 范围，auto-merge 保持普通 squash merge 路径，不使用 admin bypass。
