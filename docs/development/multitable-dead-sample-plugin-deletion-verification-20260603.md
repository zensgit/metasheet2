# Dead sample view-plugin deletion — verification

**What:** optional-hardening item #2 of the multitable field-read-gate arc (tracker `multitable-field-read-gate-tracker-20260602.md` §4) — delete the 3 dead sample view plugins to remove their latent ungated record-egress routes. **Date:** 2026-06-03. **Type:** code/test cleanup (no open leak; the arc is 12/12).

## Deleted
- `plugins/plugin-view-kanban/` — sample plugin whose `GET /api/kanban/:spreadsheetId` queries a **non-existent `records` table** (latent ungated egress).
- `plugins/plugin-view-gallery/` — `GET /api/gallery/.../records` forwards to the **unhandled** `spreadsheet:records:query` event; **no manifest** (unloadable).
- `plugins/plugin-view-calendar/` — same shape; **no manifest** (unloadable).
- The 3 **dormant** plugin-loader fixture tests that loaded the root kanban via `pluginDirs`: `kanban-plugin.test.ts`, `kanban.mvp.api.test.ts`, `plugins-api.contract.test.ts`. They were **excluded from CI in every config** (`vitest.config.ts` `exclude`, in no other step) and kanban-specific, so they provided no live coverage. Their 3 stale entries in `vitest.config.ts` `exclude` were removed.

## Re-verified dead before deleting (the load-bearing safety check)
- **Manifests:** gallery + calendar have no `plugin.json`/`manifest.json` → the loader throws → they can never load. Kanban has a manifest but its only data path hits the missing `records` table.
- **No live provider:** `rg` for `GalleryViewConfigProvider`/`CalendarViewConfigProvider`/`registerViewConfig` in `packages/core-backend/src` → **none**. The ViewConfigProviders only ever lived in the (unloadable) plugins, so deletion changes nothing at runtime. The product renders kanban/gallery/calendar view-types client-side off the gated `GET /view` (per the #2206 egress scan).
- **Distinct plugin kept:** `packages/core-backend/plugins/plugin-view-kanban/` (the **boards** kanban — queries `views`/`kanban_configs` config, not `meta_records`) is a different plugin and was **not** touched.
- **No live references:** post-deletion `rg` over `*.{ts,js,cjs,json,yml,yaml,vue}` finds **no** code/config/CI reference to the deleted plugins or tests (only the kept boards-kanban, which is expected).

## Checks
- `pnpm validate:plugins` — **12 valid / 0 invalid / 0 errors** (the deleted plugins contributed nothing valid).
- Egress-coverage guard (`multitable-egress-coverage-guard.test.ts`) — **GREEN** (the plugins are outside `core-backend/src`, so the GOLDEN is unchanged).
- `tsc` (core-backend) — exit **0**.
- Remaining plugin-loader tests (`plugin-loader.*`, `platform-app-registry`) use their own fixtures (test-plugin-a/b, hello-world, example-plugin) — unaffected.

## Residual doc references — disposition
`rg` finds mentions of the deleted names only in **docs**, all historical:
- **Frozen historical archives — intentionally NOT rewritten** (they are accurate past-tense records): `FIX_REPORT.md`, `results/phase5-*/plugin-audit.md` (a dated audit snapshot), `docs/attendance-framework-final-verification-report-20260128.md`, `docs/development/approval-phase1-baseline-20260515.md`, `docs/v2-migration-tracker.md`, `docs/v2-merge-adjustment-plan.md`, `docs/pr/PR_ci_docs_tests_hardening.md`. Rewriting an archive to erase a name it correctly recorded at the time would falsify history.
- **Informational (left, flagged):** `docs/verification-index.md` (a how-to listing a now-removable run-command for the 3 deleted tests) and `docs/multitable-view-compat-matrix.md` (attributes gallery/calendar view-config to the now-deleted plugins — already stale since they never loaded; its accuracy is a separate product question, not this cleanup's scope).

Per the tracker's discipline, the **deletion is recorded here + in the tracker §4** (the allowed exception to "no residual references"). The live code/config/CI surface is clean.

## Scope
3 plugin dirs (14 tracked files) + 3 test files + 2 `vitest.config.ts` `exclude` lines. No production `src` touched; the field-read-gate arc remains 12/12 + the §3 change gate live. The only remaining optional item is the deferred `AllowedFieldIds` branded type (tracker §4 item 3).
