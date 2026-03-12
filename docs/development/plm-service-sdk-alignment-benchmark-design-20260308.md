# PLM Service / SDK Alignment 设计与对标

日期: 2026-03-08

## 1. 本轮目标

`/plm` 前端虽然已经有统一的 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)，但它仍然直接手写了一套联邦请求封装；与此同时，仓库里已经存在 [@metasheet/sdk](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/package.json) 的 `PLM federation helper`。

这会带来两个现实问题：

- 前端和 SDK 同时维护两套 `federation/plm` 调用逻辑
- SDK 包本身没有被当前 workspace 显式纳入，`client.ts` 变更后 `client.js / client.d.ts` 也没有可靠重建链

本轮目标是把这两层收成一条链：

- `apps/web -> PlmService -> @metasheet/sdk/client -> federation`
- `pnpm workspace -> sdk build -> web consume`

## 2. 对标对象与超越目标

### 2.1 当前对标对象

当前最好的实践其实已经在仓库里存在：

- [packages/openapi/dist-sdk/client.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- [packages/openapi/dist-sdk/tests/client.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/tests/client.test.ts)

SDK 侧已经有比较完整的 `PLM federation helper`，但 `apps/web` 没真正消费它。

### 2.2 本轮超越目标

本轮不是“再补一个 helper”，而是完成三件更重要的统一：

1. [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 改为消费 SDK helper
2. [pnpm-workspace.yaml](/Users/huazhou/Downloads/Github/metasheet2/pnpm-workspace.yaml) 显式纳入 `packages/openapi/dist-sdk`
3. [build.mjs](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/scripts/build.mjs) 能同步生成 `client.js / client.d.ts`

超越点在于：

- 前端联邦读写逻辑不再和 SDK 分叉
- SDK 不再只是“仓库里有源码”，而是“workspace 内可解析、可重建、可验证”的正式包

## 3. 设计边界

### 3.1 前端服务层怎么收口

[PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 本轮不再自己维护：

- `query/mutate` 私有方法
- 一整套 `products / bom / documents / approvals / where-used / compare / substitutes / cad` 手工请求拼装

改为：

- 通过一个轻量 `RequestClient` 适配 [apiGet/apiPost](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/utils/api.ts)
- 把请求交给 [createPlmFederationClient](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- 在 `PlmService` 层仅保留本地化 fallback 映射和前端兼容默认值

### 3.2 为什么保留本地化 fallback

SDK 当前 fallback 文案是英文，例如：

- `Failed to load PLM products`
- `Failed to load PLM BOM`

而 `apps/web` 这条线已经形成中文错误文案习惯，所以本轮没有让 UI 直接暴露英文 fallback，而是在 service 层做最薄一层本地化映射：

- 上游返回明确错误消息时，原样透出
- SDK 只抛 fallback 时，转换成当前 UI 的中文文案

### 3.3 为什么要补 `includeChildFields`

前端现有 `BOM compare` 调用会透传 `includeChildFields`，而 SDK 之前没有这个字段，导致即便前端接上 SDK，也会出现参数丢失。

所以本轮把它补进了：

- [client.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- [client.d.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.d.ts)
- [client.js](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.js)

## 4. 工程补强

### 4.1 Workspace 收口

这轮补上了 [pnpm-workspace.yaml](/Users/huazhou/Downloads/Github/metasheet2/pnpm-workspace.yaml) 的显式路径，让 `@metasheet/sdk` 真的成为当前 workspace 包，而不是一个仓库内“可见但不可依赖”的目录。

### 4.2 SDK build 补链

之前 [build.mjs](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/scripts/build.mjs) 只处理 `index.js / index.d.ts`，并不会更新 `client.js / client.d.ts`。

这会导致一种很隐蔽的假通过：

- `client.ts` 改了
- 测试和消费者却还在读旧的 `client.js`

本轮直接补齐了这条链，让 SDK build 会同步生成 `client.js / client.d.ts`。

## 5. 验证目标

这轮至少要满足：

- `pnpm install`
- `pnpm --dir packages/openapi/dist-sdk build`
- `pnpm --filter @metasheet/sdk test`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

同时还要补一轮轻量联调前置检查：

- `Yuantus` 健康检查
- `docker compose -f docker/dev-postgres.yml ps`

## 6. 结论

本轮的价值不是新增业务功能，而是把 `PLM frontend service` 和 `SDK helper` 从“功能重合”推进到“真实复用”：

- 前端只保留本地化和兼容默认值
- SDK 统一承载联邦契约
- workspace 和 build 链一起补齐

这一步完成后，后续再做 `PLM capability contract` 或者把更多前端调用切到 SDK，都不会再先返工一次包解析和产物同步。
