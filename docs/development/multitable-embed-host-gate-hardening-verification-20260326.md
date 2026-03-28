# Multitable Embed Host Gate Hardening Verification

## Commands

在 `/Users/huazhou/Downloads/Github/metasheet2-multitable-next` 实际执行：

```bash
pnpm verify:multitable-pilot:readiness:test
pnpm verify:multitable-pilot:release-gate:test
node --check scripts/ops/multitable-pilot-readiness.mjs
bash -n scripts/ops/multitable-pilot-release-gate.sh
```

## Results

- `pnpm verify:multitable-pilot:readiness:test`
  - passed
- `pnpm verify:multitable-pilot:release-gate:test`
  - passed
- `node --check scripts/ops/multitable-pilot-readiness.mjs`
  - passed
- `bash -n scripts/ops/multitable-pilot-release-gate.sh`
  - passed

## What changed in the assertions

### Readiness

baseline fixture 现在默认包含：

- full embed-host protocol evidence
- full embed-host navigation protection evidence

focused failure tests改成验证“required check 缺失时 fail”，而不再验证旧的 “partial evidence appeared” 语义。

### Release gate

`web.vitest.multitable.contracts` 的 canonical command 现在要求：

- `tests/multitable-embed-route.spec.ts`
- `tests/multitable-embed-host.spec.ts`
- `tests/multitable-client.spec.ts`
- `tests/view-manager-multitable-contract.spec.ts`

对应 shell test 已锁住完整命令串。

## Outcome

embed-host 现在已经同时进入：

- readiness required evidence
- pilot runbook acceptance bar
- release gate focused contract suite

这条线从“已经实现”进一步提升到“已经被 canonical gate 明确要求”。 
