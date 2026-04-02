# PLM Workbench Team View Batch Management Audit 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 web 测试 [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmProductPanel.spec.ts)
- 更新 web 测试 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 复用 backend route [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 使用设计文档 [plm-workbench-team-view-batch-management-audit-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-batch-management-audit-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmProductPanel.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend route tests 通过，已覆盖：
  - `batch archives manageable team views and reports skipped ids`
  - `batch deletes manageable team views`
- focused web tests 通过，已覆盖：
  - workbench panel contract 暴露 batch props/actions
  - `workbench` 显式 identity 在 batch archive 后退出 URL
- `apps/web` package 级测试通过，当前为 `31 files / 158 tests`
- `type-check / lint / build` 全部通过

## 聚焦覆盖点

本轮重点锁住的是 `workbench team view` 的批量生命周期与 URL 一致性：

1. `batch archive` 后，`workbenchTeamView` 从 URL 退出
2. `batch restore` 后，同一个 `workbenchTeamView` id 再回写 URL
3. `batch delete` 后，`workbenchTeamView` 退出 URL
4. `documentRole / documentFilter / approvalsFilter / approvalComment / cadReviewState / cadReviewNote` 保留
5. 当前 workbench 头部 manager 能直接复用统一批量 UI

## Live API 准备

本轮 setup 记录在：

- [plm-workbench-team-view-batch-management-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-20260311.json)

本次 real smoke 创建了 3 条临时 `workbench team view`：

1. `Batch Workbench A`
   - `60afa72c-5745-41b6-87bb-93b43ae58d56`
2. `Batch Workbench B`
   - `dff1367f-a43f-460f-ae18-cc7e358d4a81`
3. `Batch Workbench C`
   - `31e951bb-3d46-4258-9e32-2c23529b386e`

live runtime：

- backend: `http://127.0.0.1:7778`
- frontend: `http://127.0.0.1:8899`

健康检查已通过：

- `curl -sf http://127.0.0.1:7778/health`
- `curl -sf http://127.0.0.1:8899/plm >/dev/null`

## Browser Smoke 验证

### Batch Archive

浏览器已真实走通：

1. 打开显式 deep link：
   - `.../plm?...&workbenchTeamView=60afa72c-5745-41b6-87bb-93b43ae58d56`
2. 打开 `工作台团队视图 -> 批量管理`
3. 点击 `全选可管理`
4. 点击 `批量归档`

结果：

- 出现提示：
  - `已批量归档工作台团队视角 3 项，跳过 0 项。`
- `workbenchTeamView` 从 URL 退出
- 当前 state 继续保留：
  - `documentRole=primary`
  - `documentFilter=wbatch-doc-a`
  - `approvalsFilter=wbatch-eco-a`
  - `approvalComment=wbatch-comment-a`
  - `cadReviewState=approved`
  - `cadReviewNote=wbatch-note-a`

### Batch Restore

继续在同一会话中：

1. 选中 `Batch Workbench A · dev-user · 已归档`
2. 再次 `全选可管理`
3. 点击 `批量恢复`

结果：

- 出现提示：
  - `已批量恢复工作台团队视角 3 项，跳过 0 项。`
- URL 恢复为：
  - `...&workbenchTeamView=60afa72c-5745-41b6-87bb-93b43ae58d56`
- 当前选中项恢复为：
  - `Batch Workbench A · dev-user`

### Batch Delete

继续在同一会话中：

1. 再次 `全选可管理`
2. 点击 `批量删除`

结果：

- 出现提示：
  - `已批量删除工作台团队视角 3 项，跳过 0 项。`
- `workbenchTeamView` 再次退出 URL
- 当前下拉恢复为：
  - `选择团队视图`
- 当前 state 仍保留：
  - `documentRole=primary`
  - `documentFilter=wbatch-doc-a`
  - `approvalsFilter=wbatch-eco-a`
  - `approvalComment=wbatch-comment-a`
  - `cadReviewState=approved`
  - `cadReviewNote=wbatch-note-a`

browser 证据：

- [plm-workbench-team-view-batch-management-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-browser-20260311.json)
- [page-workbench-team-view-batch-management.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-batch-management-20260311/page-workbench-team-view-batch-management.png)
- [page-workbench-team-view-batch-management.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-batch-management-20260311/page-workbench-team-view-batch-management.txt)

## 审计与路由复核

本轮复用了已有 batch route 与结构化审计线：

- `POST /api/plm-workbench/views/team/batch`
- `audit = plm-team-view-batch`

route test 已再次通过，证明 `processedIds / skippedIds / processedKinds` 仍保持稳定。

## 验证结论

本轮已经确认：

1. `workbench team view` 已具备 owner-only 的批量 `归档 / 恢复 / 删除`
2. `workbenchTeamView` 与批量生命周期保持一致
3. 批量删除不会误清当前 `PLM workbench` 状态
4. `workbench` 已复用统一的 team view batch UI，不再落后于 panel team view / team preset

## Live Cleanup 验证

本轮清理记录在：

- [plm-workbench-team-view-batch-management-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-batch-management-cleanup-20260311.json)

结果：

- `Batch Workbench A/B/C` 已全部被浏览器批量删除
- cleanup 复查时 `relevantRemainingCount = 0`
- 不需要额外 API 删除
