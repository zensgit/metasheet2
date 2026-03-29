# Directory Baseline Host Runtime And Git Slice Design

日期：2026-03-28

## 背景

上一轮已把 `142.171.239.56` 的 migration tracking 修回绿色，但工程基线还剩两个薄弱点：

1. 宿主机 `mainuser` 缺少稳定的“直接执行工程脚本”的运行入口，导致审计主要依赖容器。
2. Git 基线虽然已经有报告与切片文档，但还缺一个可执行脚本把“这组文件到底是什么、怎么 stage”变成正式输出。

## 目标

1. 让宿主机关键源码路径具备稳定写权限，并明确宿主机与容器的职责边界。
2. 给 `mainuser` 提供用户态 Node / pnpm 运行时，而不是继续依赖“容器里有 Node、宿主机没有”。
3. 新增 Git slice 报告脚本，把 migration 基线修复切片收口成：
   - 文件总数
   - tracked / untracked / clean / missing
   - bucket 分布
   - 建议 `git add` 命令
   - 建议提交顺序
4. 给根 `package.json` 增加 slice 验证与输出入口，避免后续继续靠手工筛文件。
5. 让 Git 基线脚本在非 Git 目录里友好失败，而不是直接抛出 Node stack trace。

## 方案

### 1. 宿主机源码目录修复

对 `142.171.239.56`：

- 修复 `/home/mainuser/metasheet2/packages/core-backend` ownership 为 `mainuser:mainuser`
- 把 migration CLI、审计脚本、migration 文件、测试与基线文档同步回宿主机源码目录

### 2. 宿主机用户态 Node 运行时

新增脚本：

- `scripts/ops/install-user-node-runtime.sh`

职责：

- 下载并安装用户态 Node 20
- 在 `~/.local/bin` 建立 `node / npm / npx / corepack` 软链接
- 用 `corepack` 激活用户态 `pnpm`
- 把 `~/.local/bin` 追加到 `~/.profile` / `~/.bashrc`
- 清理之前一次性修复留下的无条件 PATH 追加

宿主机运行边界：

- 宿主机源码目录用于保存可追溯源码副本
- 现阶段可靠执行环境仍以 `metasheet-backend` 容器为准
- 若后续确需直接在宿主机执行 Node 脚本，再单独补宿主机 Node 运行时

### 3. Git slice 报告脚本

新增：

- `scripts/ops/git-slice-report.mjs`

首个内建 slice：

- `directory-migration-baseline`

脚本能力：

- `--list-slices`
- `--slice <name>`
- `--json`
- `--verify`
- `--stage-command`

输出内容：

- 切片描述
- 总文件数
- present / missing
- tracked changed / untracked / clean
- bucket 分布
- 建议 `git add -- ...`
- 建议提交顺序

### 4. 非 Git 目录友好失败

适用脚本：

- `scripts/ops/git-baseline-report.mjs`
- `scripts/ops/git-slice-report.mjs`

行为：

- 若当前目录不是 Git working tree，则返回结构化：
  - `error=NOT_A_GIT_REPOSITORY`
  - `message=Current working directory is not a Git working tree.`
- 退出码：`2`

### 5. 根脚本入口

新增根脚本：

- `verify:git-slice:directory-migration-baseline`
- `print:git-slice:directory-migration-baseline`
- `print:git-slice:directory-migration-baseline:stage`

## 非目标

本轮不做：

- 自动 commit / 自动 push
- 自动解决当前分支 `behind 4`
- 自动把大工作树拆成多个 branch

## 结果

这轮交付后，migration 基线收口从“有文档说明”推进到：

1. 宿主机关键源码目录可维护
2. 切片可脚本化复查
3. stage 命令可直接生成
4. 提交顺序可从脚本和文档两端复核
