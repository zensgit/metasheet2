# Directory Baseline Git Materialize Design

日期：2026-03-28

## 背景

前面的基线工具已经分别解决了三件事：

- `git-slice-report`：切片里有哪些文件
- `git-slice-sync-plan`：当前切片和 upstream 的 ahead / behind 风险关系
- `git-slice-bundle` / `git-slice-apply`：切片如何分组、如何安全暂存

但真正的 Git 收口还缺最后一层：

- 能不能在不碰当前 dirty worktree 的前提下
- 直接把一个 slice 物化成一串真实 commit
- 并给出 branch / manifest / patch 作为交付物

如果没有这层，前面的 slice/bundle 仍然停留在“可分析、可导出”，而不是“可安全落成正式提交序列”。

## 目标

新增 `git-slice-materialize`，把一个 slice 安全地物化到临时 worktree：

1. 默认基于当前分支 upstream 建立临时 worktree
2. 按 `commitGroups` 顺序逐组复制当前源码快照
3. 每组生成一个真实 commit
4. 支持导出每个 commit 的 patch 和整体 manifest
5. 默认不碰当前 dirty worktree
6. `--verify` 模式下可全链路跑完后自动清理 worktree 和 branch

## 非目标

- 不直接改写当前 worktree 的 index
- 不自动 push 到 GitHub
- 不自动处理 `behind 4` 这种分支同步问题
- 不把部署目录强行变成 Git 仓库

## CLI 方案

脚本：

- `scripts/ops/git-slice-materialize.mjs`

入口：

- `pnpm verify:git-slice-materialize:directory-migration-baseline`
- `pnpm print:git-slice-materialize:directory-migration-baseline`
- `pnpm print:git-slice-materialize:directory-migration-baseline:groups`
- `pnpm materialize:git-slice:directory-migration-baseline`

主要参数：

- `--slice <name>`
- `--group <id>`
- `--base-ref <ref>`
- `--source-root <path>`
- `--branch-name <name>`
- `--branch-prefix <name>`
- `--worktree-dir <path>`
- `--output-dir <path>`
- `--write-manifest <path>`
- `--verify`
- `--keep-worktree`
- `--json`

## 核心流程

### 1. 先校验 slice 定义

复用 `git-slices.mjs` 里的 `files + commitGroups`，并在 materialize 前再次检查：

- 是否所有 slice 文件都已被 commit group 覆盖
- 是否存在重复归组
- 是否存在 group 收了 slice 之外的文件

这样 materialize 不会在“提交阶段”才发现 bundle 本身就有结构问题。

### 2. 基于 upstream 建立临时 worktree

默认 base ref 取当前分支 upstream，例如：

- `origin/codex/attendance-pr396-pr399-delivery-md-20260310`

工具会：

1. 生成临时目录
2. `git worktree add --detach <temp-worktree> <base-ref>`
3. 在子 worktree 中 `git switch -c <branch> --no-track`
4. 在这个 worktree 里按 group 顺序提交

当前 dirty worktree 完全不参与 checkout / reset / stash。

### 2.1 并发稳健性

materialize 默认会自动生成 branch 名：

- `prefix / slice / timestamp / pid / random suffix`

这样可以避免并发运行时的 branch name 冲突。

另外，`git worktree add` 如果短暂遇到 `.git/config` 锁，会做有限重试；同时避免使用 `git worktree add -b`，从根上绕开“先留下 branch ref，再因 config lock 失败”的半成功状态。

### 3. 按 group 复制当前源码快照

每个 commit group 的文件都从 `source root` 复制到临时 worktree 对应位置：

- 默认 `source root = 当前工作目录`
- 远端包装场景下，可显式指定：
  - `--source-root <payload/source>`

- 源存在：复制文件
- 源不存在但 base 中存在：删除并 stage removal
- 源和目标都不存在：直接报 `MISSING_GROUP_FILES`

这样能明确区分：

- 真正的删除
- 组定义写错或文件根本没落盘

### 4. 每组提交一个真实 commit

每组执行：

1. `git add -A -- <group files>`
2. 检查 staged diff 是否为空
3. `git commit -m <group.message>`
4. 记录 commit SHA、staged files、patch path

如果某组在 base ref 上物化不出差异，会直接报 `EMPTY_GROUP_MATERIALIZATION`，不会悄悄生成空提交。

### 5. 导出 manifest 与 patch

如果指定 `--output-dir`，会写出：

- `manifest.json`
- `01-<group>.patch`
- `02-<group>.patch`
- ...

这和 `git-slice-bundle` 的“原始 patch”不同，这里导出的是已经按 base ref 物化后的真实 commit patch。

### 6. verify 模式走完整链但不留分支

`--verify` 的设计目标不是“只做语法检查”，而是：

- 真正建立临时 worktree
- 真正生成 commit 序列
- 真正导出 manifest / patch
- 最后自动删除临时 branch 和 worktree

因此它验证的是“这条 slice 现在能不能被安全物化成真实提交”，而不是停留在静态分析层。

## 输出

materialize 报告包含：

- `baseRef / baseSha`
- `branchName / head`
- `selectedGroupsCount / commitCount`
- `groups[].commitSha`
- `groups[].patchPath`
- `verifyPassed`
- `cleanup.worktreeRemoved / branchDeleted / tempParentRemoved`

## 预期收益

这一步完成后，`directory-migration-baseline` 不再只是：

- 可分析
- 可判断同步风险
- 可导出 patch

而是进一步具备：

- 可在安全 worktree 中物化
- 可形成真实 commit 序列
- 可给出 branch / commit / patch / manifest 四层证据
- 可在不污染主 worktree 的前提下推进 GitHub 收口

这使 Git baseline 工具链从“分析工具”推进成了“安全收口工具”。 
