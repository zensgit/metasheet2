# PLM Panel Team View Share Owner Boundary 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用设计文档 [plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-owner-boundary-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- focused spec 通过，当前 `1 file / 15 tests`
- `apps/web` package 级回归通过，当前 `30 files / 147 tests`
- `type-check / lint / build` 全部通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

这轮锁住的是：

1. `canShareTeamView` 现在需要 `selected.canManage`
2. 非 owner 调用 `shareTeamView()` 不会继续调用：
   - `buildShareUrl`
   - `copyShareUrl`
3. 非 owner 会收到统一提示：
   - `仅创建者可分享文档团队视角。`

## Live API 验证

本轮 live setup/transfer 产物在：

- [plm-panel-team-view-share-owner-boundary-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-20260311.json)

关键 live 结果：

1. `dev-user` 创建 documents team view：
   - id: `7ddbd564-72d7-458c-ad48-dc2150f9cc4a`
   - name: `Share Owner Boundary Source`
2. `plm-transfer-user` 已在 users 表中激活
3. `transfer -> 200`
4. transfer 之后：
   - `ownerUserId = plm-transfer-user`
   - `canManage = false`

## Browser Smoke 验证

浏览器以 `dev-user` 打开：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=7ddbd564-72d7-458c-ad48-dc2150f9cc4a&documentRole=owner-secondary&documentFilter=owner-boundary-doc&approvalsFilter=owner-boundary-eco&cadReviewNote=owner-boundary-note&cadReviewState=approved
```

浏览器产物：

- [plm-panel-team-view-share-owner-boundary-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-browser-20260311.json)
- [page-panel-team-view-share-owner-boundary.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-owner-boundary-20260311/page-panel-team-view-share-owner-boundary.png)

实测结果：

1. documents panel 仍恢复同一个显式 identity：
   - `documentTeamView=7ddbd564-72d7-458c-ad48-dc2150f9cc4a`
2. 选中项已变成：
   - `Share Owner Boundary Source · plm-transfer-user`
3. 旧 owner 下：
   - `分享` 按钮禁用
   - `转移所有者` 按钮禁用

也就是说：

1. deep link 仍可读
2. 管理动作已经失效

## Cleanup

本轮临时 view 已删除：

- [plm-panel-team-view-share-owner-boundary-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-owner-boundary-cleanup-20260311.json)

cleanup 结果：

- `deleteStatus = 200`
- view id `7ddbd564-72d7-458c-ad48-dc2150f9cc4a` 已清理

## 结论

本轮已经确认：

1. `Documents / CAD / Approvals team view share` 现在是 owner-only
2. owner transfer 之后，旧 owner 仍能打开原 deep link，但不能继续分享或转移
3. `read/apply` 与 `share/manage` 的边界已经清楚分离
