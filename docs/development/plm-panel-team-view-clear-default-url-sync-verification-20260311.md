# PLM Panel Team View Clear Default URL Sync 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用设计文档 [plm-panel-team-view-clear-default-url-sync-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-clear-default-url-sync-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- focused tests `1 file / 12 tests` 通过
- `apps/web` package 级测试通过，当前为 `30 files / 144 tests`
- `type-check / lint / build` 全部通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

这轮锁住的是 `clear default` 之后显式 panel identity 不丢：

1. `Documents clear default` 后继续同步 `documentTeamView`
2. `clear default` 会重新 `applyView(saved.state)`
3. `requestedViewId`、`teamViewKey`、URL query 继续指向同一个 panel team view id

## Live API 准备

本轮 live 创建了三条默认 panel team view：

1. Documents
   - `6936fa3d-20c5-4d75-9a45-f25aa5f6559a`
   - `Clear Default Documents View`
2. CAD
   - `2cf1393f-6c7f-47ff-b2db-d2972f4eb35a`
   - `Clear Default CAD View`
3. Approvals
   - `6f290c7c-47c4-44c9-935b-29b144c82aec`
   - `Clear Default Approvals View`

setup artifact：

- [plm-panel-team-view-clear-default-url-sync-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-20260311.json)

## Browser Smoke 验证

浏览器通过显式链接打开：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=6936fa3d-20c5-4d75-9a45-f25aa5f6559a
```

页面实际恢复后，同时带回了三个 panel 的显式 identity 和状态：

- `documentTeamView=6936fa3d-20c5-4d75-9a45-f25aa5f6559a`
- `cadTeamView=2cf1393f-6c7f-47ff-b2db-d2972f4eb35a`
- `approvalsTeamView=6f290c7c-47c4-44c9-935b-29b144c82aec`
- `documentFilter=clear-doc`
- `cadReviewNote=clear-note`
- `approvalsFilter=clear-eco`

随后在同一页依次点击：

1. `文档 -> 取消默认`
2. `CAD -> 取消默认`
3. `审批 -> 取消默认`

实测结果：

1. 三个 `*TeamView` id 都还在 URL 中
2. 三个 panel 都从 `· 默认` 状态退回普通团队视图
3. 当前状态没有被清空：
   - `documentFilter=clear-doc`
   - `cadReviewNote=clear-note`
   - `approvalsFilter=clear-eco`

最终 URL：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=6936fa3d-20c5-4d75-9a45-f25aa5f6559a&documentRole=primary&documentFilter=clear-doc&approvalsTeamView=6f290c7c-47c4-44c9-935b-29b144c82aec&approvalsStatus=approved&approvalsFilter=clear-eco&approvalComment=clear-comment&approvalSort=title&approvalSortDir=asc&cadTeamView=2cf1393f-6c7f-47ff-b2db-d2972f4eb35a&cadFileId=cad-clear-main&cadOtherFileId=cad-clear-other&cadReviewState=rejected&cadReviewNote=clear-note
```

browser artifact：

- [plm-panel-team-view-clear-default-url-sync-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-browser-20260311.json)
- [page-panel-team-view-clear-default-url-sync.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-clear-default-url-sync-20260311/page-panel-team-view-clear-default-url-sync.png)

## 环境补充判断

这轮 `7910` 上游 PLM 健康端口不可达：

- `curl http://127.0.0.1:7910/api/v1/health`

返回连接失败。

但这不影响本轮验证结论，因为 `panel team view clear default` 的路径只依赖：

- `8899` 前端
- `7778` live backend

不依赖上游 `PLM federation` 实时数据。

## 验证结论

本轮已经确认：

1. `Documents / CAD / Approvals team view clear default` 现在会重新走统一 `applyView(saved)` 流程
2. `clear default` 后显式 deep link identity 不会丢
3. `clear default` 后当前 panel 状态不会被清空
4. 行为已经和现有 `duplicate / rename / archive / restore / share / owner transfer` 对齐到同一条 lifecycle 规则

## Live Cleanup 验证

本轮临时数据已全部清理：

- `6936fa3d-20c5-4d75-9a45-f25aa5f6559a`
- `2cf1393f-6c7f-47ff-b2db-d2972f4eb35a`
- `6f290c7c-47c4-44c9-935b-29b144c82aec`

cleanup artifact：

- [plm-panel-team-view-clear-default-url-sync-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-clear-default-url-sync-cleanup-20260311.json)
