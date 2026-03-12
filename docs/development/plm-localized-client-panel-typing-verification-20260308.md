# PLM Localized Client / Panel Typing 验证记录

日期: 2026-03-08

## 变更范围

- 新增 [plmFederationClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmFederationClient.ts)
- 更新 [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

## 结果

### 1. Localized client 已下沉

- `apiGet/apiPost` request adapter 已从 `PlmService` 移到 [plmFederationClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmFederationClient.ts)
- 英文 fallback -> 中文提示映射已集中维护
- [PlmService.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/PlmService.ts) 已缩成薄 service

### 2. 三个面板已脱离 `panel: any`

- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)

现在都直接消费对应的 typed panel model。

### 3. 父页 contract 已收紧

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 中:

- `documentsPanel`
- `cadPanel`
- `approvalsPanel`

均已通过 `satisfies` 绑定 model，避免父页继续无约束地向子面板透传对象。

### 4. lint 门已补齐

[apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json) 的 `lint` 现在覆盖:

- `src/views/PlmProductView.vue`
- `src/views/plm/*.ts`
- `src/services/PlmService.ts`
- `src/services/plm/*.ts`
- `src/components/plm/*.vue`
- `tests/plmService.spec.ts`
- `tests/usePlm*.spec.ts`

## 验证命令

已通过:

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充前置检查:

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果: `200`

## 验证判断

本轮改动没有变更联邦协议，也没有改动 `/api/federation/plm/*` 的业务语义，因此本轮重点验证的是:

- 页面服务层是否仍能正确驱动现有请求
- typed panel contract 是否会在 `vue-tsc` 中暴露断裂
- 新的 `src/services/plm/*.ts` 是否已真正纳入 lint 门

这些目标都已满足。

## 未补跑项

本轮没有生成新的完整 UI regression 报告。

原因:

- 这轮属于 client/panel contract 收口，不是联邦语义变更
- 最近一次成功的真实 `/plm` UI regression 仍可作为行为基线:
  [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

结论:

- 包级质量门已闭环
- 上游 `Yuantus` 健康仍可达
- 本轮可视为 `/plm` 前端结构治理的继续收口，而非新的联邦联调轮次
