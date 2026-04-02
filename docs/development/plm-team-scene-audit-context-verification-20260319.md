# PLM Team Scene Audit Context Verification

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Verified Behavior

- Audit route parsing accepts:
  - `auditSceneId`
  - `auditSceneName`
  - `auditSceneOwner`
- Audit route building emits those fields when context exists
- Team-view-derived audit state clears scene context back to empty strings
- Scene context does not count as an explicit audit filter
- Recommended scene audit deep links preserve scene context for:
  - current default
  - recent default
  - recent update
- Local saved audit views preserve scene context across save/read cycles
- Audit page can render a scene-context banner and clear only the context fields from route state

## Commands

Focused:

```bash
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web exec vitest run --watch=false tests/plmWorkbenchSceneAudit.spec.ts tests/plmAuditQueryState.spec.ts tests/plmAuditSavedViews.spec.ts
```

Result:

- `3 files / 14 tests` passed

Full web validation:

```bash
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web test
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web type-check
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web lint
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web build
```

Observed results:

- `pnpm --filter @metasheet/web test`: `35 files / 186 tests` passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm --filter @metasheet/web lint`: passed
- `pnpm --filter @metasheet/web build`: passed

## Notes

- This slice only touched front-end route/context handling and local saved-view behavior.
- No real `PLM UI regression` rerun was required for this change because:
  - no federation route changed
  - no backend contract changed
  - no upstream `Yuantus` interaction changed
