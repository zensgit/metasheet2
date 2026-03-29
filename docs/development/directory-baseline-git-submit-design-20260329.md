# Directory Baseline Git Submit Design

日期：2026-03-29

## 背景

`directory-migration-baseline` 这条 Git 基线链路已经能完成：

- materialize
- promote
- handoff
- replay
- attest

这意味着：

- 提交序列已经可以从 dirty worktree 中被独立物化
- handoff 产物已经可以在 fresh Git repo 中独立重放
- 本地与远端 baseline clone 已经被机器证明为语义等价

但还缺 `submit` 这一层正式交付：

- 给“这条 slice 现在是否已经具备提交/交接资格”一个结构化结论
- 输出面向人工交接、后续 `land`、以及真正 Git 收口的稳定 packet

## 目标

新增 `git-slice-submit`：

1. 读取 4 份上游 manifest：
   - promote
   - handoff
   - replay
   - attest
2. 校验整条链：
   - `baseRef` 一致
   - `baseSha` 一致
   - `commitCount` 一致
   - `promoted head == handoff source head == replay source head`
   - `replayed head == promoted head`
   - `bundleSha256` 一致
   - group 级 `patchSha256` 一致
   - group 级 `patchId / numstatDigest / summaryDigest / pathSetDigest` 已经被 attestation 证明等价
3. 输出 submit packet：
   - `manifest.json`
   - `submit-summary.md`
   - `README.md`
   - `submit-commands.sh`
4. 显式区分两类 readiness：
   - `sliceReadyForSubmission`
   - `currentWorktreeReadyForPush`
5. 作为 `git-slice-land` 的唯一正式输入

## 设计原则

### 1. submit 不重新证明 diff 语义

diff 语义等价已经由 `attest` 负责。

`submit` 的职责不是重复跑 `patch-id` / digest，而是做“阶段整合”：

- 把 promote / handoff / replay / attest 四阶段收拢成一份最终报告
- 给出是否可交接、是否可继续 Git 收口的清晰结论

### 2. submit 允许 slice ready，但拒绝把当前主工作树误判成 GitHub ready

当前仓库的真实状态可能仍然是：

- `ahead`
- `behind`
- `dirty`

所以 `submit` 必须明确区分：

- 这条 slice 自身是否已经足够稳定，适合交接
- 当前主工作树是否已经干净到可以直接 push

这两件事不能混淆。

### 3. submit 输出必须面向人工交接

除了 JSON report，还需要面向人类的：

- `README.md`
- `submit-summary.md`
- `submit-commands.sh`

这样后续无论是做 Git 收口、人工复核，还是给另一窗口/另一台机器继续推进，都不需要再回头读完整工具代码。

## 输入

脚本：

- `scripts/ops/git-slice-submit.mjs`

输入 manifest：

- promote manifest
- handoff manifest
- replay manifest
- attest manifest

默认不直接从工作树推导这四个阶段，而是要求显式输入。
原因：

- submit 应建立在“已验证的阶段产物”之上
- 避免把一份半成品物化结果误当正式交付链

## readiness 模型

### `sliceReadyForSubmission`

含义：

- 该 slice 的 promote / handoff / replay / attest 四阶段已经形成一致闭环
- 可以安全导出给后续 Git 收口或人工审阅使用

判定条件包括：

- `baseRefAligned`
- `baseShaAligned`
- `commitCountAligned`
- `promotedHeadMatchesHandoffSource`
- `promotedHeadMatchesReplaySource`
- `replayHeadMatchesPromotedHead`
- `bundleShaAligned`
- `groupPatchShasAligned`
- `groupPatchIdsAligned`
- `attestationAllEquivalent`
- `groupAttestationEquivalent`
- `promotedBranchExists`

### `currentWorktreeReadyForPush`

含义：

- 当前正在操作的主工作树本身已经干净并与 upstream 对齐
- 可以进一步讨论直接 push / GitHub 收口

这通常要求：

- 当前分支就是 promoted branch，或至少已切到明确的 clean 提交链
- `ahead/behind` 满足预期
- `dirty=false`

因此：

- `sliceReadyForSubmission=true` 不代表“代码已同步到 GitHub”
- `currentWorktreeReadyForPush=false` 也不否认该 slice 已具备交接价值

## 输出

### `manifest.json`

记录：

- 4 份上游 manifest 的路径
- 各阶段关键头信息
- 组级摘要
- 顶层 readiness
- 当前工作树基线状态

### `submit-summary.md`

用于快速贴结论：

- 当前 slice 是否 ready
- 当前主工作树是否 ready
- 关键 branch / head / bundleSha
- 后续建议动作
- 下一跳 `land` 的最短执行命令

### `README.md`

用于人工交接：

- submit packet 是什么
- 为什么 `sliceReadyForSubmission` 与 `githubSyncReady` 是两个概念
- 如何继续执行 `land`
- 如何继续做真正 Git 收口

### `submit-commands.sh`

提供最短命令路径：

- 查看 promoted branch
- 查看 handoff / replay / attest 证据
- 继续做人审或 Git 提交收口

## CLI

入口：

- `pnpm verify:git-slice-submit:directory-migration-baseline`
- `pnpm print:git-slice-submit:directory-migration-baseline`
- `pnpm print:git-slice-submit:directory-migration-baseline:groups`
- `pnpm submit:git-slice:directory-migration-baseline`

## 非目标

- 不直接 push 到 GitHub
- 不自动合并 `behind 4`
- 不修改现网部署目录
- 不把“当前主工作树 dirty”隐式掩盖掉

## 预期收益

工具链正式推进为：

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

也就是从“能证明这条 slice 等价”，推进到“能正式交接这条 slice，并把它推进到 landed branch 前的最后稳定输入”。
