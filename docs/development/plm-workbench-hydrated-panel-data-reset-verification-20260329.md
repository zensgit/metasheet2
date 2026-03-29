# PLM Workbench Hydrated Panel Data Reset Verification

## Scope

验证 panel-scoped route hydration 在切换 panel / target 时，会正确清理 stale panel data model，而不是只更新 route owner。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/plmHydratedPanelDataReset.spec.ts \
  tests/plmWorkbenchViewState.spec.ts \
  tests/plmHydratedTeamViewOwnerTakeover.spec.ts \
  tests/plmHydratedTeamPresetOwnerTakeover.spec.ts \
  tests/plmLocalFilterPresetRouteIdentity.spec.ts
```

结果：

- `5` 文件 / `62` 测试通过

新增覆盖点：

- `autoload=false` 时不做 panel data reset
- `cad-only` deeplink 会清掉非目标 panel 的 stale 数据
- `documents` share 在相同 product context 下保留 product-scoped fetch data
- 相同 `cad` target 不误清 metadata payload
- `compare` 输入漂移时会清空旧 compare result

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

- `65` 文件 / `563` 测试通过
