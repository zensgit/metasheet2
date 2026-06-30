# Cross-base Slice 1 — C2 / I-1: `meta_links` edge-writing path enumeration + mirror-read-only hardening — 2026-06-30

> The §10/I-1 deliverable of the RATIFIED cross-base editable-mirror design-lock
> (`multitable-crossbase-twoway-editable-mirror-slice1-designlock-20260629.md`). **Test-first discovery + a
> harden-first PR**, BEFORE the gated cross-base write-through (the C2 runtime, a separate later slice). Grounding:
> `origin/main` @ `e10c80dc5` (C1 landed). Owner-directed (2026-06-30): harden the non-conforming paths as their own
> PR first.

## 0. Why this exists
C2 will open editing of a cross-base mirror through **one** deliberately-gated path. That is only safe if **every
other** path that can write a `meta_links` edge already **rejects** a write to a mirror field — otherwise the
write-through opens onto a floor with side-doors (the generalization of the OAPI-4a REST-mint miss). I-1 enumerates
those paths and proves rejection per path; this slice **hardens the non-conforming ones** to a uniform baseline.

**The canonical guard** is `isFieldAlwaysReadOnly` (`permission-derivation.ts:58–68`): it forces **any** `mirrorOf`
field read-only — same-base **and** cross-base — independent of the property-load path. **The spine invariant:** the
single canonical `meta_links` edge must never gain a second materialized row keyed by a mirror field id.

## 1. Enumeration (every `meta_links` edge-writing path)
| Writing path (file:line) | Entry point(s) | Mirror write rejected? guard / SIDE-DOOR |
|---|---|---|
| `RecordWriteService.patchRecords` link sync (record-write-service.ts:994 INSERT / 954,983 DELETE) | bulk `POST /patch`; AI-shortcut run; revision restore/revert-execute | ✅ double: spine `validateChanges` `field.readOnly` throw (record-write-service.ts:461, guard=`isFieldAlwaysReadOnly` via univer-meta.ts:4146) + route `forbiddenWriteFieldIds` (univer-meta.ts:15223) |
| `RecordService.patchRecord` link sync (record-service.ts:1329 INSERT) | OAPI `PATCH /records/:recordId` | ✅ `field.readOnly===true` (record-service.ts:1084; guard map :414=`isFieldAlwaysReadOnly`) |
| `RecordService.createRecord` link write (record-service.ts:679 INSERT) | session `POST /records`, OAPI `POST /records`, duplicate, **import-xlsx** | ✅ `if (isFieldAlwaysReadOnly(field)) throw` (record-service.ts:532) |
| Public **form-submit** link sync (univer-meta.ts:13401 INSERT) | public form submit | ✅ `buildFieldMutationGuardMap` (univer-meta.ts:13157=`isFieldAlwaysReadOnly`) → :13190 'readonly' |
| **plugin-SDK `records.ts`** (`buildNormalizedPatch` :328 → `replaceRecordLinks` :372 INSERT) | host/plugin SDK `records.createRecord`/`patchRecord` (index.ts:565/603) | ❌ **SIDE-DOOR** — no `isFieldAlwaysReadOnly`/`mirrorOf`/`readOnly` check; writes a 2nd row by mirror field id |
| **Yjs collab bridge** → `patchRecords` (record-write-service.ts:994) | realtime grid edit (index.ts:2311; guard :2370) | ❌ **SIDE-DOOR (divergent guard)** — `readOnlyTypes.has(type)‖prop.readOnly` (index.ts:2370), misses `mirrorOf`; `guard.link` still set (:2376) |
| `RecordService.restoreRecord` link rebuild (record-service.ts:1011 INSERT) | `POST /records/:recordId/restore` | ⚠️ no explicit mirror skip — replays `snapshot[fieldId]` for `type==='link'` (:984/:1008); safe only by snapshot hygiene |
| PIT **undelete/resurrect** (univer-meta.ts:9444 INSERT) | `…/revert-execute` resurrect (flag-gated) | ⚠️ no explicit mirror skip — loops `linkFieldIds` over `r.snapshot` (:9442); snapshot-hygiene-reliant |
| PIT **reset-execute** link sync (univer-meta.ts:9676 INSERT) | `…/reset-execute` (flag-gated) | ⚠️ no explicit mirror skip **and** no upstream `hasForbidden`/`readOnly` gate (unlike revert/restore) — iterates `candidate.diff` `type==='link'` (:9644) |
| cascade DELETEs (record/sheet/field delete) | delete routes/actions | N/A — delete canonical rows legitimately, never a mirror field-value write |
| automation create/update (automation-executor.ts:2237/2077) | `create_record`/`update_record` | N/A — writes `data` jsonb only, not a `meta_links` writer (a stale mirror value in `data` is ignored on read) |

