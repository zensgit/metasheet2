# PLM Local Filter Preset Duplicate / Rename 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 使用本轮设计文档 [plm-local-filter-preset-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-duplicate-rename-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/plmFilterPresetUtils.spec.ts tests/plmWorkbenchViewState.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- 聚焦测试通过，当前为 `3 files / 11 tests`
- `apps/web test` 当前为 `30 files / 124 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. duplicate 会生成唯一副本标签
2. duplicate 会保留原 preset 内容，但生成新 key
3. rename 会保留原 key
4. rename 会拒绝重复名称
5. rename 会拒绝空名称

## Browser Smoke

### 主路径

浏览器在 live dev `/plm` 页面中，真实走通了以下路径：

1. 清空 `plm_bom_filter_presets / plm_where_used_filter_presets`
2. 创建一条 `BOM local preset`
3. 创建一条 `Where-Used local preset`
4. 对 `BOM local preset` 执行：
   - `复制`
   - `重命名`
5. 对 `Where-Used local preset` 执行：
   - `复制`
   - `重命名`
6. 最后清理浏览器 localStorage，并把地址恢复到空 `/plm`

### 关键确认点

`BOM`：

1. duplicate 后 URL 切到新 key：

```text
bomFilterPreset=bom:1773114238293:m6smqj
```

2. rename 后 URL 仍保持同一 key
3. 当前 label 从：
   - `Codex Local BOM Duplicate 20260310 副本`
   变为：
   - `Codex Local BOM Renamed 20260310`

`Where-Used`：

1. duplicate 后 URL 切到新 key：

```text
whereUsedFilterPreset=where-used:1773114457234:wz8hop
```

2. rename 后 URL 仍保持同一 key
3. 当前 label 从：
   - `Codex Local Where Duplicate 20260310 副本`
   变为：
   - `Codex Local Where Renamed 20260310`

### 浏览器产物

- [plm-local-filter-preset-duplicate-rename-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-filter-preset-duplicate-rename-browser-20260310.json)
- [plm-local-filter-preset-duplicate-rename-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-filter-preset-duplicate-rename-cleanup-20260310.json)
- [plm-local-filter-preset-duplicate-rename-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-duplicate-rename-20260310)
- [page-duplicate-rename.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-duplicate-rename-20260310/page-duplicate-rename.png)

## Cleanup

本轮 cleanup 只涉及浏览器本地状态：

1. `plm_bom_filter_presets`
2. `plm_where_used_filter_presets`

cleanup 后确认：

1. `href = http://127.0.0.1:8899/plm`
2. `bomStorage = null`
3. `whereStorage = null`

说明：

本轮没有创建后端 team preset / team view 资源，因此无需 live API 清理。

## 验证结论

本轮 `PLM local filter preset duplicate / rename` 已达到可继续推进的状态：

1. `BOM / Where-Used` 本地 preset 现在都支持 `复制 / 重命名`
2. duplicate 会生成新的 preset identity，并同步更新 URL
3. rename 只更新 label，不会改变当前 preset identity
4. 前端门禁与浏览器 smoke 已闭环
5. cleanup 后本地浏览器状态已恢复为空
