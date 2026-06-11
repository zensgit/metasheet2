# 多维表模板 install dry-run + 详情(S2)验证 — 2026-06-11

## Scope

Implements the S2 engineering slice from
`multitable-template-dryrun-detail-s2-design-20260611.md`.

- Adds a zero-write template install dry-run endpoint.
- Adds a template detail page that renders the existing descriptor and can run
  the installability check.
- Keeps install semantics unchanged.

Out of scope: sample data preview, onboarding, rollback policy changes,
OpenAPI, migrations, template authoring, and permission matrix recommendations.

## Backend

- `previewMultitableTemplateInstall()` builds the same planned base/sheet/field/view
  ids as `installMultitableTemplate()`.
- `detectTemplateInstallConflicts()` is shared by dry-run and install so the
  conflict surface does not drift.
- `POST /api/multitable/templates/:templateId/dry-run` uses the same write RBAC
  guard and request shape as install, but performs no transaction and no writes.
- The detail page passes the dry-run planned `baseId` back into install so the
  post-review HTTP path uses the same derived sheet/view/field ids.

## Frontend

- Template cards expose a secondary detail action.
- The new detail route renders sheets, fields, and views from the existing
  descriptor.
- The detail page calls dry-run with the selected base name, displays conflicts,
  and disables install when dry-run reports `installable:false`.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-template-library.test.ts --reporter=dot`
  - 21 tests passed.
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts --reporter=dot`
  - 25 tests passed.
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-template-center-view.spec.ts tests/multitable-template-detail-view.spec.ts --watch=false --reporter=dot`
  - 16 tests passed.
  - A non-fatal jsdom test server note reported `WebSocket server error: Port is already in use`; the test process exited 0.
- `pnpm --filter @metasheet/core-backend build`
  - passed.
- `pnpm --filter @metasheet/web exec vue-tsc -b --pretty false`
  - passed.
- `pnpm --filter @metasheet/web exec eslint src/views/MultitableTemplateDetailView.vue src/views/MultitableTemplateCenterView.vue src/multitable/components/MetaTemplateCard.vue tests/multitable-template-center-view.spec.ts tests/multitable-template-detail-view.spec.ts`
  - passed.
- `git diff --check`
  - passed.

## Lint Note

Targeted backend eslint over `src/routes/univer-meta.ts` is not a useful slice
gate because the file currently carries unrelated pre-existing lint errors in
untouched sections. The touched route path is covered by the focused integration
test and backend TypeScript build above.

## Review Fix

Subagent review found that the first draft dry-run and install routes generated
fresh random base ids independently. The fix is to accept `baseId` in the
install request, have the detail page send the dry-run planned base id, and test
that install receives that exact id. This closes the planned-id drift between
the preview and the actual install request.

GitHub review suggested three frontend polish fixes. The detail page now reloads
via an immediate `templateId` watcher so reused route instances refresh, new
detail strings are localized through `workbenchLabel()`, and the template card's
detail action also uses the shared label table. The reused-route behavior is
covered by a component spec.

Subagent re-review found that a stale dry-run response could still land after a
route-level template change and feed the previous template's planned `baseId`
into install. The detail page now invalidates in-flight dry-runs on template
change and only applies a dry-run response when both the request token and
`templateId` still match. A component spec holds the stale-response path.
