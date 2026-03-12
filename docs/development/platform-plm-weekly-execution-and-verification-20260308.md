# 当前窗口平台/PLM本周任务执行与验证

日期: 2026-03-08

## 本周 8 项任务状态

| # | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 抽离 PLM 前端服务层 | 完成 | 已新增统一 `plmService`，`PlmProductView` 不再直接打 `/api/federation/plm/*` |
| 2 | 拆审批区块 | 完成 | 已抽成独立 `PlmApprovalsPanel` |
| 3 | 拆 BOM / where-used / compare / substitutes 区块 | 完成 | 已抽成独立面板组件，父页保留状态与动作编排 |
| 4 | 联邦 contract fixture + 最小测试 | 完成 | 已补 `federation.contract.test.ts` 与 `contracts.ts` |
| 5 | SDK 增补 PLM helper | 完成 | `dist-sdk/client` 已覆盖 PLM 查询、审批、替代件、CAD helper |
| 6 | PLM 审批 -> 平台审批/工作流桥接设计 | 完成 | 已补桥接设计文档与最小桥接模块/测试 |
| 7 | 显式化真实适配器能力 | 完成 | 已补 `integration-status`、Stub runtime status、管理页展示 |
| 8 | 集中真实联调 | 完成 | `Yuantus` 健康/登录/文档/ECO 审批、`pnpm test:plm`、`verify-plm-bom-tools`、`verify-plm-ui-regression` 均已通过 |

## 本轮交付

### 1. PLM 前端服务层与第二轮拆页

- 新增 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 新增 [plmService.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmService.spec.ts)
- 新增 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 新增 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 新增 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 新增 [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- 新增 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)
- 新增 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 新增 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 新增 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)
- 新增 [plmClipboard.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmClipboard.ts)
- 新增 [plmCsv.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmCsv.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)

结果:

- `PlmProductView` 中的 PLM 请求已统一收口到 service
- 审批、BOM、文档、CAD、Where-Used、BOM 对比、替代件面板均已从巨页模板中拆出
- 父页当前主要负责状态、联动动作和深链接，不再直接承载这些大段模板
- 通用面板样式已收口到共享 CSS，后续继续拆剩余产品区或更细状态模块时可直接复用

### 1.1 本轮增量: Documents / CAD + PLM 作用域 Lint 门

- 新增 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 新增 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 新增 [apps/web/.eslintrc.cjs](/Users/huazhou/Downloads/Github/metasheet2/apps/web/.eslintrc.cjs)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [plm-documents-cad-lint-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-documents-cad-lint-benchmark-design-20260308.md)

结果:

- `documents / CAD` 已不再以内联模板形式停留在巨页中
- `apps/web` 新增了 `PLM` 作用域的 `lint`、`test`、`type-check`
- `lint` 当前先覆盖 `PlmProductView`、`PlmService`、`src/views/plm/*.ts`、`src/components/plm/*.vue` 和 `plmService.spec.ts`
- 根级 `pnpm lint` 现在已能实际跑到 `apps/web` 的这条 PLM 作用域 lint 门

### 1.2 本轮增量: Product Workbench 组件化

- 新增 [PlmSearchPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSearchPanel.vue)
- 新增 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 新增 [plm-product-workbench-panelization-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-product-workbench-panelization-benchmark-design-20260308.md)
- 更新 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)

结果:

- 产品搜索区已从父页中拆出
- 产品工作台头部、深链接预设区、产品详情区已从父页中拆出
- `PlmProductView` 现在更接近状态编排器，而不是大模板容器

### 1.3 本轮增量: Search State 下沉

- 新增 [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)
- 新增 [plm-search-state-module-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-search-state-module-benchmark-design-20260308.md)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)

结果:

- `search` 相关 refs 和动作已从父页中抽为独立 composable
- 父页不再直接维护 `searchProducts / applySearchItem / applyCompareFromSearch / copySearchValue`
- `PLM` 这条线已从“模板拆分”推进到“第一批状态模块化”

### 1.4 本轮增量: Product State Module + Typed Panel Contract

- 新增 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 新增 [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
- 更新 [usePlmSearchPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSearchPanel.ts)
- 更新 [usePlmSearchPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSearchPanel.spec.ts)
- 更新 [PlmSearchPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSearchPanel.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [plm-panel-state-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-state-modules-benchmark-design-20260308.md)
- 新增 [plm-panel-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-state-modules-verification-20260308.md)

结果:

- `Search / Product` 两个 panel 已从 `panel: any` 走到显式 typed contract
- `productPanel` 已从父页内联对象下沉为独立 composable
- `PlmProductView` 继续收敛为 page orchestrator，状态边界比上一轮更清晰
- 当前 `/plm` 已从“模板组件化”推进到“组件化 + 状态模块化”的第二阶段

### 1.5 本轮增量: Compare/Substitutes State Modules + Typed Contract

- 新增 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- 新增 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue)
- 更新 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmComparePanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmComparePanel.spec.ts)
- 新增 [usePlmSubstitutesPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmSubstitutesPanel.spec.ts)
- 新增 [plm-compare-substitutes-state-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-state-modules-benchmark-design-20260308.md)
- 新增 [plm-compare-substitutes-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-state-modules-verification-20260308.md)

结果:

- `compare + substitutes` 这组高联动状态已从父页内联 `panel object` 推进到 composable/state module
- [PlmComparePanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmComparePanel.vue) 和 [PlmSubstitutesPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmSubstitutesPanel.vue) 已不再依赖 `panel: any`
- `apps/web` 的 PLM lint 门已覆盖到新增的 `usePlm*.spec.ts`
- `/plm` 已进入“多 panel 组件 + 多 state module + typed contract”的第三阶段

### 1.6 本轮增量: Compare/Substitutes 独立 Composable 拆分

- 新增 [plm-compare-substitutes-composable-split-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-composable-split-benchmark-design-20260308.md)
- 新增 [plm-compare-substitutes-composable-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-composable-split-verification-20260308.md)
- 删除已被替换的合并模块 `usePlmCompareSubstitutesPanels.ts`

结果:

- `compare` 与 `substitutes` 不再共享同一个状态模块
- 父页继续保留 page orchestrator 职责，但局部状态边界进一步收紧
- 新的 `usePlmComparePanel.spec.ts` / `usePlmSubstitutesPanel.spec.ts` 让两块能力可以分别验证
- 真实 UI regression 本轮尝试再次被本机 `docker/dev-postgres.yml` 自启动阻塞，最新成功报告仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

### 1.7 本轮增量: BOM / Where-Used Contract Modules

- 新增 [usePlmBomPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomPanel.ts)
- 新增 [usePlmWhereUsedPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedPanel.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmBomPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomPanel.spec.ts)
- 新增 [usePlmWhereUsedPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedPanel.spec.ts)
- 新增 [plm-bom-where-used-contract-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-contract-modules-benchmark-design-20260308.md)
- 新增 [plm-bom-where-used-contract-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-contract-modules-verification-20260308.md)

结果:

- `BOM / Where-Used` 两块最长的 panel object 已从父页中抽成独立 composable
- [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue) 和 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue) 已不再使用 `panel: any`
- `BOM 行` / `Where-Used 行` 的模板访问现在会被 `vue-tsc` 显式检查
- 本轮仍然是 contract module 阶段，下一步再继续做更深的 state module 下沉

### 1.8 本轮增量: BOM / Where-Used State Modules

- 更新 [usePlmBomState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmBomState.ts)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmBomState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmBomState.spec.ts)
- 新增 [usePlmWhereUsedState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmWhereUsedState.spec.ts)
- 新增 [plm-bom-where-used-state-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-state-modules-benchmark-design-20260308.md)
- 新增 [plm-bom-where-used-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-state-modules-verification-20260308.md)

结果:

- `BOM / Where-Used` 已从 contract module 阶段推进到真正的 state module 阶段
- 父页不再直接维护两块大段 `filter / preset / selection / tree visibility` 本地状态
- `bomCollapsed` 的 URL/localStorage 持久化仍保留在父页 watch 中，没有因为状态下沉而回退
- `BOM path` 过滤和表格路径导出语义已在 state module 中保住，并新增了直接单测
- 包级验证已提升到 `13 files / 48 tests`
- 本轮真实 UI regression 预检再次卡在 `docker compose -f docker/dev-postgres.yml ps`，但上游 `Yuantus` 健康检查仍返回 `200`；最新可引用成功报告仍是 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

### 1.9 本轮增量: PLM Service / SDK Alignment

- 更新 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 更新 [pnpm-workspace.yaml](/Users/huazhou/Downloads/Github/metasheet2/pnpm-workspace.yaml)
- 更新 [client.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- 更新 [client.js](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.js)
- 更新 [client.d.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.d.ts)
- 更新 [tests/client.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/tests/client.test.ts)
- 更新 [build.mjs](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/scripts/build.mjs)
- 新增 [plm-service-sdk-alignment-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-service-sdk-alignment-benchmark-design-20260308.md)
- 新增 [plm-service-sdk-alignment-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-service-sdk-alignment-verification-20260308.md)

结果:

- `apps/web -> PlmService -> @metasheet/sdk/client -> federation` 这条调用链已真正打通
- `@metasheet/sdk` 现在已是 workspace 内可依赖包，不再是仓库内“可见但不可依赖”的目录
- SDK `build` 现已同步生成 `client.js / client.d.ts`，避免 `client.ts` 改了但消费者仍读旧产物
- `compareBom` 现已支持 `includeChildFields` 透传，和前端现有调用保持一致
- `pnpm install`、`pnpm --filter @metasheet/sdk test`、`pnpm --filter @metasheet/web test/type-check/lint/build`、`pnpm lint` 均已通过
- 轻量联调前置检查中，`Yuantus` 健康返回 `200`，但 `docker compose -f docker/dev-postgres.yml ps` 仍挂起，所以本轮没有新增 UI regression 报告

### 1.10 本轮增量: Localized Client 下沉 + Remaining Panel Typing

- 新增 [plmFederationClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmFederationClient.ts)
- 更新 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [plm-localized-client-panel-typing-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-localized-client-panel-typing-benchmark-design-20260308.md)
- 新增 [plm-localized-client-panel-typing-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-localized-client-panel-typing-verification-20260308.md)

结果:

- `PlmService` 中残留的 request adapter 和本地化 fallback 已进一步下沉到独立 localized client
- `Approvals / Documents / CAD` 三个面板已全部脱离 `panel: any`
- 父页的 `documentsPanel / cadPanel / approvalsPanel` 已通过 `satisfies` 绑定显式 contract
- `apps/web` 的 lint 门现已覆盖新的 `src/services/plm/*.ts`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.11 本轮增量: Shared Typed Payload Models

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 更新 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)
- 新增 [plm-typed-payload-models-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-typed-payload-models-benchmark-design-20260308.md)
- 新增 [plm-typed-payload-models-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-typed-payload-models-verification-20260308.md)

结果:

- `Product / Compare / Where-Used` 已从父页/局部 composable 的匿名 payload，推进到共享 typed model
- `PlmProductView` 中 `getProduct<any> / getBom<any> / getWhereUsed<any> / getBomCompare<any>` 已全部收口
- `usePlmProductPanel / usePlmComparePanel / usePlmWhereUsedState / usePlmSubstitutesPanel` 已开始共同消费同一组 payload model
- 包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查仍返回 `200`

### 1.12 本轮增量: Typed Action / Export Layer

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 新增 [plm-compare-substitutes-bom-export-models-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-bom-export-models-benchmark-design-20260308.md)
- 新增 [plm-compare-substitutes-bom-export-models-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-bom-export-models-verification-20260308.md)

结果:

- `Compare` 的 `effectivity / substitute count` 已从局部匿名 helper 收口到 `CompareEntry / CompareLineProps / CompareEffectivityEntry`
- `Substitutes CSV` 导出已改成显式使用 `source part / substitute part` 语义，不再混用匿名 `entry.part`
- `Where-Used` 的行属性与关系属性已补齐显式模型，`getWhereUsedRefdes / getWhereUsedLineValue` 不再掉出类型系统
- `usePlmWhereUsedState` 内部树节点已脱离 `any`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.13 本轮增量: Cross-Panel Actions / Export Modules

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmCrossPanelActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCrossPanelActions.ts)
- 新增 [usePlmExportActions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmExportActions.ts)
- 新增 [usePlmCrossPanelActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCrossPanelActions.spec.ts)
- 新增 [usePlmExportActions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmExportActions.spec.ts)
- 新增 [plm-cross-panel-actions-export-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-cross-panel-actions-export-modules-benchmark-design-20260308.md)
- 新增 [plm-cross-panel-actions-export-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-cross-panel-actions-export-modules-verification-20260308.md)

结果:

