# PLM Workbench Local Preset Batch Restore Pending Drift Verification

## 变更范围

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmLocalPresetOwnership.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`
- `apps/web/tests/plmLocalPresetOwnership.spec.ts`

## 回归点

### 1. restore 不再在 local owner drift 下主动 reapply

新增 focused 用例覆盖：

- 当前没有 `requestedPresetId`
- `hasPendingExternalOwnerDrift() === true`
- selector 指向已归档团队 preset
- batch restore 成功

断言：

- `batchPlmTeamFilterPresets('restore', ...)` 被调用
- `applyPreset` 不会被调用
- `syncRequestedPresetId` 不会被调用
- 团队 preset 草稿仍会被清空
- restored item 生命周期正确更新为未归档

### 2. local owner cleanup 改成看动作前 ownership

`plmLocalPresetOwnership.spec.ts` 新增 helper 用例：

- 如果 restore 前本地 preset 已拥有当前状态，即使动作后 active team preset id 落在 `processedIds` 中，也不能 clear local owner

这把 `BOM / Where-Used` wrapper 的 defer-clear 语义锁回动作前 canonical owner。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmLocalPresetOwnership.spec.ts
```

结果：

- `2` 个文件
- `45` 个测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Full

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `59` 个文件
- `449` 个测试通过
