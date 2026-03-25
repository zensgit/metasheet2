# PLM Workbench Team Preset Granular Gating Verification

## 范围

验证 team preset handlers 不再绕过 granular permission。

## 回归

更新：

- [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

覆盖点：

1. active preset 即使 `canManage = true`，只要 explicit permission 把 action 禁掉，对应 handler 也不会再打 API
2. archived preset 即使仍可见，只要 `canRestore = false`，`restoreTeamPreset()` 也不会旁路
3. legacy `delete` block 文案更新为 action-accurate 的 generic denial

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：见本轮提交后的回归结果
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：team preset management 现在已经和 team views 一样，按 granular permission 执行，不再留下 handler bypass。