- 父页里的 `BOM / Compare / Where-Used / Substitutes` 跨面板联动已下沉为独立 actions module
- `Where-Used / BOM Compare / Compare detail / BOM / Substitutes / Documents / Approvals` 导出逻辑已下沉为独立 export module
- `/plm` 新增两份聚焦测试，当前 `apps/web` 包级测试已提升到 `15 files / 52 tests`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.14 本轮增量: Auth / Deep-Link State Modules

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [usePlmAuthStatus.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmAuthStatus.ts)
- 新增 [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmDeepLinkState.ts)
- 新增 [usePlmAuthStatus.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmAuthStatus.spec.ts)
- 新增 [usePlmDeepLinkState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmDeepLinkState.spec.ts)
- 新增 [plm-auth-deeplink-state-modules-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-auth-deeplink-state-modules-benchmark-design-20260308.md)
- 新增 [plm-auth-deeplink-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-auth-deeplink-state-modules-verification-20260308.md)

结果:

- `MetaSheet / PLM token` 状态、401 降级处理、轮询与 legacy token 识别已抽成独立 auth module
- `deep-link scope / preset / import-export / drag-drop / query sync` 已抽成独立 deep-link module
- 父页中这组认证与深链接本地函数定义已清掉，页面继续退回编排层
- `apps/web` 包级测试已提升到 `17 files / 56 tests`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.15 本轮增量: Preset Utils 共享化 + Routing Split

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 新增 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts)
- 更新 [package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [plm-preset-utils-routing-split-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-preset-utils-routing-split-benchmark-design-20260308.md)
- 新增 [plm-preset-utils-routing-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-preset-utils-routing-split-verification-20260308.md)

结果:

- `BOM / Where-Used` 的 preset `share / import / export / persist / merge` 规则已进入共享工具层
- `featureFlags` 动态/静态混合导入 warning 已消失
- `apps/web` 已切到路由级懒加载，入口从单块约 `2.19 MB` 收到壳子约 `17.74 kB`
- 当前剩余的构建大块已收敛为独立的 `workflow-bpmn` 和 `vendor-element-plus`
- `apps/web` 包级测试已提升到 `18 files / 59 tests`

### 1.16 本轮增量: Element Plus Scoped Loading

- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [TestFormula.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/TestFormula.vue)
- 更新 [package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [element-plus-scoped-loading-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/element-plus-scoped-loading-benchmark-design-20260308.md)
- 新增 [element-plus-scoped-loading-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/element-plus-scoped-loading-verification-20260308.md)

结果:

- `Element Plus` 已不再从 `main.ts` 全局安装
- `WorkflowDesigner / TestFormula` 已改成页面级组件与样式导入
- `vendor-element-plus` 已从 `877.00 kB JS / 341.30 kB CSS` 降到 `224.80 kB JS / 78.32 kB CSS`
- `apps/web` 剩余的构建 warning 已进一步收敛到 `workflow-bpmn`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.17 本轮增量: Workflow BPMN Runtime Split

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerRuntime.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRuntime.ts)
- 更新 [vite.config.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/vite.config.ts)
- 新增 [workflow-bpmn-runtime-split-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-bpmn-runtime-split-benchmark-design-20260308.md)
- 新增 [workflow-bpmn-runtime-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-bpmn-runtime-split-verification-20260308.md)

结果:

- `WorkflowDesigner` 已改成按需加载 BPMN runtime，而不是直接静态依赖 `bpmn-js`
- 原先单一 `workflow-bpmn` 大块已拆成 `workflow-bpmn-js / workflow-diagram-js / workflow-moddle / workflow-bpmn-vendor`
- `apps/web` 构建输出中已不再出现 `Some chunks are larger than 500 kB after minification`
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.18 本轮增量: Workflow Designer Persistence / Validation

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 新增 [workflowDesignerValidation.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerValidation.ts)
- 新增 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 新增 [workflowDesignerValidation.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerValidation.spec.ts)
- 更新 [package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [workflow-designer-persistence-validation-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-persistence-validation-benchmark-design-20260308.md)
- 新增 [workflow-designer-persistence-validation-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-persistence-validation-verification-20260308.md)

结果:

- `WorkflowDesigner` 已从“页面直接承载默认 XML / save / load / deploy / validate”推进到 “runtime / persistence / validation” 三层分离
- 部署动作已修正为基于当前 `BPMN XML` 调用 `/api/workflow/deploy`
- `workflow-designer` visual-definition 与 `BPMN XML` editor 的契约漂移已被隔离到 persistence 层
- 本轮包级验证 `test / type-check / lint / build / root lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.19 本轮增量: Workflow Designer BPMN Draft API

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)
- 新增 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)
- 新增 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)
- 新增 [workflow-designer-bpmn-draft-api-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-bpmn-draft-api-benchmark-design-20260308.md)
- 新增 [workflow-designer-bpmn-draft-api-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-bpmn-draft-api-verification-20260308.md)

结果:

- `workflow-designer` 当前前端实际依赖的 `create / get / update / deploy / validate` 路径已具备 `BPMN draft` 能力
- `saveWorkflow()` 的 ID 落库问题已修正，前端拿到的 draft ID 与数据库记录一致
- 前端部署路径已改成 `saved-draft-first`，优先走 `workflow-designer/:id/deploy`
- 本轮 backend helper test / backend build / frontend test / frontend build / root lint 已通过；上游 `Yuantus` 健康检查返回 `200`

### 1.20 本轮增量: Workflow Designer Draft Collaboration / Execution

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)
- 更新 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)
- 更新 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 新增 [workflow-designer-draft-collaboration-execution-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-draft-collaboration-execution-benchmark-design-20260308.md)
- 新增 [workflow-designer-draft-collaboration-execution-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-draft-collaboration-execution-verification-20260308.md)

结果:

- `workflow-designer` 的 `list / share / test / executions` 已并入同一条 `workflow_definitions` draft model
- draft metadata 已具备 `shares / executions` 两类状态
- 旧 visual-definition 记录在 draft load 时已具备 `BPMN XML` fallback
- analytics 写入已改为 best-effort，不再阻断主流程
- 本轮 backend helper test / backend build / frontend test / frontend build / root lint 已通过；上游 `Yuantus` 健康检查返回 `200`

### 2. 平台壳补齐

- 新增 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 新增 [ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/ApprovalInboxView.vue)
- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 更新 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts)

结果:

- 主前端已有平台级 `/workflows`、`/workflows/designer/:id?`、`/approvals`
- 产品模式已扩到 `platform / attendance / plm-workbench`
- `plm-workbench` 模式下会收敛导航和首页落点

### 3. 插件装配与能力可见性

- 更新 [viewRegistry.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/plugins/viewRegistry.ts)
- 更新 [PluginViewHost.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PluginViewHost.vue)
- 更新 [PluginManagerView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PluginManagerView.vue)
- 新增 [federation-integration-status-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/federation-integration-status-20260308.md)

结果:

- 插件视图不再只硬编码 `AttendanceView`
- 管理页已显示 `plm / athena` 的 `real / stub / missing` 状态、配置状态和支持操作

### 4. 联邦契约与桥接

- 新增 [contracts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/fixtures/federation/contracts.ts)
- 新增 [federation.contract.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/federation.contract.test.ts)
- 新增 [plm-approval-bridge.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/federation/plm-approval-bridge.ts)
- 新增 [plm-approval-bridge.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-approval-bridge.test.ts)
- 新增 [plm-approval-workflow-bridge-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-approval-workflow-bridge-20260308.md)

结果:

- PLM / Athena 联邦 contract 已有离线 fixture 和聚焦测试
- PLM ECO 审批已有最小桥接模型，可作为下一步并入平台审批/工作流的基础

### 5. SDK helper

- 更新 [client.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.ts)
- 更新 [client.js](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.js)
- 更新 [client.d.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/client.d.ts)
- 更新 [client.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/tests/client.test.ts)
- 更新 [README.md](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/dist-sdk/README.md)

新增覆盖:

- `listDocuments`
- `approveApproval`
- `rejectApproval`
- `getBomCompareSchema`
- `addSubstitute`
- `removeSubstitute`
- `getCadProperties`
- `getCadViewState`
- `getCadReview`
- `getCadHistory`
- `getCadDiff`
- `getCadMeshStats`
- `updateCadProperties`
- `updateCadViewState`
- `updateCadReview`

## 真实联调入口

- 新增 [test-plm-connection.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/scripts/test-plm-connection.ts)

用途:

- 补齐根脚本 `pnpm test:plm` 的断链入口
- 基于 `PLM_BASE_URL / PLM_URL / PLM_HEALTH_URLS` 进行真实健康探测

当前执行结果:

- 默认探测地址: `http://127.0.0.1:7910`
- 默认探测路径:
  - `/api/v1/health`
  - `/health`
- 结果: `Yuantus` 已在本机启动，`/api/v1/health` 返回 `200`

补充联调结果:

- 上游 `Yuantus` 健康检查通过
- 上游 `Yuantus` 登录接口通过
- 上游 `Yuantus` 自带 `scripts/verify_docs_approval.sh` 全绿，覆盖：
  - 文档与文件上传/去重/挂载
  - 文档生命周期
  - ECO 审批通过链路
- 根级 `pnpm test:plm` 已通过
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-bom-tools.sh` 已通过
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh` 已通过
- 生成的真实联调报告:
  - [plm-bom-tools-20260308_0101.md](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-tools-20260308_0101.md)
  - [verification-plm-ui-regression-20260308_010230.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_010230.md)
  - [verification-plm-ui-regression-20260308_111544.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_111544.md)
  - [verification-plm-ui-regression-20260308_112420.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_112420.md)
  - [verification-plm-ui-regression-20260308_114512.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_114512.md)
  - [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

## 验证

已通过:

- `pnpm --filter @metasheet/web exec vitest run --watch=false`
- `pnpm --filter @metasheet/web exec vue-tsc -b`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm lint`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/federation.contract.test.ts tests/unit/plm-approval-bridge.test.ts`
- `pnpm --dir packages/openapi/dist-sdk test`
- `pnpm test:plm`
- `bash /Users/huazhou/Downloads/Github/Yuantus/scripts/verify_docs_approval.sh http://127.0.0.1:7910 tenant-1 org-1`
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-bom-tools.sh`
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260308_0101.json bash scripts/verify-plm-ui-regression.sh`

本轮增量补充验证:

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`
- 结果见 [plm-panel-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-state-modules-verification-20260308.md)
- `compare/substitutes` 本轮结果见 [plm-compare-substitutes-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-state-modules-verification-20260308.md)
- `compare/substitutes` 独立 composable 拆分结果见 [plm-compare-substitutes-composable-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-composable-split-verification-20260308.md)
- `BOM / Where-Used` contract module 结果见 [plm-bom-where-used-contract-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-contract-modules-verification-20260308.md)
- `typed action/export layer` 本轮结果见 [plm-compare-substitutes-bom-export-models-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-compare-substitutes-bom-export-models-verification-20260308.md)
- `cross-panel actions / export modules` 本轮结果见 [plm-cross-panel-actions-export-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-cross-panel-actions-export-modules-verification-20260308.md)
- `auth / deep-link state modules` 本轮结果见 [plm-auth-deeplink-state-modules-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-auth-deeplink-state-modules-verification-20260308.md)
- `preset utils / routing split` 本轮结果见 [plm-preset-utils-routing-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-preset-utils-routing-split-verification-20260308.md)
- `Element Plus scoped loading` 本轮结果见 [element-plus-scoped-loading-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/element-plus-scoped-loading-verification-20260308.md)
- `Workflow BPMN runtime split` 本轮结果见 [workflow-bpmn-runtime-split-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-bpmn-runtime-split-verification-20260308.md)
- `Workflow Designer persistence / validation` 本轮结果见 [workflow-designer-persistence-validation-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-persistence-validation-verification-20260308.md)
- `Workflow Designer BPMN draft API` 本轮结果见 [workflow-designer-bpmn-draft-api-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-bpmn-draft-api-verification-20260308.md)
- `Workflow Designer draft collaboration / execution` 本轮结果见 [workflow-designer-draft-collaboration-execution-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-draft-collaboration-execution-verification-20260308.md)

非阻塞提示:

- `core-backend` Vitest 仍会打印一次 Vite CJS deprecation warning
- `apps/web` 当前构建 warning 已收口；剩余结构性问题转为 `WorkflowDesigner` 前后端模型不一致，而不是 chunk 体积问题
- 本轮没有新增 `/plm` UI regression 报告；最近一次成功基线仍为 [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)
- `workflow-designer` 仍未迁移的旧 designer 体系主要剩 `templates / node-types`

## 结论

本周 8 项现已全部闭环。真实联调已经覆盖上游 `Yuantus`、MetaSheet 联邦健康探测、BOM 工具链，以及前端 `/plm` 页面回归；当前剩余的是后续结构治理和功能深化，而不是链路打通问题。

## 补充增量 1.21

### Workflow Designer Catalog / List Resilience

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 新增 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)
- 新增 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 新增 [workflow-designer-catalog-list-resilience-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-catalog-list-resilience-benchmark-design-20260308.md)
- 新增 [workflow-designer-catalog-list-resilience-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-catalog-list-resilience-verification-20260308.md)

结果:

- `GET /api/workflow-designer/workflows` 已去掉逐条 `loadWorkflowDraft()` 的 `N+1`
- `node-types` 已改成 `builtin` 永远可用，`custom` 读取失败只做降级，不再整体报错
- `templates` 已改成 `builtin + database` 合并模型，数据库不可用时仍能返回内建模板
- route 中的 catalog/list 解析与过滤规则已下沉到 helper module，并补了聚焦单测

补充验证:

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-drafts.test.ts tests/unit/workflow-designer-route-models.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/workflow-designer.ts src/workflow/workflowDesignerRouteModels.ts`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`

## 补充增量 1.22

### Workflow Designer Pagination / Catalog 产品化

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 新增 [workflow-designer-pagination-catalog-benchmark-design-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-pagination-catalog-benchmark-design-20260308.md)
- 新增 [workflow-designer-pagination-catalog-verification-20260308.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-designer-pagination-catalog-verification-20260308.md)

结果:

- `templates` 已支持 `search/source/sort/limit/offset`
- `workflows list` 已支持 `sort/limit/offset`
- 两条接口均保持 `data` 数组兼容，并新增 `metadata.total/limit/offset/returned`
- 前端已新增 `listWorkflowTemplates()` 和 `listWorkflowDrafts()` typed helper
- 本轮 backend helper test / backend build / web test / web type-check / web lint / web build / root lint 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.23

### Workflow Hub / Template Instantiation 闭环

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 新增 [workflow-hub-template-instantiation-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-template-instantiation-benchmark-design-20260309.md)
- 新增 [workflow-hub-template-instantiation-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-template-instantiation-verification-20260309.md)

结果:

- `WorkflowHub` 已切到真实 draft list + template catalog
- `templates/:id` 与 `templates/:id/instantiate` 已打通模板详情和模板实例化
- `WorkflowDesigner` 已支持模板对话框、模板详情预览和 route-query 模板实例化
- `hub -> template -> designer` 已形成可用闭环
- 本轮 backend helper test / backend build / web test / web type-check / web lint / web build / root lint 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.24

### Workflow Hub Draft Actions / Recent Templates

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 新增 [workflowDesignerRecentTemplates.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRecentTemplates.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 新增 [workflowDesignerRecentTemplates.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerRecentTemplates.spec.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [workflow-hub-draft-actions-recent-templates-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-draft-actions-recent-templates-benchmark-design-20260309.md)
- 新增 [workflow-hub-draft-actions-recent-templates-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-draft-actions-recent-templates-verification-20260309.md)

结果:

- `workflow-designer` 已新增 `duplicate` 和 `archive` draft action
- `WorkflowHub` 已支持 `Open / Duplicate / Archive`
- `WorkflowHub` 与 `WorkflowDesigner` 都已接入 `Recent Templates`
- duplicate naming 已具备稳定递增规则，不再生成连串 `Copy Copy`
- 本轮 backend helper test / backend build / backend eslint / web test / web type-check / web lint / web build / root lint 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.25

### Workflow Hub Restore / Runtime Schema Closure

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 新增 [zzzz20260309103000_create_workflow_designer_support_tables.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts)
- 新增 [workflow-hub-restore-runtime-schema-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-restore-runtime-schema-benchmark-design-20260309.md)
- 新增 [workflow-hub-restore-runtime-schema-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-restore-runtime-schema-verification-20260309.md)

结果:

- `workflow-designer` 已新增 `restore` draft action，hub lifecycle 变为 `Open / Duplicate / Archive / Restore`
- `Duplicate` 已支持 hub 内自定义命名，并在实机烟测中成功创建 `Smoke Draft Custom Rename`
- 浏览器烟测暴露的 `workflow_definitions / workflow_templates` 缺表问题已收进正式 migration，不再依赖手工建表
- migration 后，`/api/workflow-designer/workflows` 与 `/api/workflow-designer/templates` 已在本地 dev 环境返回 `200`
- Playwright smoke 已验证：
  - active draft 显示 `Open / Duplicate / Archive`
  - archived draft 显示 `Open / Duplicate / Restore`
  - restore 后 archived draft 回切为 `draft`
- 本轮 `core-backend migrate / helper tests / build / eslint`、`web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.26

### Workflow Dev Auth Bootstrap / Mode Alignment

- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 更新 [HomeRedirect.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/HomeRedirect.vue)
- 更新 [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [workflow-dev-auth-bootstrap-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-dev-auth-bootstrap-benchmark-design-20260309.md)
- 新增 [workflow-dev-auth-bootstrap-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-dev-auth-bootstrap-verification-20260309.md)

结果:

- `loadProductFeatures()` 已从 `App.vue + HomeRedirect.vue + route guard` 收敛为 route guard 主导
- `/workflows` 导航已受 `hasFeature('workflow')` 控制，不再在 feature disabled 时继续暴露
- backend `/api/auth/me` 已支持 `plm-workbench / plm-focused` 产品模式归一化
- backend `/api/auth/dev-token` 已改为复用 `SecretManager` 的 `JWT_SECRET` 语义，避免签发和验签走两套 secret 逻辑
- `apps/web test / type-check / lint / build`、`core-backend build / targeted eslint`、根级 `pnpm lint` 已通过
- 源码级 `dev-token -> AuthService.verifyToken()` 验证已通过，输出 `{\"ok\":true,\"id\":\"dev-user\",\"role\":\"admin\"...}`
- 当前 live dev backend 进程未在本轮被强制重启，因此 `8899` proxy 下的旧进程仍可能返回 `Invalid token`；这被记录为运行态观察，不作为本轮源码修正失败判据

## 补充增量 1.27

### Workflow Live Dev Runtime Alignment

- 重启本地 `7778` backend，使用 `WORKFLOW_ENABLED=true`、`PRODUCT_MODE=plm-workbench` 的 workflow 剖面
- 新增 [workflow-live-dev-runtime-alignment-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-live-dev-runtime-alignment-benchmark-design-20260309.md)
- 新增 [workflow-live-dev-runtime-alignment-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-live-dev-runtime-alignment-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-live-auth-bootstrap-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-live-auth-bootstrap-20260309)

结果:

- live backend 已成功监听 `http://localhost:7778`
- `8899 -> /api/auth/dev-token -> /api/auth/me` 已返回 `200`
- `/api/auth/me` features 已确认：
  - `workflow: true`
  - `mode: plm-workbench`
- 浏览器隔离会话访问 `/workflows` 已直达 `Workflow Hub`
- Playwright network 已确认：
  - `/api/auth/dev-token` `200`
  - `/api/auth/me` `200`
  - `/api/workflow-designer/workflows` `200`
  - `/api/workflow-designer/templates` `200`
- 当前剩余初始化噪声已缩小为重复两次 `/api/plugins`

## 补充增量 1.28

### Workflow Plugin Catalog Dedupe

- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 使用已更新的 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts)
- 新增 [workflow-plugin-catalog-dedupe-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-plugin-catalog-dedupe-benchmark-design-20260309.md)
- 新增 [workflow-plugin-catalog-dedupe-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-plugin-catalog-dedupe-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-plugin-catalog-dedupe-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-plugin-catalog-dedupe-20260309)

结果:

- `App.vue` 已先等待 `loadProductFeatures()` 再决定是否执行 `fetchPlugins()`
- `workflow/plm-workbench` live 启动链里的 `/api/plugins` 已从 `1` 次降到 `0` 次
- `/workflows` 页面仍然直达 `Workflow Hub`
- Playwright network 现已只剩：
  - `/api/auth/me`
  - `/api/workflow-designer/workflows`
  - `/api/workflow-designer/templates`
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.29

### Workflow Catalog Cache / Cross-Page Reuse

- 新增 [workflowDesignerCatalogCache.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerCatalogCache.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 新增 [workflowDesignerCatalogCache.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerCatalogCache.spec.ts)
- 新增 [workflow-catalog-cache-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-catalog-cache-benchmark-design-20260309.md)
- 新增 [workflow-catalog-cache-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-catalog-cache-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-catalog-cache-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-catalog-cache-20260309)

结果:

- `workflow drafts / template catalog / template detail` 已提升成共享前端 cache
- `Workflow Hub` 默认命中 cache，显式 `Refresh` 继续走强制刷新
- `duplicate / archive / restore / save / instantiate` 已会失效对应 cache
- `Hub -> Designer -> 模板弹窗` 的 live smoke 已确认：
  - `template list` 只请求 `1` 次
  - 打开模板弹窗后只新增 `template detail` 请求
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.30

### Workflow Hub Query Sync / Next-Page Prefetch

- 新增 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增 [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts)
- 新增 [workflow-hub-query-sync-prefetch-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-query-sync-prefetch-benchmark-design-20260309.md)
- 新增 [workflow-hub-query-sync-prefetch-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-query-sync-prefetch-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-hub-query-sync-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-query-sync-20260309)

结果:

- `Workflow Hub` 已把 `workflow/template` 双面板状态同步到 URL query
- `Apply` 现在会回第一页，顶部 `Refresh` 保持当前页
- 当前页成功加载后会静默预取下一页，进一步放大前一轮 catalog cache 的收益
- live smoke 已确认：
  - URL 更新为 `?tplSearch=parallel`
  - 页面结果收敛到 `Parallel Review Workflow`
  - network 请求已按 query 变化
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.31

### Workflow Hub Saved Views

- 新增 [workflowHubSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSavedViews.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 新增 [workflowHubSavedViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubSavedViews.spec.ts)
- 新增 [workflow-hub-saved-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-saved-views-benchmark-design-20260309.md)
- 新增 [workflow-hub-saved-views-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-saved-views-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-hub-saved-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-saved-views-20260309)

结果:

- `Workflow Hub` 已新增最小可用的 `saved views`
- 用户现在可以保存当前双面板 route state，并通过 `Apply view` 一键恢复
- 保存命名采用规范化 upsert，同名视图会更新而不是重复新增
- saved view ID 生成已从单纯 `Date.now()` 升级为 `randomUUID / timestamp+random suffix`，避免同毫秒冲突覆盖
- live smoke 已确认完整主路径：
  - 搜索 `parallel`
  - 保存 `Parallel Templates Saved`
  - 清空搜索恢复到 `2` 条 template
  - 应用 saved view 后回到 `?tplSearch=parallel`
  - 删除 saved view 后卡片消失并提示 `视图已删除`
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.32

### Workflow Hub Browser History Replay

- 更新 [workflowHubQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubQueryState.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflowHubQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubQueryState.spec.ts)
- 新增 [workflow-hub-history-replay-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-history-replay-benchmark-design-20260309.md)
- 新增 [workflow-hub-history-replay-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-history-replay-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-hub-history-replay-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-history-replay-20260309)

结果:

- `Workflow Hub` 已新增 route-state equality 判定，避免 route replay 比较逻辑继续散落在页面里
- `WorkflowHubView.vue` 现在会监听 `route.query`，并在浏览器 `back / forward` 时执行 `parse -> compare -> apply -> refresh`
- live smoke 已确认完整主路径：
  - 搜索 `parallel` 并 `Apply`
  - 搜索 `simple` 并 `Apply`
  - 浏览器 `Back` 后 URL、输入框和目录结果都回到 `parallel`
  - 浏览器 `Forward` 后 URL、输入框和目录结果都回到 `simple`
- network 也已确认 `search=parallel` 与 `search=simple` 请求会随浏览器 history 一起回放
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.33

### Workflow Hub Session Restore

- 新增 [workflowHubSessionState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowHubSessionState.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 新增 [workflowHubSessionState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowHubSessionState.spec.ts)
- 新增 [workflow-hub-session-restore-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-session-restore-benchmark-design-20260309.md)
- 新增 [workflow-hub-session-restore-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-session-restore-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-hub-session-restore-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-session-restore-20260309)

结果:

- `Workflow Hub` 已新增本地 session state 层，用于保存最近一次稳定的 hub route state
- 空路由 `/workflows` 现在会在存在非默认 session 时自动恢复到上次工作视角
- session restore 只在默认 route 下触发，不会覆盖显式 query 入口
- live smoke 已确认完整主路径：
  - 搜索 `parallel` 并 `Apply`
  - 离开到 `/plm`
  - 再次进入空的 `/workflows`
  - URL 自动恢复到 `?tplSearch=parallel`
  - 页面结果回到 `Parallel Review Workflow`
  - network 已确认恢复时会真实请求 `templates?search=parallel`
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.34

### Workflow Hub Team Views / Live Auth Bootstrap Repair

- 新增 [workflowHubTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowHubTeamViews.ts)
- 新增迁移 [zzzz20260309113000_create_workflow_hub_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts)
- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 新增 [workflow-hub-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-hub-team-views.test.ts)
- 更新 [AuthService.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/AuthService.test.ts)
- 新增设计文档 [workflow-hub-team-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-team-views-benchmark-design-20260309.md)
- 新增验证文档 [workflow-hub-team-views-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/workflow-hub-team-views-verification-20260309.md)
- 归档浏览器 smoke 证据到 [workflow-hub-team-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/workflow-hub-team-views-20260309)

结果:

- `Workflow Hub` 已新增后端持久化的 `team views`
- `team views` 现在支持：
  - 同租户可见
  - owner 可删除
  - 刷新后仍存在
  - 新会话重新进入后仍可读取并应用
- live smoke 已真实走通：
  - 搜索 `parallel`
  - 保存 `Team Parallel Templates`
  - 刷新后仍存在
  - `Apply` 后回到 `?tplSearch=parallel`
  - `Delete` 后 network 返回 `200`
- 这轮验证抓到并修正了一个真实 live runtime 缺陷：
  - 默认 `dev-token` 在 fresh backend 下可能因 `dev-user` 不在库里而被 `auth/me` 判成 `Invalid token`
  - [AuthService.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/AuthService.ts) 现已改为在非生产环境统一允许 synthetic dev user fallback
- 修正后，经 `7778` 直连和 `8899` 代理链验证：
  - `GET /api/auth/me` -> `200`
  - `features.workflow = true`
  - `features.mode = plm-workbench`
- API spot-check 已确认默认 `dev-token` 下：
  - `POST /api/workflow-designer/hub-views/team` -> `200`
  - `DELETE /api/workflow-designer/hub-views/team/:id` -> `200`
- 本轮 `core-backend` 聚焦单测、迁移、build、targeted eslint 通过
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.35

### PLM Team Filter Presets

- 新增 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 新增迁移 [zzzz20260309123000_create_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts)
- 新增 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [index.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts)
- 新增 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 新增 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 新增 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)
- 新增 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-filter-presets-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-filter-presets-benchmark-design-20260309.md)
- 新增验证文档 [plm-team-filter-presets-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-filter-presets-verification-20260309.md)
- 归档浏览器 smoke 证据到 [plm-team-filter-presets-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309)

结果:

- `/plm` 已新增后端持久化的 `team presets`
- 当前覆盖两个面板：
  - `BOM`
  - `Where-Used`
- 团队预设能力现在支持：
  - 同租户可见
  - owner 可删除
  - 浏览器刷新后仍可重新加载
  - live backend 下真实 `save -> apply -> delete`
- 后端资源已与上游 `PLM federation` 分层：
  - 上游 `Yuantus PLM` 仍负责业务数据
  - 本地 `plm-workbench` 负责工作台协作状态
- live 验证已确认：
  - `GET /api/auth/me -> 200`
  - `POST /api/plm-workbench/filter-presets/team -> 201`
  - `DELETE /api/plm-workbench/filter-presets/team/:id -> 200`
- 浏览器 smoke 已真实走通：
  - 输入 `gearbox`
  - 保存 `Shared Gearbox / 关键件`
  - 修改过滤值为 `motor`
  - `Apply` 后恢复到 `gearbox`
  - `Delete` 后团队预设下拉清空
- 本轮 `core-backend` 聚焦单测、迁移、build 通过
- 本轮 `apps/web test / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.36

### PLM Team Default Presets / Live Runtime Reload

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 新增迁移 [zzzz20260309133000_add_default_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-default-presets-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-default-presets-benchmark-design-20260309.md)
- 新增验证文档 [plm-team-default-presets-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-default-presets-verification-20260309.md)
- 归档浏览器 smoke 证据到 [plm-team-default-presets-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309)

结果:

- `/plm` 已新增后端唯一的 `team default preset`
- 默认约束现在是：
  - 同租户、同 `kind`
  - 最多一个默认项
- 当前已覆盖两个面板：
  - `BOM`
  - `Where-Used`
- 前端现在支持：
  - `设为默认`
  - `取消默认`
  - 下拉中的 `· 默认` 标记
  - `当前默认：...` 提示
- 空状态重新进入 `/plm` 时，如果存在默认团队预设，会自动把过滤条件同步回来
- 显式 query 和当前本地状态仍保持更高优先级，不会被默认值强行覆盖
- 本轮 live 验证抓到并修正了一个真实运行态问题：
  - `7778` 上最初还是旧 backend 进程
  - 新默认路由会出现 `Cannot POST/DELETE .../default`
  - 当前已重启 live backend 到包含新路由的代码版本
- live API 已真实确认：
  - `POST /api/plm-workbench/filter-presets/team/:id/default -> 200`
  - `DELETE /api/plm-workbench/filter-presets/team/:id/default -> 200`
  - `GET /api/plm-workbench/filter-presets/team?kind=bom` 会返回 `isDefault` 与 `defaultPresetId`
- 浏览器 smoke 已真实走通：
  - 保存团队预设
  - 设为默认
  - 新会话重新打开空 `/plm`
  - URL 自动恢复到 `?bomFilter=gearbox`
  - `取消默认`
  - 删除预设
- 验证后临时测试数据已清理，当前 `kind=bom` 团队预设列表为空
- 本轮 `core-backend` 聚焦单测、迁移、build、targeted eslint 通过
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.37

### PLM Workbench Team Default Views

- 新增 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 新增迁移 [zzzz20260309143000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts)
- 新增兼容迁移 [zzzz20260309150000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309150000_create_plm_workbench_team_views.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 新增 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-default-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-default-views-benchmark-design-20260309.md)
- 新增验证文档 [plm-workbench-team-default-views-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-default-views-verification-20260309.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-default-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309)

结果:

- `/plm` 已新增后端持久化的 `Documents / CAD / Approvals team views`
- 三类视图均支持：
  - `save`
  - `apply`
  - `delete`
  - `set default`
  - `clear default`
- 默认约束现在是：
  - 同租户、同 `kind`
  - 最多一个默认项
- 空的 `/plm` 在无显式 query 且本地状态仍为默认态时，会自动恢复：
  - `documentRole / documentFilter`
  - `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
  - `approvalsFilter`
- live API 已真实确认三类视图都能走通 `save -> set default -> list -> clear default -> delete`
- 浏览器 smoke 已真实走通：
  - 文档视图保存并设为默认
  - `CAD / Approvals` 视图保存并设为默认
  - 新会话重新打开空 `/plm`
  - URL 自动恢复到 `documentRole=primary&documentFilter=gear&approvalsFilter=eco&cadFileId=...`
- 本轮 smoke 抓到并修正了一个真实问题：
  - 首轮文档视图只保存未设默认，导致第一次恢复时没有带回 `Documents`
  - 补做 `Docs Default View -> 设为默认` 后，三类默认恢复已完整闭环
- 验证后临时团队视图已清理，当前 `documents / cad / approvals` 列表均为空
- 本轮 `core-backend` 聚焦单测、迁移、build 通过
- 本轮 `apps/web test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.38

### PLM Team View Deep Links

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-team-view-deeplinks-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-view-deeplinks-benchmark-design-20260309.md)
- 新增验证文档 [plm-team-view-deeplinks-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-view-deeplinks-verification-20260309.md)
- 归档浏览器 smoke 证据到 [plm-team-view-deeplinks-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-view-deeplinks-20260309)

结果:

- `/plm` 已支持显式 team view query：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- 显式 team view query 现在优先于默认团队视图恢复
- `copyDeepLink / buildDeepLinkUrl` 现在会把当前选中的 team view id 一并带入 URL
- 页面在 team view query 生效后，会把 resolved field state 也补回 URL，因此共享链接同时保留：
  - team view identity
  - 当前具体字段状态
- live browser smoke 已真实走通：
  - 通过 API 创建三条 team views
  - 直接打开带 `documentTeamView/cadTeamView/approvalsTeamView` 的 `/plm`
  - 页面正确选中 `Docs Link View / CAD Link View / Approvals Link View`
  - URL 自动扩展出 `documentRole=document... / cadFileId=... / approvalsFilter=...`
- 验证后临时 team views 已清理，当前 `documents / cad / approvals` 列表均为空
- 本轮 `apps/web` 聚焦单测、全量 `test / type-check / lint / build`、根级 `pnpm lint` 已通过；上游 `Yuantus` 健康检查返回 `200`

## 补充增量 1.39

### PLM Workbench Team Views

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 新增设计文档 [plm-workbench-team-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-views-benchmark-design-20260309.md)
- 新增验证文档 [plm-workbench-team-views-verification-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-views-verification-20260309.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-views-20260309)

结果:

- `/plm` 已新增 `workbench` 级别的团队视图
- `workbench` 团队视图现在支持：
  - `save`
  - `apply`
  - `delete`
  - `set default`
  - `clear default`
- 保存内容采用整页 query snapshot，而不是单面板 state
- 空 `/plm` 首屏会自动恢复默认工作台视角，并同步回具体 URL
- live API 已真实走通：
  - `save(kind=workbench) -> list(kind=workbench) -> delete`
- live browser smoke 已真实走通：
  - 打开空 `/plm`
  - 自动恢复 `PLM Workbench Link View`
  - 页面同步恢复：
    - `documentRole=primary`
    - `documentFilter=link-gear`
    - `approvalsFilter=link-eco`
    - `cadReviewState=approved`
    - `cadReviewNote=team-view-note`
- 验证后临时 `workbench` 视图已清理，当前 `kind=workbench` 列表恢复为空
- 本轮 `core-backend` 聚焦单测、`build` 通过；`apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过

## 补充增量 1.40

### PLM Workbench Team View Deep Links

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-deeplinks-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-deeplinks-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-deeplinks-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-view-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-deeplinks-20260310)

结果:

- `/plm` 已正式支持 `workbenchTeamView=<id>` 显式 deep link
- `workbenchTeamView` 现在同时具备：
  - 视图身份引用
  - 具体字段状态展开
- live 浏览器 smoke 已真实确认：
  - 默认工作台视图存在时
  - 显式 `workbenchTeamView` 仍优先生效
- 页面恢复到的显式状态包括：
  - `documentRole=secondary`
  - `documentFilter=explicit-link-doc`
  - `approvalsFilter=explicit-link-eco`
  - `cadReviewState=rejected`
  - `cadReviewNote=explicit-link-note`
- 本轮 `apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- 验证后两条临时 `workbench` 视图已清理，当前 `kind=workbench` 列表恢复为空

## 补充增量 1.41

### PLM Workbench Team View Rename / Duplicate

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-rename-duplicate-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-rename-duplicate-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-rename-duplicate-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-rename-duplicate-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-view-rename-duplicate-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-rename-duplicate-20260310)

结果:

- `PLM workbench team view` 已支持：
  - `duplicate`
  - `rename`
- `duplicate` 允许把同租户共享视图 fork 成当前用户自己的副本
- `rename` 保持 owner-only
- live API 已真实走通：
  - `save -> duplicate -> rename -> list -> cleanup`
- 浏览器 smoke 已真实走通：
  - 通过 UI 执行 `复制副本 -> 重命名`
  - 新副本会自动成为当前选中工作台视图
  - 当前 workbench 状态在复制/重命名过程中保持不变
- 本轮 `core-backend` 聚焦单测 / build、`apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- 验证后临时 `workbench` 视图已清理，当前 `kind=workbench` 列表恢复为空

## 补充增量 1.42

### PLM Workbench Team View URL Sync

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-url-sync-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-url-sync-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-url-sync-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-view-url-sync-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-url-sync-20260310)

结果:

- `PLM workbench team view` 在 `duplicate / rename` 后，地址栏里的 `workbenchTeamView` 已会切到当前视图 id
- 复制后不会再停留在旧 source view 的显式 deep link
- 重命名后会继续保持当前 workbench view 的 URL 身份
- 浏览器 smoke 已真实确认：
- `duplicate` 后 URL 从 source id 切到新副本 id
- `rename` 后 URL 保持在新副本 id
- 当前 `Documents / CAD / Approvals` 工作状态保持不变
- 本轮 `apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- 验证后临时 `workbench` 视图已清理，当前 `kind=workbench` 列表恢复为空

## 补充增量 1.43

### PLM Workbench Team View Save / Default URL Sync

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-save-default-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-save-default-url-sync-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-save-default-url-sync-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-save-default-url-sync-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-workbench-team-view-save-default-url-sync-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-save-default-url-sync-20260310)

结果:

- `PLM workbench team view` 在 `save / set default` 后，地址栏里的 `workbenchTeamView` 已会锚定当前视图 id
- 新建团队视图后，不会再停留在匿名 workbench 状态
- 设为默认后，URL 会继续保持当前视图 id，不会丢失显式 deep link 身份
- 浏览器 smoke 已真实确认：
  - `save` 后 URL 立即获得新视图 id
  - `set default` 后 URL 保持同一 id
  - 当前 `Documents / CAD / Approvals` 工作状态保持不变
- 本轮 `apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- 验证后临时 `workbench` 视图已清理，当前 `kind=workbench` 列表恢复为空

## 补充增量 1.44

### PLM BOM / Where-Used Team Preset Deep Links

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-bom-where-used-team-preset-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-team-preset-deeplinks-benchmark-design-20260310.md)
- 新增验证文档 [plm-bom-where-used-team-preset-deeplinks-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-team-preset-deeplinks-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-bom-where-used-team-preset-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310)

结果:

- `/plm` 现已支持：
  - `bomTeamPreset=<id>`
  - `whereUsedTeamPreset=<id>`
- 空 `/plm` 会自动恢复默认 `BOM / Where-Used` 团队预设，并把对应 preset id 回写到 URL
- 显式 `bomTeamPreset / whereUsedTeamPreset` deep link 会覆盖默认团队预设，不会再被默认值吞掉
- URL 会同时保留：
  - team preset identity
  - 当前过滤字段/值
- 本轮 `apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- live API 已完成：
  - `save -> set default -> explicit deep link verify -> cleanup`
- 验证后临时 `BOM / Where-Used` 团队预设已清理，当前列表恢复为：
  - `bomTotal = 0`
  - `whereUsedTotal = 0`

## 补充增量 1.45

### PLM Local Filter Preset Deep Links

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-local-filter-preset-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-deeplinks-benchmark-design-20260310.md)
- 新增验证文档 [plm-local-filter-preset-deeplinks-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-deeplinks-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-local-filter-preset-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-deeplinks-20260310)

结果:

- `/plm` 现已支持：
  - `bomFilterPreset=<local-key>`
  - `whereUsedFilterPreset=<local-key>`
- 显式 local preset deep link 会优先于同面板默认 team preset
- `BOM / Where-Used` 在应用 local preset 后，会清掉同面板的 `team preset` identity
- `field/value` 仍会保留在 URL 中，但最终恢复顺序已变成：
  - 显式 local preset
  - 显式 team preset
  - 默认 team preset
  - 原始 field/value
- 本轮 `apps/web` 聚焦测试、`test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- live/browser 验证已完成：
  - 创建默认 team preset 作为冲突环境
  - 在浏览器内保存本地 BOM / Where-Used preset
  - 打开显式 local preset URL，确认没有被默认 team preset 覆盖
  - 清理 live 默认 team preset 与浏览器 localStorage
- cleanup 后 live 列表恢复为：
  - `bomTotal = 0`
  - `whereUsedTotal = 0`

## 补充增量 1.46

### PLM Local Filter Preset Duplicate / Rename

- 更新 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 新增设计文档 [plm-local-filter-preset-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-duplicate-rename-benchmark-design-20260310.md)
- 新增验证文档 [plm-local-filter-preset-duplicate-rename-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-duplicate-rename-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-local-filter-preset-duplicate-rename-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-duplicate-rename-20260310)

结果:

- `BOM / Where-Used` 本地过滤预设现已支持：
  - `duplicate`
  - `rename`
- `duplicate` 会生成新的 local preset key，并立即把 URL 切到新的：
  - `bomFilterPreset=<local-key>`
  - `whereUsedFilterPreset=<local-key>`
- `rename` 只更新 preset label，不会改变当前 URL 中的 local preset identity
- 浏览器 smoke 已真实确认：
  - `BOM duplicate` 后 URL 切到新 key
  - `BOM rename` 后 URL 保持同一 key
  - `Where-Used duplicate` 后 URL 切到新 key
  - `Where-Used rename` 后 URL 保持同一 key
- 本轮 `apps/web` 聚焦测试、`test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- cleanup 后浏览器 localStorage 已恢复为空：
  - `plm_bom_filter_presets = null`
  - `plm_where_used_filter_presets = null`

## 补充增量 1.47

### PLM Local Preset Promote to Team

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-local-preset-promote-team-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-team-benchmark-design-20260310.md)
- 新增验证文档 [plm-local-preset-promote-team-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-team-verification-20260310.md)
- 归档浏览器 smoke 证据到 [plm-local-preset-promote-team-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-preset-promote-team-20260310)
- 新增 artifact：
  - [plm-local-preset-promote-team-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-team-browser-20260310.json)
  - [plm-local-preset-promote-team-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-team-cleanup-20260310.json)

结果:

- `BOM / Where-Used` 本地过滤预设现已支持一键 `升团队`
- promotion 成功后，URL identity 会自动从：
  - `bomFilterPreset=<local-key>` 切到 `bomTeamPreset=<id>`
  - `whereUsedFilterPreset=<local-key>` 切到 `whereUsedTeamPreset=<id>`
- promotion 成功后会同步清掉同面板 local preset identity，避免 URL 同时携带 local / team 双身份
- 团队命名冲突会自动生成安全名称，不会覆盖已有团队预设
- live/browser 已真实确认：
  - 先保存 BOM / Where-Used local preset
  - 再分别提升为 team preset
  - 两次请求都返回 `201`
  - 两个 team preset 下拉都切到新创建对象
  - 两个 local preset key 都被清空
- 本轮 `apps/web` 聚焦测试、`test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- cleanup 后 live 与浏览器状态已恢复：
  - `bomTotal = 0`
  - `whereUsedTotal = 0`
  - `plm_bom_filter_presets = null`
  - `plm_where_used_filter_presets = null`

## 补充增量 1.48

### PLM Local Preset Promote to Team Default

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-local-preset-promote-default-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-default-benchmark-design-20260310.md)
- 新增验证文档 [plm-local-preset-promote-default-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-default-verification-20260310.md)
- 新增 artifact：
  - [plm-local-preset-promote-default-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-default-browser-20260310.json)
  - [plm-local-preset-promote-default-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-default-cleanup-20260310.json)

