# PLM Workbench Archived Apply Hard Gating Verification

## Scope

Verify that archived collaborative entries remain non-applyable even when explicit permissions still say `canApply: true`.

## Focused Coverage

- Added a helper-level regression in `apps/web/tests/usePlmCollaborativePermissions.spec.ts`:
  - archived entry + `permissions.canApply = true`
  - expects `canApplyPlmCollaborativeEntry(...) === false`
- Added a `team view` regression in `apps/web/tests/usePlmTeamViews.spec.ts`:
  - archived workbench team view + `permissions.canApply = true`
  - expects `canApplyTeamView === false`
  - expects `applyTeamView()` to stop with `请先恢复工作台团队视角，再执行应用。`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- Focused permission/view tests: pass
- Frontend type-check: pass
- Full PLM frontend suite: pass
