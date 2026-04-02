# PLM Workbench Audit Collaboration Saved-View Runtime Verification

## Scope

Validate runtime normalization for `audit team view` collaboration state when a
`saved-view-promotion` source saved view disappears externally.

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Test Cases

Added focused assertions for:

- draft provenance is cleared when the promoted source saved view is no longer present
- follow-up provenance is cleared when the promoted source saved view is no longer present
- combined runtime state normalization reports `changed=true` and persists both cleaned objects

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `tests/plmAuditTeamViewCollaboration.spec.ts`: passed
- `pnpm --filter @metasheet/web type-check`: passed
- full `plm*.spec.ts` + `usePlm*.spec.ts`: passed

## Conclusion

`saved-view-promotion` collaboration state now self-heals when source saved views
disappear outside the local delete path, and no longer leaks stale provenance into
follow-up focus or subsequent collaboration actions.
