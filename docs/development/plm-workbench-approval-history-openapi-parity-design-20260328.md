# PLM Workbench Approval History OpenAPI Parity Design

## Problem

后端 `/api/approvals/{id}/history` 已经稳定返回：

- `ok`
- `data.items`
- `data.page`
- `data.pageSize`
- `data.total`

但 OpenAPI source 仍把这个接口写成裸 `Pagination`，没有 `ok/data` envelope。这样会继续把：

- `dist/openapi.yaml`
- `dist/openapi.json`
- `dist-sdk` 类型

一起生成成错误契约。

## Design

- 把 `packages/openapi/src/paths/approvals.yml` 的 `/api/approvals/{id}/history` `200` 响应改成与后端一致的 `ok + data` wrapper。
- example 同步补齐 `id / actor_name / from_version / to_version`。
- 修正 `packages/openapi/dist-sdk/scripts/build.mjs`，不再依赖已经不存在的 `dist/sdk.ts`，而是直接从 `dist/openapi.yaml` 重新生成 `index.d.ts`。
- 重新执行 OpenAPI build 和 `dist-sdk` build，确保 `dist` 与 `dist-sdk` 一起回到真实后端契约。

## Expected Outcome

approval history 的发布契约、生成物类型和真实后端响应重新一致，不再让外部客户端或生成类型误以为这是裸分页 payload。
