# PLM Typed Payload Models 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts)
- 更新 [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts)
- 更新 [usePlmSubstitutesPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmSubstitutesPanel.ts)

## 本轮结果

### 1. Product payload 已进入共享 model

- `product` 不再是父页局部 `any`
- [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts) 与 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 现在共同消费 `ProductRecord`

### 2. Compare payload 已进入共享 model

- `compare schema` 已进入 `CompareSchemaPayload`
- `compare result` 已进入 `ComparePayload`
- `compare changes` 已进入 `CompareChangeEntry`
- [usePlmComparePanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmComparePanel.ts) 不再维护一份只在本地可见的 schema/result 近似类型

### 3. Where-Used payload 已进入共享 model

- [usePlmWhereUsedState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmWhereUsedState.ts) 已直接消费 `WhereUsedPayload`
- 父页和 state module 对 `where-used.parents` 的理解已收敛到同一处

### 4. 关键旧痕迹已清掉

本轮额外 sanity check:

- `panel: any` 在 `apps/web/src/components/plm` 中已无残留
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue) 里已无 `getProduct<any> / getBom<any> / getWhereUsed<any> / getBomCompare<any>`

## 验证命令

已通过:

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充检查:

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果: `200`

## 验证结论

这轮改动证明三件事：

1. 共享 payload model 已经足够覆盖当前 `/plm` 页面真实字段消费
2. 父页与 composable 的 typed contract 没有因为 model 提升而断裂
3. 质量门已经能把这些共享 model 的变更真正卡住，不会只在局部文件里“看起来更类型化”

## 未补跑项

本轮没有新增完整 UI regression 报告。

原因:

- 这轮是前端内部 payload model 收口，不涉及联邦协议变化
- 最近一次成功的真实 `/plm` UI regression 仍可作为行为基线:
  [verification-plm-ui-regression-20260308_130820.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-plm-ui-regression-20260308_130820.md)

结论:

- 包级验证已闭环
- 上游 `Yuantus` 健康仍可达
- 本轮可视为 `/plm` 结构治理从 “typed panel contract” 继续推进到 “typed shared payload model” 的下一步