结果:

- `BOM / Where-Used` 本地过滤预设现已支持一键 `升默认`
- promotion 成功后会顺序完成：
  - 创建 team preset
  - 设为默认
  - 将 URL identity 从 local key 切到 team id
  - 清掉同面板 local preset identity
- live/browser 已真实确认：
  - `BOM` 会落到 `bomTeamPreset=7c4e79d0-19bc-4598-8dc5-839b22cfcc84`
  - `Where-Used` 会落到 `whereUsedTeamPreset=b5541f0f-3158-4d77-b494-34a51a036bd7`
  - 两个团队预设下拉都显示 `· 默认`
  - 完成后 URL 不再保留 `bomFilterPreset / whereUsedFilterPreset`
- 本轮 `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`、`apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- cleanup 后 live 与浏览器状态已恢复：
  - `bomTeamPreset = null`
  - `whereUsedTeamPreset = null`
  - `plm_bom_filter_presets = null`
  - `plm_where_used_filter_presets = null`

## 补充增量 1.49

### PLM Team Preset Clear Default URL Sync

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-clear-default-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-clear-default-url-sync-benchmark-design-20260310.md)
- 新增验证文档 [plm-team-preset-clear-default-url-sync-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-clear-default-url-sync-verification-20260310.md)
- 新增 artifact：
  - [plm-team-preset-clear-default-url-sync-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-clear-default-url-sync-browser-20260310.json)
  - [plm-team-preset-clear-default-url-sync-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-clear-default-url-sync-cleanup-20260310.json)

结果:

- `BOM / Where-Used` team preset 在 `clear default` 后已继续保持显式 URL 身份
- `clear default` 后 URL 仍保留：
  - `bomTeamPreset=<id>`
  - `whereUsedTeamPreset=<id>`
- `clear default` 后不会退回：
  - `bomFilterPreset`
  - `whereUsedFilterPreset`
- 本轮已真实验证的 team preset id 为：
  - `e2331ade-4604-47a4-8dc2-f5d0d9c2add8`
  - `2ef753ea-dd9a-45a3-983e-8e0d8c4bac2d`
- 本轮 `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`、`apps/web test / type-check / lint / build` 与根级 `pnpm lint` 已通过
- live/browser 已真实确认：
  - 先保存 BOM / Where-Used team preset
  - 再分别 `设为默认`
  - 然后分别 `取消默认`
  - 两条 URL identity 都保持不变
- cleanup 后 live 环境已恢复：
  - `bomTeamPreset = null`
  - `whereUsedTeamPreset = null`
  - URL 回到原始 `bomFilter / whereUsedFilter` 状态

## 补充增量 1.50

### PLM Team Preset Duplicate / Rename

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-duplicate-rename-benchmark-design-20260310.md)
- 新增验证文档 [plm-team-preset-duplicate-rename-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-duplicate-rename-verification-20260310.md)
- 新增 artifact：
  - [plm-team-preset-duplicate-rename-api-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-api-20260310.json)
  - [plm-team-preset-duplicate-rename-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-browser-20260310.json)
  - [plm-team-preset-duplicate-rename-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-cleanup-20260310.json)
  - [page-team-preset-duplicate-rename.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-duplicate-rename-20260310/page-team-preset-duplicate-rename.png)

结果:

- `BOM / Where-Used` team preset 现在已支持：
  - `duplicate`
  - `rename`
- `duplicate` 后会创建新的 team preset identity，并立即把 URL 切到新的：
  - `bomTeamPreset=<new-id>`
  - `whereUsedTeamPreset=<new-id>`
- `rename` 后会继续保持当前 team preset id，不会打断 deep link
- 本轮 live 浏览器真实确认：
  - BOM duplicate 后 URL 切到 `43e8bd3e-382e-4de9-b33f-f3ba92662aac`
  - Where-Used duplicate 后 URL 切到 `2e1349dd-59d6-41da-9c13-c389fd3e53b2`
  - rename 后两条 URL identity 都保持不变
  - 当前选中项最终为：
    - `BOM Browser Copy Renamed (Live) · dev-user`
    - `Where Used Browser Copy Renamed (Live) · dev-user`
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm lint`
- live runtime 本轮还顺手修正了一个真实运行态问题：
  - 旧 `7778` backend 未加载到新 route
  - 已重启到当前 `plm-workbench` 剖面
