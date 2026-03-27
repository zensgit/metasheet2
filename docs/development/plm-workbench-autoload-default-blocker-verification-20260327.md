# PLM Workbench `autoload` Default Blocker Verification

## Focused Coverage

新增回归覆盖：

- `autoload=true` 不再阻断默认 `workbenchTeamView` auto-apply
- `autoload=false` 也不再被误判成显式 blocker

测试文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`

## Commands

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 文件
- `27` 测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Frontend Regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `60` 文件
- `455` 测试通过
