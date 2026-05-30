# Multitable Record History Field Mask Design (F1)

Status: design-lock draft

Grounding: read against `origin/main` @ `0e35ae94e` on 2026-05-30, after F0a (#2114), F0b (#2141), and the field-read-gate arc.

## 0. Decision

Fix F1 as a small egress-mask slice for:

```text
GET /api/multitable/sheets/:sheetId/records/:recordId/history
```

The route already has sheet read and record read gates, but it returns `meta_record_revisions.patch`, `snapshot`, and `changedFieldIds` exactly as stored. Those revision payloads can contain field values the requester is not allowed to read.

Implementation rule:

- Keep the persisted revision rows unchanged.
- Before response, compute the same layer-2 and layer-3 allowed-field set used by the current interactive read paths: `property.hidden` plus `field_permissions.visible=false`, with `hiddenFieldIds: []` so layer-1 view-hidden remains display-only and is not a server-side data gate.
- For each returned revision item:
  - `patch` = only keys in `allowedFieldIds`.
  - `snapshot` = `null` stays `null`; otherwise only keys in `allowedFieldIds`.
  - `changedFieldIds` = only field ids in `allowedFieldIds`.
- Leave metadata (`id`, `sheetId`, `recordId`, `version`, `action`, `source`, `actorId`, `createdAt`) unchanged.

This is value-only redaction, consistent with the already-shipped read-path slices. It does not attempt full field-definition stripping.

## 1. Evidence

The route currently validates params, checks record existence, then resolves sheet/record read permission before listing revisions:

- `packages/core-backend/src/routes/univer-meta.ts:4273-4304`
- `packages/core-backend/src/routes/univer-meta.ts:4283-4300` covers `canRead` and record-scope filtering.

The actual egress is unmasked:

- `packages/core-backend/src/routes/univer-meta.ts:4304-4305` returns `items` from `listRecordRevisions(...)` directly.
- `packages/core-backend/src/multitable/record-history-service.ts:77-96` selects `changed_field_ids`, `patch`, and `snapshot`.
- `packages/core-backend/src/multitable/record-history-service.ts:99-111` serializes them verbatim into `changedFieldIds`, `patch`, and `snapshot`.

The already-shipped allowed-field primitive exists in the same route module:

- `packages/core-backend/src/routes/univer-meta.ts:2240-2248` filters record data by allowed field ids.
- `packages/core-backend/src/routes/univer-meta.ts:2251-2268` computes and loads the layer-2 and layer-3 allowed-field set with `hiddenFieldIds: []`.

OpenAPI already describes `patch`, `snapshot`, and `changedFieldIds` generically, so the wire schema does not need a contract change:

- `packages/openapi/src/base.yml:2115-2158`
- `packages/openapi/src/paths/multitable.yml:386-429`

## 2. Non-Goals

- Do not redact persisted history rows at write time. History is an audit artifact; the response is user-specific.
- Do not add a new permission model for history.
- Do not change the route's existing record-existence semantics. The current `requireRecordReadable` primitive has the same 404-before-auth shape, so F1 should not turn into an oracle-model redesign.
- Do not materialize lookup/rollup values or reinterpret historical snapshots.
- Do not add frontend UI affordances in this slice. Existing clients can render fewer keys; if product wants a "hidden by permissions" chip for history diffs, that is a later UX slice.

## 3. Implementation Shape

Preferred minimal route change:

1. Keep the existing authorization sequence or replace it with `requireRecordReadable(...)` if that reduces duplicate code without changing behavior.
2. After authorization succeeds, call:

```ts
const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)
```

3. Map `items` before returning:

```ts
const redactedItems = items.map((item) => ({
  ...item,
  changedFieldIds: item.changedFieldIds.filter((fieldId) => allowedFieldIds.has(fieldId)),
  patch: filterRecordDataByFieldIds(item.patch, allowedFieldIds),
  snapshot: item.snapshot === null ? null : filterRecordDataByFieldIds(item.snapshot, allowedFieldIds),
}))
```

If a helper is introduced, keep it pure and local to this seam; do not create a new parallel permission primitive.

## 4. Tests

Add a real-DB integration test and wire it into the Node 20 multitable real-DB CI step.

Seed requirements:

- `FLD_SECRET.property = {}` so the deny is solely layer-3 (`field_permissions.visible=false`), not a static-hidden false green.
- Add a separate `FLD_STATIC_HIDDEN` with `property.hidden=true` and no field-permission row to prove layer-2 also redacts history.
- Insert `meta_record_revisions` directly or generate one through the existing patch path, but the assertion must prove history egress, not only patch response egress.
- Include a visible positive-control field in `patch`, `snapshot`, and `changed_field_ids`, so an empty history item cannot false-green.

Required matrix:

- `R1` fail-first: denied layer-3 field value is absent from `patch`, `snapshot`, and the JSON body; visible field remains.
- `R2` fail-first: `changedFieldIds` drops the denied layer-3 field id while preserving the visible field id.
- `R3` fail-first: static-hidden field value is absent from `patch`, `snapshot`, and JSON body; no layer-3 row required.
- `R4` positive control: a different readable subject with no deny row sees the secret field in history.
- `R5` existing authz guard: non-reader still gets `403`.
- `R6` existing record gate: missing record still gets `404`.
- `R7` null snapshot guard: a revision with `snapshot=null` stays `null`, not `{}`.

CI wiring:

- Add `tests/integration/multitable-record-history-field-mask.test.ts` to the existing Node 20 real-DB multitable step in `.github/workflows/plugin-tests.yml`.

## 5. Review Checklist

- The response body contains no denied canary string anywhere, not just under `patch`.
- The visible positive-control field still appears, proving the item was not dropped.
- `changedFieldIds` and object keys stay aligned after redaction.
- Admin/readable subject behavior stays positive.
- The implementation does not mutate stored revision rows.
- No RBAC/auth central files are touched; this remains endpoint-scoped kernel polish under the K3 lock.

## 6. Follow-Ups

F1 only covers record history. Still separate opt-ins from the inventory:

- F2 `records-summary`.
- F3 PATCH /records and POST /patch echoes.
- F4 create echo and F5 link-options/person-fields.
- D1 public form context/submit product decision.
