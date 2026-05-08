# Multitable Gantt Dependency-Arrow Render — Root Cause + Fix

> Date: 2026-05-08
> Branch: `codex/multitable-gantt-dependency-field-render-fix-20260508`
> Status: **Root cause confirmed; fix applied in this branch**.
> Companion artifacts: `docs/development/artifacts/multitable-gantt-dependency-render-investigation-20260508/`

## TL;DR

When the URL anchors on a fresh sheet (`/multitable/<sheetId>/<viewId>?mode=gantt`) and that sheet does **not** belong to the user's first base, `MultitableWorkbench.vue#loadBases` auto-selected `bases[0]` (typically `base_legacy`). The follow-up `loadBaseContext(base_legacy, {sheetId})` returned **403 FORBIDDEN** because the sheet does not live under that base. With `/context` 403'd, the workbench composable's `views.value` stayed empty, `activeView.value?.config` was `undefined`, and `<MetaGanttView :view-config="undefined">` had no saved `dependencyFieldId` — so the toolbar fell back to "none" and no arrows rendered. Bars still rendered because `resolveGanttViewConfig` has fallbacks for `start/end/title` field ids but **no fallback for `dependencyFieldId`**.

The fix: skip the auto-pick of `bases[0]` whenever `props.sheetId` is in the URL, and use `loadSheetMeta(sheetId, {viewId})` to let the backend resolve the owning base from the sheet itself. `syncContextState` then sets `activeBaseId` from `ctx.sheet.baseId`.

## Symptom

`packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` "renders dependency arrows when dependencyFieldId is configured" failed against `34d731670` on 142 staging:

- `.meta-gantt__dependency-arrow` selector never appeared within 15 s
- Page snapshot showed the Gantt view loaded, both records rendered as bars, the "Predecessor" link field listed in the **Dependencies** dropdown — but the dropdown's selected value was `none`

## Diagnosis trail (what was ruled OUT first)

1. **Backend persistence**: live curl confirmed `POST /api/multitable/views` and `GET /api/multitable/views?sheetId=…` both round-trip `view.config.dependencyFieldId`.
2. **Predecessor field property**: API response carried both `foreignSheetId` AND `foreignDatasheetId` set to the parent sheet id.
3. **`MetaGanttView.vue` source**: four new vitest reproducers (mount + async fields race + async viewConfig race + sheetId race, all in `apps/web/tests/multitable-gantt-view.spec.ts`) **all pass**. The component itself is correct.
4. **Resolver and helpers**: `resolveGanttViewConfig` returns the configured `dependencyFieldId` when the inputs match staging's data. `isSelfTableLinkField` is correct (it added Predecessor to the dropdown's option list, proving the strict branch returned true at render time).
5. **Compiled bundle**: matches the source on `34d731670`; image tag verified via `docker inspect`.

## Diagnosis trail (what surfaced the truth)

A debug Playwright spec (`multitable-gantt-debug-spec.spec.ts`, removed before merge) navigated to the failing URL with `page.on('console')` + `page.on('response')` enabled and dumped:

```json
{
  "arrowCount": 0,
  "depSelectValue": "",
  "consoleCount": 2,
  "responseCount": 3,
  "contextResponseCount": 1
}
```

Two console errors recorded:
- `Failed to load resource: the server responded with a status of 500 (Internal Server Error)` (red herring; an unrelated 500 from another endpoint that was below the priority bar)
- `Failed to load resource: the server responded with a status of 403 (Forbidden)`

The 403 was the load-bearing one. The single matching response in the dump:

```
403 http://127.0.0.1:18081/api/multitable/context?baseId=base_legacy&sheetId=sheet_c76fb688-…&viewId=view_3f94f64d-…
{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}
```

The SPA was calling `/context` with `baseId=base_legacy` even though the test had created the sheet under a brand-new base. The workbench composable then never received the view, and the Gantt component fell back to defaults (which work for date/title fields but not for `dependencyFieldId`).

## Where the bug lived

`apps/web/src/multitable/views/MultitableWorkbench.vue` `loadBases()`:

```ts
async function loadBases() {
  try {
    const data = await workbench.client.listBases()
    bases.value = data.bases ?? []
    if (!workbench.activeBaseId.value && bases.value.length) workbench.selectBase(bases.value[0].id)
                                                              // ↑ auto-picks bases[0] even when the URL anchors on a sheet that lives elsewhere.
  } catch { /* silent */ }
}
```

And the follow-up in `onMounted`:

```ts
await loadBases()
if (workbench.activeBaseId.value) {
  await workbench.loadBaseContext(workbench.activeBaseId.value, {
    sheetId: props.sheetId,
    viewId: props.viewId,
  })
} else {
  await workbench.loadSheets()
}
```

