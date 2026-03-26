# PLM Workbench Panel Auto-Apply Gating Verification

## Scope

验证 `panel` 的 default auto-apply blocker 现在和 canonical panel normalization 保持一致。

## Focused Checks

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`

新增断言：

- `panel=all` 时 blocker 返回 `false`
- `panel=unknown` 时 blocker 返回 `false`
- `panel=approvals,documents` 时 blocker 返回 `true`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 个文件
- `16` 个测试通过

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
- `422` 个测试通过

## Conclusion

默认 `workbenchTeamView` auto-apply 现在只会被真正的显式 panel scope 阻断，raw `panel=all` 和非法 token 不再制造伪 blocker。
