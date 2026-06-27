# T9-W U-2 — field type/property retype revert — development & verification (2026-06-27)

> **Status: built + verified, behind a default-off flag, AWAITING OWNER REVIEW of one design re-decision.**
> Grounding: `origin/main` @ `00f338f67` (after Tier-1 sheet_config revert closed: #3264 / #3254 / #3286 / #3287 / #3291).
> This is **U-2** from the unsafe-restore design-lock (`multitable-t9-w-unsafe-restore-design-lock-20260626.md`), the
> only owner-greenlit remaining slice on the T9-W line. Read §1 first — it changes what U-2 *is*.

## 1. Premise correction (read before the rest) — why this slice is NOT "lossy retype"

The design-lock named U-2 **"lossy retype"** and required the revert to *"quantify how many cell values would be
coerced/emptied"* and *"refuse on total loss"* — i.e. it assumed the revert **transforms and drops** stored cell
values (call it **option II**, destructive). That framing rests on a premise that is **false in the code**:

- **The forward retype drops nothing.** The forward `PATCH /fields/:fieldId` route (`univer-meta.ts`) changes
  `meta_fields.type/property` but performs **no cell-value migration** — existing `meta_records.data` values are kept
  **byte-identical** (verified: the only schema op that rewrites record data is field *delete*; a repo-wide grep for a
  value-migration step is empty). Per-type coercion exists only at *write* time (`field-codecs.ts`), never at retype.
- **The read path tolerates type-mismatched values.** Record reads (`query-service.ts` `normalizeRecordData`) JSON-parse
  and pass values raw — no per-type decode that could throw. So a value that doesn't match the declared type is already
  a normal, tolerated state the forward retype creates routinely.

Therefore the only data destruction in the whole story would be **manufactured by the revert itself** if it coerced
values to the reverted type. A revert that just restores `type/property` (a raw `meta_fields` UPDATE, symmetric with
the forward route) is **lossless** (**option I**).

**Decision (built): option I — schema-only, lossless.** It is a genuine "undo the type change", it introduces no
destruction that doesn't already exist on the forward path, and it is provably **as safe as the shipped forward
retype**. The destructive value-transform (option II) is treated like Tier 3/4: a **separate, gated owner decision**,
to be made now with the corrected facts (§6).

## 2. What shipped (U-2, behind `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`, default off)

Mirrors the proven Tier-1 `isSupportedSheetConfigRevert` pattern — `classifyRevert` stays PURE (a field revert
touching `type`/`property` is intrinsically `gated`); the route opens only the supported subset behind the per-tier
flag.

- **`config-restore.ts`**
  - `FIELD_COLUMN` += `type`, `property` (so `applyConfigRevert` can write them) — schema-only, no value transform
    (mirrors the forward route).
  - `isFieldRetypeRevert(rev)` — structural gate (drives the flag): a field `update` revert touching type/property.
  - `isSupportedFieldRetypeRevert(rev)` — confirmable/executable subset: a **type-changing** retype where **both**
    endpoints (`before.type`, `after.type`) are **plain scalars** (not in `FIELD_RETYPE_EXCLUDED_TYPES` =
    formula/lookup/rollup/link/attachment/button/autoNumber/createdTime/modifiedTime/createdBy/modifiedBy).
- **`univer-meta.ts`** (config-restore preview + execute): a field-retype **flag-gate** (403
  `FIELD_RETYPE_REVERT_DISABLED` when off, on both routes); the preview `opKind='safe'` override and the execute
  422-skip now pass for `isSupportedSheetConfigRevert(rev) || isSupportedFieldRetypeRevert(rev)`. Cap gate is the
  existing `canManageFields` (field entity). Bound preview→execute identity + drift (409) reused unchanged.

### Why the **scalar restriction** is a safety necessity (not over-scoping)
`applyConfigRevert` is a raw `meta_fields` UPDATE, but the forward route ALSO runs **type-transition side effects** a
raw UPDATE skips: autoNumber sequence create/drop, formula dependency sync, link join-table. Reverting a retype that
touches those types via a raw UPDATE would leave the system inconsistent. So both endpoints must be plain scalars; any
retype involving computed/link/attachment/autoNumber/system types **stays gated** (a separate slice, if ever wanted).
This mirrors record-restore L1's "scalar user-data fields only" (Lock D).

### v1 scope cuts (documented, deferred)
- **Type-changing reverts only** — `changed_keys` must include `type` (keeps the predicate pure on `rev` so it works
  at the pre-txn 422-skip, like Tier-1). Property-only reverts (e.g. select options, number precision) are deferred.
- No value-transform / loss-scan / U-L8 machinery (it collapses to informational under option I — see §6).

## 3. Verification

Real-DB goldens (`tests/integration/multitable-field-retype-revert-realdb.test.ts`, wired into the Node 20 multitable
real-DB CI step — enumerated list + step name both updated):

- **(a)** flag-OFF → preview AND execute **403** `FIELD_RETYPE_REVERT_DISABLED`.
- **(b)** gate: actor without `canManageFields` → **403**.
- **(c)** flag-ON happy path: preview confirmable (`opKind:'safe'`, no drift) → execute reverts the field type, **a
  stored value that does NOT fit the reverted-to type is KEPT** (`'hello'` survives a revert to `number` — the lossless
  proof, the whole point of option I vs II), and a forward `source=restore` revision is appended.
- **(d)** scalar restriction: a retype with a **non-scalar endpoint (`link`)** stays gated even flag-ON — preview not
  confirmable, execute **422** `RESTORE_NOT_SUPPORTED`, **no write**.
- **(e)** drift: field type changed between preview and execute → execute **409**.

**Local `metasheet_test`: 6/6 pass.** Regression: sheet_config Tier-1 + record-restore suites **46/46** unchanged
(the shared override/skip-condition edits don't regress Tier-1). `tsc --noEmit` clean. Additive test file (no other
test touched). **Runtime merged ≠ enabled — the flag stays default-off; enabling it in any env is a separate decision.**

## 4. Read-tolerance check (the advisor's required safety gate) — PASS

Confirmed the record read path (`query-service.ts` `normalizeRecordData`) does no per-type decode that could throw on a
type-mismatched value (raw passthrough). So option I leaves the system in exactly the state the forward retype already
produces and the product already copes with → option I is provably as safe as the shipped forward retype.

## 5. T9-W line — remaining-dev map after U-2

| Item | State |
|---|---|
| Tier 1 — sheet_config revert | **DONE** (#3264 + #3254 + #3286 + #3287 + #3291) |
| **Tier 2 — field retype revert (schema-only / scalar)** | **THIS slice — built, verified, flag default-off, awaiting review** |
| Tier 2 — value-transforming retype (option II, destructive) | **GATED** — separate sign-off, corrected facts (§6) |
| Tier 3 — un-create (revert a `create`) | **HELD** — own destructive-delete sign-off |
| Tier 4 — undelete (revert a `delete`) · permission-revert | **DEFER / HOLD** — own line; permission-revert needs a per-grant policy |

`/goal` does **not** authorize the held/deferred items (the "T8-2 was authorised by a specific open, not a `/goal`"
discipline); they are listed, not built.

## 6. Owner decisions surfaced (each gated — recommend, don't decide)

1. **Confirm option I** (schema-only, lossless) as Tier-2 — vs the design-lock's literal option II. Recommended: yes
   (option II manufactures destruction the forward path never caused; it isn't a faithful "undo" either, since the
   prior values are long gone). **This is the one re-decision this slice asks for.**
2. **Option II — value-transforming retype** (coerce/drop stored values to fit the reverted type): a *new destructive*
   path that exists nowhere in the codebase today. If ever wanted, its own sign-off + the data-loss preview.
3. **Informational read-scoped loss-scan + U-L8**: under option I nothing is dropped, so the design-lock's "data-loss
   preview" collapses to an *informational* "N stored values won't satisfy the restored type" count. Useful but not
   safety-critical; it is a mild oracle, so if added it must be read-scoped (the `loadAllowedFieldIds` /
   `loadDeniedRecordIds` primitives exist). Deferred follow-up.
4. **Is the flag/ceremony even warranted?** Since option I is lossless, type/property reverts could arguably just join
   the existing `safe` path (no flag). Built behind the default-off flag for now (conservative, trivially relaxable).
5. **Property-only reverts** and a **cross-sheet-field guard** (a pre-existing consideration for *all* field reverts,
   not introduced here) — small follow-ups.

## 7. Bottom line
U-2 is built as the **safe, lossless, scalar-gated** field retype revert, behind a default-off flag, with 6 real-DB
goldens (incl. the lossless proof) + 46/46 regression + tsc clean. It **re-decides the design-lock's "lossy" premise**
on verified code truth and recommends option I; the destructive option II and the informational loss-scan are presented
as separate gated decisions. Awaiting owner confirmation of option I before merge.
