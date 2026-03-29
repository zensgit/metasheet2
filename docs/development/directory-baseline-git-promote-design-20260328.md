# Directory Baseline Git Promote Design

日期：2026-03-28

## 背景

`git-slice-materialize` 已经能把一个 slice 物化成真实提交链，但它解决的是：

- 当前 dirty 工作树如何安全变成一条旁路提交序列
- 如何导出 branch / manifest / patch 作为证据

它还没有解决一个更接近正式提交流程的问题：

- 已物化的提交链如何在不依赖 dirty 工作树的情况下，重放到一条“可正式交接”的 clean 分支
- 如何把 materialized branch 和正式 recut/promote branch 分开
- 如何在本地和远端 baseline clone 上复现同一条 promote 流程

## 目标

新增 `git-slice-promote`：

1. 以 `materialized branch` 或 `materialize manifest` 为输入
2. 基于同一个 `base ref` 新建临时 worktree
3. 按 commit group 顺序 `cherry-pick` 已物化的提交
4. 生成一条新的 `promoted/*` clean 分支
5. 导出新的 manifest 和 per-group patch
6. `--verify` 模式下自动清理 worktree 与 promote branch

## 非目标

- 不直接 push 到 GitHub
- 不自动合并 `behind 4`
- 不替代 `git-slice-materialize`
- 不直接在现网部署目录做 Git promote

## CLI 方案

脚本：

- `scripts/ops/git-slice-promote.mjs`

入口：

- `pnpm verify:git-slice-promote:directory-migration-baseline`
- `pnpm print:git-slice-promote:directory-migration-baseline`
- `pnpm print:git-slice-promote:directory-migration-baseline:groups`
- `pnpm promote:git-slice:directory-migration-baseline`

参数：

- `--slice <name>`
- `--group <id>`
- `--source-branch <name>`
- `--manifest <path>`
- `--base-ref <ref>`
- `--branch-name <name>`
- `--branch-prefix <name>`
- `--worktree-dir <path>`
- `--output-dir <path>`
- `--write-manifest <path>`
- `--verify`
- `--keep-worktree`
- `--json`

## 核心流程

### 1. 读取来源

promote 支持两种来源：

- `--source-branch`
- `--manifest`

如果传入 manifest，会自动拿到：

- `branchName`
- `baseRef`
- `slice`

这样 promote 可以直接消费上一轮 materialize 产物，而不是重新读取 dirty 工作树。

### 2. 校验来源提交布局

promote 会读取：

- `git rev-list --reverse <base>..<source-branch>`

然后把来源提交 subject 和当前 slice 的 `commitGroups` 做对齐检查。

支持两种布局：

1. `source branch` 含完整 slice 提交链
2. `source branch` 只含选中的 group 子集

如果提交消息顺序对不上，直接报 `SOURCE_BRANCH_LAYOUT_MISMATCH`，不允许在错误来源上继续 promote。

### 3. 基于 base ref 建立 clean promote worktree

流程与 materialize 类似：

1. `git worktree add --detach <temp-worktree> <base-ref>`
2. `git switch -c <promoted-branch> --no-track`
3. 在这个 worktree 里按顺序 `cherry-pick` 来源提交

这保证 promote 只依赖：

- upstream/base ref
- 已物化提交链

不再依赖当前 dirty 工作树。

### 4. 每组记录来源与新提交映射

每个 promoted group 都保留：

- `sourceCommitSha`
- `promotedCommitSha`
- `message`
- `committedFiles`
- `patchPath`

这样后续 PR/交接时，可以同时回答：

- 这组改动最初来自哪个 materialized commit
- promote 之后的新 SHA 是什么

### 5. verify 模式

`--verify` 不是静态检查，而是完整 promote 一轮后清理：

- 真正建 worktree
- 真正 cherry-pick
- 真正导出 patch / manifest
- 最后删除 promote branch 和临时 worktree

它验证的是“当前 materialized chain 能否被 clean replay”。

## 远端方案

新增远端包装脚本：

- `scripts/ops/promote-remote-git-slice.sh`

职责：

1. 先确保 `142.171.239.56:/home/mainuser/metasheet2-git-baseline` 存在且干净
2. 默认读取本地：
   - `output/remote-git-slice-materializations/<slice>/materialized-direct/report.json`
3. 从中解析远端 materialized source branch
4. 把 `git-slice-promote.mjs + git-slices.mjs` 上传到远端临时目录
5. 在远端 baseline clone 中执行 promote
6. 回收 `report.json / manifest / patch`
7. `--verify` 模式不保留 promoted branch；正式模式保留 branch 供后续 Git 收口

## 预期收益

这一步完成后，Git baseline 工具链会从：

- 报表
- bundle
- apply 预演
- materialize

再推进到：

- clean branch promote
- materialized chain -> promoted chain 的正式映射
- 本地与远端 baseline clone 都能做 promote 验证

这样后续真正做 Git 收口时，就不再停留在“我有一条旁路 branch”，而是已经具备“我有一条可正式交接的 clean 分支”。 
