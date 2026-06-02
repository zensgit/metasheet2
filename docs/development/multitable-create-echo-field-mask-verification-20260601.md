# F4 — `POST /records` create-echo field mask · verification

**Date:** 2026-06-01
**Design-lock:** `docs/development/multitable-record-egress-fieldperm-inventory-20260529.md` (#2106) §3 F4.
**Scope:** the `POST /records` create echo only. No central RBAC/auth (K3 Stage-1 lock).

## The hole

`POST /records` returned the created record's `result.data` **unmasked**. The create write gate is **layer-2 only** (`createRecord` checks `canCreateRecord` + `isFieldAlwaysReadOnly`, never `field_permissions`), so a `field_permissions.visible=false` value reached the echo two ways:
- **write-only-no-read** — a denied non-readonly field is *writable*, so the creator could supply it and get it echoed back (the F3 principle: a read-gated echo must omit it even when the caller wrote it); and
- **server-assigned** — a denied **auto-number** the creator never supplied is allocated by `allocateAutoNumberValues` and echoed back as genuinely new info.

## The fix

After `createRecord`, compute the layer-2 ∧ layer-3 `allowedFieldIds` composite (the #2028 read-mask pattern, keyed to the creator) and `filterRecordDataByFieldIds(result.data, allowedFieldIds)` before echoing. The create **write** is unchanged (still layer-2), so write-only fields persist; only the echo is masked. One site, no service change.

## Fail-first (real DB)

`tests/integration/multitable-create-echo-field-mask.test.ts` (wired into `plugin-tests.yml`). Seed: `FLD_SECRET`/`FLD_AUTONUM.property` carry no `hidden` → deny is solely layer-3.

| # | Scenario | Pre-fix | Post-fix |
|---|---|---|---|
| R1 | create supplying a denied field (write-only-no-read) | echoes the value | omitted; DB still persists it (`+` positive control `FLD_VISIBLE`) |
| **R2** | create → denied **auto-number** the creator never supplied | echoes the assigned number | omitted; DB still has it assigned |
| R3 | create as an ungranted-to-deny user | — | denied field + auto-number **present** (mask is per-subject) |

- **RED proven**: R1 (`expected '<canary>' to be undefined`) + R2 (`expected 2 to be undefined`) failed on unmodified origin/main → **4/4 GREEN** post-fix. R3's positive control confirms the auto-number actually materializes, so R2's RED is a real server-assigned leak, not a vacuous empty.

## Regression / type

- `tsc --noEmit` exit 0.
- `records-read-field-mask` + `write-echo-field-mask` → **13/13**; `sheet-realtime.api` → **3/3** (after the stub below).
- **Mock stub — F4 adds a query to the create path.** `multitable-sheet-realtime.api.test.ts` runs in the real-DB step but **mocks the pool**; its create dispatcher didn't handle F4's `loadSheetFields` (`…, "order" FROM meta_fields …`) + `field_permissions` queries → the create returned **500**. Added both stubs (no denials, mirroring its existing `meta_fields` handler). **CI caught this** — my first local regression batch missed `sheet-realtime`; lesson: run every mocked test that hits the changed route (the F3 record-patch analog).
- `multitable-record-form.api.test.ts` etc. fail under the **integration config** locally but pass in CI's **default** config — the default suite ran **265 files / 3521 tests green** with F4 — so those are config artifacts, not F4 regressions.

## Diff scope

`univer-meta.ts` (create echo, +mask), the new test, the one-line CI wiring, this doc.
