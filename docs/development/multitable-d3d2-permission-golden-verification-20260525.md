# Multitable D3d-2 — Permission Golden Matrix (real gates + non-gate contract): Verification (2026-05-25)

Implements D3d-2 per the final scope lock (`docs/development/multitable-d3d2-scope-lock-20260525.md`).
Predecessors: D3d-1 (#1827, `4ca98cda1`) · D3c export leak fix (#1820).

---

## 1. What shipped

- **Test:** `packages/core-backend/tests/integration/multitable-permission-golden-d3d2.test.ts` — 8 cases,
  real Postgres, asserted through real `export-xlsx` / `PATCH /records` / GET `/view` routes.
- **CI:** the dedicated `plugin-tests.yml` step now runs **both** D3d-1 + D3d-2 files (one gating step,
  `DATABASE_URL` hard guard, after `db:migrate`, `vitest.integration.config.ts`).

## 2. Matrix (result = pending CI; PASS/FAIL only from §4.2)

| class | case | mechanism | endpoint | expected |
|---|---|---|---|---|
| field | inherited-via-member-group | `field_permissions(member-group, visible=false)` + `platform_member_group_members` | export-xlsx | masked (header+cells) |
| sheet | inherited (control) | no sheet row, base write | PATCH /records | 200 |
| sheet | granted (control) | sheet row `spreadsheet:write` | PATCH /records | 200 |
| sheet | **write-downgraded (gate)** | base write + sheet row `spreadsheet:read` only | PATCH /records | **403** |
| record | write-own — own | write-own scope, creator | PATCH /records | 200 |
| record | **write-own — not-own (gate)** | write-own scope, non-creator | PATCH /records | **403** |
| view-access | **NON-GATE (live)** | view-wide whitelist row for another user; our user ungranted | GET /view | `canAccess===false` (whitelist) **AND** rows still returned (not enforced) |
| — | sentinel | — | — | `DATABASE_URL` set |

**Documented non-gates (no assertion):** sheet-read, record-read — grant-additive / grant-only, no deny
semantic (scope-lock §0). A non-gate returning data is the contract, never a leak.

## 3. Boundary adherence

- **Test/acceptance only**; sole non-test edit = the CI step (now runs both D3d files). No `src/` / rbac / auth.
- **New-leak rule:** only a real gate returning the wrong status (sheet write-downgrade or record not-own
  returning 200, or a masked field appearing) stops as RED → separate fix PR. Non-gates returning data = expected.

## 4. Verification

### 4.1 Local (no Postgres)

```
Test Files  1 skipped (1)
     Tests  8 skipped (8)
```
Skip is expected locally; the real run is CI (§4.2).

### 4.2 CI non-skip evidence

From the `Run multitable permission golden matrix (D3d, real DB)` step (test (20.x), run
[26408342198](https://github.com/zensgit/metasheet2/actions/runs/26408342198), 2026-05-25):

```
✓ tests/integration/multitable-permission-golden-d3d1.test.ts  (7 tests) 572ms
✓ tests/integration/multitable-permission-golden-d3d2.test.ts  (8 tests) 587ms
 Test Files  2 passed (2)
      Tests  15 passed (15)
```

**15 passed, 0 skipped, real Postgres** — non-skip proven. All real gates green (member-group mask,
sheet write-downgrade 403, record write-own 403) and the view-access non-gate (`canAccess===false` +
data returned). No enforcement leak found. The `: "${DATABASE_URL:?...}"` guard fails the job loudly if
unset, so phantom-skip can't pass.

> CI iteration note: two prior CI runs surfaced **test-harness** issues, not leaks — (1) view-access
> assertion corrected (whitelist annotation, not "always true"), (2) `meta_fields_pkey` collision from
> D3d-1/D3d-2 sharing `fld_*_${TS}` ids at same-ms import → `d3d2` infix. Real-gate assertions passed
> throughout.

## 5. Next

- Consolidated contract: `permission-matrix-golden-20260525.md` (this PR) merges D3d-1 + D3d-2 + the
  "annotation-rich, enforcement-thin" model observation.
- Out of scope (model changes): view-data gating, per-record/sheet read-deny.
