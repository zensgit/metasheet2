# Staging Ops Docs Parallel Development

## 背景

PR #1546 已经进入 review gate，继续向同一 PR 添加内容只会反复触发 CI，并不能推动合并。本轮按并行开发策略，选择一个与考勤/目录收口完全独立的 docs-only 切片：把 2026-04-26 staging deploy 事故复盘、手工部署 SOP 和 migration alignment runbook 从本地未跟踪状态整理成可 review 的运维文档分支。

分支创建后，`origin/main` 通过 `a0e5d9f85 docs: archive local planning and staging operation notes` 已合入部分同名文档。本分支随后 rebase 到最新 `origin/main`，最终范围缩小为：

- 对主干已有 staging ops 文档做路径中立性清洗；
- 更新 SOP 中关于 PR #1190 的过期未来时表述；
- 追加本轮并行开发和验证说明。

## 分支策略

本轮创建独立 worktree 和分支：

```text
<repo-worktree>
codex/staging-ops-docs-20260514
```

该分支基于最新 `origin/main`，不复用 PR #1546 的分支，不修改功能代码，不修改 schema。

## 交付范围

本轮涉及文档：

```text
docs/development/operations-docs-delivery-20260426.md
docs/development/staging-deploy-d88ad587b-20260426.md
docs/operations/staging-deploy-sop.md
docs/operations/staging-migration-alignment-runbook.md
```

配套新增本开发/验证说明：

```text
docs/development/staging-ops-docs-parallel-development-20260514.md
docs/development/staging-ops-docs-parallel-verification-20260514.md
```

## 内容处理

本轮保留了文档中的关键操作知识：

- docker-compose v1.29.2 与 Docker Engine 27+ 的 `ContainerConfig` 问题；
- 手工 image-pull 部署必须先做 migration diff；
- 不能只看 `/api/health`，必须做 authenticated round-trip；
- staging/prod-track 多栈同机时必须定位 backend 所在 network 的 postgres；
- `kysely_migration` tracking-state divergence 的 synthetic catch-up 和 full restore 分支；
- 失败时先保留 dump，再决定是否恢复。

同时做了文档中立性清洗：

- staging 主机 IP 替换为 `<staging-host>`；
- SSH 用户替换为 `<staging-ssh-user>`；
- 本机/远端栈路径替换为 `<staging-stack-dir>`；
- 临时产物目录替换为 `<artifact-dir>`。

## 已同步事实

文档引用的 `migrate.ts` flag fix 已合入：

```text
PR #1190 fix(core-backend): honor --list/--rollback/--reset in migrate.ts
mergedAt: 2026-04-27T01:17:22Z
```

因此 `staging-deploy-sop.md` 中不再使用“PR lands 后”的未来时表述。

## 非目标

本轮不执行真实 staging deploy，不登录远端主机，不运行 migration alignment，不处理 `output/` 目录，也不移动原工作区其他未跟踪文档。

## 结论

本轮把 staging deploy 事故的可复用经验整理为独立、路径中立、可 review 的运维文档切片。它可以与 PR #1546 并行 review，不互相阻塞；在主干已合入基础文档后，本分支保留为路径中立性和验证说明收口。
