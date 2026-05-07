# HTTP Adapter Query Reserved Guard - Development - 2026-05-07

## Context

`normalizeReadRequest()` caps `limit` and normalizes `cursor` before a generic
HTTP adapter read. The read query then merges adapter object query, filters,
watermark, and `request.options.query`.

Previously `request.options.query` was merged after the normalized pagination
fields, so a caller could pass `options.query.limit = 999999` and override the
`MAX_READ_LIMIT` cap.

## Change

- Added `readOptionsQuery()` in
  `plugins/plugin-integration-core/lib/adapters/http-adapter.cjs`.
- `options.query` is validated as an object.
- Reserved pagination keys `limit` and `cursor` are stripped from
  `options.query`.
- Normalized `limit` and `cursor` are written last in the final query.
- Non-reserved vendor query options still pass through.

## Behavioral Contract

Operators can use `options.query` for vendor-specific filters, but pagination
control stays with the adapter contract. `limit` remains capped and `cursor`
remains the normalized top-level cursor.
