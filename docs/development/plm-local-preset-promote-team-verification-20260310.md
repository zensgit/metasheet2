# PLM Local Preset Promote to Team 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-local-preset-promote-team-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-preset-promote-team-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmFilterPresetUtils.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- 聚焦测试通过，当前为 `2 files / 10 tests`
- `apps/web test` 当前为 `30 files / 125 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖：

1. `promoteFilterPresetToTeam()` 会把 local preset 的 `field / value / group` 写入 team preset API
2. 同名冲突时会生成安全团队名称，而不是覆盖已有条目
3. promotion 成功后会回传新 team preset，供页面继续切换 URL identity

## Live / Browser Smoke

### Live setup

本轮 live smoke 先在 `/plm` 页面里创建两条本地 preset：

1. `BOM`
   - `field = component`
   - `value = dup-bom-gear-20260310`
   - `name = Codex Promote BOM 20260310`
2. `Where-Used`
   - `field = parent_number`
   - `value = DUP-PARENT-20260310`
   - `name = Codex Promote Where 20260310`

本地 preset URL 形态为：

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&bomFilterPreset=bom:1773122577364:4zlhnn&whereUsedFilterPreset=where-used:1773122579488:at9dz7
```

### promotion 主路径

主路径 A：提升 BOM local preset

1. 当前已选中 `Codex Promote BOM 20260310`
2. 触发 `promoteBomFilterPresetToTeam`
3. live 请求返回：
   - `POST /api/plm-workbench/filter-presets/team`
   - `201 Created`
   - 新 team id = `cb4d79f1-fb46-4900-ba59-18134870c6cb`

URL 结果：

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&whereUsedFilterPreset=where-used:1773122579488:at9dz7&bomTeamPreset=cb4d79f1-fb46-4900-ba59-18134870c6cb
```

确认：

1. `bomFilterPreset` 已从 URL 清掉
2. `bomTeamPreset` 已写入新 team id
3. `BOM` 团队预设下拉已切到 `Codex Promote BOM 20260310 · dev-user`
4. `BOM` local preset key 已清空

主路径 B：提升 Where-Used local preset

1. 当前已选中 `Codex Promote Where 20260310`
2. 触发 `promoteWhereUsedFilterPresetToTeam`
3. live 请求返回：
   - `POST /api/plm-workbench/filter-presets/team`
   - `201 Created`
   - 新 team id = `1dd748d3-18a6-454e-8aea-1aebfaa1f05a`

URL 结果：

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number&bomTeamPreset=cb4d79f1-fb46-4900-ba59-18134870c6cb&whereUsedTeamPreset=1dd748d3-18a6-454e-8aea-1aebfaa1f05a
```

确认：

1. `whereUsedFilterPreset` 已从 URL 清掉
2. `whereUsedTeamPreset` 已写入新 team id
3. `Where-Used` 团队预设下拉已切到 `Codex Promote Where 20260310 · dev-user`
4. `Where-Used` local preset key 已清空

### 证据归档

浏览器与 artifact 产物：

- [plm-local-preset-promote-team-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-preset-promote-team-20260310)
- [page-open-via-promoted-team-presets.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-preset-promote-team-20260310/page-open-via-promoted-team-presets.png)
- [plm-local-preset-promote-team-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-team-browser-20260310.json)
- [plm-local-preset-promote-team-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-preset-promote-team-cleanup-20260310.json)

## Cleanup

本轮 cleanup 已完成两部分：

1. 删除临时创建的 BOM / Where-Used team preset
2. 清理浏览器本地：
   - `plm_bom_filter_presets`
   - `plm_where_used_filter_presets`

cleanup 后 live 状态恢复为：

1. `bomTotal = 0`
2. `whereUsedTotal = 0`

## 验证结论

本轮 `PLM local preset promote to team` 已达到继续推进状态：

1. `BOM / Where-Used` local preset 现在都支持一键 `升团队`
2. promotion 成功后，URL identity 会从 local key 自动切到 team preset id
3. 同面板 local/team 身份不会并存，避免 reopen `/plm` 时恢复歧义
4. 团队命名冲突具备安全重命名策略
5. 前端测试、type-check、lint、build、根级 lint、live API、浏览器 smoke、cleanup 已闭环
