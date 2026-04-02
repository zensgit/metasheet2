# PLM Audit Scene Owner Context Verification

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Verified

- Scene-context helper prefers `sceneId` over `sceneName`
- Owner-context switch preserves scene metadata and resets page to `1`
- Scene-query restore resets page to `1` and rebuilds the original scene query
- Owner-context active detection works from route state alone
- Audit banner now exposes owner-context actions without moving the logic back into page-level ad hoc code

## Commands

Focused:

```bash
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web exec vitest run --watch=false tests/plmAuditSceneContext.spec.ts tests/plmWorkbenchSceneAudit.spec.ts tests/plmAuditQueryState.spec.ts tests/plmAuditSavedViews.spec.ts
```

Result:

- `4 files / 18 tests` passed

Full:

```bash
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web test
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web type-check
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web lint
pnpm --dir /Users/huazhou/Downloads/Github/metasheet2-plm-workbench --filter @metasheet/web build
```

Observed results:

- `pnpm --filter @metasheet/web test`: passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm --filter @metasheet/web lint`: passed
- `pnpm --filter @metasheet/web build`: passed

## Notes

- No real `PLM UI regression` rerun was required for this slice because:
  - no federation route changed
  - no backend contract changed
  - no upstream `Yuantus` interaction changed
