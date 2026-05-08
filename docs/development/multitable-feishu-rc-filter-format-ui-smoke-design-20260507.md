# Multitable Feishu RC Filter And Formatting UI Smoke Design - 2026-05-07

## Scope

This slice closes two remaining executable Feishu RC staging-smoke gaps:

- `Smoke test conditional formatting persistence and reload.`
- `Smoke test filter builder typed controls and saved view behavior.`

The change is runner-only. It does not change production frontend or backend behavior.

## Design

The existing `scripts/verify-multitable-live-smoke.mjs` already provisions a pilot sheet, imports records, patches field values, runs UI/API hydration checks, and performs best-effort cleanup. This slice extends that runner after grid hydration, where two records and typed fields are already stable.

### Filter Builder Replay

`verifyFilterBuilderTypedControlsReplay()` drives the actual toolbar filter builder:

1. Open the grid toolbar `Filter` panel.
2. Add three filter rules through UI controls:
   - `Status is Todo` using a select value control.
   - `Start is 2026-03-10` using a date input.
   - `Score > 90` using a number input.
3. Apply the staged filter and wait for the view PATCH.
4. Assert only the imported row is visible and the retry row is hidden.
5. Fetch the saved view and assert `filterInfo.conditions` contains the three typed conditions.
6. Reload the page and assert the row result and filter controls replay from the saved view.
7. Restore the original `filterInfo` through the API.

The helper dispatches `change` after Playwright fills input-backed filter controls because the Vue toolbar listens on `@change`, not `@input`.

### Conditional Formatting Reload

`verifyConditionalFormattingReloadReplay()` drives the actual view-manager conditional-formatting dialog:

1. Open `Views` and the `Conditional formatting` action for `Pilot Grid`.
2. Add a rule against a temporary number field:
   - `Score > 90`
   - background `#d6ebff`
   - apply to whole row
3. Save and wait for the view PATCH.
4. Fetch the saved view and assert `config.conditionalFormattingRules` has the expected sanitized rule.
5. Reload the grid, search the target row, and assert the computed row background is `rgb(214, 235, 255)`.
6. Reopen the dialog and assert the field, operator, value, and `Apply to whole row` state hydrate correctly.
7. Restore the original view `config` through the API.

The runner writes the hex color input directly instead of clicking a palette swatch. On live Chromium the swatch click can be intercepted during dialog/overlay reflow; direct hex input exercises the same persisted rule value with less selector flake.

### Temporary Score Field

The runner creates a temporary `number` field named `Score <run>` and patches:

- imported row: `95`
- retry row: `10`

The field is added to the existing cleanup set so it is deleted after the smoke run.

### Link Picker Live Fallback

142 staging exposed a live-only flake in the existing people repair path: generated person display IDs can appear in the initial option list while exact search briefly returns the empty state. `selectLinkPickerOption()` now:

1. tries the requested display text first;
2. falls back to clearing search and choosing the first real option;
3. returns the actual selected display text so downstream assertions follow reality.

This keeps the existing people/manual-repair checks focused on choosing a real linked record instead of failing on staging-specific search/display drift.

## Non-Goals

- No product runtime behavior changes.
- No production schema or API contract changes.
- No expansion to the remaining formula editor, Gantt, hierarchy, public form, or automation smoke TODO items.
- No manual browser checklist replacement beyond these two automated checks.
