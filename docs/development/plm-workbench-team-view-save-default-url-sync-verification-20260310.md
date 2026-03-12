# PLM Workbench Team View Save / Default URL Sync 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-save-default-url-sync-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-save-default-url-sync-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamViews.spec.ts` 通过，当前为 `1 file / 7 tests`
- `apps/web test` 当前为 `30 files / 121 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. `save` 会同步新的 `requestedViewId`
2. `save` 会执行完整 `applyViewState`
3. `set default` 后仍会锚定当前 workbench 视图 id
4. `set default` 不会把 URL 身份丢回匿名状态

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/plm-workbench/views/team?kind=workbench`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

1. 浏览器保存出来的 workbench 视图已能在 live API 中查到
2. 该视图已带：
   - `isDefault: true`
   - `defaultViewId = 当前视图 id`
3. 验证完成后临时 workbench 视图已清理
4. 清理后 `kind=workbench` 列表恢复为：
   - `total: 0`

产物：

- [plm-workbench-team-view-save-default-url-sync-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-save-default-url-sync-20260310.json)
- [plm-workbench-team-view-save-default-url-sync-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-save-default-url-sync-cleanup-20260310.json)

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-view-save-default-url-sync-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-save-default-url-sync-20260310)

关键文件：

- [page-save-default-url-sync.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-save-default-url-sync-20260310/page-save-default-url-sync.json)
- [page-save-default-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-save-default-url-sync-20260310/page-save-default-url-sync.png)

主路径：

1. 打开：

```text
http://127.0.0.1:8899/plm?documentRole=secondary&documentFilter=url-save-doc&approvalsFilter=url-save-eco&cadReviewState=rejected&cadReviewNote=url-save-note
```

2. 在工作台团队视图块输入：
   - `PLM Workbench Save Default URL Sync`
3. 点击 `保存到团队`
4. 确认 URL 立刻新增：
   - `workbenchTeamView=ade84383-c5e6-46fe-977d-322b2945917c`
5. 点击 `设为默认`
6. 确认 URL 保持不变，且当前选中项变为：
   - `PLM Workbench Save Default URL Sync · dev-user · 默认`

页面确认结果：

- 当前默认标签：
  - `当前默认：PLM Workbench Save Default URL Sync`
- 当前 workbench 状态保持不变：
  - `documentRole = secondary`
  - `documentFilter = url-save-doc`
  - `approvalsFilter = url-save-eco`
  - `cadReviewState = rejected`
  - `cadReviewNote = url-save-note`

最终 URL：

```text
http://127.0.0.1:8899/plm?documentRole=secondary&cadReviewNote=url-save-note&cadReviewState=rejected&documentFilter=url-save-doc&approvalsFilter=url-save-eco&workbenchTeamView=ade84383-c5e6-46fe-977d-322b2945917c
```

说明：

- 这轮浏览器 smoke 的核心验证点是：
  - `save` 后 URL 会立即获得当前 workbench view id
  - `set default` 后 URL 仍保持当前 view id
  - URL 同步过程中不会破坏当前 workbench 状态

## 验证结论

本轮 `PLM workbench team view save / default URL sync` 已达到可继续推进的状态：

1. `save` 后，当前 workbench 视图身份和 URL 身份已经一致
2. `set default` 后，URL 会继续锚定当前 workbench 视图
3. `apply / duplicate / rename / save / set default` 这五条主动作现在都围绕同一 identity 语义运转
4. 浏览器 smoke 已真实确认不会再出现“当前视图已切换但 URL 没切换”
5. 验证后临时 workbench 视图已清理，live 环境回到干净状态
