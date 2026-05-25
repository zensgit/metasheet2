# Multitable D3d — Permission Golden Matrix: Design + Harness Decision (2026-05-25)

Short design/verification doc for D3d: turn the D3c single-point export fix into a
**5-class permission golden contract**, as a **test/acceptance slice** — no RBAC,
auth, or record-deny model changes.

Predecessors: D3a design (#1818) · D3c export field-perm leak fix + 2 green regression
tests (#1820, `cc29c6631`). Source: benchmark v2 §9 #3 / Gap 7.

---

## 0. TL;DR

- D3d = a 5-class golden matrix (sheet/view/field/record/export × granted/denied/inherited)
  asserted against a **real DB** with seeded permission rows.
- **Harness decision (the #1 scout result): a real-DB harness exists, but the default
  `pnpm test` does NOT run it** — `describeIfDatabase` skips without `DATABASE_URL`. D3d
  tests must be wired into a **dedicated CI step** (like the lone after-sales one) or they
  phantom-skip green. This is the [[feedback_metasheet2_skip_when_unreachable_blind_spot]]
  trap; non-skip verification is a hard requirement (§6).
- **Split into two slices** to keep each reviewable: **D3d-1** export + field/view (extends
  the D3c baseline), **D3d-2** sheet/record/action-guards.
- **Record class**: test existing grant/write/admin behavior only. The product has **no
  per-record read-deny** anywhere — that gap is an *open model question*, NOT fixed here.

---

## 1. Harness decision (scout result — do this right or the suite is theater)

**A real-DB integration harness exists and is the right tool:**
- Pattern: `const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip`
  (used by `approval-wp*`, `after-sales-*`).
- Config: `packages/core-backend/vitest.integration.config.ts` + `tests/setup.integration.ts`.
- All 4 permission tables are migration-created → present after `db:migrate`:
  - `field_permissions` — `src/db/migrations/zzzz20260411140100_create_field_permissions.ts`
  - `meta_view_permissions` — `src/db/migrations/zzzz20260411140000_create_meta_view_permissions.ts`
  - `record_permissions` / member-group subjects — `src/db/migrations/zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts`
  - `spreadsheet_permissions` — `migrations/036_create_spreadsheet_permissions.sql`

**The trap (must design around it):** the `Run core-backend tests` step in
`.github/workflows/plugin-tests.yml` (≈L135-137) runs `pnpm --filter @metasheet/core-backend test`
**before Postgres starts and with no `DATABASE_URL`** → all `describeIfDatabase` suites **skip**
there. Real-DB tests only execute in the **dedicated step** (≈L155-161) that sets `DATABASE_URL`,
runs after `db:migrate`, uses `vitest.integration.config.ts`, and currently lists **only**
`after-sales-plugin.install.test.ts`.

**Therefore D3d's harness work (in-scope, the only non-test edit):**
1. Author tests under `describeIfDatabase` using `vitest.integration.config.ts`, seeding real
   rows into the permission tables, asserting through the real route/query path.
2. **Wire a dedicated CI step** in `plugin-tests.yml` (env `DATABASE_URL`, after the migration
   step) that runs the D3d test path — mirror the after-sales step, incl. its
   `: "${DATABASE_URL:?...}"` hard guard.
3. No new infra (postgres service + migrations already present). This is the only change
   outside test files, and it exists solely to make the tests *run* — not product/RBAC code.

## 2. 5-class matrix + tri-state semantics (pin these per class)

`inherited` means different things per class — define explicitly so each cell's expected
value is unambiguous:

| class | `granted` | `denied` | `inherited` |
|---|---|---|---|
| **sheet** | `spreadsheet_permissions` direct grant | no grant + base capability denies | from **base capability** (no sheet-level row) |
| **view** | `meta_view_permissions` grant | view perm denies | from **sheet scope** (no view-level row) |
| **field** | `field_permissions.visible=true` (direct user) | `field_permissions.visible=false` | via **role / member-group** membership (scope-map SQL: `user_roles` / `platform_member_group_members` EXISTS), not direct user row |
| **record** | `record_permissions` read/write/admin | *(N/A — no deny semantic; see §4)* | default-allow when no record row (grant-only model) |
| **export** | `canRead && canExport` | missing `canExport` → 403 | masked set = field/view inherited results applied to export |

Each populated cell = a black-box assertion through the real endpoint. Export cells assert
**both header and cell values** (the leak surface D3c closed).

## 3. Export baseline (from D3c) + what D3d adds

D3c already ships green regression tests for: field hidden via `field_permissions.visible=false`,
and field in `view.hidden_field_ids` — both masked in export header + cells. D3d-1 **extends**
this, it does not redo it:
- Add **inherited** combos: field hidden via **role / member-group** scope (not direct user).
- Add **denied** combos: `canExport` missing → 403; record-scope export behavior per §4.
- Promote the 2 D3c canaries from mock-pool into the real-DB matrix (or keep mock-pool ones as
  fast unit-ish guards and add real-DB equivalents — decide in D3d-1; the Medium review finding
  requires the *golden matrix* itself be real-DB).

## 4. Record class — test reality, do not invent deny

Tracing the view path (`univer-meta.ts` record-permission filter) shows it is a **no-op for
hiding**: `access_level` is a grant-only enum `{read,write,admin}`, `deriveRecordPermissions`
defaults to allow, and all three levels yield `canRead=true`. So **no per-record read-deny
exists anywhere** (view, export, or frontend).

D3d-2 therefore tests **only existing behavior**: record grant escalates write/admin
(`rowActionOverrides`, `ensureRecordWriteAllowed`), and read is sheet-capability-gated, not
per-record. The matrix marks record `denied` as **N/A — open model question**. Adding a deny
semantic (deny `access_level`, or whitelist default-deny) is **product model work, explicitly
out of D3d scope**; D3d only documents the gap.

## 5. Slicing

| slice | scope | builds on |
|---|---|---|
| **D3d-1** | export + field + view classes (granted/denied/inherited), real-DB, + CI wiring step | extends D3c baseline; lower risk |
| **D3d-2** | sheet + record + action-guards (write/delete via record/own-write), real-DB | more net-new; record-deny documented not fixed |

Each is a separate explicit opt-in. D3d-1 first (closest to the shipped fix).

## 6. Non-skip verification (hard requirement)

Per the skip-when-unreachable lesson, "tests pass" is insufficient — they must be proven to
**actually execute**, not skip:
- The dedicated CI step uses the `: "${DATABASE_URL:?...}"` guard (fails if unset).
- The acceptance MD records the CI run showing the D3d suite **ran N tests, skipped 0** (cite
  the job log line), not just green.
- Optionally a sentinel assertion that fails if `DATABASE_URL` is unset inside the suite.

## 7. Boundary (locked)

- **Test/acceptance slice only.** The single non-test edit is the `plugin-tests.yml` CI step that
  runs the suite — pure test plumbing.
- **Never** touch `rbac/service.ts`, `auth/permission-templates.ts`, or any enforcement code.
- **Do not** add a record read-deny model.
- If a class assertion reveals a **new** export-style leak (like D3c's), that fix is a
  **separate** opt-in PR — not folded into D3d.

## 8. Output: the golden contract

D3d's acceptance deliverable = a reproducible matrix MD (`permission-matrix-golden-20260525.md`)
with one row per populated cell: `class · subject-state · seed · endpoint · expected`, plus the
CI non-skip evidence. This is what upgrades the D3c single-point fix into a permission **golden
contract** guarding future cross-base / AI / template work.

## 9. Next links

- **D3d-1** (export+field/view real-DB matrix + CI wiring) — next opt-in.
- **D3d-2** (sheet/record/action guards) — after D3d-1.
- **Open model question** (separate, product): per-record read-deny semantics.
