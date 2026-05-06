# Multitable DateTime Field Design — 2026-05-06

## Scope

This slice adds a dedicated `dateTime` field type to the multitable runtime as the next Feishu parity field.

Included:

- Backend field type recognition for `dateTime` and legacy aliases `datetime`, `date_time`, `date-time`, `timestamp`.
- Backend property sanitization for an optional IANA `timezone`, with `UTC` fallback.
- Backend write coercion that persists DateTime values as canonical ISO strings.
- Frontend field creation, grid rendering, cell editing, form editing, drawer editing, filter operators, and date-like view selectors.
- OpenAPI enum parity and generated OpenAPI dist refresh.

Out of scope:

- A separate `date` migration or changing existing `date` semantics.
- Timezone conversion libraries, DST policy UI, recurring schedules, durations, or range fields.
- Calendar/Gantt semantic changes beyond allowing `dateTime` fields as date-like source fields.

## Runtime Contract

`dateTime` is stored in `meta_records.data` as an ISO timestamp string. Empty values normalize to `null`.

Accepted write input:

- ISO strings or parseable timestamp strings.
- Numeric timestamps accepted by `new Date(value)`.
- `Date` objects for service-level callers.

Rejected write input:

- Invalid timestamp strings.
- Object/array shapes.

The canonical persisted shape is `Date#toISOString()`. This makes REST, RecordWriteService, imports, and future frontend clients converge on one transport format.

## Backend Changes

- `field-codecs.ts`
  - Adds `dateTime` to `MultitableFieldType`.
  - Maps aliases to `dateTime` without collapsing them to `date`.
  - Adds `validateDateTimeValue()`.
  - Adds `dateTime` to `BATCH1_FIELD_TYPES`.
  - Sanitizes `property.timezone` with `Intl.DateTimeFormat`, falling back to `UTC`.
- `record-service.ts` and `univer-meta.ts`
  - Align route-local and service-local field mapping.
- `record-write-service.ts`, `contracts.ts`, `field-validation-engine.ts`
  - Extend accepted field unions and default validation behavior.

## Frontend Changes

- `MetaFieldManager` and `MetaFieldHeader`
  - Adds `dateTime` type and clock icon.
- `field-display.ts`
  - Adds timezone resolution helper.
  - Adds `datetime-local` input serialization helpers.
  - Displays `dateTime` with field timezone.
- `MetaCellRenderer`, `MetaCellEditor`, `MetaFormView`, `MetaRecordDrawer`
  - Adds DateTime display and editing paths.
- `MetaViewManager`, `MetaGanttView`, `MetaCalendarView`, `MetaTimelineView`
  - Treats `dateTime` as date-like where views need date source fields.
- `useMultitableGrid.ts`
  - Adds DateTime filter operators matching date operators.

## OpenAPI

`MultitableFieldType` now includes `dateTime` after `date`. Generated OpenAPI dist files were refreshed and `scripts/ops/multitable-openapi-parity.test.mjs` was updated to lock the enum.

## Trade-Offs

- Timezone is display metadata, not a storage transform. Storage remains canonical UTC ISO.
- Frontend `datetime-local` inputs use the browser local timezone for user entry and emit ISO strings. Field timezone controls display formatting, not browser input picker timezone.
- `dateTime` is intentionally separate from `date`; legacy `datetime` aliases now map to `dateTime` to avoid losing time precision.
