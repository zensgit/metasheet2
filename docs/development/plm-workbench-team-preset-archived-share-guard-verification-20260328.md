# PLM Workbench Team Preset Archived Share Guard Verification

## Scope

Verify that archived team presets are blocked before share permissions, URL generation, or clipboard copy.

## Focused Regression

- Added a `usePlmTeamFilterPresets` regression that:
  - loads an archived BOM team preset
  - gives it explicit `permissions.canShare = true`
  - calls `shareTeamPreset()`
  - verifies `buildShareUrl(...)` and `copyShareUrl(...)` are never called
  - verifies the handler reports `请先恢复BOM团队预设，再执行分享。`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- Focused `usePlmTeamFilterPresets.spec.ts`: pass
- Frontend type-check: pass
- Full PLM frontend suite: pass
