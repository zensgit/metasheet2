# Multitable Embed Host Protocol Slice

## Goal

把 multitable embed host 从“只有基础 route mount”推进到一条真实可联调的宿主协议线，同时不把这次提交扩散到仍在变化的 workbench UI 功能面。

这条 slice 的目标不是再做一层外部 gate，而是把以下行为真正接起来：

- embed host route leave 草稿保护
- host `postMessage(mt:navigate)` 与 workbench 草稿/繁忙状态协同
- host `postMessage(mt:get-navigation-state)` 的可观测状态查询
- `mt:navigate-result` / `mt:navigated` 的 request correlation
- superseded / deferred / blocked / failed / applied 的 parent-facing 语义
- live smoke 中真实 `parent -> iframe -> postMessage` 验证

## Scope

### Runtime

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableEmbedHost.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue`

### Dirty-state reporters

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaFormView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaImportModal.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaFieldManager.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaViewManager.vue`

### Tests and smoke

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-embed-host.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-phase5.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-form-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-import-modal.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-field-manager.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-view-manager.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-multitable-live-smoke.mjs`

## Design

### 1. Keep dirty aggregation inside the workbench

dirty-state 的聚合继续由 `MultitableWorkbench` 持有，而不是把判断逻辑抬到 embed host。

workbench 聚合的 blocking sources 包括：

- form draft
- import draft
- field manager draft
- view manager draft
- comment draft
- form submit in-flight
- import in-flight

为了拿到这些信号，四个子组件只暴露一个最小接口：

- `update:dirty`

这样这次提交不会把子组件内部实现也重写成新的状态机，只是让它们把“当前是否存在未保存草稿”上报给 workbench。

### 2. Embed host only owns protocol, not business draft logic

`MultitableEmbedHost` 只做三件事：

- route leave 时调用 workbench 的 `confirmPageLeave()`
- 接收 host `mt:navigate`
- 接收 host `mt:get-navigation-state`

真正的 context sync、defer、replay、discard confirm 仍在 workbench 内部。

这让协议层与业务层有清晰边界：

- host 只知道“请求切换上下文”
- workbench 决定“现在能不能切、是否要 defer、是否被用户阻止”

### 3. Distinguish `mt:navigate-result` from `mt:navigated`

`mt:navigate-result` 负责表达本次 host 请求的处理结果：

- `applied`
- `deferred`
- `blocked`
- `failed`
- `superseded`

`mt:navigated` 只保留单一语义：

- 当前 effective context 已真正落到目标 `base/sheet/view`

这使 parent 不再需要靠“有没有等到 `mt:navigated`”去猜失败原因。

### 4. Request correlation is first-class

host 如果没带 `requestId`，embed host 会生成 `mt_nav_*`。

这个 request id 会贯穿：

- `mt:navigate-result`
- deferred replay 成功后的最终 `mt:navigate-result`
- 最终 `mt:navigated`
- live smoke evidence

这样 parent 能稳定地把一次 host 导航请求和最终结果对应起来。

### 5. Base-aware navigation must be complete

这次 slice 把 host 级 navigation 从原来的 “sheet/view override” 补成完整的 `base/sheet/view` 级同步：

- `overrideBaseId`
- `effectiveBaseId`
- `mt:ready`
- `mt:navigation-state`
- `mt:navigate-result`
- `mt:navigated`

都统一包含 base context。

### 6. Live smoke validates a real parent/iframe harness

`verify-multitable-live-smoke.mjs` 不再只测 in-app route，而是增加真实 embed-host harness：

- 同源 parent 页
- iframe 加载真实 `/multitable/:sheetId/:viewId?embedded=1`
- `window.postMessage`
- `mt:get-navigation-state`
- `mt:navigate`
- dirty form 场景下 blocked / confirmed 两条路径

这样 smoke 不只是“页面能打开”，而是直接覆盖到了 embed host 最有价值的协议行为。

## Why this slice is worth landing now

相较于继续只补外围 gate，这条 slice 的收益更高：

- 它把 dirty draft policy 真的接入了 embed host
- 它把协议变成 parent 可观测、可关联、可 smoke 的行为
- 它不要求先稳定 `MetaFieldManager / MetaFormView / MetaImportModal / MetaViewManager` 的全部 UI 重构，只需要它们上报 dirty
- 它直接提升了后续 pilot/staging 联调的可信度

## Non-goals

这次没有做：

- 新的 workbench 主功能
- field/view/import manager 的大交互改造
- embed host 跨域策略重写
- host 页面产品化 UI

这条提交只收协议、guard、state query 和 smoke harness。
