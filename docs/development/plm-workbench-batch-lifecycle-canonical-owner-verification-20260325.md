# PLM Workbench Batch Lifecycle Canonical Owner Verification

## 范围

验证 `usePlmTeamViews.ts` 在 pending selector drift 下的 batch lifecycle 行为：

- batch `archive` 不误清 canonical route owner
- batch `restore` 不劫持 canonical route owner

## 新增回归

文件：[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

新增断言：

1. `keeps the canonical workbench route owner when batch archiving a pending local selector target`
2. `does not hijack the canonical workbench route owner when batch restoring a pending local selector target`

覆盖点：

- `requestedViewId = A`、`teamViewKey = B` 的 pending drift
- `archive(B)` 后 `requestedViewId` 仍保持 `A`
- `restore(B)` 后不触发 `applyViewState(B)`，也不改写 `requestedViewId`
- 本地 selector cleanup 与 canonical route cleanup 的分离行为

## 执行

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

## 结果

- `1` 个文件
- `41` 个测试通过

结论：batch lifecycle 的 canonical owner 与本地 selector owner 已正确拆分，没有再出现 pending selector 劫持 route 的回归。
