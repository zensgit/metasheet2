# Multitable D3d-1 — Permission Golden Matrix (field tri-state + view hidden-field projection, real DB): Verification (2026-05-25)

Implements D3d-1 per the design (`docs/development/multitable-d3d-golden-matrix-design-20260525.md`),
scoped to what the **export path** can enforce: **FIELD** class × {granted/denied/inherited} and
**VIEW hidden-field projection** × {granted/denied}, plus the dedicated CI step that makes it run.

**Scope narrowing (vs design §5):** the export path applies `view.hidden_field_ids` but does NOT
consult `meta_view_permissions`, so view-**access** tri-state (granted/denied/**inherited-from-sheet-scope**)
is not testable via export and is **deferred to D3d-2** (view-data path). D3d-1's "view" = hidden-field
projection only.

Predecessors: D3c export field-perm leak fix (#1820, `cc29c6631`) · D3d design (#1822, `854b39712`).

---

## 1. What shipped

- **Test:** `packages/core-backend/tests/integration/multitable-permission-golden-d3d1.test.ts`
  — 7 cases, real Postgres seeded rows, asserted through the real `export-xlsx` route.
- **CI wiring (the load-bearing change):** a dedicated step in `.github/workflows/plugin-tests.yml`
  (`Run multitable permission golden matrix (D3d-1, real DB)`) — runs after `db:migrate`, with
  `DATABASE_URL` + the `: "${DATABASE_URL:?...}"` hard guard, via `vitest.integration.config.ts`.
  Mirrors the existing after-sales integration step.
- **D3c mock-pool canaries kept** as fast guards (`multitable-export-permission-canary.test.ts`);
  this real-DB suite is the golden contract.

## 2. Golden matrix (the contract)

Non-admin user (`roles:['member']`, `perms:['multitable:read']`) — admin bypass avoided so scoping applies.

Status column = **expected** outcome; PASS/FAIL is recorded only from CI (§4.2) — locally these all skip.

| class | state | seed | endpoint | expected | result |
|---|---|---|---|---|---|
| field | granted | `field_permissions(user, visible=true)` | `GET export-xlsx` | `Secret` + `topsecret` present | pending CI |
| field | denied | `field_permissions(user, visible=false)` | `GET export-xlsx` | `Secret`/`topsecret` **absent** (header + cells) | pending CI |
| field | inherited | `field_permissions(role, visible=false)` + `user_roles` | `GET export-xlsx` | absent (hidden via role membership) | pending CI |
| view-projection | granted | field not in `hidden_field_ids` | `GET export-xlsx?viewId=all` | `Secret` present | pending CI |
| view-projection | denied | field in `view.hidden_field_ids` | `GET export-xlsx?viewId=hidden` | absent | pending CI |
| export | denied | *N/A — `canExport` fused to `canRead`* | user without `multitable:read` | `403` (sheet-capability gate; no independent export-deny lever) | pending CI |
| — | sentinel | — | — | `DATABASE_URL` set (suite ran, not skipped) | pending CI |

**View-access tri-state** (`meta_view_permissions` granted/denied/inherited-from-sheet-scope): **not
here** — export ignores `meta_view_permissions`; deferred to D3d-2.
**Record class:** not in D3d-1 (→ D3d-2). Per-record read-deny does not exist in the model
(grant-only `access_level`), so it is documented, not tested-as-bug.

## 3. Boundary adherence (D3d-1 locked scope)

- **Test/acceptance only.** Sole non-test edit = the `plugin-tests.yml` CI step (pure test plumbing).
- **No** `rbac/service.ts` / `auth` / enforcement / record-deny changes.
- **Enforcement-bug disposition (pending CI):** the assertions are written to *confirm* the D3c-fixed
  contract; they have not yet run against a real DB (local = skip only). **If CI shows any masking
  assertion FAIL**, that is a new enforcement leak → per the locked rule the suite **stops as RED
  evidence** and the fix goes in a **separate** PR, NOT folded here. If CI is green, the contract holds.
  This line is resolved in §4.2 from the CI result.

## 4. Verification

### 4.1 Local (no Postgres available locally)

Suite collects cleanly and **skips** without `DATABASE_URL` — proves no import/type errors,
and that `describeIfDatabase` gates correctly:

```
Test Files  1 skipped (1)
     Tests  7 skipped (7)
```

Local skip is expected and is NOT acceptance — the real run is CI (§4.2).

### 4.2 CI non-skip evidence (REQUIRED — filled from the dedicated step)

Per the skip-when-unreachable rule, "green" is insufficient; the suite must be proven to **run**,
not skip. From the `Run multitable permission golden matrix (D3d-1, real DB)` job:

> _<fill after first CI run: paste the reporter line showing `Tests 7 passed (7)` with **0 skipped**,
> plus the job permalink>_

The step's `: "${DATABASE_URL:?...}"` guard fails the job loudly if `DATABASE_URL` is ever unset, so
a phantom-skip cannot pass silently.

## 5. Next links

- **D3d-2** (separate opt-in): sheet + record + action-guards, real DB.
- Final **`permission-matrix-golden-*.md`** contract consolidates D3d-1 + D3d-2.
- **Open model question** (out of scope): per-record read-deny semantics.