- cleanup 后 live 临时团队预设已全部删除，环境已恢复干净状态

## 补充增量 1.51

### PLM Team Preset Delete URL Cleanup

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md)
- 新增验证文档 [plm-team-preset-delete-url-cleanup-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-delete-url-cleanup-verification-20260310.md)
- 新增 artifact：
  - [plm-team-preset-delete-url-cleanup-setup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-setup-20260310.json)
  - [plm-team-preset-delete-url-cleanup-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-browser-20260310.json)
  - [plm-team-preset-delete-url-cleanup-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-cleanup-20260310.json)
  - [page-team-preset-delete-url-cleanup.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-delete-url-cleanup-20260310/page-team-preset-delete-url-cleanup.png)

结果:

- 删除当前 `BOM / Where-Used team preset` 后，URL 会立即移除：
  - `bomTeamPreset`
  - `whereUsedTeamPreset`
- 同时继续保留当前过滤工作态：
  - `bomFilter=delete-bom-gear`
  - `whereUsedFilter=delete-where-assy`
- 不会回退到：
  - `bomFilterPreset`
  - `whereUsedFilterPreset`
- hook 级 delete 语义也已经补齐：
  - 清空 `teamPresetKey`
  - 清空 `teamPresetName / teamPresetGroup`
  - 清空当前 `requestedPresetId`
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 先通过显式 `bomTeamPreset / whereUsedTeamPreset` deep link 进入
  - 删除 BOM 当前 team preset 后 URL 先只清掉 `bomTeamPreset`
  - 再删除 Where-Used 当前 team preset 后 URL 完全退出 team preset identity
