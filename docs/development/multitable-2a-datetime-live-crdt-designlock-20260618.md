# 多维表 2a · live-CRDT `dateTime` — DESIGN-LOCK (2a-S1) — 2026-06-18

> Status: **DESIGN-LOCK (design only — NO runtime).** Opens gate **2a** of `multitable-gated-remainder-development-plan-20260618.md` (#2828) for its **last** field type, `dateTime`.
> Owner opt-in: 2026-06-18 ("open 2a dateTime first; design-lock timezone/canonical/persisted-doc corruption").
> Grounding: code-anchored on `origin/main` — `MetaCellEditor.vue` (binding allowlists), `useYjsScalarCell.ts` (dual-reader), `yjs-scalar-strdate-migration-realdb.test.ts` (the migration golden template).
> Scope rule: this doc is design-lock only. The runtime build (2a-DT-S2) is a SEPARATE owner opt-in after this is reviewed.

## 0. Where dateTime sits today

`select` + `date` (#2832) and `duration` (#2838) now bind to live CRDT. `dateTime` is the **sole** remaining string-stored atomic, explicitly deferred in `MetaCellEditor.vue` (`STRING_STORED_ATOMIC_YJS_TYPES = ['select', 'date']` — dateTime excluded).

Why it was held back (the real gate): unlike `select`/`date`, the dateTime backend codec **normalizes the stored value to canonical UTC ISO**. The editor reads/writes a *local* representation via `dateTimeInputValue` (stored→local display) and `dateTimeValueFromLocalInput` (local→canonical stored). So a naive "write the editor's value into the Y.Map" would put a **local, non-canonical** string into the shared doc — diverging from the stored form and drifting across collaborators' timezones.

## 1. Decisions (locked)

### 1.1 Canonical-value invariant (the dateTime-specific crux)
The Y.Map cell for a dateTime field stores the **canonical UTC ISO** string — exactly what `dateTimeValueFromLocalInput` produces and what the backend persists. The editor still *displays* via `dateTimeInputValue` (local). Concretely: on a live edit, the binding writes `dateTimeValueFromLocalInput(localInput)` (canonical), **never** the raw local input. Reads convert canonical→local for display only.

Consequence (the property we want): two collaborators in different timezones converge on the **same canonical stored value** and each *sees* it in their own local zone. No TZ drift; the flushed `meta_records.data` keeps the canonical ISO string byte-for-byte with the REST path.

### 1.2 Migration strategy — dual-reader, lazy (same as select/date)
Reuse the proven `useYjsScalarCell` **`coerceText`** dual-reader: an old persisted doc may hold the dateTime key as `Y.Text` (historical seed shape); the binding reads `Y.Text`-or-plain and, on first edit, writes the plain canonical string. **No seed flip, no offline rewrite, no admin migration job** — lazy convergence, exactly how select/date shipped. Old/new clients interoperate during rollout (old client sees `Y.Text`, new client coerces); rollback tolerates already-migrated plain values.

### 1.3 Corruption / TZ golden (the fail-closed proof)
A real-DB golden (mirroring `yjs-scalar-strdate-migration-realdb.test.ts`):
- Seed a persisted Yjs doc with the dateTime key as `Y.Text` (a canonical ISO string).
- Open → migrate → edit → flush.
- Assert `meta_records.data[dateTimeField]` is the **canonical UTC ISO string** (the same shape the REST codec produces) — and the golden **FAILS** if a `Y.Text` object, `[object Object]`, a stringified object, a *local* (non-canonical) string, or any nested Yjs type reaches `patchRecords`.
- Add a **timezone round-trip** case: a value entered under one TZ offset must flush to the identical canonical ISO regardless of the editing client's zone (no off-by-offset drift).

### 1.4 Non-goals
- Do NOT change the stored cell shape (it stays the canonical UTC ISO string).
- Do NOT opportunistically migrate unrelated string fields.
- Do NOT bind `createdTime` / `modifiedTime` (system-managed, read-only — out of scope).

## 2. Recommended runtime slice (separate opt-in, after this lock)

| Slice | Scope | Verification |
|---|---|---|
| **2a-DT-S2** | Add `dateTime` to the live-CRDT binding writing the **canonical** value (per §1.1); reuse `coerceText` dual-reader (§1.2). No change to the dateTime editor UX. | Unit: canonical write + dual-reader read (old `Y.Text` → plain). Real-DB: the §1.3 corruption + TZ-round-trip golden. Browser smoke: two-client edit converges + displays per-zone. |

(`select`/`date`/`duration` are already shipped; dateTime is the final 2a type, so no further 2a slices after this.)

## 3. Open question for the owner (one)

The canonical-value invariant (§1.1) assumes the editor's `dateTimeValueFromLocalInput` is the single source of the canonical form. If a future requirement needs **sub-second / explicit-offset** dateTime input, the canonical normalization may need revisiting — out of scope here, flagged so 2a-DT-S2 isn't silently widened.
