# PLM Workbench Team View Share Transfer Boundary 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmCollaborativePermissions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmCollaborativePermissions.spec.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用设计文档 [plm-workbench-team-view-share-transfer-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-share-transfer-boundary-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

结果：

- focused spec 通过，`2 files / 21 tests`
- `apps/web` package 级回归通过，当前 `31 files / 159 tests`
- `type-check / lint / build` 全部通过
- backend route test 与 backend build 通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

这轮锁住的是：

1. `usePlmCollaborativePermissions` 现在优先使用 `permissions.canManage`
2. readonly workbench 视角在 `permissions` 覆盖 legacy `canManage` 时，会清空 owner transfer 输入
3. `shareTeamView()` 不再依赖 raw `view.canManage`
4. `transferTeamView()` 不再依赖 raw `view.canManage`
5. readonly workbench 视角下：
   - 不会继续复制分享链接
   - 不会继续发起 owner transfer

## Live API 验证

setup 产物在：

- [plm-workbench-team-view-share-transfer-boundary-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-20260311.json)

关键结果：

1. `dev-user` 创建临时 workbench 视角：
   - id: `707e581b-6495-4f24-b8f8-6e03804fdcfb`
   - name: `Workbench Share Transfer Source 2d2f6c1a`
2. 复用已存在用户：
   - `plm-transfer-user`
3. `transfer -> 200`
4. source user 重新 list 后：
   - `ownerUserId = plm-transfer-user`
   - `permissions.canManage = false`
   - `permissions.canShare = false`
   - `permissions.canTransfer = false`
5. target user list 后：
   - `permissions.canManage = true`
   - `permissions.canShare = true`
   - `permissions.canTransfer = true`

这说明 live backend 已把 workbench owner transfer 正确映射成 source/target 两侧不同权限。

## Browser Smoke 验证

浏览器以 `dev-user` 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=707e581b-6495-4f24-b8f8-6e03804fdcfb&documentRole=transfer-secondary&documentFilter=transfer-doc&approvalsFilter=transfer-eco&approvalComment=transfer-comment&cadReviewState=approved&cadReviewNote=transfer-note
```

浏览器产物：

- [plm-workbench-team-view-share-transfer-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-browser-20260311.json)
- [page-workbench-team-view-share-transfer-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-share-transfer-boundary-20260311/page-workbench-team-view-share-transfer-boundary.png)
- [page-workbench-team-view-share-transfer-boundary.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-share-transfer-boundary-20260311/page-workbench-team-view-share-transfer-boundary.txt)

实测结果：

1. workbench 显式 identity 仍存在：
   - `workbenchTeamView=707e581b-6495-4f24-b8f8-6e03804fdcfb`
2. 选中项已变成：
   - `Workbench Share Transfer Source 2d2f6c1a · plm-transfer-user`
3. workbench 主块仍保留：
   - `应用`
   - `复制副本`
   - `工作台团队视图名称`
4. workbench 主块已不再出现：
   - `分享`
   - `转移所有者`
   - `设为默认`
   - `归档`

也就是说：

1. deep link 仍可读
2. read/apply/duplicate 仍可用
3. manage/share/transfer 已完全退出旧 owner 的 workbench 主块

## Cleanup

cleanup 产物在：

- [plm-workbench-team-view-share-transfer-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-share-transfer-boundary-cleanup-20260311.json)

cleanup 结果：

- `delete -> 200`
- `stillExists = false`

本轮临时 `workbench team view` 已清理完成。

## 结论

本轮已经确认：

1. `PLM workbench team view` 的 `share / transfer` 运行时守卫已对齐到统一 `permissions` 矩阵
2. owner transfer 之后，旧 owner 仍能打开原 `workbenchTeamView` deep link，但只能只读/复制
3. `apply / duplicate` 与 `share / transfer / manage` 的边界已经在 workbench 主块收口
