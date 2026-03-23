# PLM Audit Canonical Team View Route Ownership Verification

Date: 2026-03-23

## Scope

Verify that `shared-entry`, `collaboration draft`, and `collaboration followup` are cleaned up by canonical route changes rather than by temporary selector browsing.

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
pnpm exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Result:

- `2` files passed
- `39` tests passed

Covered assertions:

- `shared-entry` survives only while the canonical `teamViewId` still matches
- `collaboration draft` survives only while the canonical `teamViewId` still matches

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `257` tests passed

Note:

- Vitest printed `WebSocket server error: Port is already in use`, but the run completed successfully and all tests passed.
