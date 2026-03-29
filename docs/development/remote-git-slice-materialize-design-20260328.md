# Remote Git Slice Materialize Design

日期：2026-03-28

## 背景

当前 Git baseline 工具链已经能在本地完成：

- slice 分析
- upstream 风险判断
- bundle commit groups
- alternate-index apply 预演
- 本地临时 worktree materialize

但这还缺一层关键闭环：

- 当前 slice 能不能在 `142.171.239.56` 的正式旁路 Git baseline clone 上复现
- 能不能不依赖远端部署目录
- 能不能把远端 materialize 的 report / patch / manifest 拉回本地

如果没有这层，当前工具链依然偏“本机收口”，而不是“本机和远端正式基线都能复现”。

## 目标

新增远端 materialize 包装脚本，把本地 slice 快照带到远端旁路 Git baseline clone 上执行：

1. 先确保远端 baseline clone 已存在且干净
2. 把当前 slice 的源码快照和 materialize 脚本一起打成临时 payload
3. 上传到远端
4. 在远端正式 Git clone 内执行 `git-slice-materialize`
5. 把 report / patch / manifest 拉回本地
6. `--verify` 模式默认不保留远端 branch
7. 正式 materialize 模式保留远端 branch，供后续 Git 收口

## 方案

### 1. 扩展 `git-slice-materialize`

先给本地 materialize 核心脚本补 `--source-root`：

- 默认仍使用当前 `cwd`
- 远端包装场景下，允许把上传到远端临时目录里的 slice 快照当作 source root

这样不需要把本地脏工作树本身搬过去，只需要搬：

- 当前 slice 文件快照
- `git-slice-materialize.mjs`
- `git-slices.mjs`

### 2. 新增远端包装脚本

脚本：

- `scripts/ops/materialize-remote-git-slice.sh`

职责：

1. 调用 `bootstrap-remote-git-baseline.sh`，确保远端旁路 Git clone 是最新且干净
2. 读取 slice 文件列表
3. 构建本地临时 payload：
   - `payload/source/<slice files>`
   - `payload/scripts/ops/git-slice-materialize.mjs`
   - `payload/scripts/ops/git-slices.mjs`
4. 打包成 `payload.tar.gz`
5. 通过 SSH/SCP 发到远端临时工作目录
6. 在远端 baseline clone 中执行：
   - `node .../git-slice-materialize.mjs --source-root <payload/source> --base-ref origin/<branch>`
7. 把远端 `report.json / artifacts/manifest.json / *.patch` 拉回本地
8. 默认清理远端临时工作目录

### 3. 输出边界

本地输出目录：

- `output/remote-git-slice-materializations/<slice>/verify`
- `output/remote-git-slice-materializations/<slice>/materialized`

本地保留：

- `report.json`
- `exit-code`
- `artifacts/manifest.json`
- `artifacts/<group>.patch`

远端保留规则：

- `--verify`：默认不保留 branch，且清理远端临时工作目录
- 非 verify：保留远端 materialized branch
- `--keep-remote-work-dir`：用于诊断时保留远端 payload 和 artifacts

### 4. 根脚本入口

新增：

- `pnpm verify:remote-git-slice-materialize:directory-migration-baseline`
- `pnpm ops:materialize-remote-git-slice:directory-migration-baseline`

### 5. 非目标

- 不直接在现网部署目录 `/home/mainuser/metasheet2` 上执行 materialize
- 不自动 push 到 GitHub
- 不自动把远端 materialized branch 推回 origin
- 不自动解决当前本地主工作树 `ahead 3 / behind 4 / dirty` 的主线同步问题

## 预期收益

这一步完成后，`directory-migration-baseline` 就不只是：

- 本地能 materialize
- 本地能导出 patch

而是进一步具备：

- 远端正式 Git baseline clone 可复现
- 本地与远端都能导出同一套提交证据
- 远端 verify 和正式 materialize 都有正式入口
- 后续 Git 收口时可以直接基于远端 branch 再做整理，而不是只依赖本机状态

这使 Git baseline 工具链从“本地安全收口工具”推进成“本地 + 远端一致性收口工具”。 
