# Multitable MF3 conditional formatting development

Date: 2026-04-26
Branch: `codex/multitable-feishu-mf3-condfmt-20260426`
Base: `origin/main@25202478c`

## Scope

MF3 adds Feishu-Bitable-style conditional formatting to multitable views.
Per-view rules color cells (or whole rows) based on the value of a target
field. The work is delivered as a single integration lane that touches:

- `MetaGridTable.vue` (cell + row style binding only — no behavior change
  outside of conditional styling).
- `MetaViewManager.vue` (per-view "open formatting rules" affordance that
  opens a new dialog).
- `ConditionalFormattingDialog.vue` (new — rule editor).
- `MultitableWorkbench.vue` (host that derives the formatting map and
  passes it as a prop to `MetaGridTable`).
- `packages/core-backend/src/multitable/conditional-formatting-service.ts`
  (new — canonical pure evaluator + sanitizer).
- `packages/core-backend/src/routes/univer-meta.ts` (POST/PATCH `/views`
  validate + sanitize the optional `config.conditionalFormattingRules`
  array).

## Storage choice

`meta_views.config jsonb` is already an arbitrary blob. Conditional
formatting rules are nested under
`view.config.conditionalFormattingRules`. **No migration is required**;
the existing PATCH `/api/multitable/views/:viewId` endpoint accepts an
arbitrary `config: z.record(z.unknown())` object and persists it
verbatim. This matches how `gallery` / `kanban` / `calendar` /
`timeline` per-view configs already flow.

The backend write path additionally validates and sanitizes the rules:

- Rules with unknown operators, missing `id` / `fieldId`, or invalid
  operator-specific value shapes are dropped.
- Hex colors are validated against `/^#([0-9a-fA-F]{3,8})$/`; invalid
  colors are silently dropped (the rule is preserved without the
  invalid color).
- The total rule count is capped at `CONDITIONAL_FORMATTING_RULE_LIMIT`
  (20). PATCH bodies that exceed the limit return
  `400 VALIDATION_ERROR`. The sanitizer also enforces the cap as a
  defensive bound after parsing.

## Rule schema

Type lives in `packages/core-backend/src/multitable/conditional-formatting-service.ts`
(canonical) and is mirrored in `apps/web/src/multitable/types.ts`
(`ConditionalFormattingRule`). Both shapes must be kept in lock-step
when extending the operator set.

```ts
interface ConditionalFormattingRule {
  id: string                         // stable client-generated id
  order: number                      // first-match-wins; ascending
  fieldId: string                    // target field id
  operator: ConditionalFormattingOperator
  value?: unknown                    // operator-dependent (see below)
  style: { backgroundColor?: string; textColor?: string; applyToRow?: boolean }
  enabled: boolean                   // disabled rules never match
}
```

### Operators

| Operator | Value shape | Field types | Semantics |
|----------|-------------|-------------|-----------|
| `gt` / `gte` / `lt` / `lte` | scalar number | number, formula | numeric compare; string-numbers coerced |
| `between` | `[number, number]` | number, formula | inclusive of both bounds; tolerates reversed order |
| `eq` / `neq` | scalar | any | text fields compared as strings; select fields match against any selected option |
| `contains` / `not_contains` | string | string, select | case-insensitive substring search; works on array values |
| `is_empty` / `is_not_empty` | — | any | empty = `null` / `undefined` / `''` / `[]` / `{}` |
| `is_today` | — | date | local-tz same-day match against `now` |
| `is_in_last_n_days` / `is_in_next_n_days` | positive integer | date | inclusive of today; window of N days |
| `is_overdue` | — | date | strictly before today (local-tz) |
| `is_true` / `is_false` | — | boolean | accepts `true`/`'true'`/`1` and `false`/`'false'`/`0` |

`Date` semantics are anchored on the **local timezone** start-of-day
boundary so the result matches what the end user sees in their
browser. Tests pass an explicit `options.now` to keep determinism
across CI hosts.

## Evaluation strategy

### Backend canonical evaluator

`evaluateConditionalFormattingRules(rules, record, fieldsById, options?)`
returns `{ rowStyle?, cellStyles, matchedRuleIds }`. It is pure (no DB
or network), deterministic, and exported for reuse. The function is
exercised by 39 unit tests covering every operator and the
first-match-wins semantics.

### Frontend mirror

`apps/web/src/multitable/utils/conditional-formatting.ts` reproduces
the same shape (browser cannot import server modules across workspaces).
The mirror is exercised by 25 unit tests in
`apps/web/tests/multitable-conditional-formatting.spec.ts` and stays
in lock-step with the backend canonical evaluator by sharing the same
operator semantics — when extending the rule schema, update both
files together.

### First-match-wins precedence

Rules are sorted by `order` ascending (stable on ties). The evaluator
walks the list once per record:

1. The **first matching cell-level rule** (`applyToRow !== true`) for
   each field id wins; later cell-level matches on the same field are
   ignored.
2. The **first matching row-level rule** (`applyToRow === true`) wins
   the row-level style; later row-level matches are ignored.
3. Cell and row styles compose independently. At render time, the
   cell style takes precedence over the row style on the same CSS
   property (`backgroundColor`, `color`).

`matchedRuleIds` records all matched rule ids in original `order` for
diagnostics; the actual style emission honors the precedence above.

