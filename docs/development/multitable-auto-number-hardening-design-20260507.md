# Multitable Auto Number Hardening Design - 2026-05-07

## Context

`autoNumber` already existed on `main` from PR #1321:

- `meta_field_auto_number_sequences` persists per-field counters.
- `RecordService.createRecord()` and the public form direct create path allocate values.
- `autoNumber` is a readonly system field and user-supplied values are rejected on the standard create path.

This follow-up closes the remaining Feishu parity gaps without replacing the existing table or migration.

## Scope

Implemented:

- Property normalization now supports `prefix`, `digits`, `start`, and the existing `startAt` alias.
- New and converted `autoNumber` fields backfill existing records in `(created_at, id)` order.
- Sheet-level advisory locking serializes field backfill against standard record creation.
- Field-level advisory locking serializes sequence allocation per field.
- The older `multitable.records.createRecord()` helper now rejects user-supplied `autoNumber` values and allocates generated values.
- Frontend Field Manager exposes `prefix`, `digits`, and `start` controls.
- Shared display formatting renders `prefix + zeroPad(value, digits)`.

Not changed:

- The existing `meta_field_auto_number_sequences` schema remains unchanged.
- `startAt` stays supported and is still persisted for compatibility.
- Existing sequence values are not reset when only the display property is edited.
- Deleted numbers are not reused.

## Backend Design

### Property Contract

The backend stores a normalized property shape:

```json
{
  "prefix": "INV-",
  "digits": 4,
  "start": 100,
  "startAt": 100,
  "readOnly": true
}
```

Validation rules:

- `prefix`: trimmed string, max 32 characters.
- `digits`: integer `0..12`.
- `start/startAt`: integer `>= 1`.
- `readOnly` is always forced to `true`.

### Allocation

`allocateAutoNumberRange()` uses the existing row as the counter:

```sql
INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value)
VALUES ($1, $2, $3)
ON CONFLICT (field_id)
DO UPDATE SET next_value = meta_field_auto_number_sequences.next_value + $4,
              updated_at = now()
RETURNING next_value - $4 AS start_value
```

The returned range is contiguous for that field. The single-value API delegates to the range API with `count = 1`.

### Backfill

`backfillAutoNumberField()`:

1. Acquires a sheet-level transaction advisory lock.
2. Acquires a field-level transaction advisory lock.
3. Selects target records ordered by `created_at ASC, id ASC`.
4. Writes generated integers into `meta_records.data[fieldId]` with `jsonb_set`.
5. Initializes or advances `next_value` to the first value after the backfilled range.

New field creation backfills records missing the field key. Type conversion into `autoNumber` uses `overwrite: true` so stale values from the previous type do not survive as generated IDs.

### Concurrency

The standard `RecordService.createRecord()` path now acquires the same sheet-level lock before reading fields. This prevents a create request from reading the pre-backfill schema while an `autoNumber` field is being created.

The plugin helper path also acquires the sheet-level lock before loading fields. Callers should pass a transaction-bound query when they need the lock held across the whole write.

## Frontend Design

Field Manager treats `autoNumber` as configurable:

- Prefix input.
- Digits input.
- Start-at input.
- Readonly system hint remains visible.

Display formatting is centralized in `formatFieldDisplay()`, so grid, renderer, and readonly surfaces that use the shared formatter inherit the same `INV-0042` rendering.

## Residual Limits

- Public form direct create now locks inside its write transaction, but it still loads and validates fields before that transaction. The sequence allocation itself remains atomic; the full schema-read race is best removed when public-form create is routed through `RecordService.createRecord()`.
- XLSX import currently creates records one by one through `RecordService`; values are correct and serialized, but it does not yet reserve a single batch range for the whole import.
