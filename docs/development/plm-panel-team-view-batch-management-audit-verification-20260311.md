# PLM Panel Team View Batch Management Audit 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 backend 测试 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 web 测试 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 web 测试 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用设计文档 [plm-panel-team-view-batch-management-audit-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-batch-management-audit-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend focused route tests 通过，已覆盖：
  - `batch archives manageable team views and reports skipped ids`
  - `batch deletes manageable team views`
- web focused tests 通过，已覆盖：
  - client 调 `/api/plm-workbench/views/team/batch`
  - archive 后清理显式 panel identity
  - restore 后回写同一 team view id
- `apps/web` package 级测试通过，当前为 `31 files / 156 tests`
- `type-check / lint / build` 全部通过

## 聚焦覆盖点

本轮重点锁住的是 `panel team view` 的批量生命周期与 URL 一致性：

1. `Documents` 批量归档后，`documentTeamView` 退出 URL
2. 恢复并重新应用同一 `Documents team view` 后，同一个 id 重新回到 URL
3. `Approvals` 批量删除后，`approvalsTeamView` 退出 URL
4. 批量删除不会误清当前 `approvalsFilter / approvalComment`
5. 非法 id 会进入 `skippedIds`，而不是把整批请求打挂
6. backend 会输出结构化 `plm-team-view-batch` 审计日志

## Live API 准备

本轮 live setup 记录在：

- [plm-panel-team-view-batch-management-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-20260311.json)

本次 real smoke 使用了三条显式 panel team view：

1. Documents
   - `d483b54a-76ad-45a7-8332-ef2da3d30153`
2. CAD
   - `888515b4-ffcd-4495-9126-86166ea3c1f1`
3. Approvals
   - `f076ce51-27a8-4324-9ce5-9b64286092ca`

live backend 使用的是重启后的 `7778` 新进程，健康检查：

- `curl -sf http://127.0.0.1:7778/health`

## Browser Smoke 验证

### Documents 批量归档

浏览器已真实走通：

1. 通过显式 `documentTeamView` deep link 打开 source 页面
2. 打开 `批量管理`
3. 点击 `全选可管理`
4. 点击 `批量归档`
5. 结果：
   - `documentTeamView` 从 URL 退出
   - `documentRole=primary`
   - `documentFilter=batch-doc-a`
   仍然保留

### Documents 重新应用

继续在同一会话中：

1. 选中 `Batch Documents A`
2. 点击 `应用`
3. 结果：
   - `documentTeamView=d483b54a-76ad-45a7-8332-ef2da3d30153` 重新回写 URL
   - 当前 Documents 状态恢复到该 view 对应上下文

### Approvals 批量删除

浏览器已真实走通：

1. 打开 `Approvals` panel 的 `批量管理`
2. 选择可管理项
3. 点击 `批量删除`
4. 结果：
   - `approvalsTeamView` 从 URL 退出
   - `approvalsFilter=batch-eco-a`
   - `approvalComment=note-a`
   仍然保留

browser 证据：

- [page-before-batch-actions.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-batch-management-20260311/page-before-batch-actions.png)
- [page-panel-team-view-batch-management.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-batch-management-20260311/page-panel-team-view-batch-management.png)
- [page-panel-team-view-batch-management.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-batch-management-20260311/page-panel-team-view-batch-management.txt)
- [plm-panel-team-view-batch-management-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-browser-20260311.json)

## 审计日志验证

live backend 已输出结构化审计日志，关键 request 已确认：

1. archive documents batch
   - requestId: `9c9be606-fb25-4c49-ba97-e535afac28ad`
2. restore documents batch
   - requestId: `10b4dada-eb1f-49d7-add1-26bb1f29f5e3`
3. delete approvals batch
   - requestId: `c3717905-e93b-4585-bd8e-b4fe92d5a7bb`

日志字段已包含：

- `audit = plm-team-view-batch`
- `action`
- `tenantId`
- `ownerUserId`
- `requestedIds`
- `processedIds`
- `skippedIds`
- `processedKinds`

## 验证结论

本轮已经确认：

1. `Documents / CAD / Approvals team view` 已具备 owner-only 的批量 `归档 / 恢复 / 删除`
2. 显式 panel team view identity 与批量生命周期保持一致
3. 批量动作不会误清当前 panel 状态
4. 无效 id 和不可处理项会进入 `skippedIds`
5. backend 已具备可追踪的 `plm-team-view-batch` 结构化审计日志

## Live Cleanup 验证

本轮临时数据已清理完成，清理记录在：

- [plm-panel-team-view-batch-management-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-batch-management-cleanup-20260311.json)

补充说明：

- 本轮 smoke 中 `CAD` 主要用于保持跨 panel identity 共存，未单独触发 batch 动作
- 非阻塞噪声仍有一条历史 `PLM federation 403 Forbidden（已回退默认字段）`，但不影响本轮 team view batch 生命周期验证