- live 列表校验已确认 cleanup 后恢复干净：
  - `bomTotal = 0`
  - `whereUsedTotal = 0`

## 补充增量 1.52

### PLM Workbench Team View Delete URL Cleanup

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-delete-url-cleanup-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-delete-url-cleanup-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-delete-url-cleanup-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-delete-url-cleanup-verification-20260310.md)
- 新增 artifact：
  - [plm-workbench-team-view-delete-url-cleanup-setup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-setup-20260310.json)
  - [plm-workbench-team-view-delete-url-cleanup-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-browser-20260310.json)
  - [plm-workbench-team-view-delete-url-cleanup-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-cleanup-20260310.json)
  - [page-workbench-team-view-delete-url-cleanup.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-delete-url-cleanup-20260310/page-workbench-team-view-delete-url-cleanup.png)

结果:

- 删除当前 `PLM workbench team view` 后，URL 会立即移除：
  - `workbenchTeamView`
- 同时继续保留当前工作台 query 状态：
  - `documentRole=delete-secondary`
  - `documentFilter=delete-doc`
  - `approvalsFilter=delete-eco`
  - `cadReviewState=rejected`
  - `cadReviewNote=delete-note`
- 不会回退到其他 team view，也不会把当前工作台状态一并清空
- hook 级 delete 语义也已经补齐：
  - 清空 `teamViewKey`
  - 清空 `teamViewName`
  - 清空当前 `requestedViewId`
  - 清空 `lastAutoAppliedDefaultId`
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 先通过显式 `workbenchTeamView` deep link 进入
  - 删除当前 team view 后 URL 只退出 `workbenchTeamView`
  - `document / approvals / cad` 三组工作状态继续保留
