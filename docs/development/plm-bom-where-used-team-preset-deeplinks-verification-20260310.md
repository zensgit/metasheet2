# PLM BOM / Where-Used Team Preset Deep Links 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-bom-where-used-team-preset-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-bom-where-used-team-preset-deeplinks-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamFilterPresets.spec.ts` 通过，当前为 `1 file / 5 tests`
- `apps/web test` 当前为 `30 files / 123 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. 显式 `requestedPresetId` 会优先于默认团队预设
2. `save` 后会同步新的 preset identity
3. `set default` 后仍会锚定当前 preset id
4. team preset hook 会继续执行完整 `applyPreset`

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/plm-workbench/filter-presets/team?kind=bom`
- `GET /api/plm-workbench/filter-presets/team?kind=where-used`
- `POST /api/plm-workbench/filter-presets/team`
- `POST /api/plm-workbench/filter-presets/team/:id/default`
- `DELETE /api/plm-workbench/filter-presets/team/:id`

结果：

1. 已成功创建：
   - 1 条 `BOM default` 预设
   - 1 条 `BOM explicit` 预设
   - 1 条 `Where-Used default` 预设
   - 1 条 `Where-Used explicit` 预设
2. 已成功把 `default` 预设设为默认
3. 浏览器验证完成后已清理这 4 条临时预设
4. 清理后 live 列表恢复为：
   - `bomTotal = 0`
   - `whereUsedTotal = 0`

产物：

- [plm-bom-where-used-team-preset-deeplinks-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-where-used-team-preset-deeplinks-20260310.json)
- [plm-bom-where-used-team-preset-deeplinks-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-where-used-team-preset-deeplinks-browser-20260310.json)
- [plm-bom-where-used-team-preset-deeplink-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-where-used-team-preset-deeplink-cleanup-20260310.json)

## 浏览器 Smoke

证据已归档到：

- [plm-bom-where-used-team-preset-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310)

关键文件：

- [page-explicit-team-preset-deeplink.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310/page-explicit-team-preset-deeplink.json)
- [page-explicit-team-preset-deeplink.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310/page-explicit-team-preset-deeplink.png)
- [page-default-team-preset-restore.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310/page-default-team-preset-restore.json)
- [page-default-team-preset-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-bom-where-used-team-preset-deeplinks-20260310/page-default-team-preset-restore.png)

主路径 A：默认团队预设恢复

1. 创建 `BOM default` 与 `Where-Used default`
2. 分别设为默认
3. 打开空：

```text
http://127.0.0.1:8899/plm
```

页面确认结果：

- URL 自动补上：
  - `bomTeamPreset=9fd2e92d-f825-4f8b-8a09-1bd2087447e5`
  - `whereUsedTeamPreset=f3145c90-2872-46a9-90b9-dec87eb1ca86`
- `BOM` 恢复为：
  - `field = component`
  - `value = default-gear`
- `Where-Used` 恢复为：
  - `field = parent_number`
  - `value = DEFAULT-PARENT`

主路径 B：显式 deep link 覆盖默认团队预设

1. 保留同租户默认预设不变
2. 打开显式链接：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=c2e6a029-9e15-4240-b7ed-7498dbbeba3a&whereUsedTeamPreset=2d6ff92b-2137-475b-98c2-5e3d83160449
```

页面确认结果：

- URL 最终保持显式 preset identity，并回写当前过滤状态：
  - `bomTeamPreset=c2e6a029-9e15-4240-b7ed-7498dbbeba3a`
  - `whereUsedTeamPreset=2d6ff92b-2137-475b-98c2-5e3d83160449`
  - `bomFilterField=path`
  - `bomFilter=explicit/root/path`
  - `whereUsedFilterField=path`
  - `whereUsedFilter=explicit/where/path`
- `BOM` 没有被默认预设覆盖，实际恢复的是显式预设：
  - `field = path`
  - `value = explicit/root/path`
- `Where-Used` 也没有被默认预设覆盖：
  - `field = path`
  - `value = explicit/where/path`

## 验证结论

本轮 `PLM BOM / Where-Used team preset deep links` 已达到可继续推进的状态：

1. `BOM / Where-Used` 已具备显式 preset identity query
2. 显式 preset id 会优先于默认团队预设
3. 空 `/plm` 仍可恢复默认团队预设
4. URL 会同时保留 preset identity 与当前过滤字段/值
5. live API、浏览器 smoke、前端门禁均已闭环
