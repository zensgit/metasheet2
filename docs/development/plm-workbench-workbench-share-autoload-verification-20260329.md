# PLM Workbench Workbench Share Autoload Verification

## Scope

验证 `workbench` team view share URL 会按 snapshot 自身的 fetch target 重新推导 `autoload=true`，不再依赖持久化 state 里是否已经保存了 `autoload`。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 文件 / `40` 测试通过

新增覆盖点：

- 含 `productId / itemNumber` 且 panel 命中 `documents,approvals` 的 workbench share URL 会补 `autoload=true`
- 含 `cadFileId` 的 workbench share URL 会补 `autoload=true`
- 不含真实 fetch target 的 workbench share URL 继续不带 `autoload`

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
