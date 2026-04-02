# PLM Audit Canonical Local Save Ownership Verification

Date: 2026-03-23

## Scope

Verify that generic `Save current view` now resolves shared-entry followup ownership from the canonical route state instead of the local team-view selector.

## Type Safety

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Focused Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts
```

Result:

- `2` files passed
- `18` tests passed

Covered assertions:

- generic local-save followup resolves to `shared-entry` when the canonical route still owns the shared entry
- local-save followup still falls back to `scene-context` or `null` when no shared-entry route owner is active

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `267` tests passed

- no regressions across existing PLM audit/workbench route-state and transient-attention coverage
