# PLM Team Preset Share 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plmFilterPresetUtils.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmFilterPresetUtils.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmFilterPresetUtils.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmFilterPresetUtils.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用设计文档 [plm-team-preset-share-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-share-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmFilterPresetUtils.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- focused tests `2 files / 17 tests` 通过
- `apps/web` package 级测试通过，当前为 `30 files / 140 tests`
- `type-check / lint / build` 全部通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

本轮重点锁住的是“分享出去的仍然是 team preset identity”：

1. BOM team preset 分享 URL 会带 `bomTeamPreset`
2. Where-Used team preset 分享 URL 会带 `whereUsedTeamPreset`
3. 分享 URL 还会保留当前 filter value / field
4. fresh `/plm` 打开分享 URL 后，会恢复 team preset id，而不是只恢复文本过滤值

## Live API 准备

本轮 live 创建了三条 team preset：

1. BOM source
   - `52ce489c-2190-4e4b-b844-fc97385a1d48`
   - `Share BOM Team Preset Source`
2. Where-Used source
   - `4c31c970-ad3e-4fc1-a2ca-d9582424e271`
   - `Share Where-Used Team Preset Source`
3. Where-Used valid
   - `1cd73a7d-529a-4c55-8073-d7eaf3303094`
   - `Share Where-Used Team Preset Valid`

说明：

- 初始 seeded `Where-Used` source 使用了 `parent_id`
- 该字段不在当前 UI 的 field options 里
- 因此最终分享验证改用 `parent_number` 的 valid 版本完成

setup artifact：

- [plm-team-preset-share-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-20260311.json)

## Browser Smoke 验证

### BOM 分享

浏览器已真实走通：

1. 在 source 页面选中：
   - `Share BOM Team Preset Source (分享组) · dev-user`
2. 点击：
   - `分享`
3. 页面提示：
   - `已复制BOM团队预设分享链接。`
4. 捕获复制 URL：

```text
http://127.0.0.1:8899/plm?panel=bom&bomTeamPreset=52ce489c-2190-4e4b-b844-fc97385a1d48&bomFilter=root%2Fshare-bom&bomFilterField=path
```

5. fresh 页面打开该链接后，恢复结果为：
   - `selectedTeamPresetId = 52ce489c-2190-4e4b-b844-fc97385a1d48`
   - `selectedTeamPresetText = Share BOM Team Preset Source (分享组) · dev-user`
   - `uiFilterValue = root/share-bom`
   - `uiFilterField = path`

### Where-Used 分享

浏览器已真实走通：

1. 在 source 页面刷新 team preset 列表
2. 选中：
   - `Share Where-Used Team Preset Valid (分享组) · dev-user`
3. 点击：
   - `分享`
4. 页面提示：
   - `已复制Where-Used团队预设分享链接。`
5. 捕获复制 URL：

```text
http://127.0.0.1:8899/plm?panel=where-used&whereUsedTeamPreset=1cd73a7d-529a-4c55-8073-d7eaf3303094&whereUsedFilter=ASSY-SHARE-VALID&whereUsedFilterField=parent_number
```

6. fresh 页面打开该链接后，恢复结果为：
   - `selectedTeamPresetId = 1cd73a7d-529a-4c55-8073-d7eaf3303094`
   - `selectedTeamPresetText = Share Where-Used Team Preset Valid (分享组) · dev-user`
   - `uiFilterValue = ASSY-SHARE-VALID`
   - `uiFilterField = parent_number`

browser artifact：

- [plm-team-preset-share-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-browser-20260311.json)
- [page-bom-team-preset-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-bom-team-preset-share.png)
- [page-bom-team-preset-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-bom-team-preset-share.txt)
- [page-where-used-team-preset-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-where-used-team-preset-share.png)
- [page-where-used-team-preset-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-share-20260311/page-where-used-team-preset-share.txt)

## 验证结论

本轮已经确认：

1. `BOM / Where-Used team preset` 已具备显式分享入口
2. 分享链接传递的是稳定 team preset id，不是 local payload
3. 分享链接会保留当前筛选值与字段
4. fresh `/plm` 打开分享链接后，会恢复 team preset identity 与筛选状态
5. Where-Used live smoke 中识别到 seeded data 边界，最终验证已改用有效 field 完成闭环

## Live Cleanup 验证

本轮临时数据已全部清理：

- `52ce489c-2190-4e4b-b844-fc97385a1d48`
- `4c31c970-ad3e-4fc1-a2ca-d9582424e271`
- `1cd73a7d-529a-4c55-8073-d7eaf3303094`

清理后 live 状态：

- `bomTotal = 0`
- `bomActive = 0`
- `whereUsedTotal = 0`
- `whereUsedActive = 0`

cleanup artifact：

- [plm-team-preset-share-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-share-cleanup-20260311.json)