### Performance — pre-compute once per render

`buildRecordFormattingMap(rules, records, fields)` produces a
`Map<recordId, EvaluatedFormatting>` once per render. It is wrapped in
a `computed()` in `MultitableWorkbench.vue` keyed on
`activeView.config`, `grid.rows`, and `scopedAllFields`, so:

- Vue auto-memoizes; rules are not re-evaluated on scroll, hover, or
  focus changes.
- Re-evaluation only happens when the rule list, the visible rows, or
  the field metadata change.
- `MetaGridTable.vue` reads pre-computed style objects from the map
  inside `cellStyle(rid, fid)` and `rowStyle(rid)` — both are O(1)
  Map lookups during render, no rule iteration in the hot path.

Records with no matching rules are not stored in the Map at all, so
the renderer immediately short-circuits to the existing column-width
style for those rows (no allocation, no overhead).

## UI flow

1. User opens **Manage Views** drawer (`MetaViewManager.vue`).
2. Each view row exposes a "Conditional formatting" affordance (paint
   palette icon) alongside the existing Configure / Rename / Delete
   actions.
3. Clicking opens `ConditionalFormattingDialog.vue` with the rules
   currently saved in `view.config.conditionalFormattingRules`.
4. The dialog lists existing rules with up/down reorder buttons,
   per-rule enable toggle, "Apply to whole row" checkbox, and 8-color
   palette plus a hex input.
5. The "+ Add rule" button is disabled at the configured limit (20).
6. The operator dropdown is filtered by the target field's type
   (number → comparison operators; date → today/overdue/last N days;
   boolean → checked/unchecked; etc.).
7. Save dispatches `update-view` with the merged config containing
   the sanitized rule list. The host (`MultitableWorkbench`) routes
   this through the existing `client.updateView()` and triggers a
   sheet meta refresh; the next render produces an updated
   `conditionalFormattingByRecord` map.

Admin gating uses the existing `MetaCapabilities.canManageViews`
capability — the affordance lives inside the existing
`MetaViewManager` (which is already gated on the same capability via
the dirty-flag plumbing) and the backend PATCH `/views/:viewId` route
returns 403 if the caller lacks `canManageViews`. No new permission
codes were introduced.

## Files

- `packages/core-backend/src/multitable/conditional-formatting-service.ts`
  (new, ~330 LoC)
- `packages/core-backend/src/routes/univer-meta.ts` (edited; +35 / −2:
  imports + cap/sanitize hook in POST + PATCH `/views`).
- `packages/core-backend/tests/unit/multitable-conditional-formatting.test.ts`
  (new, 39 tests).
- `apps/web/src/multitable/types.ts` (edited; +47 / −0: rule shape
  types + operator union + limit constant).
- `apps/web/src/multitable/utils/conditional-formatting.ts` (new,
  ~310 LoC).
- `apps/web/src/multitable/components/ConditionalFormattingDialog.vue`
  (new, ~340 LoC).
- `apps/web/src/multitable/components/MetaViewManager.vue` (edited;
  +35 / −1: open dialog button + handlers + import; preserves
  `conditionalFormattingRules` when saving existing gallery / kanban
  / calendar / timeline view settings).
- `apps/web/src/multitable/components/MetaGridTable.vue` (edited;
  +25 / −2: prop addition + `cellStyle(rid, fid)` signature change +
  `rowStyle(rid)` helper + style merge).
- `apps/web/src/multitable/views/MultitableWorkbench.vue` (edited;
  +10 / −0: `conditionalFormattingByRecord` computed + prop wiring +
  imports).
- `apps/web/tests/multitable-conditional-formatting.spec.ts` (new,
  25 tests).
- `docs/development/multitable-mf3-conditional-formatting-development-20260426.md`
  (this file).
- `docs/development/multitable-mf3-conditional-formatting-verification-20260426.md`
  (verification report).

## Non-goals

- No DB migration. `meta_views.config` is already JSONB and the
  existing PATCH `/views/:viewId` validator accepts arbitrary
  `config: z.record(z.unknown())`. Adding a dedicated
  `/views/:viewId/conditional-formatting` route would be redundant.
- No new permission code; reuse `canManageViews`.
- No drag-and-drop reordering; up/down buttons cover the MVP. Advanced
  DnD is a follow-up if usage warrants.
- No formula-style operators (e.g. `IF(x>10 AND y<5)` style). Each
  rule targets a single field; combinatorial logic stays out of MF3.
- No real-time sync of rule edits across users. The dialog persists
  via the same `update-view` round-trip as other view config edits;
  Yjs awareness for rule editing is a future enhancement.

## Frontend / backend evaluator parity

The two evaluators **must stay in sync**. When extending the rule
schema:

1. Add the new operator to `KNOWN_OPERATORS` in both files.
2. Add the operator's value-shape validation to both `sanitizeRule`
   functions.
3. Add the operator's evaluation branch to both `evaluateRule`
   functions.
4. Extend the mirror tests in `tests/unit/multitable-conditional-formatting.test.ts`
   and `tests/multitable-conditional-formatting.spec.ts`.
5. Update the operator table in this dev doc.

Backend remains canonical because backend tests run in CI on the
shipped contract, while the frontend evaluator runs in the browser
on the same contract; divergence between the two would surface as a
visible mismatch between client-side preview and server-side
sanitization.
