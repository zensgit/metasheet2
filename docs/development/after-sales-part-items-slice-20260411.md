# After-sales Part Items Slice

## Goal

Complete the missing `partItem` vertical slice that was already provisioned by the after-sales blueprint but not yet exposed through the plugin runtime or the main frontend view.

## Scope

- Add plugin HTTP CRUD routes for `partItem`
- Add request validation/builders for create and update payloads
- Add a frontend parts panel in `AfterSalesView.vue`
- Add route-level unit coverage, live integration coverage, and frontend view coverage

## Backend design

### API shape

- `POST /api/after-sales/parts`
- `GET /api/after-sales/parts`
- `PATCH /api/after-sales/parts/:partItemId`
- `DELETE /api/after-sales/parts/:partItemId`

### Data model

Logical fields:

- `partNo`
- `name`
- `category`
- `stockQty`
- `status`

Enum policy:

- `category`: `spare | consumable`
- `status`: `available | reserved | consumed`

### Implementation notes

- Plugin routes follow the same guard rails as customers / installed-assets / follow-ups:
  - require authenticated caller
  - require `after_sales:read` or `after_sales:write`
  - require operational install state
  - use multitable provisioning + records seam only
- `stockQty` is normalized back to `number | null` on read
- update payloads patch only explicitly provided fields instead of rewriting the whole row

## Frontend design

### New panel

`AfterSalesView.vue` now renders a `Part inventory` section when the manifest exposes the `partItem` projection.

Capabilities:

- create part
- filter by `status`
- free-text search
- inline edit
- delete
- success/error banners consistent with existing after-sales panels

### UX choices

- panel layout mirrors existing customer / follow-up / installed-asset shells
- edit mode is inline per row, not modal
- create/edit forms keep the same compact field rhythm already used elsewhere in the view

## Verification

### Backend unit

Command:

```bash
./node_modules/.bin/vitest run packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts
```

Result:

- `108/108` tests passed

### Backend integration

Command:

```bash
./node_modules/.bin/vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts
```

Run directory:

```text
packages/core-backend
```

Result:

- `25/25` tests passed
- includes the new live `parts` CRUD flow

### Frontend regression

Command:

```bash
./node_modules/.bin/vitest run tests/AfterSalesView.spec.ts tests/AfterSalesView.installed-assets.spec.ts tests/AfterSalesView.service-records.spec.ts tests/AfterSalesView.customers.spec.ts tests/AfterSalesView.follow-ups.spec.ts tests/AfterSalesView.part-items.spec.ts --config vite.config.ts
```

Run directory:

```text
apps/web
```

Result:

- `6/6` files passed
- `78/78` tests passed

## Files changed

- `plugins/plugin-after-sales/index.cjs`
- `plugins/plugin-after-sales/lib/event-entry.cjs`
- `packages/core-backend/tests/unit/after-sales-plugin-routes.test.ts`
- `packages/core-backend/tests/integration/after-sales-plugin.install.test.ts`
- `apps/web/src/views/AfterSalesView.vue`
- `apps/web/tests/AfterSalesView.part-items.spec.ts`

## Follow-up

- If this slice is split into a PR, exclude unrelated `node_modules` noise already present in the worktree.