- live 列表校验已确认 cleanup 后恢复干净：
  - `total = 0`
  - `kind = workbench`

## 补充增量 1.53

### PLM Workbench Team View Archive Restore

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增迁移 [zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新测试：
  - [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
  - [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
  - [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
  - [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-archive-restore-benchmark-design-20260310.md)
- 新增验证文档 [plm-workbench-team-view-archive-restore-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-archive-restore-verification-20260310.md)
- 新增 artifact：
  - [plm-workbench-team-view-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-20260310.json)
  - [plm-workbench-team-view-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-browser-20260310.json)
  - [plm-workbench-team-view-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-cleanup-20260310.json)
  - [page-workbench-team-view-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-archive-restore-20260310/page-workbench-team-view-archive-restore.txt)

结果:

- `PLM workbench team view` 现在支持：
  - `archive`
  - `restore`
- 归档后，URL 会立即退出：
  - `workbenchTeamView`
- 但当前工作台 query 状态仍保留：
  - `documentRole=archive-secondary`
  - `documentFilter=archive-doc`
  - `approvalsFilter=archive-eco`
  - `cadReviewState=approved`
  - `cadReviewNote=archive-note`
- 恢复后，会把同一个 `workbenchTeamView=<id>` 再次带回 URL
- 下拉目录会显式标出：
  - `· 已归档`
- 归档项不可继续应用或设默认，但可以恢复
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-team-views.test.ts tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend migrate`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `workbenchTeamView` deep link 进入
  - `archive` 后 URL 只退出 `workbenchTeamView`
  - `restore` 后 URL 恢复同一个 `workbenchTeamView` id
  - `document / approvals / cad` 三组工作状态在整个周期内保持不变
- live cleanup 已确认环境恢复干净：
  - `deleteStatus = 200`

## 补充增量 1.54

### PLM Team Preset Archive Restore

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增迁移 [zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新测试：
  - [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
  - [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
  - [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
  - [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-archive-restore-benchmark-design-20260310.md)
- 新增验证文档 [plm-team-preset-archive-restore-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-archive-restore-verification-20260310.md)
- 新增 artifact：
  - [plm-team-preset-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-20260310.json)
  - [plm-team-preset-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-browser-20260310.json)
  - [plm-team-preset-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-cleanup-20260310.json)
  - [page-team-preset-archive-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-archive-restore-20260310/page-team-preset-archive-restore.png)
  - [page-team-preset-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-archive-restore-20260310/page-team-preset-archive-restore.txt)

结果:

- `BOM / Where-Used team preset` 现在支持：
  - `archive`
  - `restore`
- 归档后，URL 会只退出当前面板的：
  - `bomTeamPreset`
  - `whereUsedTeamPreset`
- 同时继续保留当前过滤工作态：
  - `bomFilter=root/archive-live`
  - `whereUsedFilter=assy-restore-live`
- 归档项会在目录中显式显示：
  - `· 已归档`
- 恢复后，会把同一个 team preset id 再次带回 URL
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend migrate`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `bomTeamPreset / whereUsedTeamPreset` deep link 进入
  - 先 archive BOM，再 archive Where-Used，URL 会按面板逐步退出 identity
  - 再 restore BOM 和 Where-Used，同一个 preset id 会逐步回到 URL
- live cleanup 已确认环境恢复干净：
  - `bom total / activeTotal / archivedTotal = 0 / 0 / 0`
  - `whereUsed total / activeTotal / archivedTotal = 0 / 0 / 0`

## 补充增量 1.55

### PLM Panel Team View Archive Restore

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增设计文档 [plm-panel-team-view-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-archive-restore-benchmark-design-20260310.md)
- 新增验证文档 [plm-panel-team-view-archive-restore-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-archive-restore-verification-20260310.md)
- 新增 artifact：
  - [plm-panel-team-view-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-20260310.json)
  - [plm-panel-team-view-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-browser-20260310.json)
  - [plm-panel-team-view-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-cleanup-20260310.json)
  - [page-panel-team-view-archive-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-archive-restore-20260310/page-panel-team-view-archive-restore.png)
  - [page-panel-team-view-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-archive-restore-20260310/page-panel-team-view-archive-restore.txt)

结果:

- `Documents / CAD / Approvals team view` 现在都支持：
  - `archive`
  - `restore`
- `archive` 后会只退出对应面板的 URL identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- 同时保留当前面板工作状态：
  - `documentRole / documentFilter / sort`
  - `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
  - `approvalsFilter / approvalComment / sort`
- 已归档视图会在下拉中显式显示：
  - `· 已归档`
- 归档项不能继续 `apply`
- `restore` 后同一个 team view id 会重新回到 URL
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `documentTeamView / cadTeamView / approvalsTeamView` deep link 进入
  - 三个面板分别 `archive` 后，URL 会逐步退出对应 identity
  - 三个面板分别 `restore` 后，同一个 id 会逐步回到 URL
- live cleanup 已确认环境恢复干净：
  - `documents total = 0`
  - `cad total = 0`
  - `approvals total = 0`

## 补充增量 1.58

### PLM Team Preset Share

- 更新 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-share-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-share-benchmark-design-20260311.md)
- 新增验证文档 [plm-team-preset-share-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-share-verification-20260311.md)
- 新增 artifact：
  - [plm-team-preset-share-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-20260311.json)
  - [plm-team-preset-share-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-browser-20260311.json)
  - [plm-team-preset-share-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-cleanup-20260311.json)
  - [page-bom-team-preset-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-bom-team-preset-share.png)
  - [page-bom-team-preset-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-bom-team-preset-share.txt)
  - [page-where-used-team-preset-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-where-used-team-preset-share.png)
  - [page-where-used-team-preset-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-where-used-team-preset-share.txt)

结果:

- `BOM / Where-Used team preset` 现在都支持：
  - `分享`
- 分享生成的是显式协作 deep link：
  - `bomTeamPreset=<id>`
  - `whereUsedTeamPreset=<id>`
- 分享链接会继续带回当前 filter 值与字段：
  - `bomFilter / bomFilterField`
  - `whereUsedFilter / whereUsedFilterField`
- fresh `/plm` 打开分享链接后，会恢复：
  - 选中的 team preset id
  - 对应的 filter value
  - 对应的 filter field
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmFilterPresetUtils.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - BOM 分享链接恢复为 `path + root/share-bom`
  - Where-Used 分享链接恢复为 `parent_number + ASSY-SHARE-VALID`
  - 两条分享链接都恢复到了显式 team preset identity
- live cleanup 已确认环境恢复干净：
  - `bomTotal = 0`
  - `whereUsedTotal = 0`

## 补充增量 1.58

### PLM Team Preset Owner Transfer

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-team-preset-owner-transfer-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-owner-transfer-benchmark-design-20260310.md)
- 新增验证文档 [plm-team-preset-owner-transfer-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-owner-transfer-verification-20260310.md)
- 新增 artifact：
  - [plm-team-preset-owner-transfer-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-20260310.json)
  - [plm-team-preset-owner-transfer-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-browser-20260310.json)
  - [plm-team-preset-owner-transfer-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-cleanup-20260310.json)
  - [page-team-preset-owner-transfer.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-owner-transfer-20260310/page-team-preset-owner-transfer.png)
  - [page-team-preset-owner-transfer.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-owner-transfer-20260310/page-team-preset-owner-transfer.txt)

结果:

- `BOM / Where-Used team preset` 现在都支持：
  - `owner transfer`
- transfer 后会继续保持对应 preset 的 URL identity：
  - `bomTeamPreset`
  - `whereUsedTeamPreset`
- transfer 后当前列表项 owner 会立即更新
- transfer 后当前用户会立即失去：
  - `设为默认`
  - `删除`
  - `归档`
  - `转移所有者`
 这些管理权限
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `bomTeamPreset / whereUsedTeamPreset` deep link 进入
  - 输入 `plm-preset-transfer-user`
  - 分别点击两侧 `转移所有者`
  - 页面选中项分别切到：
    - `Transfer BOM Team Preset Source (owner-transfer) · plm-preset-transfer-user`
    - `Transfer Where-Used Team Preset Source (owner-transfer) · plm-preset-transfer-user`
  - URL 仍保持：
    - `bomTeamPreset=e940479d-b025-47f7-9e44-9a8d679e9916`
    - `whereUsedTeamPreset=bbaff28d-dfbe-4264-901d-6ec83c49c637`
- live cleanup 已确认环境恢复干净：
  - `remainingPresetCount.count = 0`
  - `remainingUserCount.count = 0`

## 补充增量 1.57

### PLM Panel Team View Owner Transfer

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增设计文档 [plm-panel-team-view-owner-transfer-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-owner-transfer-benchmark-design-20260310.md)
- 新增验证文档 [plm-panel-team-view-owner-transfer-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-owner-transfer-verification-20260310.md)
- 新增 artifact：
  - [plm-panel-team-view-owner-transfer-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-20260310.json)
  - [plm-panel-team-view-owner-transfer-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-browser-20260310.json)
  - [plm-panel-team-view-owner-transfer-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-cleanup-20260310.json)
  - [page-panel-team-view-owner-transfer.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-owner-transfer-20260310/page-panel-team-view-owner-transfer.png)
  - [page-panel-team-view-owner-transfer.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-owner-transfer-20260310/page-panel-team-view-owner-transfer.txt)

结果:

- `Documents / CAD / Approvals team view` 现在都支持：
  - `owner transfer`
- transfer 后会继续保持对应面板的 URL identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- transfer 后当前列表项 owner 会立即更新
- transfer 后当前用户会立即失去：
  - `设为默认`
  - `删除`
  - `归档`
  - `转移所有者`
  这些管理权限
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `documentTeamView` deep link 进入
  - 输入 `plm-transfer-user`
  - 点击 `转移所有者`
  - 页面选中项切到 `Transfer Panel View Source · plm-transfer-user`
  - URL 仍保持 `documentTeamView=0e798b6f-7372-42c2-b341-3fd3ecc7e8a8`
- live cleanup 已确认环境恢复干净：
  - `remainingView.count = 0`
  - `remainingUser.count = 0`

## 补充增量 1.56

### PLM Panel Team View Duplicate Rename

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 新增设计文档 [plm-panel-team-view-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-duplicate-rename-benchmark-design-20260310.md)
- 新增验证文档 [plm-panel-team-view-duplicate-rename-verification-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-duplicate-rename-verification-20260310.md)
- 新增 artifact：
  - [plm-panel-team-view-duplicate-rename-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-20260310.json)
  - [plm-panel-team-view-duplicate-rename-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-browser-20260310.json)
  - [plm-panel-team-view-duplicate-rename-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-cleanup-20260310.json)
  - [page-panel-team-view-duplicate-rename.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-duplicate-rename-20260310/page-panel-team-view-duplicate-rename.png)
  - [page-panel-team-view-duplicate-rename.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-duplicate-rename-20260310/page-panel-team-view-duplicate-rename.txt)

结果:

- `Documents / CAD / Approvals team view` 现在都支持：
  - `duplicate`
  - `rename`
- `duplicate` 后会只切换对应面板的 URL identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- `rename` 后会继续保持当前副本 id，不会回退到 source
- 三个面板的当前工作状态在整个 duplicate / rename 周期内保持不变：
  - `documentRole / documentFilter`
  - `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
  - `approvalsFilter / approvalComment`
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `documentTeamView / cadTeamView / approvalsTeamView` deep link 进入
  - 三个面板分别 `duplicate` 后，URL 会逐步切到新副本 id
  - 三个面板分别 `rename` 后，URL 会继续保持对应副本 id
- live cleanup 已确认环境恢复干净：
  - `documents total = 0`
  - `cad total = 0`
  - `approvals total = 0`
## 补充增量 1.58

### PLM Panel Team View Share

- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 新增设计文档 [plm-panel-team-view-share-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-share-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-share-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-20260311.json)
  - [plm-panel-team-view-share-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-browser-20260311.json)
  - [plm-panel-team-view-share-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-cleanup-20260311.json)
  - [page-panel-team-view-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-20260311/page-panel-team-view-share.png)
  - [page-panel-team-view-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-20260311/page-panel-team-view-share.txt)

结果:

- `Documents / CAD / Approvals team view` 现在都支持：
  - `分享`
- 分享链接会显式带出对应 panel identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- 分享链接会同时保留当前 panel 的关键状态：
  - `documentRole / documentFilter / documentSort / documentSortDir / documentColumns`
  - `cadFileId / cadOtherFileId / cadReviewState / cadReviewNote`
  - `approvalsStatus / approvalsFilter / approvalComment / approvalSort / approvalSortDir / approvalColumns`
- fresh `/plm` 打开分享链接后，会继续恢复 team view identity，而不是回退到默认 team view 或匿名状态
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchViewState.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - Documents `分享` 后，fresh 页面恢复 `documentTeamView = c7af9e28-e525-44c7-8a8a-08e46558f4ec`
  - CAD `分享` 后，fresh 页面恢复 `cadTeamView = 9af3a52e-bd08-46fb-95d9-5ec040286e1f`
  - Approvals `分享` 后，fresh 页面恢复 `approvalsTeamView = 3d762c41-7f27-4de6-aae6-12181cbd7e5d`
- live cleanup 已确认环境恢复干净：
  - `documents = 0`
  - `cad = 0`
  - `approvals = 0`

## 补充增量 1.59

### PLM Panel Team View Clear Default URL Sync

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-panel-team-view-clear-default-url-sync-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-clear-default-url-sync-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-clear-default-url-sync-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-clear-default-url-sync-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-clear-default-url-sync-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-20260311.json)
  - [plm-panel-team-view-clear-default-url-sync-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-browser-20260311.json)
  - [plm-panel-team-view-clear-default-url-sync-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-cleanup-20260311.json)
  - [page-panel-team-view-clear-default-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-clear-default-url-sync-20260311/page-panel-team-view-clear-default-url-sync.png)

结果:

- `Documents / CAD / Approvals team view` 现在在 `clear default` 后会继续保留显式 URL identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- `clear default` 后会继续保留当前 panel 工作状态：
  - `documentFilter`
  - `cadReviewNote`
  - `approvalsFilter`
- 这条 lifecycle 已与：
  - `duplicate / rename`
  - `archive / restore`
  - `share`
  - `owner transfer`
  对齐到同一条 identity 规则
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `documentTeamView` deep link 打开 `/plm`
  - 依次点击 `文档 / CAD / 审批` 的 `取消默认`
  - 最终 URL 仍保留：
    - `documentTeamView=6936fa3d-20c5-4d75-9a45-f25aa5f6559a`
    - `cadTeamView=2cf1393f-6c7f-47ff-b2db-d2972f4eb35a`
    - `approvalsTeamView=6f290c7c-47c4-44c9-935b-29b144c82aec`
- live cleanup 已确认环境恢复干净：
  - `documents delete = 200`
  - `cad delete = 200`
  - `approvals delete = 200`

## 补充增量 1.60

### PLM Panel Team View Set Default URL Sync

- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-panel-team-view-set-default-url-sync-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-set-default-url-sync-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-set-default-url-sync-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-set-default-url-sync-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-set-default-url-sync-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-20260311.json)
  - [plm-panel-team-view-set-default-url-sync-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-browser-20260311.json)
  - [plm-panel-team-view-set-default-url-sync-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-cleanup-20260311.json)
  - [page-panel-team-view-set-default-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-set-default-url-sync-20260311/page-panel-team-view-set-default-url-sync.png)

结果:

- `Documents / CAD / Approvals team view` 在 `set default` 后会继续保留显式 URL identity：
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
- `set default` 后会继续保留当前 panel 工作状态：
  - `documentFilter`
  - `cadReviewNote`
  - `approvalsFilter`
- 三个 panel 都会进入 `· 默认`，但不会把显式 deep link identity 降级成匿名默认状态
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live 浏览器 smoke 已真实确认：
  - 通过显式 `documentTeamView / cadTeamView / approvalsTeamView` deep link 打开 `/plm`
  - 依次点击 `文档 / CAD / 审批` 的 `设为默认`
  - 最终 URL 仍保留：
    - `documentTeamView=31975883-9b2e-4bef-80ed-50fcfaaa7228`
    - `cadTeamView=7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c`
    - `approvalsTeamView=f9bd71c1-a96d-4f2d-837f-4c9474be2883`
- live cleanup 已确认环境恢复干净：
  - `documents delete = 200`
  - `cad delete = 200`
  - `approvals delete = 200`

## 补充增量 1.61

### PLM Panel Team View Permission Guards

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 新增设计文档 [plm-panel-team-view-permission-guards-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-permission-guards-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-permission-guards-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-permission-guards-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-permission-guards-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-permission-guards-20260311.json)

结果:

- `Documents / CAD / Approvals team view` 在 `archived` 状态下，前端现在会统一阻断：
  - `分享`
  - `转移所有者`
  - `取消默认`
- `plm-workbench` 后端 route 已补齐 archived `409`：
  - `transfer -> 409`
  - `clear default -> 409`
- 这轮把 archived 权限边界从“按钮状态”提升成了“前端 runtime guard + 后端 route guard”双层约束
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- fresh live backend 已真实确认：
  - `auth/me = 200`
  - `create = 201`
  - `archive = 200`
  - `transfer = 409`
  - `clear default = 409`
  - `cleanup = 200`

## 补充增量 1.62

### PLM Panel Team View Share Owner Boundary

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-share-owner-boundary-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-owner-boundary-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-share-owner-boundary-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-20260311.json)
  - [plm-panel-team-view-share-owner-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-browser-20260311.json)
  - [plm-panel-team-view-share-owner-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-cleanup-20260311.json)
  - [page-panel-team-view-share-owner-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-owner-boundary-20260311/page-panel-team-view-share-owner-boundary.png)

结果:

- `Documents / CAD / Approvals team view share` 现在收成了 owner-only
- transfer owner 之后，旧 owner 仍能通过显式 `documentTeamView` 打开视图，但不能再：
  - `分享`
  - `转移所有者`
- 这轮把 `read/apply` 和 `share/manage` 的边界正式拆开了
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live API 已真实确认：
  - `create = 201`
  - `transfer = 200`
  - `ownerUserId = plm-transfer-user`
  - `canManageAfterTransfer = false`
- live browser smoke 已真实确认：
  - 显式 `documentTeamView=7ddbd564-72d7-458c-ad48-dc2150f9cc4a` 仍能恢复
  - 选中项显示 `Share Owner Boundary Source · plm-transfer-user`
  - `分享` 按钮禁用
  - `转移所有者` 按钮禁用

## 补充增量 1.63

### PLM Panel Team View Readonly UI Boundary

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-panel-team-view-readonly-ui-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-readonly-ui-boundary-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-readonly-ui-boundary-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-readonly-ui-boundary-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-readonly-ui-boundary-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-20260311.json)
  - [plm-panel-team-view-readonly-ui-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-browser-20260311.json)
  - [plm-panel-team-view-readonly-ui-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-cleanup-20260311.json)
  - [page-panel-team-view-readonly-ui-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-readonly-ui-boundary-20260311/page-panel-team-view-readonly-ui-boundary.png)

