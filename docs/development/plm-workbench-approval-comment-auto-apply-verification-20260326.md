# PLM Workbench Approval Comment Auto-Apply Verification

## Scope

验证 `approvalComment` 不再阻断默认 `workbenchTeamView` auto-apply，同时其他显式 query state 继续保留 blocker 语义。

## Focused Checks

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts`

新增断言：

- `approvalComment` 单独存在时，`hasExplicitPlmWorkbenchAutoApplyQueryState(...) === false`
- `approvalComment + approvalsFilter` 时仍返回 `true`
- `workbenchTeamView` 时仍返回 `true`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts tests/usePlmTeamViews.spec.ts
```

结果：

- `2` 个文件
- `60` 个测试通过

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `56` 个文件
- `421` 个测试通过

## Conclusion

默认 `workbenchTeamView` auto-apply 的 blocker 现在只覆盖真正的显式 workbench route state，`approvalComment` 继续保持本地草稿语义。
