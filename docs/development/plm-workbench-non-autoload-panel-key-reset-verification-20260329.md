# PLM Workbench Non-Autoload Panel Key Reset Verification

## Scope

验证 `autoload=false` 的 hydration 在同一产品上下文下也会正确清掉 panel-owned stale payload：

- BOM `bomDepth / bomEffectiveAt`
- documents `documentRole`
- approvals `approvalsStatus`

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmHydratedPanelDataReset.spec.ts
```

结果：

- `1` 文件 / `8` 测试通过

新增覆盖点：

- non-autoload 同一产品下 `bomDepth: 2 -> 3` 会触发 `clearBom`
- non-autoload 同一产品下 `documentRole: drawing -> spec` 会触发 `clearDocuments`
- non-autoload 同一产品下 `approvalsStatus: pending -> rejected` 会触发 `clearApprovals`

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

- `65` 文件 / `567` 测试通过
