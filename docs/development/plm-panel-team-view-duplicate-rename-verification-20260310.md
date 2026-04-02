# PLM Panel Team View Duplicate / Rename 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 使用本轮设计文档 [plm-panel-team-view-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-duplicate-rename-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamViews.spec.ts` 当前为 `1 file / 9 tests`
- `apps/web test` 当前为 `30 files / 134 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

## 聚焦覆盖点

本轮验证的重点不是新增后端算法，而是 panel 接线已经真正闭环：

1. `documents` 面板已经暴露 `duplicate / rename`
2. `cad` 面板已经暴露 `duplicate / rename`
3. `approvals` 面板已经暴露 `duplicate / rename`
4. duplicate 后会把当前 URL id 切到新副本
5. rename 后会继续保持当前副本 id

## Live API 准备

本轮先通过 live API 创建三条 source team view：

1. `documents`
2. `cad`
3. `approvals`

source id：

- `documents`: `c49e0e75-cee6-4e20-90bc-7de545ca7bb2`
- `cad`: `ac1b2d05-73e0-4937-97d0-27b4dfe776f3`
- `approvals`: `4837d1b6-897b-44be-a89c-9b866e7e03df`

产物：

- [plm-panel-team-view-duplicate-rename-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 用显式 deep link 打开：

```text
http://127.0.0.1:8899/plm?documentTeamView=c49e0e75-cee6-4e20-90bc-7de545ca7bb2&cadTeamView=ac1b2d05-73e0-4937-97d0-27b4dfe776f3&approvalsTeamView=4837d1b6-897b-44be-a89c-9b866e7e03df
```

2. 在 `Documents` 面板点击 `复制副本`
3. 验证 URL 切到：
   - `documentTeamView=370e242a-1f24-4361-8d77-6161cc94192a`
4. 将副本重命名为：
   - `Panel Documents Renamed 20260310`
5. 验证 rename 后 URL 保持同一 `documentTeamView`
6. 在 `CAD` 面板点击 `复制副本`
7. 验证 URL 切到：
   - `cadTeamView=7e872b11-b3be-4c80-b7cf-c5912e095a1f`
8. 将副本重命名为：
   - `Panel CAD Renamed 20260310`
9. 验证 rename 后 URL 保持同一 `cadTeamView`
10. 在 `Approvals` 面板点击 `复制副本`
11. 验证 URL 切到：
   - `approvalsTeamView=ac447252-131d-4e59-ad12-c5564c03dd27`
12. 将副本重命名为：
   - `Panel Approvals Renamed 20260310`
13. 验证 rename 后 URL 保持同一 `approvalsTeamView`

关键结果：

- 最终 URL 为：

```text
http://127.0.0.1:8899/plm?documentTeamView=370e242a-1f24-4361-8d77-6161cc94192a&cadTeamView=7e872b11-b3be-4c80-b7cf-c5912e095a1f&approvalsTeamView=ac447252-131d-4e59-ad12-c5564c03dd27&documentRole=primary&documentFilter=panel-doc-source&approvalsFilter=panel-approval-source&approvalComment=panel-approvals-comment&cadFileId=cad-source-file&cadOtherFileId=cad-compare-file&cadReviewState=approved&cadReviewNote=panel-cad-source
```

- 当前选中项分别为：
  - `Panel Documents Renamed 20260310 · dev-user`
  - `Panel CAD Renamed 20260310 · dev-user`
  - `Panel Approvals Renamed 20260310 · dev-user`
- `document / approvals / cad` 三组工作状态在 duplicate / rename 后保持不变：
  - `documentRole=primary`
  - `documentFilter=panel-doc-source`
  - `approvalsFilter=panel-approval-source`
  - `approvalComment=panel-approvals-comment`
  - `cadFileId=cad-source-file`
  - `cadOtherFileId=cad-compare-file`
  - `cadReviewState=approved`
  - `cadReviewNote=panel-cad-source`

产物：

- [plm-panel-team-view-duplicate-rename-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-browser-20260310.json)
- [page-panel-team-view-duplicate-rename.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-duplicate-rename-20260310/page-panel-team-view-duplicate-rename.png)
- [page-panel-team-view-duplicate-rename.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-duplicate-rename-20260310/page-panel-team-view-duplicate-rename.txt)

## Live Cleanup 验证

本轮 live 临时 team view 已全部清理。

清理对象包括：

1. 三条 source view
2. 三条 duplicate 后重命名的 view

清理结果：

- `documents`: `c49e0e75-cee6-4e20-90bc-7de545ca7bb2`, `370e242a-1f24-4361-8d77-6161cc94192a`
- `cad`: `ac1b2d05-73e0-4937-97d0-27b4dfe776f3`, `7e872b11-b3be-4c80-b7cf-c5912e095a1f`
- `approvals`: `4837d1b6-897b-44be-a89c-9b866e7e03df`, `ac447252-131d-4e59-ad12-c5564c03dd27`

全部删除成功。

产物：

- [plm-panel-team-view-duplicate-rename-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-duplicate-rename-cleanup-20260310.json)

## 验证结论

本轮 `PLM panel team view duplicate / rename` 已达到可继续推进的状态：

1. `Documents / CAD / Approvals` 三个 panel 都已支持 `duplicate / rename`
2. `duplicate` 会生成新的 panel team view identity，并立即同步到 URL
3. `rename` 会保留当前 panel team view identity，不会打断 deep link
4. 三个 panel 的团队视角生命周期语义现在已与 `workbench team view` 对齐
5. 代码级测试、包级质量门、live 浏览器 smoke 全部通过
6. live 临时数据已清理，环境回到干净状态
