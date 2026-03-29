# Remote Git Slice Submit Design

日期：2026-03-29

## 背景

远端 baseline clone 这条链已经能做到：

- bootstrap
- materialize
- promote
- handoff
- replay
- attest

但还缺 `submit` 这一层最终包装，用来回答：

- `142.171.239.56` 上的正式 baseline clone 是否也能独立形成最终 submit packet
- 远端 baseline clone 当前是否 clean、是否已经具备 GitHub ready 条件

## 目标

新增远端包装脚本：

- `scripts/ops/submit-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone
2. 上传 4 份上游 manifest：
   - remote promote
   - remote handoff
   - remote replay
   - remote attest
3. 在远端 baseline clone 中运行 `git-slice-submit`
4. 回收：
   - `report.json`
   - `manifest.json`
   - `README.md`
   - `submit-summary.md`
   - `submit-commands.sh`
5. 在本地形成统一回收目录，供后续文档、人工交接和 `remote land` 继续消费

## 为什么远端 submit 要在远端 baseline clone 内执行

因为远端 submit 关注的不只是 slice 是否 ready，还关注：

- 远端当前 baseline clone 的 `branch / head / ahead / behind / dirty`
- 远端 baseline clone 当前是否 `githubSyncReady`

这些信息必须在远端 baseline clone 内部读取，不能只靠本地推测。

## 默认输入来源

- remote promote：`output/remote-git-slice-promotions/<slice>/promoted/artifacts/manifest.json`
- remote handoff：`output/remote-git-slice-handoffs/<slice>/handoff/artifacts/manifest.json`
- remote replay：`output/remote-git-slice-replays/<slice>/replay/report.json`
- remote attest：`output/remote-git-slice-attestations/<slice>/attest/manifest.json`

这些文件都已经是“本地回收后的远端产物”，所以 wrapper 的职责是：

- 把它们重新送回远端 baseline clone
- 在正确上下文里生成最终 submit packet

## 输出

本地回收目录：

- `output/remote-git-slice-submissions/<slice>/verify`
- `output/remote-git-slice-submissions/<slice>/submit`

其中包含：

- `report.json`
- `exit-code`
- `artifacts/manifest.json`
- `artifacts/README.md`
- `artifacts/submit-summary.md`
- `artifacts/submit-commands.sh`

## verify 与 submit 的区别

### verify

- 远端生成 submit packet
- 但标记为 verify 模式
- 主要用于证明：脚本链路和当前远端 baseline clone 状态都正常

### submit

- 远端生成正式 submit packet
- 用于后续交接、归档、`remote land` 和 Git 收口继续推进

## 关键边界

### 1. baseline clone 与 deploy dir 分离

远端必须继续保持：

- baseline clone：`/home/mainuser/metasheet2-git-baseline`
- 现网部署目录：`/home/mainuser/metasheet2`

submit 只在 baseline clone 中执行，不进入 deploy dir。

### 2. 远端 `githubSyncReady` 可能为 true，而本地主工作树仍为 false

这是当前设计的核心价值之一：

- 远端正式 baseline clone 是 clean 的
- 本地主工作树仍然是 `ahead/behind/dirty`

submit 必须把这两种状态并列展示，而不是混成一个结论。

## CLI

入口：

- `pnpm verify:remote-git-slice-submit:directory-migration-baseline`
- `pnpm ops:submit-remote-git-slice:directory-migration-baseline`

## 非目标

- 不修改现网部署目录
- 不直接 push GitHub
- 不自动处理主工作树 `behind 4`
- 不把远端 baseline clone 的 clean 状态误当本地主工作树 clean

## 预期收益

远端链路正式推进为：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay
6. attest
7. submit

也就是：远端现在不仅能独立证明语义等价，还能独立生成 `remote land` 的正式输入，并给出“是否已经具备正式交接条件”的结构化答案。