After the auto-pick, `loadBaseContext(base_legacy, {sheetId, viewId})` would 403 if the sheet was elsewhere, and the workbench composable's `views.value` stayed empty.

## The fix in this PR

Two adjustments in `apps/web/src/multitable/views/MultitableWorkbench.vue`:

1. **Defer base auto-pick when the URL is sheet-anchored**:

   ```ts
   if (!workbench.activeBaseId.value && !props.sheetId && bases.value.length) {
     workbench.selectBase(bases.value[0].id)
   }
   ```

2. **Route to `loadSheetMeta(sheetId, {viewId})` when `props.sheetId` is set but no base is yet active**:

   ```ts
   await loadBases()
   if (workbench.activeBaseId.value) {
     await workbench.loadBaseContext(workbench.activeBaseId.value, {
       sheetId: props.sheetId,
       viewId: props.viewId,
     })
   } else if (props.sheetId) {
     await workbench.loadSheetMeta(props.sheetId, { viewId: props.viewId })
   } else {
     await workbench.loadSheets()
   }
   ```

`loadSheetMeta(sheetId)` calls `/api/multitable/context?sheetId=…&viewId=…` (no `baseId`), the backend resolves the owning base from the sheet, and `syncContextState` then sets `activeBaseId` from `ctx.sheet.baseId`. Composable contract already covered by `apps/web/tests/multitable-workbench.spec.ts:126` "syncs activeBaseId from loaded sheet metadata".

## Behaviour matrix (URL → onMounted path)

| URL pattern | Old behaviour | New behaviour |
|---|---|---|
| `?baseId=B&sheetId=S&viewId=V` | `loadBaseContext(B, {S,V})` | unchanged |
| `/multitable/S/V` (no baseId) | `loadBases()` auto-picks `bases[0]` → `loadBaseContext(bases[0], {S,V})` → **403 if S ∉ bases[0]** | `loadBases()` defers auto-pick → `loadSheetMeta(S, {V})` → `/context` derives base from S |
| `?baseId=B` (no sheetId) | `loadBaseContext(B, {})` | unchanged |
| empty URL | `loadBases()` auto-picks `bases[0]` → `loadBaseContext(bases[0], {})` | unchanged (`!props.sheetId` keeps the auto-pick) |

## Tests in this branch

- `apps/web/tests/multitable-gantt-view.spec.ts` adds 4 regression cases for `MetaGanttView.vue` (sheetId + self-table link, async fields, async viewConfig, sheetId race). Currently green; document contracts the component must continue to honour.
- Existing composable tests (`apps/web/tests/multitable-workbench.spec.ts`) cover `loadSheetMeta` resolving `activeBaseId` from `/context` (already passing on origin/main).
- Local pre-existing failures in `multitable-workbench-import-flow.spec.ts` and `multitable-workbench-manager-flow.spec.ts` are environment-bound (`window.localStorage.clear is not a function` from the happy-dom polyfill) — confirmed reproducible on origin/main without any local changes; out of scope for this PR.

## Verification on staging (post-deploy)

After deploying this branch's `metasheet-web` build to 142 and re-running:

```bash
cd packages/core-backend
TOKEN=$(cat /tmp/<staging-admin-jwt>) FE_BASE_URL=http://127.0.0.1:18081 \
  API_BASE_URL=http://127.0.0.1:18081 AUTH_TOKEN="$TOKEN" \
  pnpm exec playwright test --config tests/e2e/playwright.config.ts \
  multitable-gantt-smoke.spec.ts --workers=1
```

Expected: 3/3 pass (was 2/3 — bars + dropdown filter pass; arrows fail because `dependencyFieldId` is `none`).

## RC implications

Once 3/3 lands on the deployed image and `verify:multitable-rc:staging` (the API harness) is re-run for confirmation, a follow-up RC tag `multitable-rc-20260508b-<sha>` is appropriate.

## Cross-references

- Bug introduced in: `apps/web/src/multitable/views/MultitableWorkbench.vue:1725` (`loadBases` auto-pick) — predates the multitable RC closeout series; not specific to any single commit.
- Composable contract relied on: `apps/web/src/multitable/composables/useMultitableWorkbench.ts:121-122` (`syncContextState` setting `activeBaseId` from `ctx.sheet.baseId`).
- Backend `/context` route: `packages/core-backend/src/routes/univer-meta.ts:3091`. The `resolveMetaSheetId` step at line 3113 is what derives the owning base when only `sheetId` is supplied.

## Artifacts attached for triage

- `staging-trace.zip` — full Playwright trace from the failing pre-fix run
- `post-views-response.json` — proof backend persists `dependencyFieldId`
- `page-snapshot.md` — accessibility tree at the moment of `.meta-gantt__dependency-arrow` timeout
