# Multitable Gantt Dependency-Arrow Render — Investigation Handoff

> Date: 2026-05-08
> Branch: `codex/multitable-gantt-dependency-field-render-fix-20260508`
> Status: Diagnosis only — **no fix written**. Handoff for an FE specialist (Codex / human with browser dev-tools access).
> Companion artifacts: `docs/development/artifacts/multitable-gantt-dependency-render-investigation-20260508/`

## Symptom

`scripts/verify-multitable-rc-staging-smoke.mjs` (the API harness) passes 7/7 against deployed staging at `34d731670`. But `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` "renders dependency arrows when dependencyFieldId is configured" fails on the same deployment:

- `.meta-gantt__dependency-arrow` selector never appears within 15 s timeout
- Page snapshot shows the Gantt view loaded, both records rendered as bars, the "Predecessor" link field listed in the **Dependencies** dropdown — **but the dropdown's selected value is `none`**, not the saved `dependencyFieldId`

So the saved `view.config.dependencyFieldId` is not reaching the rendered toolbar's bound `<select :value="dependencyFieldId">` despite the SPA receiving the correct API response.

## What is confirmed correct

### Backend (DB → API contract)

Live curl against `127.0.0.1:18081` (via SSH tunnel) on the deployed image:

- `POST /api/multitable/views` with `config.dependencyFieldId: "fld_xxx"` → 200, response carries `data.view.config.dependencyFieldId`
- `GET /api/multitable/views?sheetId=…` → 200, the persisted view's `config.dependencyFieldId` is present
- The Predecessor field's `property` carries both `foreignSheetId` AND `foreignDatasheetId` set to the parent sheet id

The captured `POST /views` response is at `artifacts/.../post-views-response.json`.

### MetaGanttView.vue source

Four new vitest cases in `apps/web/tests/multitable-gantt-view.spec.ts` exercise the component directly with the same data shape staging produces. **All four pass** on `34d731670`:

1. `renders dependency arrows when sheetId is supplied and link field foreignSheetId matches (staging regression)` — synchronous mount with all props populated
2. `renders dependency arrows after fields prop populates after initial empty mount (workbench async-load regression)` — fields arrive AFTER first mount tick
3. `renders dependency arrows after viewConfig prop populates after fields load (workbench late-config regression)` — viewConfig arrives later
4. `renders dependency arrows when sheetId arrives empty initially then populates (sheetId race regression)` — sheetId arrives later

These are kept as durable regression tests; even though they currently pass, they document the rendering contract MetaGanttView is supposed to honor and would catch a future regression that does affect the component itself.

### Resolver and helper functions

- `resolveGanttViewConfig` returns the configured `dependencyFieldId` when the field exists with `type === 'link'` and `isSelfTableLinkField(field, sheetId) === true`.
- `isSelfTableLinkField` permissive branch (`!currentSheetId → return true`) is irrelevant here because staging passes a real sheetId, and the strict branch (`foreignSheetId === currentSheetId`) succeeds with the API data captured above.

### Page snapshot evidence

`artifacts/.../page-snapshot.md` shows:

- `region "Gantt view"` is the active rendering (forced-mode `?mode=gantt` works — bars render)
- `combobox "Dependencies"` lists `option "none" [selected]` and `option "Predecessor"` — the dropdown's options computed by `dependencyFields` *include* Predecessor (so `isSelfTableLinkField(Predecessor, sheetId)` returned true at that moment), but the selected value is the empty fallback

## What is unconfirmed and still suspect

The bug is reproducible only against the deployed FE bundle running in real Chromium. None of the four vitest reproducers — exercising the component under jsdom-style runtime — surfaces the failure. Likely suspects, none of which can be verified from this branch:

