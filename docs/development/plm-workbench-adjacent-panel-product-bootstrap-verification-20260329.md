# PLM Workbench Adjacent Panel Product Bootstrap Verification

## Scope

验证产品相邻 panel 的冷启动 deep link/runtime contract 已经对齐：

- `where-used`
- `compare`
- `substitutes`
- `where-used` local/team preset share 在只有产品上下文时也会带 `autoload=true`

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/plmWorkbenchViewState.spec.ts \
  tests/plmFilterPresetUtils.spec.ts
```

结果：

- `2` 文件 / `47` 测试通过

新增覆盖点：

- `shouldAutoloadPlmProductContext(...)` 对 `where-used / compare / substitutes` 返回 `true`
- `cad` 继续保持 `false`
- `where-used` local preset share 在只有 `productId / itemNumber / itemType` 时也会输出 `autoload=true`
- `where-used` team preset share 在同场景下也会输出 `autoload=true`

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
