# Directory Baseline Git Bundle Design

日期：2026-03-28

## 背景

`git-slice-report` 解决了“这组文件是什么”，`git-slice-sync-plan` 解决了“这组文件与 upstream 的关系是什么”，但 Git 基线仍缺最后一块正式交付物：

- 这组 slice 应该按哪几个提交切
- 每个提交具体收哪些文件
- 每个提交的 `git add` 命令能不能直接生成
- 能不能一键导出每个提交组的 patch 和 manifest

如果这些仍靠文档手工维护，后续很容易再次发生：

- 提交顺序漂移
- 文件重复归组
- 某些 slice 文件没人收
- 交接时只给口头说明，没有可验证产物

## 目标

新增 `git-slice-bundle`，把 slice 从“文件集合”推进成“可提交 bundle”：

1. 每个 slice 定义正式的 commit groups
2. 每个 group 有稳定 id、commit message、文件列表
3. 能输出每组 `git add` 命令
4. 能导出每组 patch 和整体 manifest
5. 能验证组定义是否覆盖完整、是否有重复归组

## 方案

### 1. 在 `git-slices.mjs` 中加入 commit groups

对 `directory-migration-baseline` 新增 `commitGroups`：

- `core-backend-migration-cli`
- `directory-iam-migrations`
- `ops-baseline-tooling`
- `migration-audit-tests`
- `migration-baseline-docs`

每组都带：

- `id`
- `message`
- `files`

这样 slice 清单和提交分组定义仍然在同一个中心文件里维护。

### 2. 新增 `git-slice-bundle.mjs`

CLI：

- `--slice <name>`
- `--list-slices`
- `--group <id>`
- `--json`
- `--verify`
- `--stage-command`
- `--export-dir <path>`
- `--write-manifest <path>`

行为：

- 读取 slice 的 `files + commitGroups`
- 校验：
  - 是否所有 slice 文件都被分组覆盖
  - 是否存在重复归组
  - 是否有 group 收了不在 slice 内的文件
- 统计每组当前状态：
  - `trackedChanged`
  - `untracked`
  - `missing`
  - `clean`
- 输出：
  - 整体 manifest
  - 每组 stage command
  - 可选 patch 导出

### 3. verify 规则

`--verify` 失败条件：

- 当前目录不是 Git worktree
- slice 未定义 commit groups
- 指定 group 不存在
- slice 存在未覆盖文件
- slice 存在重复归组
- 或 group 内存在缺失文件

这和 `git-slice-sync-plan` 的职责不同：

- `git-slice-sync-plan` 解决“是否适合先切”
- `git-slice-bundle` 解决“切的时候是否完整、是否可提交”

### 4. 导出产物

`--export-dir` 产物包括：

- `manifest.json`
- `<group-id>.patch`

用途：

- 交接
- 归档
- 审查提交边界
- 在正式 git 提交前先给出证据包

## 预期收益

这轮交付后，migration baseline slice 不再只是：

- 可分析
- 可判定是否与 upstream 冲突

而是进一步具备：

- 可分组提交
- 可导出 patch
- 可验证 coverage
- 可直接生成提交级 stage command

这一步是从“Git 基线分析工具”推进到“Git 基线收口工具”。 
