# Multitable Record History Development - 2026-04-30

## Scope

Phase 5 implements the first production record version history slice for multitable records.

Included:

- Persist record revisions in `meta_record_revisions`.
- Record revisions from authoritative record writes:
  - `RecordService.createRecord()`
  - `RecordService.patchRecord()`
  - `RecordService.deleteRecord()`
  - `RecordWriteService.patchRecords()` for batch/Yjs writes.
- Capture actor, source, version, changed field ids, patch, snapshot, and timestamp.
- Expose `GET /api/multitable/sheets/:sheetId/records/:recordId/history`.
- Add a History tab to the record drawer.
- Update OpenAPI source and generated dist for the new history API.
- Add focused backend and frontend coverage.

Not included:

- Diff UI or rollback UI.
- Revision cleanup/retention jobs.
- Deleted-record history browsing after the live record row is gone.
- Public-form, automation, and plugin legacy direct-write paths. Those are documented follow-ups unless they are routed through `RecordService` or `RecordWriteService`.

## Backend Design

### Persistence

Migration:

- `packages/core-backend/src/db/migrations/zzzz20260430172000_create_meta_record_revisions.ts`

Table:

- `meta_record_revisions.id`: UUID primary key.
- `sheet_id`, `record_id`: text identifiers, intentionally not cascading from `meta_records` so delete history can be retained.
- `version`: server version after create/update, or the deleted version for delete.
- `action`: `create`, `update`, or `delete`.
- `source`: defaults to `rest`; Yjs bridge writes preserve `yjs-bridge`.
- `actor_id`: nullable user/system actor.
- `changed_field_ids`: changed field ids in write order.
- `patch`: the submitted authoritative patch.
- `snapshot`: post-write snapshot for create/update, pre-delete snapshot for delete.
- `created_at`: server timestamp.

Retention default: no cleanup in v1.

### Write Path

New service:

- `packages/core-backend/src/multitable/record-history-service.ts`

`recordRecordRevision()` inserts revision rows inside the same DB transaction as the record mutation. If revision persistence fails, the record mutation fails too. This is intentional because history is part of the authoritative write contract for this slice.

`RecordWriteService.patchRecords()` uses `input.source ?? 'rest'`, so Yjs-originated writes keep their source attribution and REST writes remain the default.

### Read API

Route:

- `GET /api/multitable/sheets/:sheetId/records/:recordId/history?limit=&offset=`

Response shape:

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "...",
        "sheetId": "...",
        "recordId": "...",
        "version": 2,
        "action": "update",
        "source": "rest",
        "actorId": "user_1",
        "changedFieldIds": ["fld_title"],
        "patch": { "fld_title": "Updated" },
        "snapshot": { "fld_title": "Updated" },
        "createdAt": "2026-04-30T09:00:00.000Z"
      }
    ],
    "limit": 50,
    "offset": 0
  }
}
```

Permission model:

- Requires authenticated user.
- Requires sheet `canRead`.
- Reuses existing record-permission scope checks when record-level assignments are present.
- Returns an empty history list if the revision table is not migrated yet, matching the router's compatibility pattern for optional multitable tables.

## Frontend Design

Types:

- `MetaRecordRevision`
- `MetaRecordRevisionAction`

Client:

- `MultitableApiClient.listRecordHistory(sheetId, recordId, { limit, offset })`

OpenAPI:

- `MultitableRecordRevision` schema.
- `GET /api/multitable/sheets/{sheetId}/records/{recordId}/history` path.
- Generated `packages/openapi/dist/{combined.openapi.yml,openapi.json,openapi.yaml}` refreshed.

Record drawer:

- Adds `Details` and `History` tabs.
- Defaults to `Details`.
- Loads history lazily when the user opens `History`.
- Guards stale async responses with a monotonic request id.
- Shows loading, empty, error, and unavailable states.
- Displays action, version, timestamp, actor, source, and changed field labels.

## Follow-ups

- Add integration route tests for the history endpoint with real permission fixtures.
- Add history rows for public-form, automation, and plugin legacy direct writes, or route those writes through the shared services.
- Add deleted-record history browsing in a future audit surface.
- Add diff rendering and optional rollback after retention/product rules are settled.
