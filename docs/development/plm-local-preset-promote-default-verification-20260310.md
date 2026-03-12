# PLM Local Preset Promote to Team Default 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-local-preset-promote-default-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-default-benchmark-design-20260310.md)

## 代码级验证

已通过:

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果:

- 聚焦测试通过，当前为 `1 file / 7 tests`
- `apps/web test` 当前为 `30 files / 126 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖:

1. `promoteFilterPresetToTeamDefault()` 会先创建 team preset，再调用默认设置接口
2. 返回对象会把新建 preset 标记成 `isDefault = true`
3. 当前选中 team preset key 会切到新创建的 team id
4. 成功消息会明确表述为“提升为默认团队预设”

## Live / Browser Smoke

### Live setup

本轮 live smoke 在 `/plm` 页面里先创建两条本地 preset:

1. `BOM`
   - `field = component`
   - `value = dup-bom-gear-20260310`
   - `name = BOM Local Default 20260310`
2. `Where-Used`
   - `field = parent_number`
   - `value = DUP-PARENT-20260310`
   - `name = WhereUsed Local Default 20260310`

保存本地 preset 后，浏览器进入的 URL 为:

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&bomFilterPreset=bom:1773123245158:tijg5b&whereUsedFilterPreset=where-used:1773123258229:knzr0d
```

### 主路径 A: BOM `升默认`

点击 `BOM` 面板新的 `升默认` 后，页面 toast 为:

```text
已将BOM本地预设提升为默认团队预设：BOM Local Default 20260310
```

live 页面状态确认:

1. `BOM` 团队预设下拉切到 `BOM Local Default 20260310 · dev-user · 默认`
2. `当前默认：BOM Local Default 20260310` 已显示
3. 地址栏从 local key 切到 team id

中间结果 URL:

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&whereUsedFilterPreset=where-used:1773123258229:knzr0d&bomTeamPreset=7c4e79d0-19bc-4598-8dc5-839b22cfcc84
```

确认:

1. `bomFilterPreset` 已被清掉
2. `bomTeamPreset = 7c4e79d0-19bc-4598-8dc5-839b22cfcc84`
3. BOM 当前身份已切换成 team default

### 主路径 B: Where-Used `升默认`

点击 `Where-Used` 面板新的 `升默认` 后，页面 toast 为:

```text
已将Where-Used本地预设提升为默认团队预设：WhereUsed Local Default 20260310
```

live 页面状态确认:

1. `Where-Used` 团队预设下拉切到 `WhereUsed Local Default 20260310 · dev-user · 默认`
2. `当前默认：WhereUsed Local Default 20260310` 已显示
3. 地址栏从 local key 切到 team id

完成后 URL:

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&bomTeamPreset=7c4e79d0-19bc-4598-8dc5-839b22cfcc84&whereUsedTeamPreset=b5541f0f-3158-4d77-b494-34a51a036bd7
```

确认:

1. `whereUsedFilterPreset` 已被清掉
2. `whereUsedTeamPreset = b5541f0f-3158-4d77-b494-34a51a036bd7`
3. 两个面板都已切到 team default identity

## Cleanup

本轮 cleanup 已完成:

1. 删除临时创建的 BOM team default preset
2. 删除临时创建的 Where-Used team default preset
3. 清理浏览器本地:
   - `plm_bom_filter_presets`
   - `plm_where_used_filter_presets`

cleanup 后最终状态:

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number
```

并且:

1. `bomTeamPreset = null`
2. `whereUsedTeamPreset = null`
3. `plm_bom_filter_presets = null`
4. `plm_where_used_filter_presets = null`

## 证据归档

artifact 产物:

- [plm-local-preset-promote-default-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-default-browser-20260310.json)
- [plm-local-preset-promote-default-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-default-cleanup-20260310.json)

本轮没有追加新的截图文件。浏览器验证以 URL、页面下拉状态、toast 与 cleanup 结果为证据。

## 验证结论

本轮 `PLM local preset promote to team default` 已闭环:

1. `BOM / Where-Used` 本地预设现在支持一键 `升默认`
2. 成功后会:
   - 创建 team preset
   - 设为默认
   - 切换 URL identity 到 team id
   - 清掉同面板 local identity
3. live 页面已真实展示默认态，不是只有单测通过
4. 聚焦测试、完整 `apps/web` 门禁与根级 `pnpm lint` 均通过
5. 团队数据与浏览器本地状态都已清理，不会污染后续验证

