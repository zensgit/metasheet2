# PLM Workbench Team-Scope List Web Runtime Verification

Date: 2026-03-29
Commit: pending

## Goal

Verify that the web PLM workbench client now matches the team-scope list contract already supported by backend and SDK:

- omitted `kind` is allowed
- request URLs omit `?kind=...` when no filter is requested
- `metadata.kind = 'all'` survives mapping
- mixed team-view items normalize by their own runtime `kind`

## Focused Web Client Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Validated:

- `listPlmTeamFilterPresets()` works without a `kind` argument
- team-scope preset metadata preserves `kind: 'all'`
- `listPlmWorkbenchTeamViews()` works without a `kind` argument
- mixed team-scope view items keep their own runtime kinds during normalization
- no-kind request URLs omit the `kind` query parameter

## Type Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Validated:

- the widened web client signatures and overloads type-check cleanly
- existing typed call sites that still pass explicit kinds remain valid

## Frontend Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Validated:

- the PLM frontend regression suite stays green after the web-runtime contract widening
