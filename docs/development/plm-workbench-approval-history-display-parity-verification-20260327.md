# PLM Workbench Approval History Display Parity Verification

## Focused Verification

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmApprovalHistoryDisplay.spec.ts tests/plmApprovalInboxFeedback.spec.ts
pnpm --filter @metasheet/web type-check
```

Results:

- focused Vitest passed
- `2` files / `10` tests passed
- frontend type-check passed

Covered:

- actor label 优先使用 `actor_name`
- actor label 正确回退到 `approver_name / actor_id / user_id`
- version label 正确展示 `from_version -> to_version`

## Full Verification

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- full frontend Vitest passed
- `61` files / `469` tests passed
