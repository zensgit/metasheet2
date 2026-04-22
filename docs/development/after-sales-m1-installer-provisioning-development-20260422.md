# After-Sales M1 — Installer C-min Through multitable/provisioning.ts (Development)

> Document type: Development record
> Date: 2026-04-22
> Scope: Roadmap §5.2 (after-sales C-min) M1
> Related: `docs/development/multitable-service-extraction-roadmap-20260407.md`
> Worktree: `.worktrees/after-sales-m1`
> Branch: `codex/after-sales-m1-installer-provisioning-20260422`
> Baseline commit: `27a9b9de1`

## 1. Background and recon finding

The task brief expected to "replace the direct/fake provisioning path in the
after-sales installer with a production adapter that calls
`multitable/provisioning.ts`." Reconnaissance against baseline `27a9b9de1`
found that this wiring is **already in place** — M0 Path A landed it:

1. `plugins/plugin-after-sales/lib/installer.cjs#runInstall` resolves
   `context.api.multitable.provisioning` (lines 224–232 and 466–475).
2. When present, the installer calls
   `provisioning.ensureObject({ projectId, descriptor })` for every blueprint
   object whose `backing === 'multitable'` (or whose
   `provisioning.multitable === true` for hybrid types).
3. The production context binds the seam in `packages/core-backend/src/index.ts`
   (lines 357–414) and the plugin-scoped wrapper in
   `createPluginScopedMultitableApi` (same file, lines 1090–1183) wires
   `ensureObjectInScope`, which delegates to
   `multitable/provisioning.ts#ensureObject`.
4. `plugins/plugin-after-sales/lib/blueprint.cjs` enriches the
   `installedAsset` descriptor with a field list that already contains the
   C-min minimum floor (`assetCode` required + `serialNo` optional) as its
   first two entries, plus five additional C-full business fields (`model`,
   `location`, `installedAt`, `warrantyUntil`, `status`).
5. The existing end-to-end integration test
   `packages/core-backend/tests/integration/after-sales-plugin.install.test.ts`
   already exercises the whole install path against real Postgres and locks
   in the full 7-field descriptor for installedAsset.

This is consistent with the roadmap §5.2 acceptance criteria for M1:

> - after-sales installer 不直接访问 `meta_*`
> - `runInstall()` 真实建出 `installedAsset` 对应 sheet 和字段
> - 现有 installer unit tests 继续通过
> - 新增 1-2 个 integration tests 验证 provisioning helper 与真实 DB 契约

The first three criteria are already satisfied at baseline. M1 is therefore
scoped down to **adding a seam-level integration test** that proves the
provisioning helper contract directly against real Postgres, plus these dev
and verification notes.

## 2. Why the blueprint is not trimmed to 2 fields

The roadmap §5.2 says "推荐的最小持久字段集" = **recommended minimum floor**,
not a hard cap. The five extra `installedAsset` fields
(`model`, `location`, `installedAt`, `warrantyUntil`, `status`) are real
business fields that map to the template's grid view and to the plugin's
runtime admin. They are not placeholders (`id`, `created_at`, `updated_at`)
or scaffolding. Trimming them would:

1. Break `after-sales-plugin.install.test.ts`, which asserts all 7 fields.
2. Delete real functionality already landed under the blueprint enrichment path.
3. Exceed the M1 scope by reworking blueprint + end-to-end tests that belong
   to subsequent C-full slices.

We therefore leave `plugin-after-sales/lib/blueprint.cjs` untouched. The M1
acceptance criterion ("installer builds a real installedAsset sheet + fields
through provisioning.ts") is satisfied because the C-min floor (`assetCode`
required + `serialNo` optional) is already the first two fields of the
descriptor and gets persisted by `ensureFields` in the same code path as the
rest.

## 3. Adapter shape (unchanged from baseline)

```
installer.cjs::runInstall
  ├─ loads blueprint (with enriched field list)
  └─ for each object where backing === 'multitable':
       provisioning = context.api.multitable.provisioning
       → provisioning.ensureObject({ projectId, descriptor })
           ├─ production: packages/core-backend/src/index.ts
           │    calls multitable/provisioning.ts#ensureObject
           │    inside a pooled transaction
           │    (ensureLegacyBase → ensureSheet → ensureFields)
           └─ unit tests: inject a vi.fn() fake adapter
```

The production adapter:

