# Multitable Embed Host Protocol Slice Verification

## Scope Verified

本轮验证覆盖以下能力：

- embed route leave guard
- host `mt:navigate` 的 `applied / deferred / blocked / superseded`
- `mt:get-navigation-state` / `mt:navigation-state`
- generated request id 与 explicit request id 回传
- dirty-state reporters 到 workbench 的 wiring
- live smoke 脚本的 embed-host harness 语法与路径接线

## Commands

在 `/Users/huazhou/Downloads/Github/metasheet2-multitable-next` 实际执行：

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-embed-host.spec.ts \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-phase5.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-view-manager.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit

pnpm --filter @metasheet/web build

node --check scripts/verify-multitable-live-smoke.mjs
```

## Results

### Focused frontend regressions

`vitest` 通过：

- `8 files / 70 tests passed`

关键覆盖包括：

- `multitable-embed-host.spec.ts`
  - route leave rejected
  - navigation state query
  - applied/deferred/blocked/superseded navigation result semantics
  - deferred replay request id echo
- `multitable-workbench-view.spec.ts`
  - workbench 内部 dirty / busy context switching behavior
- dirty reporter specs
  - form
  - import modal
  - field manager
  - view manager

### Type checking

`vue-tsc --noEmit` 通过。

### Production build

`@metasheet/web build` 通过。

构建结果中 `MultitableEmbedHost` 产物正常生成：

- `dist/assets/MultitableEmbedHost-*.css`
- `dist/assets/MultitableEmbedHost-*.js`

### Smoke script syntax

`node --check scripts/verify-multitable-live-smoke.mjs` 通过。

说明新的 embed harness、message helpers、dirty form smoke path 没有语法层问题。

## Notes

### What was not claimed

这轮没有声称已经完整跑通 live smoke 的真实环境联调，因为脚本依赖 API/Web 服务在线。

这轮确认的是：

- embed host smoke harness 已接入脚本
- 语法和调用链可加载
- 组件/协议层 focused regressions 已绿

### Why this is good enough for landing

这条 slice 的核心风险不在“某个纯函数是否正确”，而在：

- dirty-state 是否真的能冒泡到 workbench
- workbench defer/block policy 是否能稳定反映到 embed host 协议
- request id / state query / smoke harness 是否闭环

本轮验证已经把这三层都覆盖到了。

## Outcome

multitable embed host 现在不只是“能嵌进去”，而是已经具备：

- draft-safe route leave
- host-visible navigation result protocol
- host-queryable navigation state
- replay/supersede request correlation
- live smoke harness

这条线已经从内部组件行为，提升到了可联调、可 smoke、可 release evidence 接入的水平。