结果:

- `Documents / CAD / Approvals team view` 在 owner transfer 之后，非 owner 现在进入真正的只读 UI
- 非 owner 仍可：
  - `应用`
  - `复制副本`
- 非 owner 不再看到：
  - `分享`
  - `设为默认`
  - `取消默认`
  - `删除`
  - `归档`
  - `恢复`
  - `重命名`
  - `转移所有者`
- owner transfer 输入框也会自动清空并从 UI 中移除
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live browser smoke 已真实确认：
  - 显式 `documentTeamView=c746900a-4ba7-44c7-8505-915ce546225e` 仍能恢复
  - 选中项显示 `Readonly UI Boundary Source · plm-transfer-user`
  - 可见按钮仅剩 `应用 / 复制副本 / 保存到团队`
  - owner transfer 输入框不存在
- 临时 live documents team view 已清理，`deleted = 1`

## 补充增量 1.64

### PLM Collaborative Permissions Team Preset Readonly Boundary

- 新增 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 新增设计文档 [plm-collaborative-permissions-team-preset-readonly-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-permissions-team-preset-readonly-benchmark-design-20260311.md)
- 新增验证文档 [plm-collaborative-permissions-team-preset-readonly-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-permissions-team-preset-readonly-verification-20260311.md)
- 新增 artifact：
  - [plm-team-preset-readonly-ui-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-readonly-ui-boundary-browser-20260311.json)
  - [plm-team-preset-readonly-ui-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-readonly-ui-boundary-cleanup-20260311.json)
  - [page-team-preset-readonly-ui-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-readonly-ui-boundary-20260311/page-team-preset-readonly-ui-boundary.png)

结果:

- `PLM collaborative permissions` 现在从 panel team view 扩展到了 `BOM / Where-Used team preset`
- `usePlmTeamViews` 和 `usePlmTeamFilterPresets` 已统一改成消费共享权限 helper，不再维护两套重复的 owner-only / archived / default 规则
- owner transfer 后，`BOM / Where-Used team preset` 会进入真正的只读 UI：
  - 仍可 `应用`
  - 仍可 `复制副本`
  - 仍可 `保存到团队`
  - 不再看到 `分享 / 归档 / 恢复 / 重命名 / 设为默认 / 取消默认 / 删除 / 转移所有者`
- 切到不可管理 preset 时，owner transfer 输入会自动清空
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live browser smoke 已真实确认：
  - 显式 `bomTeamPreset=5d5a79fc-96ed-406b-a353-f700f505b95c` 仍能恢复
  - 选中项显示 `Readonly BOM Preset Source 1047 (只读组) · plm-transfer-user`
  - 可见按钮仅剩 `刷新 / 应用 / 复制副本 / 保存到团队`
  - owner transfer 输入不存在
- 本轮创建的临时 BOM 团队预设已清理，`deleted = 3`

## 补充增量 1.65

### PLM Collaborative Permissions Matrix

- 新增 [plmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmCollaborativePermissions.ts)
- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)
- 新增 backend 测试 [plm-collaborative-permissions.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-collaborative-permissions.test.ts)
- 更新 backend 测试 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 更新 backend 测试 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 web 测试 [usePlmCollaborativePermissions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCollaborativePermissions.spec.ts)
- 新增设计文档 [plm-collaborative-permissions-matrix-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-permissions-matrix-benchmark-design-20260311.md)
- 新增验证文档 [plm-collaborative-permissions-matrix-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-permissions-matrix-verification-20260311.md)
- 新增 artifact：
  - [plm-collaborative-permissions-matrix-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-permissions-matrix-20260311.json)
  - [plm-collaborative-permissions-matrix-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-permissions-matrix-cleanup-20260311.json)

结果:

