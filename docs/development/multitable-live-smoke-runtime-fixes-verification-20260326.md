# Multitable Live Smoke Runtime Fixes Verification 2026-03-26

## Scope

Verification for the runtime and smoke hardening slice covering:

- `date` field runtime/OpenAPI parity
- `meta_views.config` forward migration
- `meta_comments` forward migration
- comments client transport alignment
- multitable capability derivation from request role/permissions
- workbench metadata refresh propagation into overlay consumers
- embed-host applied context alignment with requested targets
- embed-host router/URL sync after host-driven navigation
- pilot smoke self-seeding and reconcile-path hardening

## Commands Run

### Backend and contract checks

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts --reporter=dot
pnpm verify:multitable-openapi:parity
DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_multitable_pilot_v3' pnpm --filter @metasheet/core-backend migrate
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/comments.api.test.ts --reporter=dot
```

Observed:

- `multitable-context.api.test.ts`: passed, including the new capability derivation case
- OpenAPI parity: passed
- migration `zzzz20260326134000_create_meta_comments`: applied successfully to `metasheet_multitable_pilot_v3`
- `comments.api.test.ts`: passed after normalizing its legacy test-table bootstrap

### Frontend focused checks

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-comments.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-import-flow.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench-view.spec.ts tests/multitable-embed-host.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
node --check scripts/verify-multitable-live-smoke.mjs
node --test scripts/verify-multitable-live-smoke.test.mjs
```

Observed:

- `multitable-comments.spec.ts`: `6 passed`
- `multitable-workbench-import-flow.spec.ts`: `6 passed`
- `multitable-workbench-view.spec.ts` + `multitable-embed-host.spec.ts`: `29 passed`
- `vue-tsc`: passed
- `web build`: passed
- `verify-multitable-live-smoke.mjs`: syntax check passed after each smoke-harness edit
- `verify-multitable-live-smoke.test.mjs`: `1 passed`

## Real Environment Verification

### Runtime prerequisites

Local environment used:

- API: `http://127.0.0.1:7778`
- Web: `http://127.0.0.1:8899`
- Pilot DB: `postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_multitable_pilot_v3`

Fresh-database verification confirmed:

- `meta_views.config` exists
- `meta_comments` exists
- `/api/comments` can now create and list comments successfully against the pilot DB

Direct API probe after migration:

- `POST /api/comments` returned `201`
- `GET /api/comments?spreadsheetId=...&rowId=...` returned `200`

### Full pilot-local smoke

Command:

```bash
PILOT_DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_multitable_pilot_v3' pnpm verify:multitable-pilot:local
```

Observed progression during this slice:

1. Initial blockers:
   - comment text never appeared
   - comments transport used the wrong request keys
   - pilot DB had no `meta_comments`
   - later runs exposed stale embed applied-context reporting and stale iframe route state

2. Intermediate blockers after comments/runtime fixes:
   - busy/deferred embed replay timed out on applied result
   - then timed out on the iframe route still staying on the old path

3. Final state:
   - full `pilot-local` smoke passed end-to-end
   - latest successful artifacts:
     - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-local/20260326-140830/report.json`
     - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-local/20260326-140830/report.md`
     - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-local/20260326-140830/local-report.json`
     - `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-local/20260326-140830/local-report.md`

Representative successful milestones observed in the green report:

- `ui.import.failed-retry`
- `ui.import.mapping-reconcile`
- `ui.import.people-repair-reconcile`
- `ui.import.people-manual-fix`
- `ui.person.assign`
- `ui.route.form-entry`
- `api.form.attachment-upload`
- `ui.form.upload-comments`
- `api.multitable.attachment-hydration`
- `ui.grid.search-hydration`
- `ui.embed-host.navigate.applied`
- `ui.embed-host.navigate.explicit-request-id`
- `ui.embed-host.navigate.blocked`
- `ui.embed-host.navigate.confirmed`
- `ui.embed-host.navigate.deferred`
- `ui.embed-host.navigate.superseded`
- `ui.embed-host.navigate.replayed`
- `api.embed-host.persisted-busy-form-save`
- `ui.embed-host.state-query.initial`
- `ui.embed-host.state-query.final`
- `ui.embed-host.state-query.deferred`

## Assessment

Validated as fixed:

- missing runtime `date` support
- missing fresh-db `meta_views.config` support
- missing fresh-db `meta_comments` support
- comments client/backend contract mismatch
- multitable capability derivation drift for request-level admin/permissions
- import modal field-label refresh drift while metadata changes in the background
- embed-host applied result drift versus requested target
- embed-host route/path drift versus internal override state
- full `pilot-local` smoke reproducibility across the later field/view reconcile sequence

## Evidence Paths

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/multitable-pilot-local/20260326-140830/`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/output/playwright/field-manager-repro/field-manager-repro.png`

## Conclusion

This slice materially closed the real pilot readiness gap. The local pilot runner now completes successfully against a real API, real database, and real browser flow. The remaining follow-up work is PR/review/merge and environment promotion, not another known local runtime blocker in the multitable smoke path.
