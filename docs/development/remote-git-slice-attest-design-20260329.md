# Remote Git Slice Attest Design

日期：2026-03-29

## 背景

远端 baseline clone 这条链已经能做到：

- materialize
- promote
- handoff
- replay

但还缺一层正式包装，把“远端产物已经回收到本地”这件事进一步收口为：

- 远端产物与本地产物之间的归一化等价证明

## 目标

新增远端包装脚本：

- `scripts/ops/attest-remote-git-slice.sh`

职责：

1. bootstrap 远端 baseline clone，确认远端基线目录仍可用
2. 默认读取：
   - 本地 handoff / replay manifest
   - remote handoff / replay manifest
3. 调用本地 `git-slice-attest`
4. 输出 combined report：
   - remote bootstrap 状态
   - attestation report

远端 attestation 本身仍然比较 4 类证据：

- `patch-id`
- `numstatDigest`
- `summaryDigest`
- `pathSetDigest`

## 设计取舍

这个 wrapper 不在远端执行 attestation 逻辑本身。

原因：

- attestation 比较的是“本地 handoff/replay 输出”和“remote handoff/replay 回收输出”
- 这些回收产物已经都在本地
- 真正有价值的远端动作只是：
  - baseline clone 可达
  - baseline clone 仍 clean
  - baseline clone 仍在正确分支 / HEAD

因此 wrapper 的设计是：

- 远端只负责 baseline availability
- attestation 本身在本地完成
- 等价证明以本地回收的 remote artifacts 为准，而不是在远端另造一份口径

## 默认来源

- local handoff：`output/git-slice-handoffs/<slice>/manifest.json`
- local replay：`output/git-slice-replays/<slice>/manifest.json`
- remote handoff：`output/remote-git-slice-handoffs/<slice>/handoff/artifacts/manifest.json`
- remote replay：`output/remote-git-slice-replays/<slice>/replay/artifacts/manifest.json`

## CLI

脚本：

- `scripts/ops/attest-remote-git-slice.sh`

入口：

- `pnpm verify:remote-git-slice-attest:directory-migration-baseline`
- `pnpm ops:attest-remote-git-slice:directory-migration-baseline`

## 非目标

- 不修改现网部署目录
- 不 push 到 GitHub
- 不要求远端 commit SHA 与本地 commit SHA 一致
- 不把远端 bundle SHA 与本地 bundle SHA 当最终证明

## 预期收益

远端这条链最终推进为：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay
6. attest

即：远端不仅能产出和消费交接产物，还能被正式证明与本地链路语义等价。
