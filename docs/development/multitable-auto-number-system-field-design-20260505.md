# Multitable Auto Number System Field Design - 2026-05-05

## Context

`docs/development/multitable-feishu-rc-todo-20260430.md` still had one unchecked Phase 4 system-field item:

- `autoNumber` was blocked because a row-index placeholder would not be stable.

This slice removes that blocker by adding a persistent per-field sequence. It does not implement display formatting such as prefix, padding, or reset policies.

## Design

`autoNumber` is treated as a readonly system field:

- Field type is accepted by backend route normalization, OpenAPI, and frontend field manager types.
- Client-supplied values are rejected on create/patch through the same readonly field guards used by formula/system fields.
- Values are generated only during record creation.

Persistent allocation uses a new table:

- `meta_field_auto_number_sequences(field_id primary key, sheet_id, next_value, created_at, updated_at)`
- `field_id` and `sheet_id` cascade with `meta_fields`/`meta_sheets`.
- Allocation is transactional:
  - first create for a field inserts `next_value = startAt + 1`
  - later creates atomically increment `next_value`
  - returned value is `next_value - 1`

Creation paths covered:

- `RecordService.createRecord()` allocates auto numbers inside the same transaction before inserting `meta_records`.
- Public form direct create path in `univer-meta.ts` also allocates inside its transaction before insert.

Field lifecycle behavior:

- Deleting an `autoNumber` field deletes its sequence explicitly; the FK also cascades.
- Changing an `autoNumber` field to another type deletes the old sequence row.

## Deferred

- Formatting (`prefix`, `suffix`, min digits) is intentionally deferred.
- Reset policies are intentionally deferred.
- Existing rows are not backfilled when adding an `autoNumber` field to a sheet with records.
