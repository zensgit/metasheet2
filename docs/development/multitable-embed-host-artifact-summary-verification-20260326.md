# Multitable Embed Host Artifact Summary Verification

## Scope Verified

本轮验证的是 embed-host 证据从 readiness 提升到更上层 pilot artifact 的链路是否闭环：

- `handoff.json`
- `handoff.md`
- `release-bound/report.json`
- `release-bound/report.md`

这次不再重复验证 embed-host runtime，而是验证 artifact promotion 是否正确消费 readiness 输出。

## Commands

在 `/Users/huazhou/Downloads/Github/metasheet2-multitable-next` 实际执行：

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
```

## Results

### Script syntax

通过：

- `node --check scripts/ops/multitable-pilot-handoff.mjs`
- `bash -n scripts/ops/multitable-pilot-release-bound.sh`

说明新增的 embed-host artifact wiring 没有引入语法或 shell 级错误。

### Artifact promotion regressions

`node --test scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs` 通过：

- `2 tests passed`

覆盖内容：

- `multitable-pilot-handoff.test.mjs`
  - readiness fixture 中的 `embedHostProtocol`
  - readiness fixture 中的 `embedHostNavigationProtection`
  - `embedHostAcceptance.ok = protocol.ok && navigationProtection.ok`
  - `handoff.json` 和 `handoff.md` 顶层都能看到这些字段

- `multitable-pilot-release-bound.test.mjs`
  - `release-bound.sh` 能从 `handoff.json` 继续提升 embed-host evidence
  - `report.json` 和 `report.md` 都能看到 protocol / navigation protection 的 PASS/FAIL

## Notes

这轮没有重复运行：

- `pnpm verify:multitable-pilot:readiness:test`
- embed-host runtime focused Vitest
- live smoke

原因是这条 slice 的唯一职责就是把已经存在于 readiness/handoff 的 evidence 再往上游 artifact 提升。它的风险面完全在脚本和模板，不在 runtime。

上游前提已经由前两轮覆盖：

- embed host protocol slice verification
  - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/docs/development/multitable-embed-host-protocol-slice-verification-20260326.md`
- embed host readiness promotion verification
  - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/docs/development/multitable-embed-host-readiness-promotion-verification-20260326.md`

## Outcome

embed-host 证据现在不再埋在 `readiness.json` 里。

它已经被提升到 pilot 交付链里最先被查看的两个层面：

- handoff
- release-bound

这样 operator / reviewer / sign-off owner 不需要再下钻 readiness 才能看到 embed-host 是否通过。
