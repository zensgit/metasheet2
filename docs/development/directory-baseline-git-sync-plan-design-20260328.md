# Directory Baseline Git Sync Plan Design

日期：2026-03-28

## 背景

在 `git-baseline-report` 和 `git-slice-report` 之后，migration 基线这条线还缺一个关键问题的正式回答：

- 这组切片和当前 upstream 到底有没有路径重叠
- 当前 `behind` 的提交是否会打到这组文件
- 现在先收 migration 切片是否安全
- 当前切片是不是只是“可独立收口”，还是已经真的“可宣称与 GitHub 同步”

如果这一步仍靠人工临时跑 `git log / git diff-tree`，后续接手的人仍然要重复同一套判断。

## 目标

新增一个可执行的 `git-slice-sync-plan`，把“切片相对 upstream 的集成风险”固化成正式输出。

输出应包含：

1. 当前分支 / upstream / merge-base
2. ahead / behind 计数
3. 当前切片本地 dirty 路径
4. 当前切片在本地 ahead 提交中触及的路径
5. 当前切片在 upstream behind 提交中触及的路径
6. 双方重叠路径
7. 建议 stage 命令
8. 建议处理顺序
9. 切片可独立 stage 与 GitHub 同步 readiness 的分层结论

## 方案

### 1. 共享 slice 定义

新增：

- `scripts/ops/git-slices.mjs`

职责：

- 统一维护 `directory-migration-baseline` 的文件清单和建议提交顺序
- 供：
  - `git-slice-report.mjs`
  - `git-slice-sync-plan.mjs`
  共同复用

避免两个脚本各自复制一份 slice 名单后再漂移。

### 2. sync-plan 脚本

新增：

- `scripts/ops/git-slice-sync-plan.mjs`

CLI：

- `--slice <name>`
- `--upstream <ref>`
- `--json`
- `--list-slices`
- `--stage-command`
- `--verify`
- `--patch-file <path>`

行为：

- 自动取当前分支 upstream，除非显式指定 `--upstream`
- 读取：
  - `git merge-base`
  - `git rev-list --reverse HEAD..upstream`
  - `git rev-list --reverse upstream..HEAD`
  - `git status --short -- <slice paths>`
  - `git show --name-only <commit>`（逐提交路径）
- 生成：
  - `localDirtyPaths`
  - `localTrackedChangedPaths`
  - `localUntrackedPaths`
  - `localAheadCommits`
  - `upstreamBehindCommits`
  - `localAheadOverlapPaths`
  - `upstreamBehindPaths`
  - `overlapPaths`
  - `upstreamOnlyPaths`
  - `localOnlyPaths`
  - `stageCommand`
  - `stageReadiness`
  - `syncReadiness`

### 3. verify 规则

`--verify` 退出非零条件：

- 当前目录不是 Git worktree
- 当前分支无 upstream
- `syncReadiness.githubSyncReady = false`

设计理由：

- 这里需要明确拆成两层判断：
  - `stageReadiness.safeToStage`
    - 表示当前切片 dirty 路径与 upstream behind 提交无路径重叠，可先独立 stage 或导出 patch
  - `syncReadiness.githubSyncReady`
    - 表示当前分支不再 behind，且切片无 upstream 路径重叠，可以宣称“这条线与 GitHub 同步条件成立”
- 在当前仓库里，这两层结论并不相同：
  - migration baseline slice 可以先收
  - 但整个分支仍然不能说“已同步 GitHub”
- 因此 `--verify` 应绑定 `githubSyncReady`，而不是绑定“能否先切片”

### 4. 非 Git 目录友好失败

和前一轮 Git 工具保持一致：

- 若当前目录不是 Git 仓库
- 返回结构化：
  - `error=NOT_A_GIT_REPOSITORY`
  - `message=Current working directory is not a Git working tree.`
- 退出码：`2`

## 预期收益

这轮交付后，“是否先收 migration 切片”不再是口头判断，而是可以直接跑脚本得到：

1. upstream 是否碰到这组路径
2. 当前切片是否与 behind 提交重叠
3. 当前切片是否可先独立 stage
4. 当前是否仍然不能宣称“已同步 GitHub”

在当前仓库里，这一点尤其重要，因为真实风险不在 migration 切片本身，而在切片之外的大量 IAM / web / admin dirty 改动。
