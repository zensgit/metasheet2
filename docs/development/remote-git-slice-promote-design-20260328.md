# Remote Git Slice Promote Design

日期：2026-03-28

## 背景

远端 baseline clone 已经能完成 materialize，但后续 Git 收口还缺最后一层：

- 已经在远端 baseline clone 上生成的 `materialized/*` 分支
- 能否继续在远端 clean baseline 上 replay 成 `promoted/*` 分支
- 并把 promote report / manifest / patch 回收到本地

如果没有这层，远端仍停留在“可复现物化”，还没有推进到“可正式交接 clean branch”。

## 目标

新增远端 promote 包装脚本：

- `scripts/ops/promote-remote-git-slice.sh`

要求：

1. 先 bootstrap 远端 baseline clone
2. 默认读取本地 remote materialize report，自动解析 `sourceBranch`
3. 把 promote 核心脚本上传到远端
4. 在远端 baseline clone 内执行 promote
5. 拉回 `report + manifest + patch`
6. `--verify` 模式默认不保留 promoted branch
7. 正式模式保留 promoted branch

## 方案

### 1. 来源 branch 解析

远端 promote 默认读：

- `output/remote-git-slice-materializations/<slice>/materialized/report.json`

兼容回退：

- `output/remote-git-slice-materializations/<slice>/materialized-direct/report.json`

从中解析：

- `report.branchName`

也允许显式传：

- `--source-branch`

### 1.1 并发稳健性

remote promote 会先调用 `bootstrap-remote-git-baseline.sh`。如果同时还有别的 baseline 工具在刷新同一旁路 clone，可能短暂撞上：

- `could not lock config file .git/config: File exists`

本轮已在 wrapper 里补有限重试，避免这类短暂锁竞争直接让 promote 失败。

### 2. 远端执行边界

远端 promote 只在：

- `/home/mainuser/metasheet2-git-baseline`

执行，不触碰：

- `/home/mainuser/metasheet2`

这样运行目录与 Git baseline 目录继续分离。

### 3. 上传内容

payload 仅包含：

- `git-slice-promote.mjs`
- `git-slices.mjs`

promote 的输入不是本地源码快照，而是远端已存在的 materialized branch，所以不需要再上传 slice source snapshot。

### 4. 回收产物

本地输出目录：

- `output/remote-git-slice-promotions/<slice>/verify`
- `output/remote-git-slice-promotions/<slice>/promoted`

回收内容：

- `report.json`
- `exit-code`
- `artifacts/manifest.json`
- `artifacts/*.patch`

### 5. 远端收口价值

这样就能验证两件事：

1. 远端 baseline clone 上的 materialized branch 确实可 replay
2. replay 完成后，远端 baseline 主工作树仍保持 clean，不被 promote 污染

## 非目标

- 不自动 push promoted branch 到 GitHub
- 不自动切换现网部署
- 不把远端 deploy dir 改造成 Git 仓库

## 预期收益

远端工具链从：

- baseline bootstrap
- remote materialize

进一步推进到：

- remote promote
- remote materialized branch -> promoted branch clean replay
- 本地与远端均能对同一条 Git slice 做正式交接预演
