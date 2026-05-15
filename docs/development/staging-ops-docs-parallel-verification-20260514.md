# Staging Ops Docs Parallel Verification

## 验证环境

- 日期：2026-05-14
- Worktree：`<repo-worktree>`
- 分支：`codex/staging-ops-docs-20260514`
- 基线：最新 `origin/main`

## 范围检查

执行：

```bash
git ls-tree -r --name-only origin/main -- docs/development/staging-deploy-d88ad587b-20260426.md docs/development/staging-deploy-d88ad587b-postmortem-20260426.md docs/development/operations-docs-delivery-20260426.md docs/operations/staging-deploy-sop.md docs/operations/staging-migration-alignment-runbook.md
```

初始执行时无输出，确认这些文档当时尚未在 `origin/main`。后续 rebase 时，`origin/main` 已通过 `a0e5d9f85 docs: archive local planning and staging operation notes` 合入部分同名文档，因此本分支范围收缩为对主干文档做路径中立性修正，并新增本轮开发/验证说明。

执行：

```bash
git diff --name-only origin/main...HEAD
```

最终预期范围：

```text
docs/development/operations-docs-delivery-20260426.md
docs/development/staging-deploy-d88ad587b-20260426.md
docs/development/staging-ops-docs-parallel-development-20260514.md
docs/development/staging-ops-docs-parallel-verification-20260514.md
docs/operations/staging-deploy-sop.md
docs/operations/staging-migration-alignment-runbook.md
```

## 上游依赖检查

执行：

```bash
gh pr view 1190 --json number,title,url,state,mergedAt,mergeCommit
```

结果：

```text
state: MERGED
mergedAt: 2026-04-27T01:17:22Z
mergeCommit: 303ff0520119a296b6294a5a8812cffa97491f4e
```

结论：`migrate.ts --list/--rollback/--reset` 相关 SOP 前提已经合入主干。

## 路径中立性检查

执行：

```bash
rg -n "<real-staging-host>|<real-staging-ssh-user>|<local-home-pattern>|<temp-artifact-pattern>|<remote-stack-path-pattern>" docs/development/staging-deploy-d88ad587b-20260426.md docs/development/staging-deploy-d88ad587b-postmortem-20260426.md docs/development/operations-docs-delivery-20260426.md docs/operations/staging-deploy-sop.md docs/operations/staging-migration-alignment-runbook.md
```

结果：使用真实本地/远端路径和 staging host 模式执行扫描后，无命中。

占位符检查：

```bash
rg -n "<staging-host>|<staging-ssh-user>|<artifact-dir>|<staging-stack-dir>" docs/development/staging-deploy-d88ad587b-20260426.md docs/development/staging-deploy-d88ad587b-postmortem-20260426.md docs/development/operations-docs-delivery-20260426.md docs/operations/staging-deploy-sop.md docs/operations/staging-migration-alignment-runbook.md
```

结果：命中预期占位符。

## 敏感值检查

执行：

```bash
rg -n "(eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]|xox[baprs]-|gh[pousr]_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|SEC[0-9A-Za-z_-]{10,}|https://oapi\\.dingtalk\\.com/robot/send\\?access_token=|-----BEGIN [A-Z ]*PRIVATE KEY)" docs/development/staging-deploy-d88ad587b-20260426.md docs/development/staging-deploy-d88ad587b-postmortem-20260426.md docs/development/operations-docs-delivery-20260426.md docs/operations/staging-deploy-sop.md docs/operations/staging-migration-alignment-runbook.md
```

结果：无命中。

## Markdown/Whitespace 检查

执行：

```bash
git diff --check -- docs/development/operations-docs-delivery-20260426.md docs/development/staging-deploy-d88ad587b-20260426.md docs/development/staging-deploy-d88ad587b-postmortem-20260426.md docs/development/staging-ops-docs-parallel-development-20260514.md docs/development/staging-ops-docs-parallel-verification-20260514.md docs/operations/staging-deploy-sop.md docs/operations/staging-migration-alignment-runbook.md
```

结果：无输出。

## 当前结论

本轮是 docs-only 交付。文档范围、路径中立性、敏感值扫描和 whitespace 检查均通过；未执行真实 staging 操作。
