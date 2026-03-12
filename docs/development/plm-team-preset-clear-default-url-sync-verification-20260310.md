# PLM Team Preset Clear Default URL Sync 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-preset-clear-default-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-clear-default-url-sync-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamFilterPresets.spec.ts` 通过，当前为 `1 file / 7 tests`
- `apps/web test` 当前为 `30 files / 126 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. `save` 后会同步新的 `requestedPresetId`
2. `set default` 后会继续锚定当前 team preset
3. `clear default` 后仍会继续锚定当前 team preset
4. `clear default` 不会把 URL 身份丢回匿名状态

关键断言在 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)：

- `syncRequestedPresetId` 在 `clear default` 后仍以 `preset-saved` 为最后一次值
- `trackedApply` 在 `clear default` 后仍返回 `preset-saved`

## Live / Browser 验证

live 浏览器验证已通过。

主路径：

1. 打开：

```text
http://127.0.0.1:8899/plm?bomFilter=dup-bom-gear-20260310&bomFilterField=component&whereUsedFilter=DUP-PARENT-20260310&whereUsedFilterField=parent_number
```

2. 分别创建：
   - `BOM Clear Default 20260310`
   - `WhereUsed Clear Default 20260310`
3. 记录创建后的显式 URL：
   - `bomTeamPreset=e2331ade-4604-47a4-8dc2-f5d0d9c2add8`
   - `whereUsedTeamPreset=2ef753ea-dd9a-45a3-983e-8e0d8c4bac2d`
4. 依次执行：
   - `设为默认`
   - `取消默认`
5. 验证 `clear default` 后：
   - URL 仍保留同一组 team preset id
   - 没有退回 `bomFilterPreset / whereUsedFilterPreset`
6. 清理临时团队预设

关键结果：

- `clear default` 后最终仍保持：
  - `bomTeamPreset=e2331ade-4604-47a4-8dc2-f5d0d9c2add8`
  - `whereUsedTeamPreset=2ef753ea-dd9a-45a3-983e-8e0d8c4bac2d`
- 同时确认：
  - `bomFilterPreset = null`
  - `whereUsedFilterPreset = null`

验证后清理结果：

- `bomTeamPreset = null`
- `whereUsedTeamPreset = null`
- live 页面回到只保留原始 `bomFilter / whereUsedFilter` 的状态

产物：

- [plm-team-preset-clear-default-url-sync-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-clear-default-url-sync-browser-20260310.json)
- [plm-team-preset-clear-default-url-sync-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-clear-default-url-sync-cleanup-20260310.json)

## 验证结论

本轮 `PLM team preset clear default URL sync` 已达到可继续推进的状态：

1. `clear default` 后，当前 `BOM / Where-Used` team preset identity 不会丢失
2. `clear default` 后，URL 仍会锚定当前显式 team preset id
3. `save / set default / clear default / explicit deep link` 现在已经围绕同一条 identity 语义运转
4. live 浏览器验证已确认不会再出现“当前选中项仍在，但 URL 丢身份”的状态裂缝
5. 临时 live team preset 已清理，环境回到干净状态
