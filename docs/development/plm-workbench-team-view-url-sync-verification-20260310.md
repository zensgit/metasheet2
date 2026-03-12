# PLM Workbench Team View URL Sync 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-url-sync-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamViews.spec.ts` 通过，当前为 `1 file / 6 tests`
- `apps/web test` 当前为 `30 files / 120 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. `duplicate` 后会先同步新的 `requestedViewId`
2. `duplicate` 后会执行完整 `applyViewState`
3. `rename` 后仍会继续锚定当前 workbench 视图 id
4. `rename` 不会把 URL 身份回退到旧 source view

## Live API 前置检查

已通过：

- `GET /api/auth/dev-token`
- `POST /api/plm-workbench/views/team`
- `GET /api/plm-workbench/views/team?kind=workbench`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

1. 成功创建源 workbench 视图：
   - `PLM Workbench URL Sync Source`
2. 可正常列出 workbench 团队视图
3. 验证完成后临时视图已清理
4. 清理后 `kind=workbench` 列表恢复为：
   - `total: 0`

产物：

- [plm-workbench-team-view-url-sync-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-url-sync-20260310.json)
- [plm-workbench-team-view-url-sync-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-url-sync-browser-20260310.json)
- [plm-workbench-team-view-url-sync-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-url-sync-cleanup-20260310.json)

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-view-url-sync-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-url-sync-20260310)

关键文件：

- [page-workbench-rename-duplicate-url-sync.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-url-sync-20260310/page-workbench-rename-duplicate-url-sync.json)
- [page-workbench-rename-duplicate-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-url-sync-20260310/page-workbench-rename-duplicate-url-sync.png)

主路径：

1. 先通过 live API 创建源 workbench 视图：
   - `PLM Workbench URL Sync Source`
2. 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=6675572a-f822-4d94-a7c9-db460745153c
```

3. 在工作台团队视图块输入：
   - `PLM Workbench URL Sync Copy`
4. 点击 `复制副本`
5. 确认地址栏里的 `workbenchTeamView` 立刻切到：
   - `66eaaa8e-26ca-4377-979d-92ba590c8c3f`
6. 再输入：
   - `PLM Workbench URL Sync Renamed`
7. 点击 `重命名`
8. 确认 URL 仍保持：
   - `workbenchTeamView=66eaaa8e-26ca-4377-979d-92ba590c8c3f`

页面确认结果：

- 当前选中视图文本：
  - `PLM Workbench URL Sync Renamed · dev-user`
- 当前 workbench 状态保持不变：
  - `documentRole = primary`
  - `documentFilter = url-sync-doc`
  - `approvalsFilter = url-sync-eco`
  - `cadReviewState = approved`
  - `cadReviewNote = url-sync-note`

最终 URL：

```text
http://127.0.0.1:8899/plm?documentRole=primary&cadReviewNote=url-sync-note&cadReviewState=approved&documentFilter=url-sync-doc&approvalsFilter=url-sync-eco&workbenchTeamView=66eaaa8e-26ca-4377-979d-92ba590c8c3f
```

说明：

- 这轮浏览器 smoke 的核心验证点是：
  - 复制后 URL 身份会跟着切到新副本
  - 重命名后 URL 不会回退到旧 source id
  - 当前 workbench 状态在切换 URL 身份时保持稳定

## 验证结论

本轮 `PLM workbench team view URL sync` 已达到可继续推进的状态：

1. `duplicate` 后，当前 workbench 视图身份与 URL 身份已经一致
2. `rename` 后，URL 会继续锚定当前选中视图
3. 显式 deep link、复制副本、重命名这三条能力现在已经闭环
4. 真实浏览器 smoke 已确认不再停留在旧 source view id
5. 验证后临时 workbench 视图已清理，live 环境回到干净状态
