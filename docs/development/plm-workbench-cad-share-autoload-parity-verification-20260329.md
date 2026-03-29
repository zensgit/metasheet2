# PLM Workbench CAD Share Autoload Parity Verification

## Scope

验证 `CAD team view` 分享链接在存在 primary CAD file 时会输出 `autoload=true`，从而与产品页 `applyQueryState()` 的 autoload gate 保持一致。

## Focused Tests

命令：

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 文件 / `32` 测试通过

覆盖点：

- 现有 CAD share URL expectation 已更新为包含 `autoload=true`
- 新增单文件 CAD 视图 case，锁住“只要 `fileId` 存在就必须输出 `autoload=true`”

## Full Validation

待本轮代码一起继续验证：

- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Runtime Outcome

- 用户通过分享链接打开 CAD team view 时，fresh load 不再只 hydrate route
- 如果 share URL 里带了 `cadFileId`，产品页会继续自动触发 CAD metadata/diff 加载
