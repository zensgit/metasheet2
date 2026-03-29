# Directory Baseline Git Deliver Design

日期：2026-03-29

## 背景

`directory-migration-baseline` 已经具备：

- materialize
- promote
- handoff
- replay
- attest
- submit
- land
- publish

但 `publish` 的职责仍然是“生成可交付包”，并不意味着 landed branch 已经真正推到了目标远端。

## 目标

新增 `git-slice-deliver`：

1. 只消费 `publish manifest`
2. 把 landed branch 真正推送到目标远端分支
3. 在 verify 模式下仍然避免触碰真实 GitHub，而是推送到临时 bare repo 验真
4. 输出：
   - `manifest.json`
   - `deliver-summary.md`
   - `README.md`
   - `deliver-commands.sh`
   - `remote-head.txt`
   - `request-pull-remote.txt`
   - `compare-url.txt`
   - `commit-summary.md`

## 设计原则

### 1. deliver 只消费 publish

`deliver` 不回头重新读取 `land / submit / replay`。

原因：

- `publish` 已经证明 landed branch 是完整、可交付、可 request-pull 的发布包
- `deliver` 的职责只是把这份发布包真正送到目标远端

### 2. verify 证明“可推送”，非 verify 才是真推送

`--verify` 不会触碰真实 GitHub，而是：

1. 创建临时 bare repo
2. 推送 upstream base branch
3. 推送 landed branch 到目标 remote branch
4. 再次 `ls-remote` 和 `request-pull`

这样能证明 deliver 流程本身正确，而不污染真实远端。

### 3. deliver 必须显式验证远端 head

真正交付不只看 `git push` 返回码，还要做：

- `git ls-remote --heads`
- 校验 remote head 是否等于 landed head

只有这样，`deliverReady=true` 才可信。

### 4. compare / branch URL 只在可推导 GitHub URL 时输出

`repoUrl` 可能是：

- `https://github.com/...`
- `git@github.com:...`
- `file://...`（verify）

只有 GitHub URL 才生成：

- `branchUrl`
- `compareUrl`
- `pullRequestUrl`

## 实现

脚本：

- `scripts/ops/git-slice-deliver.mjs`

输入：

- `--publish-manifest`
- `--repo-url` 可选，默认取 publish manifest 中的 `repoUrl`
- `--remote-branch` 可选，默认沿用 landed branch name

关键校验：

1. `publish manifest.publishReady=true`
2. landed branch ref 仍存在
3. 当前 landed branch head 与 manifest 一致
4. push 后 remote ref 存在
5. remote head 与 landed head 一致
6. remote `request-pull` 可生成

## CLI

- `pnpm verify:git-slice-deliver:directory-migration-baseline`
- `pnpm print:git-slice-deliver:directory-migration-baseline`
- `pnpm print:git-slice-deliver:directory-migration-baseline:groups`
- `pnpm deliver:git-slice:directory-migration-baseline`

## 非目标

- 不直接改主工作树
- 不替代 publish
- 不自动宣称“已同步整个仓库到 GitHub”

## 预期收益

工具链推进为：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay
9. attest
10. submit
11. land
12. publish
13. deliver

也就是：从“有正式 publish packet”推进到“目标远端已经存在 landed branch，并且远端 head 可证明确认一致”。