## 2. Findings (independently verified)
**Conforming (6 paths) — reject a mirror write via `isFieldAlwaysReadOnly` today:** bulk `/patch`, OAPI `PATCH`, all
create/import, form-submit, AI-shortcut, revision-restore/revert. (No change needed; locked by goldens.)

**Side-doors (VERIFIED open):**
1. **plugin-SDK `records.ts` (records.ts:328 → :372)** — `buildNormalizedPatch` processes any `type:'link'` field
   (a mirror is `type:'link'` + `mirrorOf`) with **zero** read-only/mirror check, and `replaceRecordLinks` INSERTs a
   `meta_links` row keyed by the **mirror field id** → a **second canonical row**. This breaks the spine invariant
   **today**, for a **same-base** mirror too (not only cross-base). *Reachability:* host/plugin SDK (index.ts:565/603)
   — confirm caller trust during the fix, but the gate is absent regardless.
2. **Yjs collab bridge (index.ts:2370)** — comment claims "same logic as `buildFieldMutationGuardMap`" but is
   hand-rolled `readOnlyTypes.has(f.type) ‖ prop.readOnly===true`: keys on lookup/rollup + **raw** `prop.readOnly`,
   **not** `mirrorOf`, and still sets `guard.link` (:2376). A mirror whose persisted property lacks `readOnly:true`
   — the exact case `isFieldAlwaysReadOnly` (permission-derivation.ts:62–66) was written to close — is writable via
   realtime grid edits.

**Snapshot-rebuild (3 paths) — hygiene-reliant, not guarded:** `restoreRecord`, PIT undelete, PIT reset-execute
iterate `type==='link'` over a server-derived snapshot/diff with no `isFieldAlwaysReadOnly`. Safe only because a
mirror value never lands in `data` (so the snapshot doesn't carry it). Defense-in-depth: add an explicit mirror skip
so the spine does not depend on snapshot hygiene.

## 3. The hardening (this slice — NO write-through)
Converge every non-conforming path onto the **canonical** `isFieldAlwaysReadOnly`, and lock each with a golden:
- **Side-door #1:** in `buildNormalizedPatch` (records.ts), reject a write to an `isFieldAlwaysReadOnly` field
  (parity with `record-service.ts:532`) — **before** any `meta_links` write. A mirror field write → validation error,
  no row.
- **Side-door #2:** replace the hand-rolled Yjs guard (index.ts:2370) with `isFieldAlwaysReadOnly(f)` (delivering on
  its own "same logic as buildFieldMutationGuardMap" comment) so a mirror field is read-only and `guard.link` is not
  set for it.
- **Snapshot paths (×3):** filter out `isFieldAlwaysReadOnly` (mirror) fields from the link-replay loop in
  `restoreRecord`, PIT undelete, PIT reset-execute — explicit skip + assertion.

**Acceptance — one golden per path, fail-first where it's a fix:**
- side-door #1 / #2 goldens: a mirror-field write through that path is rejected / produces **no** `meta_links` row;
  **fail-first** = RED before the convergence (the side-door currently writes a row).
- snapshot goldens: a resurrect/restore/reset of a record whose paired mirror exists does **not** create a mirror
  row.
- conforming-path characterization goldens (representative): mirror write still rejected (regression lock).
- The spine invariant assertion: after every path's mirror-write attempt, `SELECT count(*) FROM meta_links WHERE
  field_id = <mirror field id>` is **0**.

After this lands, "mirror is read-only on every path" is a **guarded** invariant (not hygiene-reliant), and the C2
write-through can open exactly one gated cross-base path with the enumeration goldens proving no other path reopened.
