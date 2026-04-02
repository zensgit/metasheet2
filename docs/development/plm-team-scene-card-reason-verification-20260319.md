# PLM Team Scene Card Reason Verification

## Scope

验证推荐场景卡片上的“推荐来源说明”是否正确生成和展示。

## Files

- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css)
- [plmWorkbenchSceneCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchSceneCatalog.spec.ts)
- [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmProductPanel.spec.ts)

## Commands

```bash
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Expected

- 推荐场景返回稳定的来源标签和时间字段
- 产品页 panel contract 透出这组信息
- `web` 包测试、类型、lint、构建全部通过

## Notes

这轮没有补真实 `PLM UI regression`，因为改动仍然只在前端目录展示层，没有碰联邦接口、SDK 契约或上游 `Yuantus` 行为。

## Result

- `pnpm --filter @metasheet/web test` 通过，`34 files / 182 tests`
- `pnpm --filter @metasheet/web type-check` 通过
- `pnpm --filter @metasheet/web lint` 通过
- `pnpm --filter @metasheet/web build` 通过