1. **A timing or ordering quirk specific to real Chromium** that jsdom-style runtimes (happy-dom or @vue/test-utils' DOM) don't replicate. For example, an extra microtask flush ordering between `props.fields`, `props.viewConfig`, and `props.sheetId` populating from three separate composable refs.
2. **The compiled SPA bundle differs from the source** in how the `<script setup>` macros, `defineProps`, or `computed`/`watch` are emitted. This would make the bundled MetaGanttView behave differently from the source-mounted reproducer even when the inputs are identical.
3. **Workbench composable / activeView reactivity drift** after `?mode=gantt` forces gantt rendering. The composable might leave `activeView.value` lagging on a previous view (whose config has no `dependencyFieldId`) for the first paint, and the watcher's `pendingConfigKey` might not retroactively pick up the eventual update. The reproducers cover async props but not the multi-ref composable lifecycle.
4. **An overlapping mutation source** — for example, a separate `MetaViewManager` instance that also resolves view config, races with `MetaGanttView`, and writes back a sanitized config that drops `dependencyFieldId`.

## Steps recommended for the FE specialist

In rough order of cheapness:

1. **Inject a `console.log` patch into `MetaGanttView.vue`'s watcher and resolver** to record `props.fields.length`, `props.viewConfig`, `props.sheetId`, and `resolvedConfig.dependencyFieldId` at every tick. Build a debug image of `metasheet-web`, redeploy to staging, re-run the failing spec, capture the console log via Playwright's `page.on('console', …)`. Compare to the four passing reproducers' implied trace.
2. If 1 surfaces a transient `dependencyFieldId=null` followed by `=fld_xxx` then "stuck" at empty: the watcher is dropping the late update under `pendingConfigKey` lock. Fix by gating the lock with a generation token instead of a JSON-stringify key, or by clearing `pendingConfigKey` on prop change.
3. If 1 shows `dependencyFieldId=fld_xxx` but the `<select>` still binds to '': the `dependencyFieldId` ref is stale at template render time. Possible Vue 3 reactivity bug after #1440's mode-forcing changes. Inspect the `forced-mode → activeViewType → conditional render` branch in `MultitableWorkbench.vue` — maybe the `MetaGanttView` instance is being replaced (key collision) when `?mode=gantt` is applied.
4. Inspect `MetaViewManager.vue:936` (`Object.assign(ganttDraft, resolveGanttViewConfig(...))`). If the view manager is mounted in parallel and re-emits a sanitized config back via `update-view-config`, that could overwrite the saved `dependencyFieldId` with `null`.

## Artifacts attached for triage

- `staging-trace.zip` — full Playwright trace.zip from the failing run (chromium 1208, headless, 142 via tunnel)
- `post-views-response.json` — actual API response showing `config.dependencyFieldId` is persisted
- `page-snapshot.md` — accessibility tree at moment of `.meta-gantt__dependency-arrow` timeout
- Four new vitest cases in `apps/web/tests/multitable-gantt-view.spec.ts` (+ regression tests for future coverage)

## What this branch does NOT contain

- Any change to MetaGanttView.vue, useMultitableWorkbench.ts, view-config.ts, or the API client. The bug was not localised to a specific code path.
- A speculative fix. Without a confirmed reproduction, applying changes risks introducing different defects.

## RC implications

Per the user's earlier judgement: `multitable-rc-20260508-1b06bf286` remains the API/automation GO baseline. **No new RC tag should be cut at `34d731670`** until this UI render bug is fixed and the Gantt UI smoke moves to 3/3.

## Cross-references

- Failing spec: `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts:95` "renders dependency arrows when dependencyFieldId is configured"
- API harness (still 7/7 GO): `scripts/verify-multitable-rc-staging-smoke.mjs`
- Source under suspicion: `apps/web/src/multitable/components/MetaGanttView.vue` (watcher at L208), `apps/web/src/multitable/views/MultitableWorkbench.vue` (forced-mode branch at L593-597 + `<MetaGanttView>` at L202)
- Resolver: `apps/web/src/multitable/utils/view-config.ts:136` (`resolveGanttViewConfig`)
- Recent merges related to this surface: PR #1409 (link-only narrowing), #1412 (self-table enforcement), #1440 (Workbench forced-mode support), #1441 (`?mode=gantt` deeplink in smoke)
