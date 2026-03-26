# Multitable People Preset And Smoke

Date: 2026-03-25
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Why

After restoring the `/api/multitable` runtime contract, the next shortest high-value frontend gap was still the `person` field creation flow.

The backend already exposed `POST /api/multitable/person-fields/prepare`, but the new clean worktree still had four frontend gaps:

1. the API client could not call `person-fields/prepare`
2. field creation UI still excluded `person`
3. workbench field creation always created a raw field type
4. link picker still behaved like a generic multi-select even for `refKind=user`

At the same time, smoke coverage had recovered only to `bases/create-base/create-sheet/context/fields`; it still missed the real grid hydration path and follow-on lightweight reads.

## Design

### 1. Frontend people preset flow

The frontend now treats `person` as a create-only preset instead of a new persisted backend field type.

- `MetaFieldManager` offers `person` as a field creation option.
- `MultitableWorkbench` intercepts `type === 'person'`.
- The workbench first calls `client.preparePersonField(sheetId)`.
- It then creates a normal `link` field with the returned preset `fieldProperty`.

This keeps persisted schema aligned with backend reality while making the user-facing create flow explicit.

### 2. Person display and picker semantics

Two user-facing details were tightened so the flow does not regress after creation:

- field manager displays `link + property.refKind === 'user'` as `person`
- link picker switches to single-select mode when `limitSingleRecord === true` or `refKind === 'user'`

The picker also now shows the selected chips and exposes an explicit clear/cancel affordance, which makes person-style selection clearer than the old generic checkbox-only flow.

### 3. Smoke-core raise

`scripts/verify-smoke-core.mjs` now covers more of the restored `/api/multitable` runtime surface using the smoke-created seeded sheet:

- `GET /api/multitable/views`
- `GET /api/multitable/view`
- `GET /api/multitable/form-context`
- `GET /api/multitable/records-summary`
- `POST /api/multitable/person-fields/prepare`

This keeps smoke on the real restored contract instead of only checking context metadata.

## Files

Frontend:

- `apps/web/src/multitable/api/client.ts`
- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaLinkPicker.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/types.ts`

Tests:

- `apps/web/tests/multitable-client.spec.ts`
- `apps/web/tests/multitable-link-picker.spec.ts`
- `apps/web/tests/multitable-workbench.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`

Smoke:

- `scripts/verify-smoke-core.mjs`

## Verification

Passed:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-link-picker.spec.ts tests/multitable-workbench.spec.ts tests/multitable-workbench-view.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
node --check scripts/verify-smoke-core.mjs
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/multitable-attachments.api.test.ts --reporter=dot
```

Observed results:

- frontend TypeScript: pass
- frontend Vitest: `4 files / 22 tests passed`
- frontend build: pass
- smoke core syntax check: pass
- backend TypeScript: pass
- backend targeted integration: `3 files / 18 tests passed`

Not run:

- `pnpm verify:smoke`
- `pnpm verify:smoke:all`

Reason:

- local `API_BASE=http://127.0.0.1:7778` and `WEB_BASE=http://127.0.0.1:8899` were not running in this session
- full smoke bootstrap still depends on local Postgres at `127.0.0.1:5435`

## Old Worktree

The old multitable worktree directory can be deleted at the filesystem level because the branch history is still preserved in git refs.

It is still not recommended to delete it yet.

Reason:

- the old branch remains materially ahead on selective migration inventory
- this round migrated the people preset slice and part of smoke coverage, but not the remaining old-only attachment/UI slices

Practical guidance:

- continue development in `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`
- keep `/Users/huazhou/Downloads/Github/metasheet2-multitable` until the remaining high-value old-only slices are selectively migrated
