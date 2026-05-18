# Multitable Home Template Quickstart Development - 2026-05-18

## Why This PR Exists

PR #1618 made `/multitable` the primary table entry, but the landing page still behaved mostly as a base list plus blank-base creator. The hero copy already promised "from templates"; this PR wires the existing template APIs into the home page so users can start from a template without first entering the full workbench.

## Scope

In scope:

- Load the existing multitable template library on `/multitable`.
- Render template cards with category, description, sheet count, and view count.
- Install a template through the existing `MultitableApiClient.installTemplate` method.
- Route the user into the first installed sheet/view with `baseId` preserved in query params.
- Keep the existing blank Base creation flow unchanged.
- Add focused frontend regression coverage.

Out of scope:

- No backend route, migration, OpenAPI, schema, or permission changes.
- No change to `/grid` or `/spreadsheets` legacy compatibility.
- No change to `MultitableWorkbench.vue` template-library behavior.
- No new template definitions.
- No staging deploy or browser smoke in this PR.

## Implementation

### Template Loading

`MultitableHomeView.vue` now loads bases and templates together through:

- `multitableClient.listBases()`
- `multitableClient.listTemplates()`

Each loader catches its own error. A template-library failure does not block the base list or blank-base creation flow; it renders a warning and lets users continue with an empty Base.

### Template Cards

The home page renders a new "模板快速开始" panel. Each card shows:

- template icon / fallback first letter
- category
- name
- description
- sheet count
- total view count across template sheets

The view count is computed client-side from `template.sheets[].views`.

### Install And Open

Clicking "使用模板" calls:

```ts
multitableClient.installTemplate(template.id, { baseName: `${template.name} Base` })
```

After install, the page:

1. Prepends the installed base to the local base list if it is not already present.
2. Resolves the first installed sheet and its matching first view.
3. Navigates to `AppRouteNames.MULTITABLE` with `{ sheetId, viewId }` params and `{ baseId }` query.
4. If the install response has no usable sheet/view, shows a user-facing error and refreshes bases.

This matches the existing blank-base create path: create or install first, then route directly into the workbench.

## Files Changed

- `apps/web/src/views/MultitableHomeView.vue`
- `apps/web/tests/multitable-home-view.spec.ts`
- `docs/development/multitable-home-template-quickstart-development-20260518.md`
- `docs/development/multitable-home-template-quickstart-verification-20260518.md`

## Parallel Read-Only Scout

A parallel read-only explorer confirmed:

- `/multitable` already routes to `MultitableHomeView`.
- `MultitableApiClient` already exposes `listBases`, `createBase`, `listTemplates`, `installTemplate`, `createSheet`, and `createView`.
- Backend routes for `/bases`, `/templates`, and `/templates/:templateId/install` already exist.
- Existing tests cover base list/open and blank-base creation; the useful missing home-level behavior was template install/open.

## Risk Notes

- Template install uses existing backend authorization and validation.
- The PR does not invent a new data shape; it consumes existing `MetaTemplate` and `InstallTemplateResult`.
- The panel is additive. If templates fail to load, existing base workflows continue.
- The direct legacy route compatibility policy from #1618 is unchanged.
