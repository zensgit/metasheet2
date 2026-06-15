# Multitable Cross-Base Phase C1 — real-time invalidation fan-out — design-lock

Status: **DESIGN-LOCK.** Closes the closeout §5 deferred item "Yjs 跨 base fan-out — 实时层失效
信号扇出到 target base 房间" (real-time invalidation fan-out to the target base's room). Own
beat, separate from C3/C2 per the riskiness of the real-time surface. Own-principles framing.

## 0. Empirical trace (done before designing — this is what the live path actually is)

The real-time client-delivery path for a multitable write is:
`publishMultitableSheetRealtime(payload)` (`realtime-publish.ts`) → invalidates the sheet's
records cache **and** publishes the shared-eventBus event `spreadsheet.cell.updated` with an
**ids-only** broadcast payload (`Omit<…,'recordPatches'>` — no row data) → `CollabService`
(`CollabService.ts:49`) is subscribed and emits `sheet:op` to the Socket.IO room
`sheet:${spreadsheetId}`.

- **The `sheet:${sheetId}` room join is auth-gated** by `sheetRoomAuthChecker`
  (`CollabService.ts:223`, wired `index.ts:2161`; fail-closed default `async () => false`). Only
  authorized users are in a sheet's room.
- **REST writes** (`univer-meta.ts`) call `publishMultitableSheetRealtime`, so a sheet's room
  already receives that sheet's invalidations.
- **The gap (缺席):** the **automation executor never calls** `publishMultitableSheetRealtime`.
  So automation-driven writes — including the new cross-base writes/deletes (②b / C2) — are
  **invisible to the real-time layer**; a base-A automation that writes a record in base B does
  not tell base-B's subscribers their data changed. The domain events the executor *does* emit
  (`multitable.record.updated/created/deleted`) are consumed only by automation-trigger chaining
  and the webhook bridge — **not** the client fan-out path.

(Correcting an earlier mis-grounding: this is NOT a base-read membership problem. A *direct*
record read in REST is gated by **sheet** capability, not base-read — `resolveBaseReadable`
applies only to cross-base *link/foreign-field* projection. So the room's existing sheet-scoped
gate is the right and sufficient boundary; there is no membership gap to close.)

## 1. Principle — relative invariance, not an absolute claim

C1 must deliver the cross-base invalidation **to the same target, gated identically** as the
already-established fan-out for that sheet. The target of a write to sheet `T` (base `B`) is the
room `sheet:T`; that room's audience is fixed by `sheetRoomAuthChecker(T, user)` and **does not
depend on where the write originated**. So routing an automation write's invalidation to
`sheet:${effectiveSheetId}` **adds no audience and changes no gate** — a cross-base write to `T`
reaches exactly the audience a REST write to `T` already reaches. Any property of that gate
(e.g. it returns raw sheet `canRead`) is pre-existing and out of scope. We deliberately do **not**
assert "room membership == full read authority" (the Yjs/sheet gate is sheet-scoped and does not
re-apply the record-scope map REST uses — a pre-existing property, not C1's concern).

## 2. The change (minimal)

In the automation executor's three record-write methods — `executeUpdateRecord`,
`executeCreateRecord`, `executeDeleteRecord` — after the successful mutation (and alongside the
existing domain-event emit), call `publishMultitableSheetRealtime` for the **effective** sheet:

```
publishMultitableSheetRealtime({
  spreadsheetId: effectiveSheetId,           // target sheet for cross-base; trigger sheet for same-base
  source: 'multitable',
  kind: 'record-updated' | 'record-created' | 'record-deleted',
  recordId: effectiveRecordId,
  actorId: gate.crossBase ? undefined : (context.actorId ?? undefined),
})
```

This closes the gap uniformly (same-base automation writes also gain the live invalidation REST
writes already have); the cross-base case is the named demand. `effectiveSheetId`/
`effectiveRecordId` are the values the gate already resolved (target for cross-base, trigger for
same-base), so the fan-out targets exactly the row that changed.

## 3. The one genuinely-new datum: `actorId`

The ids the invalidation carries (recordId; the payload omits row data) name a row in `T` that
`sheet:T` subscribers can already read — nothing new. The one new datum a **cross-base** fan-out
would put in base-B's room is the **trigger `actorId`** — a base-A actor's id surfacing to base-B
subscribers. **Decision: omit `actorId` for cross-base** (pass it only for same-base, where the
actor belongs to the same base). Rationale: the actor hint is a same-base UI affordance ("changed
by X" / self-echo suppression); a base-B subscriber has no need for a base-A actor identity, and
omitting it avoids surfacing a cross-base principal. `fieldIds` are intentionally not added by
these call sites; the target record's own fields are not §2a.3-masked to its own sheet's
subscribers, so this is not about the cross-base mask — it is simply the minimal payload.

## 4. Fail-first tests
- A **cross-base** `update_record` fan-out publishes `spreadsheet.cell.updated` with
  `spreadsheetId === targetSheetId`, `recordId === targetRecordId`, and **no `actorId`** (RED
  before C1 — the executor published nothing).
- A **same-base** `update_record` publishes with `spreadsheetId === triggerSheetId` and the
  `actorId` present (the uniform gap-close).
- `create_record` / `delete_record` publish the matching `kind` for the effective sheet.
- A blocked cross-base write (gate `ok:false`) publishes **nothing** (no fan-out on a write that
  did not happen).

## 5. Out of scope (not gold-plating the real-time layer)
No change to `sheetRoomAuthChecker` or the Yjs per-record auth gate (pre-existing, correct for
their scope). No live CRDT cross-base co-editing (the fan-out is an invalidation, subscribers
re-fetch through the normal gated+masked REST path). No per-field real-time masking (the re-fetch
path applies §2a.3). No new socket channel.
