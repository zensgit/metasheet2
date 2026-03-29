# Directory Baseline Git Replay Design

日期：2026-03-29

## 背景

`git-slice-handoff` 已经能输出：

- `bundle`
- `patch series`
- `manifest`
- `README`
- `commit summary`

但它还没有证明一件更关键的事：

- 这些 handoff 产物是否真能在一个 fresh Git 环境里独立还原出同一条提交链

## 目标

新增 `git-slice-replay`：

1. 以 handoff manifest 为输入
2. 在临时 fresh Git repo 中拉取 `baseRef`
3. 校验 `bundle` 和 `patches` 的 SHA
4. 从 bundle 重放出 replay branch
5. 校验：
   - `replayedHead == sourceHead`
   - commit 序列与 manifest 一致
   - 重新导出的 patch 与 handoff patch 完全一致
6. 输出 replay report、README、summary

## 非目标

- 不 push 到 GitHub
- 不替代 handoff
- 不在 replay 阶段解决当前主工作树的 `ahead / behind / dirty`

## CLI

脚本：

- `scripts/ops/git-slice-replay.mjs`

入口：

- `pnpm verify:git-slice-replay:directory-migration-baseline`
- `pnpm print:git-slice-replay:directory-migration-baseline`
- `pnpm print:git-slice-replay:directory-migration-baseline:groups`
- `pnpm replay:git-slice:directory-migration-baseline`

## 核心流程

### 1. 解析 handoff artifacts

优先读取 handoff manifest，并支持：

- manifest 里的绝对路径
- manifest 相邻目录中的 `bundle`
- manifest 相邻目录中的 `patches/*.patch`

这样 replay 不依赖 handoff 生成时的原始目录。

### 2. 构造 fresh Git 环境

replay 不复用当前 dirty repo 的 worktree，而是在临时目录里：

1. `git init`
2. `git remote add origin <repoUrl>`
3. `git fetch origin <baseRef>`
4. `git checkout --detach FETCH_HEAD`

### 3. 重放 bundle

在 fresh repo 里：

1. `git bundle verify <bundle>`
2. `git fetch <bundle> <sourceBranch>:refs/heads/<replayed-branch>`
3. `git switch <replayed-branch>`

然后校验：

- base SHA 与 manifest 一致
- replayed head 与 manifest `sourceHead` 一致
- `rev-list` 序列与 manifest `commits[]` 一致

### 4. 重新导出 patch 并比对

replay 会重新跑：

- `git format-patch --full-index --binary --abbrev=40 <baseSha>..HEAD`

并逐条校验：

- patch 文件名
- patch SHA-256

这样 handoff 就不只是“bundle 可验”，而是“bundle 重放后的 patch 也和原 handoff 保持一致”。

之所以显式固定 `--full-index --binary --abbrev=40`，是为了消除 `index` 行缩写长度差异导致的伪差异，保证不同 replay 环境下 patch 哈希稳定。

### 5. 读取 handoff 中的 bundle 元数据

handoff manifest 额外提供：

- `bundleFileName`
- `bundleRefName`

replay 优先消费这两个字段，而不是猜测 bundle 文件名或 ref 名称，避免后续 handoff 命名策略扩展时破坏重放逻辑。

## 预期收益

链路推进成：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay

也就是从“能切分改动”推进到“能证明交接包可独立重放”。
