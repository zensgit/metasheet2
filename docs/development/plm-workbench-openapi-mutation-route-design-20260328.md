# PLM Workbench OpenAPI mutation route design

## Problem

上一轮补完了 `team view / team preset` 的 core list/save/batch/default contract，但高频 mutation 还缺一整段：

- duplicate
- transfer
- archive
- restore

这些路由已经被前端主流程直接调用，后端 runtime shape 也早就稳定；如果继续缺席 source OpenAPI，`dist-sdk` 仍然只能覆盖一半主线。

## Design

在 `packages/openapi/src/paths/plm-workbench.yml` 继续扩展第二阶段 mutation path：

- team view
  - `/views/team/{id}/duplicate`
  - `/views/team/{id}/transfer`
  - `/views/team/{id}/archive`
  - `/views/team/{id}/restore`
- team preset
  - `/filter-presets/team/{id}/duplicate`
  - `/filter-presets/team/{id}/transfer`
  - `/filter-presets/team/{id}/archive`
  - `/filter-presets/team/{id}/restore`

这些 path 直接复用当前 runtime 的既有 envelope：

- duplicate: `201 + data:item`
- transfer/archive/restore: `200 + data:item`
- 继续暴露 runtime 里真实存在的 `400/401/403/404/409/503` 面

同时把 `dist-sdk` 的 compile-time path test 一起扩到这一层，确保生成物不会再次退回“只有默认和 batch 路由可见”的半覆盖状态。

## Expected outcome

`plm-workbench` 主线 collaborative mutation contract 进入第二阶段完整暴露，外部 consumer / SDK / repo 内类型使用者都能看到 duplicate/transfer/lifecycle 这组核心路径。
