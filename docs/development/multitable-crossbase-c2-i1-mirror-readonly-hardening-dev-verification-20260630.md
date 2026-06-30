# Cross-base C2 / I-1 — mirror-read-only hardening — dev & verification (2026-06-30)

> The harden-first PR of the §10/I-1 deliverable (enumeration in
> `multitable-crossbase-c2-i1-mirror-readonly-enumeration-20260630.md`). Closes the two verified side-doors + the
> three snapshot-rebuild paths so a mirror field is read-only on **every** `meta_links`-writing path, via the
> CANONICAL `isFieldAlwaysReadOnly`. **No write-through, no flag, no new write capability — TIGHTENS only.**
> Grounding: `origin/main` @ `e10c80dc5`.

## 1. The five fixes (all converge on `isFieldAlwaysReadOnly`, permission-derivation.ts)
| # | Path | Change |
|---|---|---|
| Fix 1 | plugin-SDK `records.ts` `buildNormalizedPatch` (:328-ish) | Added `if (isFieldAlwaysReadOnly(field)) throw MultitableRecordValidationError` at the TOP of the per-field loop (before the link branch), parity with `record-service.ts:532`. A mirror/computed field write now rejects → `replaceRecordLinks` never writes a 2nd canonical row. |
| Fix 2 | Yjs collab bridge `index.ts` (~:2370) | Replaced hand-rolled `readOnlyTypes.has(type)‖prop.readOnly` with `isReadOnly = isFieldAlwaysReadOnly(f)`; and set `guard.link` **only when `!isReadOnly`** (defense-in-depth). |
| Fix 3a | `RecordService.restoreRecord` (record-service.ts:984) | `linkFieldIds = …filter(f.type==='link' && !isFieldAlwaysReadOnly(f))` — skip the mirror in the replay. |
| Fix 3b | PIT undelete (univer-meta.ts:9430) | `…filter(f.type==='link' && fieldById.get(f.id)?.readOnly !== true)` (patchContext guard = canonical). |
| Fix 3c | PIT reset-execute (univer-meta.ts:9652) | `if (field?.type !== 'link' || field.readOnly === true) continue` — skip the mirror in the reset replay. **Defense-in-depth:** the reset's pre-existing PREVIEW preflight (univer-meta.ts:9322) already refuses a mirror-diff reset (`409 RESET_BLOCKED`, `readOnly` via `isFieldAlwaysReadOnly`), so 9652 is unreachable while that preflight holds — a secondary spine assertion, not the primary guard (corrects the earlier "no upstream gate" read). |

## 2. Yjs downstream finding (Fix 2 — how it BLOCKS)
The bridge builds `fieldById` (the guard map) and passes it to `RecordWriteService.patchRecords` (index.ts:2404).
`patchRecords.validateChanges` (record-write-service.ts:461) throws `RecordFieldForbiddenError` when
`field.readOnly === true`. So setting `guard.readOnly = isFieldAlwaysReadOnly(f)` makes the mirror read-only **and
the existing spine guard rejects it** — the same enforcement the bulk `/patch` path already uses. Skipping
`guard.link` for a read-only field makes the link-write path additionally unreachable for a mirror.

## 3. Verification (real DB `metasheet_oapi4a_test`)
**New golden `multitable-mirror-readonly-enumeration-realdb.test.ts` → 8/8.** Each attempt asserts the spine
invariant `SELECT count(*) FROM meta_links WHERE field_id = <mirror> === 0`:
- **SD-1a / SD-1b** — plugin-SDK `createRecord` / `patchRecord` with a mirror-field value → rejected (read-only), no edge.
- **CONF** — bulk `POST /patch` on the mirror field → 403, no edge (conforming-baseline regression).
- **SD-2** — a mirror field (`mirrorOf`, no raw `readOnly`) is read-only via `isFieldAlwaysReadOnly` (true) where the
  OLD hand-rolled Yjs predicate judged it WRITABLE (false) — the convergence that closes the gap.
- **SNAP** — restore (via route) of a record whose snapshot carries a (bogus) injected mirror value → the mirror is
  NOT replayed as an edge (Fix 3a).
- **SNAP-undelete** — PIT resurrect (`revert-execute` confirm:`undelete`, flag-on) of a deleted record whose T-snapshot
  carries a bogus mirror value → the mirror is NOT rebuilt as an outbound edge (Fix 3b, univer-meta.ts:9430).
- **SNAP-reset** — PIT reset-to-T (`reset-preview`, flag-on) whose revert diff would write the mirror field → **refused
  at the all-or-nothing PREFLIGHT** (`409 RESET_BLOCKED`), nothing written. **Finding:** the reset path's reachable
  spine guard is the **pre-existing** preview preflight (univer-meta.ts:9322, `readOnly !== true` via
  `isFieldAlwaysReadOnly` ⇒ `mirrorOf`) — so reset was NOT a true side-door; the Fix-3c replay-skip (9652) is
  **defense-in-depth**, unreachable while that preflight holds (kept as a secondary spine assertion).

**Fail-first proof (load-bearing):** neutralizing Fix 1 → **SD-1a/SD-1b RED** (a `meta_links` row appears — the spine
break is real); neutralizing Fix 3a → **SNAP RED**; neutralizing **Fix 3b (the 9430 undelete filter) → SNAP-undelete
RED** (`expected 1 to be 0` — a mirror outbound edge is rebuilt). SD-2 is the in-test proof for Fix 2 (the realtime
loop isn't drivable in-test; the guard derivation is asserted directly). **SNAP-reset pins the pre-existing PREFLIGHT,
not the defense-in-depth 9652 skip** — so it is honestly NOT fail-first against Fix 3c (the preflight blocks first). All
8 verified green together; the fail-first reverts were `git checkout`-restored from the commit.

**Regression:** plugin-SDK `multitable-records.test.ts` + `multitable-record-lock.test.ts` → **23/23** (a
computed/mirror field write was never valid, so Fix 1 only tightens). **`tsc --noEmit`: exit 0.** Golden wired into
`plugin-tests.yml` real-DB list + step name (verify it RAN, not skipped-green).

## 4. Plugin-SDK reachability (for the reviewer)
Side-door #1's entry is the host/plugin SDK `records.createRecord`/`patchRecord` (index.ts:565/603). The gate was
**absent regardless of caller trust**, and a mirror write is invalid for any caller — so Fix 1 is correct independent
of reachability. Whether the SDK is reachable by untrusted callers determines whether this was an *exploitable* spine
break vs a *latent* one; flagging for the reviewer (not gating this tightening).

## 5. Boundaries honored
Every fix only **rejects/skips** a mirror write (TIGHTENS); no mirror was ever legitimately writable. No cross-base
write-through, no `MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE` flag, no new `meta_links` write path. After this, "mirror
read-only on every path" is a **guarded** invariant (not snapshot-hygiene-reliant), so the later C2 write-through can
open exactly one gated path with the enumeration goldens proving no other path reopened.
