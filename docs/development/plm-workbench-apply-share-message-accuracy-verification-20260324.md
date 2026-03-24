# PLM Workbench Apply And Share Message Accuracy Verification

Date: 2026-03-24

## Claude Code status

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
/Users/huazhou/.local/bin/claude auth status
/Users/huazhou/.local/bin/claude -p "Inspect usePlmTeamViews.ts after commit 9debf58b3 for the next highest-confidence handler or message mismatch."
```

Result:

- `Claude Code` 登录态正常
- 进一步 prompt 在返回结论前再次命中了当日额度上限
- 本轮 message-accuracy 修复因此由本地代码核对直接完成

## Focused coverage

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
```

Result:

- `1` file passed
- `32` tests passed

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
- `343` tests passed

## Assertions locked by this round

- non-archived `permissions.canApply = false` 不再误报“请先恢复”
- manageable-but-non-shareable team view 不再误报“仅创建者可分享”
- archived share/apply 和 readonly ownership share 文案保持原合同
