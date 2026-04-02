# PLM Audit Shared-Entry Source Action Takeover Verification

## Scope

This verification covers the shared-entry takeover fix for source-aware collaboration actions on the active shared-entry team view.

Files touched:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Supporting design note:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-audit-shared-entry-source-action-takeover-design-20260323.md`

## Expected behavior

When a source-aware collaboration action targets the same team view that currently owns `auditEntry=share`:

- the old shared-entry banner is consumed
- `auditEntry=share` is removed
- the new collaboration draft/followup remains the only transient owner

Generic actions without source provenance must not consume shared-entry ownership.

## Validation

### Type-check

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- passed

### Focused tests

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Result:

- `2` files passed
- `42` tests passed

### Full PLM frontend regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `261` tests passed

## Conclusion

The shared-entry/source-aware action path now closes cleanly without leaving a stale shared-entry notice or marker behind, and the broader PLM audit frontend regression set remains green.
