# Directory Baseline Git Apply Design

日期：2026-03-28

## 背景

`git-slice-bundle` 已经把 migration baseline slice 推进到了：

- 有正式 commit groups
- 有每组 `git add` 命令
- 有 manifest 与 patch 导出

但还缺最后一个关键能力：

- 在不污染当前真实 index 的前提下，验证每个 commit group 是否真的能被 stage
- 在需要时，把某个 group 精确应用到 alternate index
- 在极少数明确场景下，允许管理员显式应用到当前 index

如果这一步仍靠人工复制 `git add` 命令，不仅慢，而且容易直接污染当前脏工作树的 index。

## 目标

新增 `git-slice-apply`，把 bundle 从“静态提交定义”推进到“可安全 stage 的提交执行器”：

1. 默认使用 alternate index，避免污染当前 index
2. 支持按 group 单独 apply
3. 支持 dry-run 与 persisted alternate index
4. 支持导出 staged patch 与 apply manifest
5. 仅在显式确认时才允许写入当前 index

## 方案

### 1. CLI

- `--slice <name>`
- `--group <id>`
- `--list-slices`
- `--list-groups`
- `--json`
- `--verify`
- `--apply`
- `--use-current-index`
- `--index-file <path>`
- `--export-dir <path>`
- `--write-manifest <path>`

## 2. 默认安全模式

默认行为：

- 不写当前 index
- 为每个 group 创建 alternate index
- `git read-tree HEAD`
- 再对该 group 执行 `git add -- <files>`
- 输出：
  - `stagedFiles`
  - `patchBytes`
  - `patchEmpty`
  - `hasStagedChanges`
  - `treeHash`

这意味着即使当前工作树非常脏，也能先验证“这组提交是否真的可 stage”。

### 3. 风险开关

`--use-current-index` 只允许：

- 搭配 `--apply`
- 且必须指定单个 `--group`

原因很直接：

- 直接写当前 index 是危险动作
- 只能在管理员明确知道自己要 stage 哪一个 group 时开放

### 4. verify 规则

`--verify` 的职责不是判断 GitHub 是否同步，而是判断：

- 当前目录是不是 Git worktree
- 当前 slice / group 是否存在
- 当前 group 的文件是否都存在
- 当前 group 是否能成功 stage 到 alternate index
- 当前 group 是否真的形成非空 staged 结果

所以这层和 `git-slice-sync-plan` 不同：

- `sync-plan` 关注 upstream 风险
- `bundle` 关注分组完整性
- `apply` 关注 staged 执行是否安全、是否真实可行

如果 group 内有缺失文件，`git-slice-apply` 会返回结构化：

- `error=MISSING_GROUP_FILES`

避免继续落回 Git 的原始 pathspec 报错。

### 5. 导出产物

`--export-dir` 产物：

- `<group-id>.staged.patch`
- `apply-manifest.json`

用途：

- 提交前复核
- 交接
- 作为 staged 证据包

## 预期收益

这轮交付后，migration baseline 这条线将从：

- 可分析
- 可分组
- 可导出

进一步推进到：

- 可安全 stage
- 可验证每组是否真的可提交
- 可在不碰当前 index 的情况下预演提交结果

这一步是“真正开始 Git 收口”前最后一个安全层。 
