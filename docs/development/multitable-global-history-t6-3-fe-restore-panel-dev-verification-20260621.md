# Global History — T6-3 FE Restore Panel 开发与验证 MD

> The final slice of the owner-ratified T6 staging. Wires the preview→confirm→execute restore chain into the
> multitable FE: the record drawer EMITS a restore intent, the workbench OWNS the flow, and a confirm panel
> shows what would change (and any conflict) before the actor commits — with the T6-1 identity carried through.

## 1. Shape (per the owner's review)

- **`api/client.ts`**: `restorePreviewRecord(sheetId, recordId, targetVersion)` → `{ changes, schemaDrift,
  previewIdentity, … }`; `restoreExecuteRecord(sheetId, recordId, targetVersion, expectedVersion,
  previewIdentity)` → the restore result.
- **`MetaRecordDrawer`**: unchanged — it still only EMITS the restore intent `{ recordId, targetVersion,
  expectedVersion }` (the drawer does not own confirm/execute).
- **`MultitableWorkbench`** (the upper-level handler): `onRestoreRecordVersion` now, for a FULL-record restore,
  calls `restorePreviewRecord` → opens the panel → on confirm calls `restoreExecuteRecord` with the identity →
  refreshes. Per-field (column-level) restore keeps the existing direct `/restore` path (the T6 identity binds
  the full-record diff; per-field-through-preview is a follow-up).
- **`RestorePreviewDialog.vue`** (new): shows the masked changes (field name + set/clear + value), a no-op
  message, or a **schema-drift conflict**; confirm is enabled ONLY for a real, executable, non-empty change set.

## 2. The UI safety (`canConfirm`)

The actor can commit ONLY when `!loading && executable && !schemaDrift && changes.length > 0`. So a schema-drift
conflict (the server withheld the identity → `previewIdentity: null` → `executable=false`) shows the conflict and
the confirm button is **disabled** — the FE cannot drive a blocked restore. A no-op (empty diff) and the loading
state also disable confirm. This mirrors the backend (T6-2 rejects drift / empty-diff replays); the FE never
offers an action the server would refuse.

## 3. Verification

- **`vue-tsc -b` 0** (full web typecheck).
- **5 dialog specs** (jsdom mount): changes render + confirm enabled (executable, non-empty); schema-drift →
  conflict shown + confirm **disabled** + no `confirm` emit; empty diff → no-op + disabled; loading → disabled;
  cancel emits. Added to the `multitable-web-guard` filter + path triggers.
- Web-guard slice green locally (representative: dialog + history + trash + grid specs, 157/157).

## 4. T6 complete + follow-ups

T6-1 (identity contract #3016) + T6-2 (scoped execute + schema-drift #3023/`4203c165`) + `/restore` row-deny
closure (#3026) + T6-3 (this FE panel) = the ratified T6 staging is done; all three restore surfaces (preview /
execute / legacy `/restore`) enforce row-deny. **Full-record FE restore goes through preview→execute; per-field
(column-subset) restore remains on the legacy `/restore` — now protected by row-deny (#3026) — and
per-field-through-preview is a named follow-up below** (`MultitableWorkbench.onRestoreRecordVersion` routes a
`fieldIds` payload to the direct path; `MetaRecordDrawer` emits `fieldIds` for a field subset).

Named follow-ups (each a separate opt-in): per-field restore through the preview chain; batch / multi-record /
field-subset restore (a `scope` claim on the identity); unify the three diff copies behind one helper (the P3).
T8 (destructive PIT restore) + T9 (config history) remain design-locked + gated.
