# Multitable realtime broadcast invalidation design

**Date:** 2026-06-01
**Slice:** post-crossSheetRelated new finding #2 - realtime `sheet:op` value broadcast.
**Status:** DESIGN-LOCK ONLY. Implementation is a separate explicit opt-in.
**Grounding:** `origin/main` @ `5377c1830` (after #2178).

---

## 0. Why this exists

The record read/write echo arc now gates persisted HTTP responses by the layer-2 and layer-3 field-read composite. The realtime channel is still outside that floor:

- `publishMultitableSheetRealtime` publishes the payload to `spreadsheet.cell.updated` unchanged after cache invalidation (`realtime-publish.ts:40-44`).
- `CollabService` forwards that payload to every socket in `sheet:${spreadsheetId}` as `sheet:op` (`CollabService.ts:25-33`).
- Publishers put raw values in `recordPatches[].patch`: `RecordWriteService.patchRecords` includes user changes and formula values (`record-write-service.ts:941-966`); direct create/update paths include raw `patch` (`record-service.ts:601-614`, `:1009-1021`); form update and attachment delete paths do the same (`univer-meta.ts:7248-7260`, `:8143-8155`).
- The frontend normalizes `recordPatches[].patch` and merges it into local row data (`useMultitableSheetRealtime.ts:75-87`, `:205-217`; `useMultitableGrid.ts:928-940`; `MultitableWorkbench.vue:906-915`, `:2757-2776`).

So a sheet subscriber can receive a field value even if that field would be masked by `GET /view`, `GET /records/:recordId`, history, write echoes, or cross-sheet related echoes.

There is also a subscription gate problem:

- The browser opens the sheet realtime socket with only a `userId` query, not an auth token (`useMultitableSheetRealtime.ts:249-253`; presence/comment realtime use the same pattern in `useMultitableSheetPresence.ts:92-96` and `useMultitableCommentRealtime.ts:111-115`).
- `CollabService` can verify a token if present (`CollabService.ts:44-67`), but `join-sheet` does not require or use that verified identity. It accepts any `sheetId`, trusts the query `userId` only for presence, and joins `sheet:${sheetId}` (`CollabService.ts:169-176`, `:189-199`).

Therefore the realtime fix must address both the **value channel** and the **room membership gate**. Removing values while still allowing arbitrary sockets into sheet rooms would leave record/field activity metadata exposed.

---

## 1. Locked decisions

### D0 - Authenticate and authorize `join-sheet`

`join-sheet` must be a trusted sheet-read gate:

1. Browser sheet realtime clients send the existing JWT in the Socket.IO `auth.token` field. `useAuth().getToken()` already exists (`useAuth.ts:171-173`, `:442-444`).
2. `CollabService` verifies the token and stores the trusted user id on the socket. Do not trust `handshake.query.userId` for authorization or presence identity.
3. On `join-sheet`, call a sheet-room auth checker equivalent to `resolveSheetCapabilitiesForUser(query, sheetId, trustedUserId)` and require `capabilities.canRead`.
4. If no token, invalid token, missing user id, missing sheet, or no sheet read capability: do **not** join the sheet room, do **not** add presence, and emit a small denial acknowledgement such as `join-denied` for diagnostics. Do not disconnect the socket; other rooms may have their own auth model.
5. Presence identity must come from the verified token-derived user id. The query `userId` may remain temporarily for non-auth telemetry only, but it must not decide room membership or presence.

Implementation shape: add a `setSheetRoomAuthChecker`-style injection to `CollabService`, similar in spirit to the Yjs adapter's auth checker (`index.ts:2019-2044`). This keeps central RBAC/auth untouched and avoids hard-wiring database imports into `CollabService`.

### D1 - Choose value-free invalidation over per-recipient masking

For this slice, `sheet:op` becomes an invalidation signal, not a value transport:

- Keep metadata needed to decide whether to refetch: `spreadsheetId`, `actorId`, `kind`, `recordId`, `recordIds`, and `fieldIds`.
- Remove value-bearing `recordPatches[].patch` from the broadcast payload. The safest implementation is to sanitize inside `publishMultitableSheetRealtime` before `eventBus.publish`, so every publisher is covered by one seam.
- Preserve cache invalidation at `realtime-publish.ts:40-44`.

Per-recipient masking is intentionally not chosen for this slice. It would require subscriber identity tracking, per-socket field permission resolution, per-recipient fan-out, cache discipline, and cross-sheet handling for any future related payload. It is the right future optimization only if value-level realtime latency becomes a product requirement. It is not necessary for the current safety floor.

### D2 - Refetch through already-gated HTTP paths

Clients should use existing fallback behavior:

- If a realtime event has no `recordPatches` entry for a local target, `useMultitableSheetRealtime` already marks the record unresolved and calls `mergeRemoteRecord(recordId)` (`useMultitableSheetRealtime.ts:205-230`).
- `MultitableWorkbench.mergeRemoteRecordContext` refetches via `client.getRecord(recordId, { sheetId, viewId })` (`MultitableWorkbench.vue:2723-2751`), which now goes through the gated `GET /records/:recordId` path.
- If no per-record merge handler is available, the composable falls back to `reloadCurrentSheetPage` (`useMultitableSheetRealtime.ts:223-235`).
- `record-created` already reloads the page rather than applying patch values (`useMultitableSheetRealtime.ts:183-185`).

Implementation must make the no-value path explicit in tests. Do not keep a hidden fast path that still applies `patch` values for "simple" fields.

### D3 - Treat `fieldIds` as non-value metadata, but only after D0

`fieldIds` can remain in the invalidation payload because this project currently chose value-only field masking: field definitions and field ids are not stripped. That assumption is only acceptable when sheet-room membership is gated by `canRead`. Without D0, `fieldIds` would still leak sheet activity to arbitrary sockets.

If the deferred full field-definition strip is later implemented, this decision must be revisited.

### D4 - Keep non-realtime channels out of this slice

This slice only covers Socket.IO `sheet:op` produced by `publishMultitableSheetRealtime`.

Non-goals:

- `multitable.record.updated` EventBus emissions for automation/webhooks (`record-write-service.ts:971-980`, `record-service.ts:1023-1028`).
- Yjs document seeding/sync content. Yjs has its own token and record-level checker (`index.ts:2009-2044`) and is a separate collab surface.
- Comment-specific rooms (`join-comment-record`, `join-comment-sheet`, inbox rooms). They use some of the same Socket.IO service but carry comment payloads, not record cell patches.
- F4 create HTTP echo and F5 link-options/person-fields HTTP read paths.

---

## 2. Required implementation shape

### Backend

- Add a trusted sheet-room authorization seam to `CollabService`:
  - verify Socket.IO `auth.token`,
  - store trusted user identity on `socket.data`,
  - on `join-sheet`, require sheet `canRead` before `socket.join(this.buildSheetRoom(sheetId))`.
- Sanitize realtime payloads at the shared helper seam:
  - either drop `recordPatches` entirely, or keep only non-value metadata if a future type needs it;
  - no `patch` object may reach `eventBus.publish('spreadsheet.cell.updated', ...)`.
- Preserve `actorId` self-skip behavior on the client (`useMultitableSheetRealtime.ts:255-259`), using the server-provided actor id from the write path.

### Frontend

- Update all sheet-room clients that call `join-sheet` to pass `auth: { token }`:
  - `useMultitableSheetRealtime`,
  - `useMultitableSheetPresence`,
  - `useMultitableCommentRealtime`.
- Update realtime tests to assert token auth is sent.
- Update sheet realtime behavior tests so no-value `record-updated` events drive `mergeRemoteRecord` / page refetch instead of `applyRemoteRecordPatch`.

---

## 3. Verification matrix

All security tests for room membership must exercise a real Socket.IO server. Mocked frontend tests are still required for the fallback behavior, but they are not enough for D0.

### Required fail-first tests

- **R1 unauthorized sheet room cannot receive values or signals:** connect a socket with no token or an invalid token, emit `join-sheet` for a real sheet, then trigger a write. On current `origin/main`, the socket joins and receives `sheet:op`. After the fix, it receives no `sheet:op` and does not appear in `sheet:presence`.
- **R2 non-reader cannot join a known sheet:** use a valid token for a subject without sheet `canRead`. It must not join `sheet:${sheetId}` and must not receive `sheet:op`. This pins sheet authorization, not only authentication.
- **R3 reader can join and gets value-free invalidation:** use a valid sheet-reader token, trigger an update containing a denied-field canary. The socket receives `sheet:op` with `recordIds`/`fieldIds`, but no `recordPatches[].patch` and no canary anywhere in the payload.
- **R4 writer's own event is still ignored by the originating client:** client-side self-skip by `actorId` remains intact. This prevents the invalidation path from causing duplicate local refreshes for the writer.
- **R5 frontend fallback refetch path:** a no-value `record-updated` event for a visible row calls `mergeRemoteRecord(recordId)` and does not call `applyRemoteRecordPatch`. If the changed field is structural, existing page reload behavior remains.
- **R6 create/form/attachment publishers are covered by the shared seam:** record-created, form-update, bulk patch, direct patch, and attachment-updated events contain no value-bearing `patch`.
- **R7 cache invalidation still fires:** the helper still calls the registered cache invalidator for the sheet even after payload sanitization.
- **R8 presence uses trusted identity:** presence lists the token-derived user id, not a spoofed `?userId=` query value.

### Non-vacuous seed requirements

- Use a field whose `property.hidden` is explicitly unset and whose denial is solely `field_permissions.visible=false`.
- Include a visible-field positive control so an empty event cannot pass as a successful invalidation.
- Include a canary value and assert it is absent from the raw Socket.IO payload string.
- Run at least one test through the same `publishMultitableSheetRealtime` helper used by REST writes, not a direct `io.emit`.

---

## 4. Compatibility notes

The frontend already contains the fallback needed by the no-value design:

- no `recordPatches` entry -> unresolved record -> `mergeRemoteRecord` (`useMultitableSheetRealtime.ts:205-230`);
- no merge handler -> page reload (`:223-235`);
- created records -> page reload (`:183-185`).

The expected UX tradeoff is higher read-after-write latency for other clients because simple cell edits will refetch instead of merging the value directly. This is acceptable for the safety slice. If latency becomes unacceptable, a later opt-in can add per-recipient masked value fan-out, but it must preserve D0 and the R1-R8 tests.

---

## 5. Landing checklist

- [x] Design-lock drafted.
- [ ] Implementation PR: authenticated/authorized `join-sheet` + value-free realtime invalidation.
- [ ] Fail-first proof for R1/R2/R3 against unmodified `origin/main`.
- [ ] Frontend no-value fallback tests.
- [ ] Backend type-check + frontend type-check.
- [ ] CI confirms Socket.IO integration tests and web realtime specs ran.
- [ ] Memory update only after merge, on explicit user instruction.
