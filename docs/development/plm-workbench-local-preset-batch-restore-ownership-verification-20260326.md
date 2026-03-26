# PLM Workbench Local Preset Batch Restore Ownership Verification

## Scope

验证 batch restore 只有在 restored team preset 真正成为 active owner 时，才会清掉本地 preset owner。

## Focused Checks

文件：

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmLocalPresetOwnership.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts`

新增断言：

- `processedIds` 命中选中项，但没命中 requested owner 时，不清本地 owner
- restored preset 真正成为 active owner 时，才清本地 owner

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalPresetOwnership.spec.ts tests/usePlmTeamFilterPresets.spec.ts
```

结果：

- `2` 个文件
- `41` 个测试通过

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

batch restore 的 local-owner cleanup 现在和底层 restore takeover 语义一致，不会再因为单纯 `processedIds` 非空就错误剥离本地 preset owner。
