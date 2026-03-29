# PLM Workbench Team View Share Origin Verification

## Scope

验证 `team view` share helper 不再默认写死 localhost：

- 未显式传 origin 时，使用当前 `window.location.origin`
- `workbench` saved snapshot 仍会正确补 `autoload=true`

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 文件 / `40` 测试通过

新增覆盖点：

- `workbench` saved snapshot 命中产品相邻 panel 时，share URL 会补 `autoload=true`
- `workbench` saved snapshot 命中 `cadFileId` 时，share URL 会补 `autoload=true`
- team-view share helper 未显式传 origin 时，会回退到当前 runtime origin

## Type Check

命令：

```bash
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## Full Frontend Regression

命令：

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `65` 文件 / `570` 测试通过