- `PLM` 协作对象现在由后端直接返回统一 `permissions` 矩阵，不再只暴露 `canManage / isArchived / isDefault`
- `team preset` 和 `team view` 已共享同一套 matrix builder
- web client 会优先消费接口返回的 `permissions`，旧字段只保留兜底兼容
- `usePlmCollaborativePermissions` 已改成优先使用 `permissions`，不再只依赖本地推导
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-collaborative-permissions.test.ts tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-team-views.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`
- live backend 已重启到新源码，`create` 与 `list` 响应已真实返回完整 `permissions`
- 临时 live preset/view 已清理成功

## 补充增量 1.66

### PLM Team Preset Batch Management Audit

- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 backend 测试 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 web 测试 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增设计文档 [plm-team-preset-batch-management-audit-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-batch-management-audit-benchmark-design-20260311.md)
- 新增验证文档 [plm-team-preset-batch-management-audit-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-batch-management-audit-verification-20260311.md)
- 新增 artifact：
  - [plm-team-preset-batch-management-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-20260311.json)
  - [plm-team-preset-batch-management-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-browser-20260311.json)
  - [plm-team-preset-batch-management-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-cleanup-20260311.json)
  - [page-2026-03-11T03-38-18-805Z.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-batch-management-20260311/.playwright-cli/page-2026-03-11T03-38-18-805Z.png)

结果:

- `PLM BOM / Where-Used team preset` 现在支持 owner-only 的批量 `归档 / 恢复 / 删除`
- web hook 已新增批量管理选择态、批量动作和 processed/skipped 反馈
- `BOM / Where-Used` panel 已增加真实批量管理 UI，不再只能逐条点按钮
- backend 新增 `/api/plm-workbench/filter-presets/team/batch`
- route 已补无效 id 防御：非法 id 不再触发 PostgreSQL `uuid` 比较错误，而是进入 `skippedIds`
- live backend 已输出结构化审计日志，包含：
  - `action`
  - `tenantId`
  - `ownerUserId`
  - `requestedIds`
  - `processedIds`
  - `skippedIds`
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-team-filter-presets.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
- live browser smoke 已真实走通：
  - `BOM batch archive` 后，`bomTeamPreset` 退出 URL
  - 选中同一 archived preset 后 `batch restore`，`bomTeamPreset` 再回写 URL
  - `Where-Used batch delete` 后，`whereUsedTeamPreset` 退出 URL，但 `whereUsedFilter=assy-batch-a` 保留
- 本轮临时 preset 已清理成功；Where-Used 临时数据在批量删除步骤已被清掉，因此 cleanup 返回 `404` 属于预期

## 补充增量 1.67

### PLM Panel Team View Batch Management Audit

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 backend 测试 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 web 测试 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-panel-team-view-batch-management-audit-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-batch-management-audit-benchmark-design-20260311.md)
- 新增验证文档 [plm-panel-team-view-batch-management-audit-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-batch-management-audit-verification-20260311.md)
- 新增 artifact：
  - [plm-panel-team-view-batch-management-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-20260311.json)
  - [plm-panel-team-view-batch-management-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-browser-20260311.json)
  - [plm-panel-team-view-batch-management-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-cleanup-20260311.json)
  - [page-panel-team-view-batch-management.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-batch-management-20260311/page-panel-team-view-batch-management.png)

结果:

- `PLM Documents / CAD / Approvals team view` 现在支持 owner-only 的批量 `归档 / 恢复 / 删除`
- web hook 已新增批量管理选择态、批量动作和 processed/skipped 反馈
- `PlmTeamViewsBlock` 已具备统一批量管理 UI，三个 panel 复用同一块交互
- backend 新增 `/api/plm-workbench/views/team/batch`
- route 已补无效 id 防御：非法 id 不再触发 PostgreSQL `uuid` 比较错误，而是进入 `skippedIds`
- live backend 已输出结构化审计日志，包含：
  - `action`
  - `tenantId`
  - `ownerUserId`
  - `requestedIds`
  - `processedIds`
  - `skippedIds`
  - `processedKinds`
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live browser smoke 已真实走通：
  - `Documents batch archive` 后，`documentTeamView` 退出 URL
  - 重新应用同一 documents team view 后，`documentTeamView` 再回写 URL
  - `Approvals batch delete` 后，`approvalsTeamView` 退出 URL，但 `approvalsFilter=batch-eco-a` 与 `approvalComment=note-a` 保留
- 本轮临时 panel team view 已清理成功

## 补充增量 1.68

### PLM Workbench Team View Batch Management Audit

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 web 测试 [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
- 更新 web 测试 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-batch-management-audit-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-batch-management-audit-benchmark-design-20260311.md)
- 新增验证文档 [plm-workbench-team-view-batch-management-audit-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-batch-management-audit-verification-20260311.md)
- 新增 artifact：
  - [plm-workbench-team-view-batch-management-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-20260311.json)
  - [plm-workbench-team-view-batch-management-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-browser-20260311.json)
  - [plm-workbench-team-view-batch-management-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-cleanup-20260311.json)
  - [page-workbench-team-view-batch-management.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-batch-management-20260311/page-workbench-team-view-batch-management.png)

结果:

- `PLM workbench team view` 现在支持 owner-only 的批量 `归档 / 恢复 / 删除`
- `workbench` 已复用统一的 team view batch UI，不再落后于 `panel team view / team preset`
- `workbenchTeamView` 与批量生命周期保持一致：
  - `batch archive` 后退出 URL
  - `batch restore` 后同一 id 回写 URL
  - `batch delete` 后 identity 清理，但当前 workbench state 保留
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmProductPanel.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live browser smoke 已真实走通：
  - `Batch Workbench A/B/C` 批量归档后，`workbenchTeamView` 退出 URL
  - 批量恢复后，`workbenchTeamView=60afa72c-5745-41b6-87bb-93b43ae58d56` 再回写 URL
  - 批量删除后，`workbenchTeamView` 再退出 URL，但 `documentRole / documentFilter / approvalsFilter / approvalComment / cadReviewState / cadReviewNote` 保留
- 本轮临时 workbench team view 已由浏览器批量删除；cleanup 复查结果为 `relevantRemainingCount = 0`

## 补充增量 1.69

### PLM Workbench Team View Share Transfer Boundary

- 更新 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 web 测试 [usePlmCollaborativePermissions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCollaborativePermissions.spec.ts)
- 更新 web 测试 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 新增设计文档 [plm-workbench-team-view-share-transfer-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-share-transfer-boundary-benchmark-design-20260311.md)
- 新增验证文档 [plm-workbench-team-view-share-transfer-boundary-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-share-transfer-boundary-verification-20260311.md)
- 新增 artifact：
  - [plm-workbench-team-view-share-transfer-boundary-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-20260311.json)
  - [plm-workbench-team-view-share-transfer-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-browser-20260311.json)
  - [plm-workbench-team-view-share-transfer-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-cleanup-20260311.json)
  - [page-workbench-team-view-share-transfer-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-share-transfer-boundary-20260311/page-workbench-team-view-share-transfer-boundary.png)
  - [page-workbench-team-view-share-transfer-boundary.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-share-transfer-boundary-20260311/page-workbench-team-view-share-transfer-boundary.txt)

结果：

- `PLM workbench team view` 的 `share / transfer` 运行时守卫现在统一对齐到 `permissions` 矩阵
- source user 在 owner transfer 之后，API 已返回：
  - `permissions.canManage = false`
  - `permissions.canShare = false`
  - `permissions.canTransfer = false`
- target user 则仍保留完整管理权限
- `workbenchTeamView=<id>` 显式 deep link 仍可读，但 workbench 主块只保留：
  - `应用`
  - `复制副本`
  - `保存到团队`
- `分享 / 转移所有者 / 设为默认 / 归档` 已从旧 owner 的 workbench 主块退出
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm lint`
- live/browser smoke 已真实走通：
  - 创建并转移临时 workbench 视角给 `plm-transfer-user`
  - `dev-user` 再打开显式 `workbenchTeamView` deep link
  - 选中项显示 `Workbench Share Transfer Source 2d2f6c1a · plm-transfer-user`
  - workbench 主块只保留 `应用 / 复制副本 / 保存到团队`
  - 临时 view 已 cleanup，`stillExists = false`

## 补充增量 1.70

### PLM Collaborative Audit Page

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增 backend 测试 [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- 更新 backend 测试 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)
- 更新 [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
- 更新 [App.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/App.vue)
- 新增设计文档 [plm-collaborative-audit-page-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-page-benchmark-design-20260311.md)
- 新增验证文档 [plm-collaborative-audit-page-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-page-verification-20260311.md)
- 新增 artifact：
  - [plm-collaborative-audit-page-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-20260311.json)
  - [plm-collaborative-audit-page-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-browser-20260311.json)
  - [plm-collaborative-audit-page-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-page-cleanup-20260311.json)
  - [page-plm-collaborative-audit.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-page-20260311/page-plm-collaborative-audit.png)

结果：

- `PLM team preset` 与 `PLM team view` 的批量 `归档 / 恢复 / 删除` 已统一写入 `operation_audit_logs`
- backend 新增：
  - `GET /api/plm-workbench/audit-logs`
  - `GET /api/plm-workbench/audit-logs/summary`
- `/plm/audit` 已成为正式工作台页，可直接查看最近窗口内的批量协作审计
- 页面已能展示：
  - `窗口 180 分钟`
  - `资源桶 6`
  - `主要动作 归档`
  - `团队预设批量 · 3`
  - `团队视图批量 · 3`
  - 6 条真实明细行
- live 验证中抓到的真实问题已修正：
  - 初版审计写入落在 `audit_logs`
  - 查询页读的是 `operation_audit_logs`
  - 现已统一到 `operation_audit_logs`
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-workbench-audit-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live/browser smoke 已真实走通：
  - 创建临时 `BOM team preset` 与 `documents team view`
  - 依次执行 `archive / restore / delete`
  - `/plm/audit` 页面加载出 6 条审计记录
  - summary action 桶为 `归档 2 / 删除 2 / 恢复 2`
  - summary resource 桶为 `团队预设批量 3 / 团队视图批量 3`
  - cleanup 后临时对象均已删除

## 补充增量 1.71

### PLM Collaborative Audit Query/Export

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 backend 测试 [plm-workbench-audit-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plmAuditQueryState.ts)
- 新增 web 测试 [plmAuditQueryState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmAuditQueryState.spec.ts)
- 更新 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增设计文档 [plm-collaborative-audit-query-export-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-query-export-benchmark-design-20260311.md)
- 新增验证文档 [plm-collaborative-audit-query-export-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-query-export-verification-20260311.md)
- 新增 artifact：
  - [plm-collaborative-audit-query-export-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-20260311.json)
  - [plm-collaborative-audit-query-export-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-browser-20260311.json)
  - [plm-collaborative-audit-query-export-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-query-export-cleanup-20260311.json)
  - [page-plm-collaborative-audit-query-export.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-query-export-20260311/page-plm-collaborative-audit-query-export.png)

结果：

- `/plm/audit` 现在支持 route-driven 的显式筛选协议：
  - `auditPage`
  - `auditQ`
  - `auditActor`
  - `auditKind`
  - `auditAction`
  - `auditType`
  - `auditFrom`
  - `auditTo`
  - `auditWindow`
- `PlmAuditView` 现在支持直接 `导出 CSV`
- backend 新增：
  - `GET /api/plm-workbench/audit-logs/export.csv`
- `list` 与 `export.csv` 已共用同一份 `buildPlmCollaborativeAuditWhere(...)`
- 本轮已通过：
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-audit-routes.test.ts`
  - `pnpm --filter @metasheet/core-backend build`
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- live/browser smoke 已真实走通：
  - 创建临时 `documents team view`
  - 依次执行 `archive / restore / delete`
  - 通过显式 URL 打开 `/plm/audit?auditActor=dev-user&auditKind=documents&auditAction=archive&auditType=plm-team-view-batch&auditWindow=720`
  - 页面自动恢复 `actor/kind/action/resource/window` 筛选
  - 表格成功收敛到 `documents archive` 审计记录
  - `export.csv` 返回 `200`，CSV preview 带出当前过滤结果
  - cleanup 后临时协作对象已删除，`remainingCount = 0`

## 补充增量 1.72

### PLM Collaborative Audit Saved Views

- 新增 [plmAuditSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plmAuditSavedViews.ts)
- 新增测试 [plmAuditSavedViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmAuditSavedViews.spec.ts)
- 更新 [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmAuditView.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)
- 新增设计文档 [plm-collaborative-audit-saved-views-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-saved-views-benchmark-design-20260311.md)
- 新增验证文档 [plm-collaborative-audit-saved-views-verification-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-collaborative-audit-saved-views-verification-20260311.md)
- 新增 artifact：
  - [plm-collaborative-audit-saved-views-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-saved-views-browser-20260311.json)
  - [plm-collaborative-audit-saved-views-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-saved-views-cleanup-20260311.json)
  - [page-plm-collaborative-audit-saved-views.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-saved-views-20260311/page-plm-collaborative-audit-saved-views.png)

结果：

- `/plm/audit` 现在支持本地 `saved views`
- saved view 复用完整 `PlmAuditRouteState`：
  - `auditPage`
  - `auditQ`
  - `auditActor`
  - `auditKind`
  - `auditAction`
  - `auditType`
  - `auditFrom`
  - `auditTo`
  - `auditWindow`
- 应用 saved view 继续走 route-driven 恢复链路，不绕过 URL
- 删除 saved view 只清理本地条目，不会打断当前审计上下文
- 本轮已通过：
  - `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSavedViews.spec.ts tests/plmAuditQueryState.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
  - `pnpm --filter @metasheet/web exec eslint src/views/PlmAuditView.vue src/views/plmAuditQueryState.ts src/views/plmAuditSavedViews.ts tests/plmAuditSavedViews.spec.ts --max-warnings=0`
  - `pnpm --filter @metasheet/web test / type-check / lint / build`
  - `pnpm lint`
- browser smoke 已真实走通：
  - 打开 `/plm/audit`
  - 设置 `documents / dev-user / archive / team-view-batch / 720`
  - 保存视图 `Documents Archive Saved`
  - 点击 `重置`
  - 再应用 saved view
  - 页面与 URL 一起恢复
  - 删除 saved view 后列表回到空状态，但当前 route 仍保持筛选结果
