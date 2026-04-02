# PLM Team Scene Summary Actions Verification

## Scope

验证摘要 chip 的快捷动作层：

- 点击后切推荐筛选
- 自动聚焦首条推荐卡片
- 首条推荐卡片短暂高亮

## Files

- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css)
- [plm-team-scene-summary-actions-design-20260319.md](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-team-scene-summary-actions-design-20260319.md)

## Commands

```bash
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Expected

- 摘要 chip 点击仍能正确切换推荐筛选
- 列表首条卡片会被程序性定位并高亮
- 前端测试、类型、lint、构建全部通过

## Notes

这轮没有补真实 `PLM UI regression`，因为改动仍然只在前端目录交互层，没有碰联邦接口、SDK 契约或上游 `Yuantus` 行为。

## Result

- `pnpm --filter @metasheet/web test` 通过，`34 files / 182 tests`
- `pnpm --filter @metasheet/web type-check` 通过
- `pnpm --filter @metasheet/web lint` 通过
- `pnpm --filter @metasheet/web build` 通过
