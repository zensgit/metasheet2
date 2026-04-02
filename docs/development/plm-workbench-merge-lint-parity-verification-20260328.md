# PLM Workbench Merge Lint Parity Verification

## Scope

Files updated:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`

Docs added:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-workbench-merge-lint-parity-design-20260328.md`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/docs/development/plm-workbench-merge-lint-parity-verification-20260328.md`

## Validation

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- lint passes with no unused-symbol errors in `plmWorkbenchClient.ts` or `PlmProductView.vue`
- web type-check passes
- PLM frontend suite stays green

## Release Meaning

If the rerun GitHub check turns green after this patch, the remaining publish gates are no longer code-merge blockers; they become standard remote CI and staging acceptance gates.
