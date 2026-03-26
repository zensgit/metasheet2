# PLM Workbench Approvals Auto-Apply Gating Verification

## Scope

验证 `approvalComment` 不再阻断默认 `approvalsTeamView` auto-apply，而真正的 approvals route state 仍继续生效。

## Focused Checks

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts`

新增断言：

- `approvalComment` 单独存在时，approvals auto-apply blocker 返回 `false`
- `approvalComment + approvalsFilter` 时 blocker 返回 `true`
- `approvalsTeamView` 时 blocker 返回 `true`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts tests/usePlmTeamViews.spec.ts
```

结果：

- `2` 个文件
- `61` 个测试通过

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
- `423` 个测试通过

## Conclusion

`approvalComment` 现在只保留本地审批草稿语义，不再干扰默认 `approvalsTeamView` 的 canonical auto-apply。