1. Opens a transaction on the core pool.
2. Calls `ensureLegacyBase(query)` — idempotent `meta_bases` insert.
3. Calls `ensureSheet({ query, baseId, sheetId, name, description })`.
4. Calls `ensureFields({ query, sheetId, fields })`.
5. Claims plugin scope via `claimPluginObjectScope` (adds the registry row
   that protects this sheet from cross-plugin writes).

Plugins never touch `meta_*` SQL directly — that invariant is enforced by
`createPluginScopedMultitableApi` in core-backend `index.ts`.

## 4. Field spec actually persisted for installedAsset

From `blueprint.cjs#enrichObjectDescriptor` (`installedAsset` branch):

| Field ID        | Name            | Type   | Required | C-min? |
|-----------------|-----------------|--------|----------|--------|
| `assetCode`     | Asset Code      | string | ✓        | ✓      |
| `serialNo`      | Serial No       | string |          | ✓      |
| `model`         | Model           | string |          | C-full |
| `location`      | Location        | string |          | C-full |
| `installedAt`   | Installed At    | date   |          | C-full |
| `warrantyUntil` | Warranty Until  | date   |          | C-full |
| `status`        | Status          | select | ✓        | C-full |

The new integration test asserts the first two rows (the C-min floor) land
in `meta_fields` with correct `type` via the direct seam call. The existing
end-to-end test (`after-sales-plugin.install.test.ts`) continues to assert
all 7.

## 5. New integration test outline

File:
`packages/core-backend/tests/integration/after-sales-installer-provisioning.api.test.ts`

Harness:

- `beforeAll`: opens a real `pg.Pool` from `DATABASE_URL`, then calls a
  local `ensureMultitableSeamSchema(pool)` helper that creates only the
  tables this suite exercises (`meta_bases`, `meta_sheets`, `meta_fields`,
  `plugin_after_sales_template_installs`). This keeps the suite independent
  from the full migration graph (which at baseline has an unrelated blocker
  around `views.id` vs `kanban_configs.view_id` uuid/text mismatch in
  `20250924120000_create_views_view_states.ts`). The schema definitions are
  exact mirrors of the source migrations — no drift.
- `beforeEach`: deletes rows from the seam tables for the dedicated test
  tenant (`tenant_m1_installer_it`).
- `afterAll`: cleans up and ends the pool.

Three cases:

1. **Direct seam path (primitives)** — calls `ensureLegacyBase` →
   `ensureSheet` → `ensureFields` with the C-min descriptor and asserts:
   - `meta_bases` contains `base_legacy`.
   - `meta_sheets` row has `id=SHEET_ID, name='Installed Asset', base_id='base_legacy'`.
   - `meta_fields` contains the 2 rows in the expected order.

2. **Aggregate path (ensureObject)** — invokes
   `provisioning.ensureObject({ projectId, descriptor })` with a minimal
   2-field `installedAsset` descriptor. Asserts the same row layout plus
   that the return value's `fields[*].name` matches expectation.

3. **End-to-end through the plugin installer** — builds a minimal plugin
   context with `api.database` backed by real Postgres and
   `api.multitable.provisioning.ensureObject` backed by a spy that forwards
   to the real `provisioning.ensureObject`. Runs
   `installer.runInstall({ blueprint: { objects: [installedAsset C-min] }, mode: 'enable' })`
   and asserts:
   - install result reports `status='installed'`, `projectId=${TENANT}:after-sales`,
     `createdObjects=['installedAsset']`.
   - the spy was called exactly once with the C-min descriptor.
   - `meta_fields` contains the 2 expected rows.

Case 3 is the direct M1 acceptance for "runInstall() 真实建出 installedAsset
对应 sheet 和字段" — it proves the plugin installer genuinely routes its
installedAsset provisioning through `multitable/provisioning.ts` against
real Postgres rather than a fake.

## 6. Out of scope for M1 (C-full follow-ups)

- installedAsset views (the `installedAsset-grid` view definition stays in
  `blueprint.cjs` but is still covered only by the end-to-end install test).
- Blueprint-driven records for installedAsset.
- installedAsset attachments.
- Other after-sales objects (ticket, customer, serviceRecord, partItem,
  followUp) — all still covered by the existing end-to-end test.
- Automation / notification / approval wiring around installedAsset.

## 7. Files changed

- `packages/core-backend/tests/integration/after-sales-installer-provisioning.api.test.ts` (new)
- `docs/development/after-sales-m1-installer-provisioning-development-20260422.md` (this file)
- `docs/development/after-sales-m1-installer-provisioning-verification-20260422.md`
