# PLM Workbench Approval Inbox Version Actionability Verification

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmApprovalInboxActionPayload.spec.ts
```

Result:

- passed (`1` file / `5` tests)

Coverage added:

- resolves optimistic-lock versions from numeric and string payloads
- formats pending version labels through the shared helper
- disables actionability when inbox rows do not expose a usable version

## Type Validation

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Frontend Regression Sweep

Command:

```bash
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- passed

## Manual Behaviour Verified In Code

- pending approvals now render version labels through `formatApprovalInboxVersion(...)`
- `Approve` / `Reject` buttons are disabled when `canActOnApprovalInboxEntry(...)` returns `false`
- conflict recovery still reconciles versions through `reconcileApprovalInboxConflictVersion(...)`
