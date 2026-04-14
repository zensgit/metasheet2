# Public Form Baseline Development

Date: `2026-04-14`

## Goal

Deliver the Week 3 baseline for anonymous multitable form access without adding new tables or a separate public-form service.

This baseline focuses on:

- anonymous form-context loading through a public token
- anonymous form submission through the same public token
- a dedicated public route and page in the web app
- create-only anonymous submission semantics

This baseline does not include:

- public link management UI
- rate limiting or CAPTCHA
- branded theming
- edit-existing-record public links
- advanced form logic

## Design Decisions

### 1. Reuse `view.config.publicForm`

Public access is configured from the existing `meta_views.config` payload instead of a new table.

Expected shape:

```json
{
  "publicForm": {
    "enabled": true,
    "publicToken": "pub_token_123",
    "expiresAt": "2099-12-31T23:59:59.000Z"
  }
}
```

Why:

- no migration required for the baseline
- public-form state stays attached to the form view itself
- easy to evolve later into a management UI

### 2. Keep anonymous access create-only

Anonymous public access can create a new record, but cannot:

- load an existing `recordId`
- update an existing `recordId`

Why:

- avoids leaking record data through a shared token
- avoids turning a public intake form into an edit surface
- keeps the first public-form release low-risk

### 3. Keep the existing form engine

The public page reuses `MetaFormView` and the existing multitable form endpoints.

Why:

- reduces divergence between internal and public form behavior
- reuses field rendering and field-error display
- keeps Week 3 focused on access semantics, not renderer duplication

## Backend Changes

Files:

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/multitable-record-form.api.test.ts`
- `packages/openapi/src/paths/multitable.yml`

Main changes:

- `GET /api/multitable/form-context` now accepts `publicToken`
- `POST /api/multitable/views/:viewId/submit` now accepts `publicToken`
- anonymous access is allowed only when:
  - `view.config.publicForm.enabled === true`
  - `publicToken` matches
  - the link is not expired
- form-context returns a tokenized `submitPath` for public links
- anonymous submissions write `created_by = null`
- anonymous public access now uses a dedicated capability set:
  - `canRead: true`
  - `canCreateRecord: true`
  - `canEditRecord: false`
- anonymous public access rejects `recordId` on both load and submit

## Frontend Changes

Files:

- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/router/multitableRoute.ts`
- `apps/web/src/router/types.ts`
- `apps/web/src/views/PublicMultitableFormView.vue`
- `apps/web/tests/multitable-embed-route.spec.ts`
- `apps/web/tests/multitable-phase4.spec.ts`
- `apps/web/tests/public-multitable-form.spec.ts`

Main changes:

- added public route:
  - `/multitable/public-form/:sheetId/:viewId?publicToken=...`
- extended the multitable client to pass `publicToken` on:
  - `loadFormContext`
  - `submitForm`
- added `PublicMultitableFormView.vue`
  - loads form context anonymously
  - reuses `MetaFormView`
  - submits with `publicToken`
  - shows a success state after submission

## Test Harness Adjustment

`packages/core-backend/tests/integration/multitable-record-form.api.test.ts` needed a small mock-pool update to keep up with current route behavior.

The mocked query layer now returns empty defaults for:

- `spreadsheet_permissions`
- `field_permissions`
- `meta_view_permissions`
- `record_permissions`
- `formula_dependencies`

Why:

- these queries are now part of the normal route path
- the baseline change exposed gaps in the old test harness
- this keeps the integration suite aligned with current backend behavior

## Known Follow-ups

- add admin UI to generate, rotate, expire, and disable public form links
- add rate limiting and abuse protection
- support configurable success copy and branding
- decide whether authenticated external edits should ever be supported
- add a public-form management surface inside multitable view settings
