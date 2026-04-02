# PLM Workbench Reset Route Owner Purge Verification

## 变更范围

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

### 1. reset helper 覆盖全部 canonical owner keys

新增 focused regression：

- `buildPlmWorkbenchResetOwnerQueryPatch()` 必须同时返回
  - `workbenchTeamView`
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`

这样 `resetAll()` 再引用 helper 时，不会只清本地 ref 却漏掉 route query。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 个文件
- `14` 个测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Full

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `56` 个文件
- `417` 个测试通过
