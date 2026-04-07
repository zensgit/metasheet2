# Multitable Permission Delivery Checklist

Date: 2026-04-07
Branch baseline: `origin/main` at `d367c828b`
Goal: determine whether the recent multitable permission work is close to delivery, what was verified locally, and what still needs staging sign-off.

## Current Delivery Status

The code path is close to sign-off. The core permission model changes are already in `main`:

- sheet/base creation visibility aligned with global `multitable:write`
- unreadable foreign-sheet lookup/rollup/link-summary reads are blocked or redacted
- sheet permission candidate lists now match actual global multitable eligibility
- `canManageSheetAccess` is split from `canManageFields`
- `capabilityOrigin` is returned by backend multitable context endpoints
- the workbench now surfaces `capabilityOrigin` in UI
- list visibility now respects direct sheet grants without leaking unreadable bases/sheets

At this point, remaining work is mostly:

- staging verification
- manual role-matrix validation
- optional UX polish beyond the main workbench surface

## Local Verification Completed

Executed on latest `main`:

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-permissions.api.test.ts \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  --reporter=dot

pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-sheet-permission-manager.spec.ts \
  --watch=false --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Observed results:

- backend integration: `61/61` passing
- frontend vitest: `44/44` passing
- backend typecheck: passing
- frontend typecheck: passing

Notes:

- frontend Vitest emitted a benign `WebSocket server error: Port is already in use` warning but the suite passed
- no staging environment was exercised in this pass

## Staging / Pilot Validation Entry Points

The repo already contains usable multitable validation entry points. No new staging harness is needed.

### Quick smoke

- Root script: [package.json](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-permission-delivery-20260407/package.json)
- Command: `pnpm verify:smoke`
- Runner: [scripts/verify-smoke-core.mjs](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-permission-delivery-20260407/scripts/verify-smoke-core.mjs)

This covers:

- `/api/multitable/bases`
- `POST /api/multitable/bases`
- `POST /api/multitable/sheets`
- `/api/multitable/views`
- `/api/multitable/view`
- `/api/multitable/form-context`
- `/api/multitable/records-summary`
- `/api/multitable/person-fields/prepare`
- `/api/multitable/context`
- `/api/multitable/fields`

### Full local readiness

- Command: `pnpm verify:multitable-pilot:ready:local`
- Script: [scripts/ops/multitable-pilot-ready-local.sh](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-permission-delivery-20260407/scripts/ops/multitable-pilot-ready-local.sh)

This chains:

- live smoke
- grid profile
- profile threshold validation
- release gate
- readiness summary generation

### Full staging readiness

- Command: `pnpm verify:multitable-pilot:ready:staging`
- Script: [scripts/ops/multitable-pilot-ready-staging.sh](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-permission-delivery-20260407/scripts/ops/multitable-pilot-ready-staging.sh)

This is the best existing sign-off path once staging credentials and running services are available.

### Release-bound staging gate

- Command: `pnpm verify:multitable-pilot:ready:staging:release-bound`
- Wrapper: [scripts/ops/multitable-pilot-ready-release-bound.sh](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/multitable-permission-delivery-20260407/scripts/ops/multitable-pilot-ready-release-bound.sh)

This is appropriate when tying the multitable pilot to on-prem/release evidence.

## Required Staging Sign-Off Matrix

These scenarios should be exercised manually in staging before calling the multitable permission work fully delivered.

1. Admin user
   - Can create bases and sheets
   - Can manage fields, views, and sheet access
   - Workbench banner shows `admin`

2. Global multitable reader/editor without sheet assignments
   - Sees only globally allowed bases/sheets
   - Workbench banner shows `global-rbac`

3. Direct sheet-grant user with no global `multitable:read`
   - Can see only the granted base/sheet
   - `/context`, `/view`, `/form-context`, `/records/:id` all load
   - Workbench banner shows `sheet-grant`

4. Sheet-scope restricted user
   - Can enter the sheet
   - Restricted actions are disabled consistently
   - Workbench banner shows `sheet-scope`
   - Banner copy matches actual disabled actions

5. User with `multitable:share` but no field-management rights
   - Can open Access manager
   - Cannot open Fields manager
   - Sheet permission candidate list excludes ineligible users

6. Cross-sheet lookup / rollup on unreadable foreign sheet
   - Create/update should reject unreadable foreign-sheet targets
   - Existing computed/link-summary values should be redacted rather than leaked

## Residual Risks

These are the main remaining risks after the current code merges.

### Required before final sign-off

- No staging run was performed in this pass
- No real role-matrix evidence was captured from a deployed environment

### Non-blocking follow-up candidates

- `capabilityOrigin` is surfaced in the workbench, but not yet consistently exposed in all secondary multitable surfaces
- UX copy is now much better for the main entry point, but drawer/form-specific explanation can still be improved later

## Delivery Estimate

If staging credentials and a running environment are available:

- engineering work remaining: low
- expected remaining effort to sign-off: roughly `0.5` to `1.5` day

That estimate assumes:

- the existing staging scripts run as-is
- no new permission drift is found in the manual matrix above

If staging access is not available, the codebase is still in a strong “locally verified, staging pending” state, but not at full delivery sign-off.
