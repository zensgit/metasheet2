# Directory Baseline Git Publish Design

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

但 `land` 仍然停留在“已经得到 clean landed branch”。它证明分支可推送，不等于已经产出了正式可交付的发布包。

## 目标

新增 `git-slice-publish`：

1. 只消费 `land manifest`
2. 把 landed branch 产出为正式 publish packet
3. 在不触碰真实 GitHub 的前提下，额外做一次 `push-to-temp-bare` 验真
4. 输出：
   - `manifest.json`
   - `publish-summary.md`
   - `README.md`
   - `publish-commands.sh`
   - `commit-summary.md`
   - `request-pull.txt`
   - `request-pull-warning.txt`
   - `publish.bundle`
   - `bundle-verify.txt`

## 设计原则

### 1. publish 只消费 land

`publish` 不再重新读取 promote / replay / attest。

原因：

- `land` 已经证明 landed branch 是 clean push candidate
- `publish` 的职责是把“可推”推进成“可交付”

### 2. publish 不要求 branch 已经推到 GitHub

真实流程里，`request-pull` 对 GitHub URL 会要求远端已有 landed branch。

因此 `publish` 分成两层：

- 远端 URL request-pull 尝试
- 本地 repo fallback request-pull 预览

也就是说：

- 未 push GitHub 时不再把 publish 误判为失败
- 但会通过 `requestPullRemoteReady=false` 明确标出当前还只是 preview

### 3. verify 要证明“可发布”，不是“已发布”

`--verify` 不会触碰真实 `origin`，而是：

1. 创建临时 bare repo
2. 把 landed branch 推进去
3. 验证 pushed head 与 landed head 一致

这样能证明：

- branch 本身是 publishable 的
- 不需要真的 push GitHub

## 实现

脚本：

- `scripts/ops/git-slice-publish.mjs`

输入：

- `--land-manifest`
- `--repo-url` 可选，默认 `origin` URL

关键校验：

1. `land manifest.branchReadyForPush=true`
2. landed branch ref 仍存在
3. 当前 landed branch head 与 manifest 一致
4. `ahead=commitCount`
5. `behind=0`
6. `git bundle verify` 通过
7. `request-pull` 至少能生成 preview

## CLI

- `pnpm verify:git-slice-publish:directory-migration-baseline`
- `pnpm print:git-slice-publish:directory-migration-baseline`
- `pnpm print:git-slice-publish:directory-migration-baseline:groups`
- `pnpm publish:git-slice:directory-migration-baseline`

## 非目标

- 不直接 push GitHub
- 不修改当前主工作树
- 不替代 `land`

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

也就是：从“已经 landed”为止，再推进到“已经生成正式 publish packet，可直接进入最终 Git 收口或人工交接”。
