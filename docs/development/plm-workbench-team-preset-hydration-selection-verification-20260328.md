# PLM Workbench Team Preset Hydration Selection Verification

## Focused tests

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmHydratedTeamPresetOwnerTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts
```

Checks:

- route owner `A -> B` trims stale `A` from batch selection
- removed route owner `A -> none` trims only `A`
- pending selector `B` is preserved when still valid
- selector/name/group/owner drafts keep the existing hydration semantics

## Safety regression

Run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Checks:

- no PLM panel regression from the helper contract change
- `team preset` route hydration remains authoritative
- batch management no longer keeps stale preset ids after route owner takeover/removal
