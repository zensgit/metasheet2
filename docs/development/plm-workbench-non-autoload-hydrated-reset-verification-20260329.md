# PLM Workbench Non-Autoload Hydrated Reset Verification

## Scope

验证 `autoload=false` 的 route hydration 在外部 target 变化时会清掉 stale payload，而 target 未变化时不会误清。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/plmHydratedPanelDataReset.spec.ts \
  tests/plmWorkbenchViewState.spec.ts \
  tests/plmFilterPresetUtils.spec.ts
```

结果：

- `3` 文件 / `53` 测试通过

新增覆盖点：

- non-autoload `cadFileId: cad-a -> cad-b` 会触发 `clearCad`
- non-autoload 且 target 不变时不误清 payload

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

- `65` 文件 / `565` 测试通过
