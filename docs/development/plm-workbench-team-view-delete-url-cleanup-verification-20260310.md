# PLM Workbench Team View Delete URL Cleanup 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-delete-url-cleanup-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-delete-url-cleanup-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamViews.spec.ts` 当前为 `1 file / 8 tests`
- `apps/web test` 当前为 `30 files / 130 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖：

1. 删除当前 `workbench team view` 会清空 `requestedViewId`
2. 删除当前 `workbench team view` 会清空 `teamViewKey`
3. 删除当前 `workbench team view` 会清空残留的 `teamViewName`
4. 删除后列表中不再保留该视图

关键断言见 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)：

- `syncRequestedViewId` 最后一次调用为 `undefined`
- `requestedViewId.value === ''`
- `teamViewKey.value === ''`
- `teamViewName.value === ''`

## Live Setup

本轮 live smoke 先通过 live API 创建一条显式 `workbench` 团队视图：

- `28dc0232-2f03-4c4f-8f3c-ed6131c38455`
- `PLM Workbench Delete URL Cleanup`

其 query 状态为：

- `documentRole=delete-secondary`
- `documentFilter=delete-doc`
- `approvalsFilter=delete-eco`
- `cadReviewState=rejected`
- `cadReviewNote=delete-note`

产物：

- [plm-workbench-team-view-delete-url-cleanup-setup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-setup-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=28dc0232-2f03-4c4f-8f3c-ed6131c38455
```

2. 页面自动恢复出：
   - `documentRole=delete-secondary`
   - `documentFilter=delete-doc`
   - `approvalsFilter=delete-eco`
   - `cadReviewState=rejected`
   - `cadReviewNote=delete-note`
3. 点击当前 `workbench` 团队视图 `删除`
4. 验证最终 URL 变成：

```text
http://127.0.0.1:8899/plm?documentRole=delete-secondary&cadReviewNote=delete-note&cadReviewState=rejected&documentFilter=delete-doc&approvalsFilter=delete-eco
```

关键结果：

1. `workbenchTeamView` 已从 URL 中退出
2. `documentRole / documentFilter / approvalsFilter / cadReviewState / cadReviewNote` 仍然保留
3. 当前 `workbench` 团队视图下拉已回到 `选择团队视图`
4. `teamViewName` 输入框已清空

产物：

- [plm-workbench-team-view-delete-url-cleanup-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-browser-20260310.json)
- [page-workbench-team-view-delete-url-cleanup.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-delete-url-cleanup-20260310/page-workbench-team-view-delete-url-cleanup.png)
- [page-workbench-team-view-delete-url-cleanup.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-delete-url-cleanup-20260310/page-workbench-team-view-delete-url-cleanup.json)

## Cleanup 验证

本轮删除动作本身已经完成 live 清理。  
随后又通过 live API 列表校验确认环境恢复干净：

- `total = 0`
- `kind = workbench`
- `defaultViewId = null`

产物：

- [plm-workbench-team-view-delete-url-cleanup-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-delete-url-cleanup-cleanup-20260310.json)

## 验证结论

本轮 `PLM workbench team view delete URL cleanup` 已达到可继续推进的状态：

1. 删除当前 `workbench team view` 后，URL identity 会正确退出
2. 当前 `PLM workbench` query 工作态会保留为匿名工作态
3. 不会残留失效的 `workbenchTeamView`
4. hook 内的表单残留状态也会同步清空
5. 代码级测试、包级门禁、live 浏览器 smoke 与 live 清理校验均已通过
