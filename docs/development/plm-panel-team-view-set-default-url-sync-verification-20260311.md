# PLM Panel Team View Set Default URL Sync 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用设计文档 [plm-panel-team-view-set-default-url-sync-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-set-default-url-sync-benchmark-design-20260311.md)

说明：

- 本轮没有修改 `setTeamViewDefault()` 的运行时代码
- 本轮补的是 focused spec、live API 和浏览器 smoke，用来确认现有行为已经满足 URL 一致性要求

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- focused tests `1 file / 13 tests` 通过
- `apps/web` package 级测试通过，当前为 `30 files / 145 tests`
- `type-check / lint / build` 全部通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

这轮锁住的是 `set default` 之后显式 panel identity 仍然不丢：

1. `Documents set default` 后继续同步 `documentTeamView`
2. `requestedViewId`、`teamViewKey`、`isDefault` 会一起更新到同一个 id
3. `applyViewState(saved.state)` 会被重新调用

## Live API 准备

本轮 live 创建了三条非默认 panel team view：

1. Documents
   - `31975883-9b2e-4bef-80ed-50fcfaaa7228`
   - `Set Default Documents View`
2. CAD
   - `7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c`
   - `Set Default CAD View`
3. Approvals
   - `f9bd71c1-a96d-4f2d-837f-4c9474be2883`
   - `Set Default Approvals View`

setup artifact：

- [plm-panel-team-view-set-default-url-sync-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-20260311.json)

## Browser Smoke 验证

浏览器通过显式链接打开：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=31975883-9b2e-4bef-80ed-50fcfaaa7228&documentRole=primary&documentFilter=set-doc&cadTeamView=7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c&cadFileId=cad-set-main&cadOtherFileId=cad-set-other&cadReviewState=approved&cadReviewNote=set-note&approvalsTeamView=f9bd71c1-a96d-4f2d-837f-4c9474be2883&approvalsStatus=approved&approvalsFilter=set-eco&approvalComment=set-comment&approvalSort=title&approvalSortDir=asc
```

在同一页依次点击：

1. `文档 -> 设为默认`
2. `CAD -> 设为默认`
3. `审批 -> 设为默认`

实测结果：

1. 三个 `*TeamView` id 都仍然保留在 URL 中：
   - `documentTeamView=31975883-9b2e-4bef-80ed-50fcfaaa7228`
   - `cadTeamView=7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c`
   - `approvalsTeamView=f9bd71c1-a96d-4f2d-837f-4c9474be2883`
2. 三个 panel 都进入了 `· 默认`
3. 当前状态没有被覆盖：
   - `documentFilter=set-doc`
   - `cadReviewNote=set-note`
   - `approvalsFilter=set-eco`

最终 URL：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=31975883-9b2e-4bef-80ed-50fcfaaa7228&documentRole=primary&documentFilter=set-doc&cadTeamView=7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c&cadFileId=cad-set-main&cadOtherFileId=cad-set-other&cadReviewState=approved&cadReviewNote=set-note&approvalsTeamView=f9bd71c1-a96d-4f2d-837f-4c9474be2883&approvalsStatus=approved&approvalsFilter=set-eco&approvalComment=set-comment&approvalSort=title&approvalSortDir=asc
```

browser artifact：

- [plm-panel-team-view-set-default-url-sync-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-browser-20260311.json)
- [page-panel-team-view-set-default-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-set-default-url-sync-20260311/page-panel-team-view-set-default-url-sync.png)

## 验证结论

本轮已经确认：

1. `Documents / CAD / Approvals team view set default` 已满足 URL 一致性要求
2. `set default` 不会吞掉显式 panel deep link identity
3. `set default` 不会覆盖当前 panel 工作状态
4. 当前行为已经和：
   - `clear default`
   - `duplicate / rename`
   - `archive / restore`
   - `share`
   - `owner transfer`
   保持同一条 identity 规则

## Live Cleanup 验证

本轮临时数据已全部清理：

- `31975883-9b2e-4bef-80ed-50fcfaaa7228`
- `7d7944e3-51c5-4adf-b8ed-ecccb00f2c7c`
- `f9bd71c1-a96d-4f2d-837f-4c9474be2883`

cleanup artifact：

- [plm-panel-team-view-set-default-url-sync-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-set-default-url-sync-cleanup-20260311.json)
