# PLM Team Preset Batch Management Audit Verification

日期: 2026-03-11

## 范围

验证 `PLM BOM / Where-Used team preset` 的批量管理与审计：

- `batch archive`
- `batch restore`
- `batch delete`
- URL identity 退场 / 回写
- live backend 结构化审计日志

## 代码验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts tests/unit/plm-team-filter-presets.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

结果：

- `apps/web` 当前测试计数已提升到 `31 files / 153 tests`
- backend / web 的批量管理契约都已被单测覆盖

## Live API

setup 与结果见：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-20260311.json`

关键结果：

- 创建了 4 条临时 preset：
  - `Batch BOM Alpha 20260311-batch`
  - `Batch BOM Beta 20260311-batch`
  - `Batch Where-Used Alpha 20260311-batch`
  - `Batch Where-Used Beta 20260311-batch`
- `batch archive` 处理了 2 条 BOM preset，并跳过了 `invalid-batch-id`
- `batch restore` 恢复了 2 条 BOM preset
- `batch delete` 删除了 2 条 Where-Used preset

这轮抓到并修复了一个真实问题：

- 历史无效 id 会在 PostgreSQL `uuid` 比较时报错
- 现在 route 会先分离 `queryableIds / invalidIds`
- 无效 id 进入 `skippedIds`，不再让整批失败

## Live Browser Smoke

浏览器产物：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-browser-20260311.json`
- `/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-batch-management-20260311/.playwright-cli/page-2026-03-11T03-38-18-805Z.png`

真实流程：

1. 打开显式 deep link：
   - `bomTeamPreset=f0071c3e-eaab-4002-85c6-9d880b1c9305`
   - `whereUsedTeamPreset=bb0a9e88-5b85-4a5e-9be4-c01af322e276`
2. 在 `BOM` 团队预设批量管理中选中 `Alpha + Beta`，执行 `批量归档`
3. 确认 URL 只退出 `bomTeamPreset`，保留：
   - `whereUsedTeamPreset`
   - `bomFilter=batch-root-a`
4. 重新选中已归档的 `BOM Alpha`，执行 `批量恢复`
5. 确认同一 `bomTeamPreset=f0071c3e-eaab-4002-85c6-9d880b1c9305` 重新写回 URL
6. 在 `Where-Used` 团队预设批量管理中选中 `Alpha + Beta`，执行 `批量删除`
7. 确认 URL 退出 `whereUsedTeamPreset`，但保留：
   - `whereUsedFilter=assy-batch-a`
   - `bomTeamPreset=f0071c3e-eaab-4002-85c6-9d880b1c9305`

最终页面状态通过浏览器 `eval` 再确认一次：

- `bomFilter = batch-root-a`
- `whereUsedFilter = assy-batch-a`
- `bomTeamPreset = f0071c3e-eaab-4002-85c6-9d880b1c9305`
- `whereUsedTeamPreset = null`

## 审计日志

live backend 会话已输出结构化日志，关键证据：

- `Processed PLM team preset batch action` `action=archive`
- `Processed PLM team preset batch action` `action=restore`
- `Processed PLM team preset batch action` `action=delete`

其中一条 archive 日志已确认包含：

- `tenantId=default`
- `ownerUserId=dev-user`
- `processedIds=[f0071c3e-eaab-4002-85c6-9d880b1c9305, f1007b0a-2e49-44da-9830-a00424390be4]`
- `skippedIds=[]`

另一条早期 API 运行则确认：

- `invalid-batch-id` 已被归入 `skippedIds`

## Cleanup

cleanup 结果见：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-batch-management-cleanup-20260311.json`

结果：

- 本轮临时 BOM preset 已删除
- 本轮临时 Where-Used preset 因已在批量删除步骤中清掉，cleanup 返回 `404 not found`，属于预期结果
- cleanup 后：
  - `where-used total = 0`
  - `bom total = 3`

这 3 条 BOM 为历史数据，不属于本轮临时对象

## 结论

本轮 `PLM team preset batch management + audit` 已闭环：

- backend route 可用
- invalid id 防御已补齐
- web UI 可真实执行批量归档 / 恢复 / 删除
- URL identity 与当前过滤状态符合预期
- live backend 已输出结构化审计日志
- 临时数据已清理
