# Multitable MF2 — Field Types Batch 1 — 2026-04-26

## Scope

First batch of the multitable对标飞书 field-type expansion (gap analysis
identified 14 missing types vs Feishu Bitable). This slice ships **6
types**:

| Type | Use case | Storage | Validation |
|------|----------|---------|-----------|
| **currency** | money values with currency code + display symbol | NUMBER | finite number; non-negative not enforced |
| **percent** | XX.X% display, stored as decimal | NUMBER | finite number |
| **rating** | 1-N star rating (configurable max, default 5) | NUMBER | 0 ≤ value ≤ max, integer (or 0.5-step if half-stars later) |
| **url** | clickable URL | TEXT | http/https only, regex `URL_REGEX = /^https?:\/\/[^\s]+$/i` |
| **email** | clickable mailto link | TEXT | local@domain.tld, lenient regex (Unicode local part allowed) |
| **phone** | clickable tel link | TEXT | lenient (digits + optional separators, 6-24 chars; first char `+`/digit/`(`) |

The remaining 8 missing types (auto-number / created-time / modified-time
/ multi-select advanced / barcode / location / etc.) are deferred to
Batch 2.

## Architectural decision: hardcoded, not registry

The gap analysis observed that `field-type-registry.ts` is dead code (zero
plugin callers). MF2 adds the 6 new types **directly to the canonical
type union** (`MetaFieldType` in `apps/web/src/multitable/types.ts`) and
to backend `field-codecs.ts`, **without routing through the registry**.
Reviving the registry as a plugin extensibility seam is a future refactor
target, not in this slice.

Justification:
- Hardcoded path is the existing pattern for the prior 11 field types.
- Adding to registry first means new types fan-in through TWO surfaces
  (registry + the existing hardcoded paths in `record-service.ts` etc.),
  which doubles the diff and leaves dead-code traps.
- A future "registry refactor" lane can move all field types through it
  uniformly once it has a real first plugin caller.

## Files touched (11 / +802 / -8)

### Backend

- `packages/core-backend/src/multitable/field-codecs.ts` (+177 LoC) —
  new exports: `URL_REGEX`, `EMAIL_REGEX`, `PHONE_REGEX`,
  `validateUrlValue`, `validateEmailValue`, `validatePhoneValue`,
  `validateCurrencyOptions`, `validatePercentOptions`,
  `validateRatingOptions`, `coerceCurrencyValue`, `coercePercentValue`,
  `coerceRatingValue`, `coerceBatch1Value` (dispatcher).
- `packages/core-backend/src/multitable/record-service.ts` (+30 / -X) —
  routes the 6 new types through `coerceBatch1Value` in the create / patch
  validation path.
- `packages/core-backend/src/multitable/record-write-service.ts` (+35 / -X)
  — same routing for the write-service entry point.
- `packages/core-backend/src/routes/univer-meta.ts` (+33 / -X) — accepts
  new type metadata in field-create / field-update payloads (validates
  options shape per type).

### Frontend

- `apps/web/src/multitable/types.ts` (+6) — adds `'currency' | 'percent'
  | 'rating' | 'url' | 'email' | 'phone'` to `MetaFieldType`.
- `apps/web/src/multitable/utils/field-config.ts` (+102) — per-type config
  defaults + options validators (currency code, decimals, percent decimals,
  rating max).
- `apps/web/src/multitable/utils/field-display.ts` (+29) — formatting
  helpers (`Intl.NumberFormat` for currency / percent; star glyphs for
  rating; mailto / tel link generation).
- `apps/web/src/multitable/components/MetaFieldManager.vue` (+118) —
  field-type picker now lists the 6 new types with type-specific config
  panels (currency-code dropdown, percent-decimals input, rating-max input).
- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue` (+76) —
  renders new types: currency `¥1,234.56`, percent `25.0%`, rating
  `★★★☆☆`, url/email/phone as clickable links.
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue` (+116) —
  inline editors for new types (number-with-currency-prefix, percent
  numeric input, click-stars-to-rate, text input with validation feedback
  for url/email/phone).
- `apps/web/src/multitable/components/MetaFormView.vue` (+88) — form-view
  inputs for the 6 new types when used as form fields.

### Tests

- `packages/core-backend/tests/unit/multitable-field-types-batch1.test.ts`
  (new, 51 cases) — covers all coercion + validation paths plus regex
  pattern shape.

## Storage choice

All 6 types reuse the existing `multitable_record_values` JSON value
column (no schema change). Currency / percent / rating store as numbers;
url / email / phone store as strings. This means:

- **No migration required for this slice.**
- Existing query / filter / sort paths work unchanged (number sort works
  for currency/percent/rating; text sort for url/email/phone).
- Currency / rating's `options` (currency code, max stars) live in the
  field's existing `property` JSONB column — no schema change.

## Out of scope

- Advanced rating UI (drag-to-rate, half-star) — deferred to UX polish
  pass.
- Currency conversion (multi-currency aggregations) — out of scope; the
  field stores a single code per row.
- Phone number international formatting normalization (e.g., E.164) —
  current regex is intentionally lenient.
- The remaining 8 missing field types — Batch 2.
- Migrating existing field types to the (currently dead) registry — a
  separate refactor lane.

## Rollback

Revert the single commit. None of the 6 types are persisted with an
incompatible schema (all reuse JSON value column), so existing data is
preserved. Field metadata (`property` JSONB) for any rows that already
used the new types would lose its UI editor but values stay readable.

## Follow-ups

1. Batch 2: auto-number / created-time / modified-time / multi-select-
   advanced (P1 in gap analysis, ~5 人天).
2. Phone E.164 normalization helper (deferred; lenient regex acceptable
   for v1).
3. Registry-based field-type extensibility (separate refactor).
