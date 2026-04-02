# PLM Workbench OpenAPI core route design

## Problem

`plm-workbench` 的 `team view / team preset` 路由已经是前端主流程里的稳定依赖，但 OpenAPI source 里仍完全缺失这一组 path。结果是：

- `packages/openapi/dist/openapi.*` 没有这些路由
- `packages/openapi/dist-sdk/index.d.ts` 的 `paths` 类型也没有这些键
- 外部 consumer 和 repo 内的 SDK 使用者都无法通过正式 contract 感知这些接口

## Scope choice

这轮先补最稳定、最值钱的一组 core route，而不是一次性把所有边角 mutation 全摊开：

- team view
  - list
  - save
  - rename/delete
  - batch archive/restore/delete
  - set-default / clear-default
- team preset
  - list
  - save
  - rename/delete
  - batch archive/restore/delete
  - set-default / clear-default

这组已经覆盖了当前页面最常见的 collaborative CRUD/default 管理面，而且 response shape 在前后端之间已经长期稳定。

## Design

新增 `packages/openapi/src/paths/plm-workbench.yml`，在 source OpenAPI 中显式暴露上述 core path：

- team view item / team preset item 用 file-local YAML anchors 复用
- list response 保留 `success + data + metadata`
- batch response 保留 `processedIds / skippedIds / items / processedKinds`
- default route 用单条 item 成功 envelope
- rename/delete route 反映当前 runtime request/response 形态

同时新增 `packages/openapi/dist-sdk/tests/plm-workbench-paths.test.ts`，通过 compile-time `paths[...]` 断言锁住这些 route 会真实进入 generated SDK 类型。

## Expected outcome

`plm-workbench` 至少拥有第一组正式对外的 OpenAPI/SDK contract，而不是继续停留在“后端和前端都在用，但 source/spec 不存在”的状态。
