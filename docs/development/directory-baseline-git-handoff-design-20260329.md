# Directory Baseline Git Handoff Design

日期：2026-03-29

## 背景

`git-slice-promote` 已经能把一条 slice 变成：

- `promoted/*` clean branch
- manifest
- per-group patch

但它还缺最后一层“交付形态”：

- 如何把 promoted branch 直接打包成可移交给其他仓库/开发者的 handoff 产物
- 如何同时导出 `bundle + patch series + README + commit summary`
- 如何让 handoff 产物基于 promoted manifest 自动复现，而不是靠人工拼命令

## 目标

新增 `git-slice-handoff`：

1. 以 `promoted branch` 或 promote manifest 为输入
2. 校验 source branch 相对 base ref 的提交布局
3. 输出：
   - `bundle`
   - `patches/*.patch`
   - `manifest.json`
   - `README.md`
   - `commit-summary.md`
4. 支持 verify 模式，确保产物能在当前仓库真实生成
5. 为远端 baseline clone 的后续交接提供统一 payload 形态

## 非目标

- 不直接 push 到 GitHub
- 不自动创建 PR
- 不替代 promote；handoff 只消费 promote 结果
- 不在 handoff 阶段解决 `ahead / behind / dirty`

## CLI 方案

脚本：

- `scripts/ops/git-slice-handoff.mjs`

入口：

- `pnpm verify:git-slice-handoff:directory-migration-baseline`
- `pnpm print:git-slice-handoff:directory-migration-baseline`
- `pnpm print:git-slice-handoff:directory-migration-baseline:groups`
- `pnpm handoff:git-slice:directory-migration-baseline`

参数：

- `--slice <name>`
- `--group <id>`
- `--source-branch <name>`
- `--manifest <path>`
- `--base-ref <ref>`
- `--output-dir <path>`
- `--write-manifest <path>`
- `--verify`
- `--list-slices`
- `--list-groups`
- `--json`

## 核心流程

### 1. 来源解析

handoff 支持两种输入：

- `--source-branch`
- `--manifest`

如果输入 manifest，会自动继承：

- `slice`
- `branchName`
- `baseRef`

这样 handoff 可以直接接在 promote 之后。

### 2. 提交布局校验

handoff 会读取：

- `git rev-list --reverse <base>..<source-branch>`

再把提交 subject 与当前 slice 的 `commitGroups` 做匹配。

支持两种布局：

1. `source branch` 含完整 slice 提交链
2. `source branch` 仅含显式选中的 group 子集

如果使用 `--group`，但 source branch 仍是完整 slice 提交链，直接报错：

- `GROUP_HANDOFF_REQUIRES_GROUP_SOURCE`

原因很明确：group handoff 必须交接“已经被缩窄后的 promoted/group source”，不能对整条 promoted branch 假装只导出其中一组。

### 3. 交付物

handoff 输出目录包含：

- `<slice>.bundle`
- `patches/*.patch`
- `manifest.json`
- `README.md`
- `commit-summary.md`

其中：

- `bundle` 用于保留完整 Git 对象关系
- `patch series` 用于人工审阅和邮件式交付
- `README` 记录 bundle 校验与建议命令
- `commit summary` 记录 group 到 patch 的映射

### 4. Manifest 语义

handoff manifest 记录：

- `baseRef / baseSha`
- `sourceBranch / sourceHead`
- `bundleSha256`
- `patchFiles[*].sha256`
- `groups[*].sourceCommitSha`
- `groups[*].patchFileName`

这样后续不需要再反查 promote 产物，也能单独校验 handoff 交付物。

### 5. verify 模式

`--verify` 会完整执行 handoff 一次，并把结果写入 verify 输出目录。

它不是 dry-run，而是验证：

- bundle 可创建
- bundle 可验证
- patch series 可导出
- manifest / README / summary 可落盘

## 与现有链路的关系

当前链路已变成：

1. `report`
2. `sync-plan`
3. `bundle`
4. `apply`
5. `materialize`
6. `promote`
7. `handoff`

也就是：从“识别 dirty 改动”，已经推进到“生成最终交接包”。
