# PLM Workbench Team View Lifecycle Owner Draft Verification

Date: 2026-03-29
Commit: pending

## Goal

Verify that successful `team view` duplicate and rename actions no longer leave behind stale owner-transfer drafts.

## Focused Verification

Commands:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/usePlmTeamViews.spec.ts
```

Validated:

- duplicate success continues to clear stale owner drafts
- rename success now also clears stale owner drafts after applying the renamed view
- existing team-view management regressions remain green

## Type Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Validated:

- the lifecycle cleanup change introduces no web type regressions

## Frontend Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Validated:

- the full PLM frontend regression suite remains green after the additional owner-draft cleanup
