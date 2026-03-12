# PLM Team Preset Delete URL Cleanup 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-delete-url-cleanup-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamFilterPresets.spec.ts` 当前为 `1 file / 9 tests`
- `apps/web test` 当前为 `30 files / 129 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖：

1. 删除当前 team preset 会清空 `requestedPresetId`
2. 删除当前 team preset 会清空 `teamPresetKey`
3. 删除当前 team preset 会清空残留的 `teamPresetName / teamPresetGroup`
4. 删除后列表中不再保留该 preset

关键断言见 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)：

- `syncRequestedPresetId` 最后一次调用为 `undefined`
- `requestedPresetId.value === ''`
- `teamPresetName.value === ''`
- `teamPresetGroup.value === ''`

## Live Setup

本轮 live smoke 先通过 live API 创建两条显式团队预设：

- BOM:
  - `fb7ba74f-9faa-4876-b979-ca7323b09fd5`
  - `Delete URL Sync BOM 20260310`
- Where-Used:
  - `c42df496-9b8d-4baf-a95f-87472b859943`
  - `Delete URL Sync Where 20260310`

产物：

- [plm-team-preset-delete-url-cleanup-setup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-setup-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=fb7ba74f-9faa-4876-b979-ca7323b09fd5&whereUsedTeamPreset=c42df496-9b8d-4baf-a95f-87472b859943
```

2. 页面自动恢复出：
   - `bomFilter=delete-bom-gear`
   - `whereUsedFilter=delete-where-assy`
3. 点击 BOM 团队预设 `删除`
4. 验证 URL 变成：

```text
http://127.0.0.1:8899/plm?whereUsedTeamPreset=c42df496-9b8d-4baf-a95f-87472b859943&whereUsedFilter=delete-where-assy&whereUsedFilterField=parent&bomFilter=delete-bom-gear&bomFilterField=component
```

5. 再点击 Where-Used 团队预设 `删除`
6. 验证 URL 最终变成：

```text
http://127.0.0.1:8899/plm?whereUsedFilter=delete-where-assy&whereUsedFilterField=parent&bomFilter=delete-bom-gear&bomFilterField=component
```

关键结果：

1. `bomTeamPreset` 已被移除
2. `whereUsedTeamPreset` 已被移除
3. `bomFilter / whereUsedFilter` 继续保留
4. 没有回退到：
   - `bomFilterPreset`
   - `whereUsedFilterPreset`

产物：

- [plm-team-preset-delete-url-cleanup-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-browser-20260310.json)
- [page-team-preset-delete-url-cleanup.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-delete-url-cleanup-20260310/page-team-preset-delete-url-cleanup.png)
- [page-team-preset-delete-url-cleanup.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-delete-url-cleanup-20260310/page-team-preset-delete-url-cleanup.json)

## Cleanup 验证

本轮删除动作本身已完成 live 清理。  
随后又通过 live API 列表校验确认环境恢复干净：

- `bomTotal = 0`
- `whereUsedTotal = 0`

产物：

- [plm-team-preset-delete-url-cleanup-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-delete-url-cleanup-cleanup-20260310.json)

## 验证结论

本轮 `PLM team preset delete URL cleanup` 已达到可继续推进的状态：

1. 删除当前 team preset 后，URL identity 会正确退出
2. 当前 BOM / Where-Used 过滤状态会保留为匿名工作态
3. 不会残留失效的 `bomTeamPreset / whereUsedTeamPreset`
4. hook 内的表单残留状态也会同步清空
5. 代码级测试、包级门禁、live 浏览器 smoke 和 live 清理校验均已通过
