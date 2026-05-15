# K3 WISE WebAPI Material/BOM read/list - GATE-front verification - 2026-05-15

## What this PR is

Docs-only GATE-front preparation for #1526 finding #2. Companion to
`integration-core-k3wise-webapi-read-list-gate-contract-design-20260515.md`.

**No runtime was implemented or changed.** The K3 PoC Stage 1 Lock forbids
touching `plugins/plugin-integration-core` until the customer GATE PASS, so the
P1 read/list runtime is deferred. This PR locks the contract so the post-GATE
slice is mechanical and reviewable in advance.

## Stage 1 Lock conformance (verified)

| Check | Result | How verified |
| --- | --- | --- |
| No `plugins/plugin-integration-core` change | PASS | `git diff --stat origin/main...HEAD` lists only `docs/**` |
| `read: unsupportedAdapterOperation(...)` unchanged | PASS | `k3-wise-webapi-adapter.cjs:753` not in diff |
| No DB migration | PASS | no file under `**/migrations/**` in diff |
| No API runtime / REST route change | PASS | no `apps/web`, `packages/core-backend`, `scripts/ops` in diff |
| No token/authorityCode/password/session/SQL conn string | PASS | docs use placeholders only; see secret-hygiene self-check below |

Because no runtime changed, there is no local unit test run for this PR. The
test matrix below is the **post-GATE** plan, not a result of this PR.

## Secret-hygiene self-check (run on the doc set in this PR)

Confirmed the three added docs contain no secret-shaped values:

- no `"password":` / `"token":` / `"authorityCode":` / `"sessionId":` literals
  with real values (placeholders `<TBD ...>` / `<redacted>` only),
- no `eyJ` JWT-shaped strings,
- no `?...token=` / `?...secret=` populated query strings,
- no `Server=...;User Id=...;Password=...` SQL connection strings,
- no raw `postgres://user:pass@host` userinfo.

The customer manifest explicitly instructs the customer to redact before
sending and to never paste live auth material into the issue, PR, or sample
files.

## Post-GATE verification matrix (to run when the Lock lifts)

Each row maps to an acceptance criterion in the original task.

| # | Acceptance criterion | Post-GATE test |
| --- | --- | --- |
| A1 | adapter `testConnection` behavior does not regress | re-run existing `k3-wise-adapters.test.cjs` testConnection cases unchanged; assert same `{ ok, status, authenticated }` shape |
| A2 | object discovery still returns material/bom | `listObjects()` includes `material` and `bom`; `operations` now contains `read` only for objects that opted in, still contains `upsert` |
| A3 | schema discovery returns Material/BOM readable fields | `getSchema('material')` -> `FNumber,FName,FModel,FBaseUnitID`; `getSchema('bom')` -> `FParentItemNumber,FChildItemNumber,FQty,FUnitID,FEntryID` (unchanged from today) |
| A4 | read/list mock path returns 1-3 sample records | new `mock-k3wise-webapi-read` fixture; `read({object:'material'})` and `read({object:'bom'})` each return 1-3 projected rows; `list` == `read` with no key filter |
| A5 | read failure -> clear error, not write failure | inject transport error on `readPath`; assert error `code` starts `K3_WISE_READ_`; assert message has no `Save`/`Submit`/`Audit`; assert it does NOT enter the `upsert` error path |
| A6 | `pnpm -F plugin-integration-core test` passes | full plugin test script green, including the new `__tests__/k3-wise-webapi-read.test.cjs` wired into `package.json` `test` |
| A7 | K3 offline PoC continues to pass | `scripts/ops` K3 WISE offline PoC unchanged and green |
| A8 | write path untouched | `previewUpsert`/`upsert`/`buildSaveBody`/autoSubmit/autoAudit tests unchanged and green |

### Mock case detail (A4 / A5)

- `material` mock: 3 rows with distinct `FNumber` (`MAT-001..003`), realistic but
  fully synthetic `FName`/`FModel`/`FBaseUnitID`.
- `bom` mock: 2 rows under one `FParentItemNumber`, distinct `FChildItemNumber`,
  numeric `FQty`/`FEntryID`.
- detail case: `read({object:'material', filter:{number:'MAT-001'}})` returns
  exactly 1 row.
- failure case: fixture toggled to return HTTP 500 / K3 business error;
  adapter must surface `K3_WISE_READ_FAILED` (transport) or
  `K3_WISE_READ_BUSINESS_ERROR` (K3-level), never `K3_WISE_SAVE_FAILED`.

### Live case detail (only after customer provides O1-O6)

- bind customer-confirmed `readPath`/`readMethod`/pagination to an
  external-system JSON config (no migration),
- 1-page Material list, single Material detail, 1-page BOM list, single BOM
  detail,
- assert no secret-shaped value in returned `raw`/records (reuse existing
  payload-redaction test harness),
- read-only: confirm zero Save/Submit/Audit calls issued during read (assert
  request log contains no `savePath`/`submitPath`/`auditPath`).

## Deployment impact

None. Docs-only. No env, no migration, no flag, no route, no bundle change.

## GATE-blocking status

This PR does **not** lift the customer GATE and does not implement P1 runtime.
It records that #1526 P1 K3 WebAPI read/list runtime is **deferred until customer
GATE PASS**, and front-loads the contract + customer intake so the post-GATE
slice is small and pre-reviewed.

## Rollback

Trivial: revert the docs commit. No code or data to reverse.
