# PLM Workbench Granular Management Gating Verification

Date: 2026-03-24

## Claude Code status

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude auth status
/Users/huazhou/.local/bin/claude -p "Inspect apps/web/src/views/plm/usePlmTeamViews.ts after commit 4b72050e1 for the next highest-confidence granular permission-gating bug."
```

Result:

- `Claude Code` 本轮仍处于登录态
- 进一步 prompt 在返回结论前命中了当日额度上限
- 本次 granular handler bypass 因此由本地代码核对直接完成

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `31` tests passed

## Type-check

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- Passed

## Full PLM frontend regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `48` files passed
- `342` tests passed

## Assertions locked by this round

- generic team-view management handler 不再绕过 `canDelete/canArchive/canRestore/canRename/canTransfer/canSetDefault/canClearDefault`
- coarse `canManage` 和 per-action gating 现在都在 handler 层生效
- 已有“仅创建者可...”文案和只读 gating 合同保持不变
