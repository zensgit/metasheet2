# Attendance Windows-native QA v2 — PQA-01..10 per-case runbook

**Draft / HOLD. Synthetic data only. No deployment, staging, customer UAT, flag
enablement, external notification, or issue-closure authorization.**

Pinned exact product source SHA (`SOURCE_SHA`, unchanged by this QA-tooling
revision): `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`.

> ## ⚠️ REWORK — read this first (supersedes the per-case *fixtures* + *cleanup* below)
>
> The provisioning + fixtures + cleanup mechanics in the per-case sections below are **superseded**
> by the reworked Node flow in `scripts/ops/windows-qa/` (see that directory's `README.md`). The
> per-case **objectives, product-surface citations, steps, and expected values** below remain the
> authoritative operator reference; only the *how you create/clean* changed. Specifically:
>
> - **Identities are product-minted UUIDs, captured to `.runtime/qa-identities.json`.** The old
>   text ids (`$admin`, `$orgShadow`, …) THREW on the W4/rollout/scheduled paths.
>   `harness/provision-synth-directory.mjs` creates users via the product path
>   (`AuthService.register` → `crypto.randomUUID`) and org anchors via `getOrCreateLocalIntegration`;
>   every reference below now resolves through `qa-identities.json` — no hardcoded ids.
> - **Runtime mode picks the ONE product path** (no fallback, no symlinks): on the Windows package
>   run every `.mjs` below under plain `node` (modules resolve from the shipped
>   `packages/core-backend/dist/src/<subpath>.js`); for the macOS source proof run them under
>   `node --import tsx …` (modules resolve from `src/<subpath>.ts`). A missing path fails with a
>   mode-specific error instead of silently using the other mode's path. See
>   `scripts/ops/windows-qa/README.md` → "Runtime modes".
> - **Cleanup = DROP + recreate the isolated DB** (`node reset-isolated-db.mjs`), NEVER per-row
>   DELETE — the append-only / deny-delete triggers reject deletes (proven: a DELETE on
>   `attendance_calculation_rollout_state` raises `W4C0_IMMUTABLE`). The reset also verifies the DB
>   reached the pinned migration SET (311 names) + that the deny triggers exist and are enabled — the
>   false-zero guard (a partial re-migrate that leaves tables missing would ALSO show zero QA rows).
> - **Export evidence FIRST, then tear down.** For every case, run its named evidence SELECT(s)
>   (the `SELECT …` blocks in each section) and capture the output BEFORE the drop/recreate. Then
>   run `residue-check.sql` as a negative control (must be **> 0** while synthetic rows exist), then
>   `reset-isolated-db.mjs`, then `residue-check.sql` again (must be **0** — that 0 is
>   `summary.json.residue`).
> - **Two evidence kinds; the harnesses write 09/10, the operator records 01..08.**
>   `harness/pqa-05|06|08|09|10-*.mjs` invoke the real route-less product code and emit each case's status
>   + evidence into `<evidence-dir>/summary.json`. A PASS requires the RIGHT structured evidence kind for
>   the case:
>   - **09/10 — machineEvidence@1:** the ONE whitelisted `harnessModule` for that case
>     (PQA-09 ⇒ `pqa-09-outbox-retry.mjs`, PQA-10 ⇒ `pqa-10-scheduled-sweep.mjs`) + that case's EXACT
>     facts schema. A non-whitelisted `harnessModule` or an invented/missing/wrong-typed fact is REJECTED
>     (owner P1). Real product fn end-to-end.
>   - **01/02/03/04/07 — operatorEvidence@1:** a well-formed operator record (`caseId` = the case slot +
>     campaign `runId` + `tester` + UTC `timestamp` + `command`/`route` + `expected`/`observed` + an
>     artifact manifest `{ path, sha256, runId }` + bound `sourceSha`/`qaToolingSha`) from a genuine
>     HTTP/UI run. The runner **RECOMPUTES** the artifact sha over the real file in the evidence dir — a
>     missing/tampered file, a symlink, or a path escaping the dir is REJECTED. A status + long reason
>     with no operatorEvidence, a swapped `caseId`, or a `runId` != `summary.runId` (old-run replay) is
>     REJECTED — but a well-formed operatorEvidence DOES PASS them. (Kinds are strictly partitioned: a
>     machineEvidence on these cases is rejected.)
>   - **05/06/08 — operatorEvidence@1 with a full-boundary attestation:** they stay BLOCKED unless the
>     FULL objective (legacy projection unchanged + shadow rows / review-required + no fabricated
>     projection / old-snapshot-unmutated + mismatch review-required) was truly executed AND attested via
>     `boundaryAttestation`. Their route-less harnesses emit BLOCKED (the full boundary needs the
>     plugin-internal legacyAdapters), and affirming host facts alone never flips them; a thin
>     operatorEvidence does NOT pass them.
>   **Consequence:** a green `--strict` (10/10) **IS reachable — but ONLY via genuine evidence**:
>   whitelisted-harness machineEvidence (09/10) + well-formed operatorEvidence (01..08, with a truthful
>   full-boundary attestation for 05/06/08), with the Windows host safety facts affirmed. Off-Windows the
>   host-safety facts hold everything BLOCKED, and no envelope can be hand-typed to a PASS. The tooling
>   ALONE (no Windows operator, no artifacts) reaches at most **09/10**.
> - **No auth material in Git.** The synthetic login password is operator-set via env
>   `QA_SYNTH_PASSWORD`; `qa-identities.json` holds ids/emails/orgs only.
> - **Operator prerequisite (UNVERIFIED — Windows host):** grant each synthetic user its attendance
>   permission via the product admin UI (QA tooling never writes RBAC): admin→`attendance:admin`,
>   u1→`attendance:write`, u2/u3→`attendance:read`.
>
> **Proven-by-execution (macOS + local PG15) vs operator-verified (Windows-only):** the drop/recreate
> + migration-SET/trigger integrity, the residue negative-control → 0, and harnesses 09/10
> (PASS-eligible via machineEvidence@1) + 05/06/08 (BLOCKED-with-evidence) + 07 create-fixture are proven
> by execution. The `.bat`/PowerShell wrappers, browser-UI + authenticated-HTTP product execution
> (PQA-01/02/03/04/07, recorded as operatorEvidence@1), the login round-trip, the Windows host safety
> facts, and the end-to-end boundary composition for 05/06/08 (PASS only with a truthful
> `boundaryAttestation`) stay `UNVERIFIED — operator to confirm`.

> ## Identity, fixture & residue resolution (READ FIRST — the tokens below are placeholders)
>
> The `$name` tokens throughout this runbook are **placeholders resolved at runtime from
> `.runtime/qa-identities.json`** (written by `harness/provision-synth-directory.mjs`). They are NOT
> literal ids: every org/user id is a UUID at runtime (orgs = the reserved `00000000-0000-4000-8000-…`
> namespace; users = product-minted `crypto.randomUUID()`), which is why the old `qa_synth_*` text ids
> threw on the W4/rollout/scheduled paths. Resolve each placeholder before running:
>
> | placeholder | qa-identities.json path | what it is |
> |---|---|---|
> | `$orgA` | `orgs.orgA` | primary synthetic org |
> | `$orgShadow` | `orgs.orgShadow` | shadow-posture synthetic org (W4 enabled) |
> | `$orgLegacy` | `orgs.orgLegacy` | legacy / outside-allowlist synthetic org |
> | `$orgB` | `orgs.orgB` | the DEDICATED "other org" for PQA-07's cross-org probe. `provision-synth-directory.mjs` creates its directory anchor but adds NO user membership, so `u1` is provably NOT a member — the cross-org 403 target is valid out-of-the-box (no operator hand-creation of an org). `pqa-07-authorization-setup.mjs` asserts `u1` has 0 active memberships in `orgB` before recording the fixture. |
> | `$admin` | `users.admin.id` | `qa-synth-admin@qa.invalid` (attendance:admin) |
> | `$u1` | `users.u1.id` | `qa-synth-u1@qa.invalid` (attendance:write) |
> | `$u2` | `users.u2.id` | `qa-synth-u2@qa.invalid` (attendance:read) |
> | `$u3` | `users.u3.id` | `qa-synth-u3@qa.invalid` (attendance:read) |
>
> **There are no per-case `fixtures/pqa-NN.sql` files — that path never existed.** Creation is
> `provision-synth-directory.mjs` (identities) + this case's harness
> (`harness/pqa-05|06|07|08|09|10-*.mjs`) or, for 01/02/03/04, the operator HTTP/UI steps in the
> section. **Cleanup is drop/recreate (`reset-isolated-db.mjs`), never per-row DELETE** (the append-only
> / deny-delete triggers reject per-row cleanup).
>
> **Residue is measured only by `scripts/ops/windows-qa/residue-check.sql`**, which keys on the REAL
> synthetic markers — the org UUID prefix `00000000-0000-4000-8000-…` and the
> `qa-synth-…@qa.invalid` email namespace — NOT a `… LIKE 'qa_synth_%'` text prefix on
> `id`/`org_id`/`user_id` (those are UUIDs). The per-case `LIKE 'qa_synth_%'` residue snippets below
> are **superseded illustrations**; run `residue-check.sql` instead.

Isolated database (the only accepted name): `metasheet_windows_qa`.

This runbook is the *product-matrix* half of the package. The qa-runner
(`scripts/ops/attendance-windows-native-qa-runner.mjs`) validates SAFETY + SHA
binding only; **the operator** determines each case's PASS/FAIL by executing the
scenario below against synthetic data and comparing observed vs expected, then
records it in `<evidence-dir>/summary.json` (copied from
`scripts/ops/windows-qa/summary.template.json`).

Execution order is owner-specified by risk (README §"Execution order"):
**PQA-07 → 03 → 01 → 02 → 05 → 06 → 08 → 09 → 10 → 04** — follow that order when
executing. Each `## PQA-NN` section below is self-contained; sections are grouped
by product subsystem (authorization, shift authoring, calculation/shadow,
durability/scheduling) rather than strictly re-sorted, so use the section headings
to navigate and the order above to execute.

---

## Citation convention (read before trusting any `file:line`)

1. **Line numbers are from the pinned tree.** This tooling branch changed only
   `docs/` and `scripts/ops/windows-qa/`; `git diff 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b HEAD -- packages plugins apps`
   is empty, so every product `file:line` below is identical at the pinned SHA.
   A reviewer can re-derive this with that one diff.
2. **Attendance DDL lives in `packages/core-backend/src/db/migrations/*.ts`**, as
   Kysely migrations that mix raw ``sql`CREATE TABLE …` `` and the fluent
   `db.schema.createTable(...).addColumn(...)` builder — **not** in
   `packages/core-backend/migrations/*.sql` (only
   `055_create_attendance_import_tokens.sql` lives there, and it is unrelated to
   these cases). Every table/column citation points at the real creation site.
   The fluent builder means a column like `attendance_shifts.timezone` is created
   by an `.addColumn('timezone', …)` call, not a literal `timezone` token on a
   `CREATE TABLE` line — grep the migration file, not just its first line.
3. **Two HTTP route surfaces.**
   - Plugin routes are registered as
     `context.api.http.addRoute('<METHOD>', '<path>', <handler>)` in
     `plugins/plugin-attendance/index.cjs` (the method is the 1st arg, the path
     the 2nd — e.g. lines 29196–29199 register `POST /api/attendance/punch`).
   - Core-backend admin routes are Express
     `r.get|r.post('<path>', <guard>, <handler>)` in
     `packages/core-backend/src/routes/attendance-admin.ts`.
4. **UNVERIFIED markers.** Anything requiring a running server, a real login /
   session, `.bat`/PowerShell behavior, or a browser click path is written as
   `UNVERIFIED — operator to confirm`. Those are instructions to verify, not
   asserted facts. An honestly-marked gap is correct; a confident invention is a
   defect.
5. **Synthetic marking (UUIDs, not a text prefix).** Org and user ids are UUIDs
   at runtime — orgs are the reserved `00000000-0000-4000-8000-…` namespace and
   users are product-minted `crypto.randomUUID()`, captured to
   `.runtime/qa-identities.json` (resolve the `$name` placeholders from there; see
   the resolution table above). Synthetic USERS are detected by the
   `qa-synth-…@qa.invalid` **email** namespace and orgs by the UUID prefix — that is
   how `residue-check.sql` keys; shift `name` stays a free-text synthetic marker.
   There is no `… LIKE 'qa_synth_%'` keying on `id`/`org_id`/`user_id`.

---

## PQA-07 — Authorization isolation

**Objective (matrix).** Same-org other-user, cross-org, forged witness, and
inactive membership probes fail before result SQL.

### Product surface

Result-read route (self calculation detail), guarded, org/membership-checked
BEFORE any result SQL:

- `packages/core-backend/src/routes/attendance-admin.ts:1512` —
  `r.get('/api/attendance/records/:recordId/calculation-detail', rbacGuard('attendance', 'read'), async (req, res) => {`
  - `userId` query param is rejected outright:
    `attendance-admin.ts:1514-1516` → 400 `USER_ID_NOT_ACCEPTED`.
  - active membership is resolved from the directory BEFORE the read:
    `attendance-admin.ts:1524-1531` —
    `SELECT uo.org_id FROM user_orgs uo JOIN users u ON u.id = uo.user_id WHERE uo.user_id = $1 AND uo.is_active = true AND u.is_active = true`.
  - no active membership → 403 `FORBIDDEN` ("No active org membership"):
    `attendance-admin.ts:1535`.
  - requested `orgId` not among active memberships → 403 `FORBIDDEN`
    ("orgId does not match an active org membership"): `attendance-admin.ts:1539`.
  - only AFTER those checks is the result SQL invoked:
    `attendance-admin.ts:1541-1546` (`readAttendanceCalculationDetail`).

Result SQL (subject-scoped; fires only after authorization):

- `packages/core-backend/src/services/AttendanceW4CalculationDetail.ts:512-524`
  — `FROM attendance_records r … WHERE r.id = $1::uuid AND r.org_id = $2` plus the
  subject predicate `AND r.user_id = $3` (`:510`, bound to the caller's own id at
  the route, `attendance-admin.ts:1543`). A record owned by another user returns
  `ATTENDANCE_CALCULATION_DETAIL_NOT_FOUND` even at the SQL layer.

Forged-witness (WRITE path) authorization — in-process branded witness, never
accepted from request JSON:

- `packages/core-backend/src/attendance/w4c0-authorization.ts:240` —
  `export function verifyAuthorizedAttendanceWriteContextV1(context: unknown)`;
  a plain object / spread / JSON clone / prototype lookalike / mutated witness
  fails the `WeakMap` digest recheck and throws
  `ATTENDANCE_WRITE_NOT_AUTHORIZED` (`w4c0-authorization.ts:257-260`) **before any
  source/result DML**.
- Transaction-bound liveness/membership recheck (a directory deprovision or
  membership deactivation between mint and use invalidates the witness):
  `w4c0-authorization.ts:310` —
  `export async function recheckAttendanceActorLivenessInTransactionV1(...)`,
  querying `users.is_active`/`activation_status` (`:322-328`) and
  `user_orgs.is_active` (`:329-335`).
- The witness is documented as "an in-process branded value, never request JSON"
  (`w4c0-authorization.ts:1-17`): there is **no route parameter by which an HTTP
  client supplies or forges a witness**, so the forged-witness probe is an
  in-process invariant, covered by the unit suites
  `packages/core-backend/src/attendance/__tests__/w4c0-identity.test.ts` and
  `w4c0-operation-layer.test.ts`. See Steps P5.

### Tables / columns (with creation sites)

- `users` — `packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:9`
  (`createTable('users')`); `id text` (`:11`), `email text` (`:12`, unique index
  `:26`), `permissions jsonb` (`:16`), `is_active boolean` (`:18`).
  `activation_status text` added by
  `zzzz20260723140000_add_users_activation_status_and_local_password_set.ts:22`.
- `user_orgs` — `zzzz20260114110000_create_user_orgs_table.ts:11`
  (`createTable('user_orgs')`); `user_id text` (`:13`), `org_id text` (`:14`),
  `is_active boolean` (`:15`); PK `(user_id, org_id)` (`:25`).
- `attendance_records` — `zzzz20260114090000_create_attendance_tables.ts:54`
  (`createTable('attendance_records')`); `user_id text` (`:57`), `work_date date`
  (`:58`), `timezone varchar(64)` (`:59`). `org_id text NOT NULL DEFAULT 'default'`
  added by `zzzz20260114100000_add_attendance_org_id.ts:39`.
  `current_calculation_id uuid` (nullable) added by
  `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:1085`;
  `projection_owner`/`visibility_state`/`visibility_reason` at `:1088/:1092/:1096`.
- `attendance_record_calculations` (LEFT JOIN in the read) —
  `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:470`.

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-07.sql` exists — create = this case’s setup `harness/pqa-07-authorization-setup.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section).

The setup is **FAIL-CLOSED on pre-existing records**: if any `attendance_records` row already exists
for `$u1`/`$u2`, it REFUSES (throws, non-zero exit) instead of proceeding or duplicating — that state
means the isolated DB was not drop/recreated since the last run. Reset + re-provision, then re-run it.

It seeds:

- orgs (text ids only; no `orgs` table row is required — `org_id` is free-text on
  `user_orgs`/`attendance_records`): `$orgA`, `$orgB`.
- users: `$u1` (active), `$u2` (active, same-org other user),
  `$u3` (active user row, but INACTIVE org membership). All carry
  `permissions '["attendance:read"]'::jsonb`.
- `user_orgs`: `($u1, $orgA, true)`,
  `($u2, $orgA, true)`, `($u3, $orgA, false)`.
- `attendance_records`: one row for `$u1` and one for `$u2`, both
  in `$orgA`, `current_calculation_id` left NULL (a record with no
  calculation returns HTTP 200 with `calculation: null` — see
  `AttendanceW4CalculationDetail.ts:528-531` — a clean positive control needing no
  hand-crafted calculation row).

### Steps (exact API calls)

Session acquisition (obtaining a logged-in session/token for `$u1` and
`$u3` that carries `attendance:read`) requires the running server's login
flow: `UNVERIFIED — operator to confirm`. The RBAC evaluation of
`rbacGuard('attendance', 'read')` against the seeded `users.permissions` is also
operator-observed at runtime. Capture the two seeded record ids as
`{u1_record_id}` / `{u2_record_id}` from the fixture output.

- **P1 (positive control).** As `$u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail`
- **P2 (same-org other-user via param).** As `$u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail?userId=$u2`
- **P2b (same-org other-user via foreign recordId — subject-scoped SQL).** As
  `$u1`:
  `GET /api/attendance/records/{u2_record_id}/calculation-detail`
- **P3 (cross-org).** As `$u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail?orgId=$orgB`
- **P4 (inactive membership).** As `$u3`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail`
- **P5 (forged witness — in-process, WRITE path).** There is no HTTP surface that
  accepts a witness; run the in-process unit probe:
  `pnpm --filter @metasheet/core-backend test w4c0-operation-layer` and confirm a
  forged/plain-object write context is rejected with
  `ATTENDANCE_WRITE_NOT_AUTHORIZED`. Exact command/runner is
  `UNVERIFIED — operator to confirm`; the code path is
  `w4c0-authorization.ts:240-260`.

### Expected (observable values to compare)

- **P1** → HTTP 200, JSON body `{ ok: true, data: { recordId: "{u1_record_id}", calculation: null, segments: [], current: … } }`.
- **P2** → HTTP 400, error code `USER_ID_NOT_ACCEPTED` (rejected before the result
  SQL runs). `attendance-admin.ts:1515`.
- **P2b** → HTTP 404, error code `CALCULATION_DETAIL_NOT_FOUND` (the result SQL's
  `AND r.user_id = $3` excludes another user's record).
- **P3** → HTTP 403, error code `FORBIDDEN` ("orgId does not match an active org
  membership"), before the result SQL. `attendance-admin.ts:1539`.
- **P4** → HTTP 403, error code `FORBIDDEN` ("No active org membership"), before
  the result SQL. `attendance-admin.ts:1535`.
- **P5** → in-process rejection `ATTENDANCE_WRITE_NOT_AUTHORIZED`; no source/result
  DML executed.

PASS requires P1 and every negative probe (P2–P4) to match, and P2b/P5 to hold or
be honestly recorded as operator-confirmed.

### Residue SQL (rows this case created)

Per-case residue (must be 0 after cleanup):

```sql
SELECT
    (SELECT count(*) FROM users        WHERE id      LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs    WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  AS pqa_07_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-07.sql` exists — create = this case’s setup `harness/pqa-07-authorization-setup.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section) — deletes the
`attendance_records`, `user_orgs`, and `users` rows this case created (synthetic
`qa_synth_*` keys only).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-07"`: `status` = PASS|FAIL|BLOCKED,
`syntheticDataOnly` = true (only `qa_synth_*` orgs/users/records used), `reason` =
observed HTTP statuses/codes for P1–P4, the P2b/P5 disposition, and this case's
residue count.

---

## PQA-03 — Timezone validation

**Objective (matrix).** Valid IANA timezone succeeds; invalid or offset-less
authoritative input fails closed.

### Product surface

Shift-write routes (both apply the single strict W4 IANA validator BEFORE
persisting):

- `plugins/plugin-attendance/index.cjs:46030-46032` —
  `context.api.http.addRoute('POST', '/api/attendance/shifts', withPermission('attendance:admin', …))`;
  timezone guard at `index.cjs:46040-46044`
  (`if (parsed.data.timezone !== undefined && respondUnlessStrictIanaTimezoneWrite(res, parsed.data.timezone)) return`).
- `plugins/plugin-attendance/index.cjs:46069-46071` —
  `context.api.http.addRoute('PUT', '/api/attendance/shifts/:id', withPermission('attendance:admin', …))`;
  same guard at `index.cjs:46079-46083`.

The guard and validator:

- `plugins/plugin-attendance/index.cjs:24660` —
  `const respondUnlessStrictIanaTimezoneWrite = (res, zone, fieldName = 'timezone') => {`;
  on validator throw it responds HTTP 400 `VALIDATION_ERROR`
  "`<field> must be a valid IANA time zone`" (values-free, the submitted zone is
  never echoed — `index.cjs:24674-24678`); if the port is absent it fails closed
  503 `W4_TIMEZONE_VALIDATOR_UNAVAILABLE` (`index.cjs:24663-24668`).
- The single strict validator:
  `packages/core-backend/src/attendance/w4c1-strict-time.ts:119` —
  `export function validateAttendanceIanaTimezoneV1(zone: unknown): string {`.
  Rejects (throws `W4C1_TIMEZONE_INVALID`): non-string/empty (`:121`), any
  whitespace (`:122`), and **offset-style zones** such as `"+08:00"` /
  `"-05:00"` (`:126` — "an offset can never masquerade as a zone"); rejects any
  identifier `Intl.DateTimeFormat` cannot construct (`:127-131`); returns the zone
  unchanged on success (`:132`). Wired as the port method `validateIanaTimezone`
  at `packages/core-backend/src/index.ts:2099`.

Route body shape: `shiftCreateSchema` (`index.cjs:25955`), `timezone` optional
string (`index.cjs:25957`).

### Tables / columns (with creation sites)

- `attendance_shifts` — `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:13`
  (`createTable('attendance_shifts')`); `timezone varchar(64) NOT NULL DEFAULT 'UTC'`
  at `:18`; `org_id text` at `:16`, `name text` at `:17`. The canonical writer for
  this table is `plugins/plugin-attendance/lib/attendance-shift-service.cjs`
  (header `:8`), `createShift` at `:643`.

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-03.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): one admin
user `$admin` (`permissions '["attendance:admin"]'`) and its active
membership in `$orgA`. No shift is pre-seeded — the valid step T1 creates
one.

### Steps (exact API calls)

Session/RBAC for `$admin` carrying `attendance:admin`:
`UNVERIFIED — operator to confirm`. All bodies below are the request JSON.

- **T1 (valid IANA).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_tz", "timezone": "Asia/Shanghai", "segments": [{ "startTime": "09:00", "endTime": "18:00" }], "orgId": "$orgA" }`
- **T2 (invalid identifier).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_tz_bad", "timezone": "Not/AZone", "segments": [{ "startTime": "09:00", "endTime": "18:00" }], "orgId": "$orgA" }`
- **T3 (offset masquerade).** same body, `"timezone": "+08:00"`.
- **T4 (whitespace).** same body, `"timezone": " "`.

### Expected (observable values to compare)

- **T1** → HTTP 201, `{ ok: true, data: { … timezone: "Asia/Shanghai" … } }`; one
  `attendance_shifts` row written.
- **T2 / T3 / T4** → HTTP 400, error code `VALIDATION_ERROR`, message
  "`timezone must be a valid IANA time zone`"; **no** `attendance_shifts` row
  written (the guard returns before `createShift`). T3 specifically exercises the
  offset-rejection at `w4c1-strict-time.ts:126`.

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_shifts          WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments  WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                  WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                      WHERE id LIKE 'qa_synth_%')
  AS pqa_03_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-03.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section) — deletes the
synthetic shift(s) (segments first, then shift), the membership, and the admin
user.

### Evidence (summary.json fields)

Set `cases[] where id="PQA-03"`: `status`, `syntheticDataOnly=true`, `reason` =
observed statuses for T1–T4 (esp. T3 offset rejection) and the residue count.

---

## PQA-01 — Multi-segment authoring

**Objective (matrix).** Create a two-segment shift, reopen it, and confirm
ordering/times/timezone are retained.

### Product surface

- Create: `plugins/plugin-attendance/index.cjs:46030-46032` —
  `context.api.http.addRoute('POST', '/api/attendance/shifts', withPermission('attendance:admin', …))`;
  handler calls `getAttendanceShiftService().createShift(db, { orgId, input })`
  (`index.cjs:46054`).
- Reopen (read one): `plugins/plugin-attendance/index.cjs:46000-46002` —
  `context.api.http.addRoute('GET', '/api/attendance/shifts/:id', withPermission('attendance:admin', …))`;
  handler calls `getAttendanceShiftService().readShift(db, { orgId, shiftId })`
  (`index.cjs:46013`).
- List: `plugins/plugin-attendance/index.cjs:45963-45965` —
  `context.api.http.addRoute('GET', '/api/attendance/shifts', …)`.
- Request body: `shiftCreateSchema` (`index.cjs:25955`), `segments` =
  `z.array(shiftSegmentInputSchema).min(1).max(3)` (`index.cjs:25961`);
  `shiftSegmentInputSchema` (`index.cjs:25933`) =
  `{ segmentIndex?, startTime, endTime, startDayOffset?(0), endDayOffset?(0|1) }`.
- Canonical writer/reader (the ONE writer for `attendance_shifts` +
  `attendance_shift_segments`, header `attendance-shift-service.cjs:8`):
  `createShift` at `attendance-shift-service.cjs:643` (segment INSERT at
  `:616-617`, dense `segment_index` assigned by array position, `:376`);
  `readShift` at `:919` → `readShiftWithSegments` at `:633`, segments returned
  **ordered by `segment_index`** (`:585`, re-sorted `:848`).

### Tables / columns (with creation sites)

- `attendance_shift_segments` —
  `packages/core-backend/src/db/migrations/zzzz20260724120000_create_attendance_shift_segments.ts:109`
  (`.createTable(SEGMENTS)`, `SEGMENTS='attendance_shift_segments'` at `:41`);
  columns `org_id` (`:112`), `shift_id` (`:113`), `segment_index integer`
  (`:114`), `start_time time` (`:115`), `start_day_offset` (`:116`), `end_time time`
  (`:117`), `end_day_offset` (`:118`); unique `(shift_id, segment_index)` at `:152`;
  `segment_index BETWEEN 0 AND 2` (`:121`), `end_day_offset IN (0,1)` (`:123`). The
  table **deliberately carries no timezone column — every segment uses the parent
  `attendance_shifts.timezone`** (migration header `:7-9`).
- `attendance_shifts.timezone` — as in PQA-03,
  `zzzz20260114120000_add_attendance_scheduling_tables.ts:18`.
- Product design lock reference:
  `docs/development/attendance-shift-group-advanced-capability-design-lock-20260723.md`
  §3.1 (cited by the migration header `:2-3`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-01.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin user
`$admin` + active membership in `$orgA`. The shift itself is
created by step A1 (this case is authoring).

### Steps (exact API calls)

Session/RBAC for `$admin`: `UNVERIFIED — operator to confirm`.

- **A1 (create two-segment shift).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_2seg", "timezone": "Asia/Shanghai", "segments": [ { "startTime": "09:00", "endTime": "12:00" }, { "startTime": "13:00", "endTime": "18:00" } ], "orgId": "$orgA" }`
  — capture `data.id` as `{shift_id}`.
- **A2 (reopen).** `GET /api/attendance/shifts/{shift_id}`.

### Expected (observable values to compare)

- **A1** → HTTP 201; `data.segments` has 2 entries with `segmentIndex` 0 then 1.
- **A2** → HTTP 200; `data.timezone === "Asia/Shanghai"`; `data.segments` length 2,
  **ordered** `segmentIndex` 0,1; segment 0 `startTime`/`endTime` = 09:00 / 12:00,
  segment 1 = 13:00 / 18:00 (both `startDayOffset`/`endDayOffset` = 0). The exact
  time serialization (`"09:00"` vs `"09:00:00"`) is server-normalized:
  `UNVERIFIED — operator to confirm` the surface form, but the ordering, the two
  distinct segments, and the retained parent timezone are the invariant to assert.

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_shifts          WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments  WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                  WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                      WHERE id LIKE 'qa_synth_%')
  AS pqa_01_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-01.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section) — deletes the
synthetic shift's segments, the shift, the membership, and the admin user.

### Evidence (summary.json fields)

Set `cases[] where id="PQA-01"`: `status`, `syntheticDataOnly=true`, `reason` =
observed segment ordering/times/timezone from A2 and the residue count.

---

## PQA-02 — Overnight attribution

**Objective (matrix).** Assign an overnight multi-segment shift and verify next-day
punch evidence stays on the intended business workDate.

### Product surface

- Punch route: `plugins/plugin-attendance/index.cjs:29196-29198` —
  `context.api.http.addRoute('POST', '/api/attendance/punch', withPermission('attendance:write', …))`
  (method literal `'POST'` at `:29197`, path `'/api/attendance/punch'` at `:29198`);
  body `punchSchema` (`index.cjs:29200` parse; schema `:25914`) — `eventType`
  (`'check_in'|'check_out'`) required, `occurredAt`/`timezone`/`source`/`orgId`
  optional, self-scoped (no `userId` in body).
- Shift authoring (overnight, two segments): `POST /api/attendance/shifts`
  (`index.cjs:46030-46032`) with a segment carrying `endDayOffset: 1`
  (`shiftSegmentInputSchema`, `index.cjs:25938`, `endDayOffset ∈ {0,1}`).
- Assignment: `plugins/plugin-attendance/index.cjs:46883-46885` —
  `context.api.http.addRoute('POST', '/api/attendance/assignments', …)`; body
  `assignmentCreateSchema` (`index.cjs:25971`) — `userId`, `shiftId`, `startDate`
  required.
- Work-date resolver (the overnight attribution logic):
  `plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs` —
  `createAttendanceWorkDateResolver` (`:576`), `resolve` (`:700`),
  `selectAmongMatchingCandidates` (`:371`). Overnight branches: open previous-night
  record → `REASON.OPEN_PREVIOUS_NIGHT_RECORD` (`:397-422`); post-midnight
  containing shift → `REASON.PREVIOUS_NIGHT_CONTAINING_SHIFT` (`:463-485`);
  irreducible overlap fails closed to ambiguity (`:514-518`).
- Punch handler → resolver wiring: `index.cjs:29274`
  (`resolvePunchWorkDateByShiftWindow`, def `:15624`, resolver built `:15640-15648`)
  → adapter `plugins/plugin-attendance/lib/attendance-work-date-adapters.cjs:32-35`.
  On ambiguity the route returns HTTP 422 `WORK_DATE_ATTRIBUTION_AMBIGUOUS`
  (`index.cjs:29285-29296`); on `resolved` it adopts the resolver's (possibly
  previous-day) workDate (`index.cjs:29297`).

### Tables / columns (with creation sites)

- `attendance_events.work_date date NOT NULL` —
  `packages/core-backend/src/db/migrations/zzzz20260114090000_create_attendance_tables.ts:35`.
- `attendance_records.work_date date NOT NULL` — same file `:58` (unique
  `(user_id, work_date, org_id)` re-created by
  `zzzz20260114100000_add_attendance_org_id.ts:45-48`).
- `attendance_shift_assignments` —
  `zzzz20260114120000_add_attendance_scheduling_tables.ts:35` (`user_id` `:39`,
  `shift_id` `:40`, `start_date` `:43`, `is_active` `:45`, `org_id` `:38`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-02.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin
`$admin` (`attendance:admin`) and punching user `$u1`
(`attendance:write`), both active members of `$orgA`. The overnight shift,
assignment, and punches are produced by the product in the steps.

### Steps (exact API calls)

Sessions for `$admin` / `$u1`: `UNVERIFIED — operator to confirm`.

- **O1 (overnight two-segment shift).** As admin: `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_overnight", "timezone": "Asia/Shanghai", "isOvernight": true, "segments": [ { "startTime": "08:00", "endTime": "12:00" }, { "startTime": "20:00", "endTime": "04:00", "endDayOffset": 1 } ], "orgId": "$orgA" }`
  — capture `{shift_id}`. This envelope satisfies the canonical service's segment
  contract (`attendance-shift-service.cjs:379-444`): each `startDayOffset=0`
  (`:404-405`), one segment crosses midnight via `endDayOffset=1` (`:407-409`,
  `:439-441`), segments are ordered/non-overlapping after offsets (`:433`), and the
  total planned minutes = 720 ∈ (0, 24h] (`:442-444`). (The example
  `20:00→23:59` + `00:00→04:00(+1)` would be rejected — total > 24h — so this shape
  is used instead.)
- **O2 (assign).** As admin: `POST /api/attendance/assignments`
  `{ "userId": "$u1", "shiftId": "{shift_id}", "startDate": "2026-01-05", "orgId": "$orgA" }`.
- **O3 (evening check-in, business day 2026-01-05).** As `$u1`:
  `POST /api/attendance/punch`
  `{ "eventType": "check_in", "occurredAt": "2026-01-05T20:05:00+08:00", "timezone": "Asia/Shanghai" }`.
- **O4 (next-morning check-out, calendar day 2026-01-06).** As `$u1`:
  `POST /api/attendance/punch`
  `{ "eventType": "check_out", "occurredAt": "2026-01-06T03:30:00+08:00", "timezone": "Asia/Shanghai" }`.

### Expected (observable values to compare)

- **O3/O4** → HTTP 2xx, `resolved`. The **key assertion**: the check-out punch,
  though it occurs on calendar day 2026-01-06, is attributed to business
  **`work_date = 2026-01-05`** — both the `attendance_events` row for O4 and the
  consolidated `attendance_records` row carry `work_date = 2026-01-05` (the
  previous-night containing shift, `attendance-work-date-resolver.cjs:463-485`).
  Verify via SQL:
  `SELECT event_type, work_date FROM attendance_events WHERE org_id='$orgA' AND user_id='$u1' ORDER BY occurred_at;`
  and `SELECT work_date FROM attendance_records WHERE org_id='$orgA' AND user_id='$u1';`
- A next-day punch must **not** create a second `attendance_records` row on
  2026-01-06 for this shift.

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_events            WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records           WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_assignments WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments    WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shifts            WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                    WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                        WHERE id LIKE 'qa_synth_%')
  AS pqa_02_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-02.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-02"`: `status`, `syntheticDataOnly=true`, `reason` =
the observed `work_date` of the O4 event/record (must be 2026-01-05) and the
residue count.

---

## PQA-05 — Shadow posture

**Objective (matrix).** Exact synthetic-org shadow keeps the legacy projection and
appends W4 shadow evidence.

### Product surface

W4 posture is controlled by TWO gates — **there is no HTTP route to flip it**:

1. Env allowlist (exact-org match, wildcard never counts):
   `packages/core-backend/src/attendance/w4c0-identity.ts:363`
   (`const SEGMENT_CALCULATION_ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'`),
   predicate `isOrgExactlyAllowlisted` (`:366`), exported
   `isAttendanceCalculationOrgAllowlistedV1` (`:381`).
2. Persisted rollout state, resolved by `resolveSegmentCalculationPosture`
   (`w4c0-identity.ts:454`, decision core `:475-487`). Closed states
   `ATTENDANCE_ROLLOUT_STATES_V1 = ['legacy','shadow','eligible','authoritative','suspended']`
   (`:78-85`); write postures
   `ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1 = ['legacy_projection_only','shadow','authoritative']`
   (`:71-76`).

The state is mutated only by the internal command
`transitionAttendanceCalculationRolloutV1`
(`packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1125`; module
header `:3-4` states it "deliberately have no PluginServices, route, flag, or index
surface" — only test callers today), gated by the allowlist at `:1162-1163`
(`W4C3A_ROLLOUT_CONTROL_ORG_NOT_ALLOWLISTED`).

Shadow evidence is appended without changing the legacy projection: a
`mode='shadow'` calculation row is DB-forced to `projection_effect='none'`
(`chk_arc_shadow_effect`,
`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:749`),
so the legacy `attendance_records` projection is untouched while a shadow
`attendance_record_calculations` row is appended. The shadow write literal
`'none'`/`'shadow'` is at
`packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts:758`.

### Tables / columns (with creation sites)

- `attendance_calculation_rollout_state` —
  `zzzz20260725120000_...durable_storage.ts:993`; `org_id text PRIMARY KEY` (`:994`),
  posture column **`state`** (`:995`, values = the `ROLLOUT_STATES` closed set,
  migration `:201`), `scope text` (`:1002`) pinned to `'synthetic_staging'` by
  `chk_acrs_scope` (`:1005`),
  `engine_version`/`reason_code`/`actor_id`/`version`/`prior_state`
  (`:996-1001`); the INSERT-guard trigger admits only `state='legacy'`/
  `prior_state NULL`/`version=1` as a bootstrap and `legacy→shadow` thereafter
  (`:1040-1050`, `:1055-1063`). Companion
  `attendance_calculation_rollout_events` (`:1011`, `org_id` `:1013`).
- `attendance_record_calculations` (the shadow evidence) — `:655`; `org_id`
  (`:657`), `attendance_record_id` (`:658`), `mode` (`:661`, `CHECK mode IN ('shadow','authoritative')` `:711`),
  `entrypoint` (`:662`), `outcome` (`:681`), `projection_effect` (`:683`),
  `shadow_diff_code` (`:693`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-05.sql` exists — create = this case’s harness `harness/pqa-05-rollout.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin + user
in **`$orgShadow`**, plus a bootstrap `attendance_calculation_rollout_state`
row `state='legacy'` (`prior_state` NULL, `scope='synthetic_staging'`) — the only
INSERT shape the state-guard trigger admits.

### Steps

1. **Env + posture (UNVERIFIED — operator to confirm).** Set
   `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED=$orgShadow` on the host,
   then move the rollout state `legacy → shadow` for `$orgShadow` via the
   internal command `transitionAttendanceCalculationRolloutV1`
   (`w4c3a-rollout-control.ts:1125`) — **no HTTP route exists**, so this is a
   node/test-harness invocation; the exact runner is operator-confirmed.
2. **Drive one calculation** for a synthetic record in `$orgShadow`
   (e.g. a punch via `POST /api/attendance/punch`, then the W4 boundary evaluates
   in shadow). The in-process boundary path is
   `w4c2-live-scheduled-boundary.ts` — `UNVERIFIED — operator to confirm` the
   host wiring that reaches it.

### Expected

- The legacy `attendance_records` projection for the subject is **present and
  unchanged** (no W4 mutation of `status`/`work_minutes`).
- Exactly one appended `attendance_record_calculations` row with `mode='shadow'`
  and, by `chk_arc_shadow_effect`, `projection_effect='none'`:
  `SELECT mode, projection_effect, outcome FROM attendance_record_calculations WHERE org_id='$orgShadow';`
- `attendance_calculation_rollout_state.state = 'shadow'` for `$orgShadow`.

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_record_calculations         WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_segments             WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_state   WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_events  WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                     WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_events                      WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                              WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                                  WHERE id LIKE 'qa_synth_%')
  AS pqa_05_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-05.sql` exists — create = this case’s harness `harness/pqa-05-rollout.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section). Also unset
`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (operator).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-05"`: `status`, `syntheticDataOnly=true`, `reason` =
the legacy-projection-unchanged observation, the appended `mode='shadow'`/
`projection_effect='none'` row, and residue. If env/posture activation could not be
performed, record BLOCKED with the UNVERIFIED note rather than inventing PASS.

---

## PQA-06 — Ambiguous evidence

**Objective (matrix).** Duplicate/ambiguous candidates produce review-required,
never a fabricated authoritative projection.

### Product surface

Two distinct ambiguity boundaries, both fail-closed:

1. **Work-date attribution ambiguity (punch route).** When the resolver cannot pick
   one business workDate, `selectAmongMatchingCandidates` returns ambiguity
   (`attendance-work-date-resolver.cjs:514-518`) and the punch route returns HTTP
   422 `WORK_DATE_ATTRIBUTION_AMBIGUOUS` (`plugins/plugin-attendance/index.cjs:29285-29296`)
   — no calculation/record projection is fabricated.
2. **Segment duplicate/ambiguous match (calculator).** Duplicate check-in/out or an
   ambiguous segment match selects the review outcome:
   `packages/core-backend/src/attendance/w4c1-segment-calculator.ts:913-919`
   (`return review('duplicate_check_in' | 'duplicate_check_out' | 'ambiguous_segment_match')`);
   `review()` helper `:179-183` emits `{ outcome: 'review_required', … }` (result
   union `:172-177` has only `'completed' | 'review_required'`).

The persisted guarantee ("never a fabricated authoritative projection"): a
`review_required` calculation is DB-forced to carry no projection —
`chk_arc_review_shape`
(`zzzz20260725120000_...durable_storage.ts:750-756`: `projection_effect='none'`,
`expected_segment_count=0`, all `projected_*` NULL). At the record level a review
retires a placeholder instead of publishing —
`attendance_records.visibility_state='retired'` / `visibility_reason='review_placeholder'`
(`w4c3a-canonical-import-kernel.ts:859-860`; column/constraint
`zzzz20260725120000_...:1092`, `:1107-1108`, `:1121-1122`).

### Tables / columns (with creation sites)

- `attendance_record_calculations.outcome text NOT NULL` (`:681`), allowed values
  `OUTCOMES = ['baseline','completed','review_required','reversed']` (migration
  `:117`), `CHECK chk_arc_outcome` (`:718`), review-reason pairing
  `chk_arc_outcome_reason_pair` (`:721-726`), review shape `chk_arc_review_shape`
  (`:750-756`); `projection_effect` (`:683`, values
  `['none','set_active','set_retired']` `:155`).
- `attendance_records.visibility_state` (`:1092`, `'active'|'retired'`),
  `visibility_reason` (`:1096`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-06.sql` exists — create = this case’s harness `harness/pqa-06-ambiguous.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin + user in
`$orgA` (for the route-422 flavor) / `$orgShadow` (for the
calculator review flavor, which needs W4 enabled — see PQA-05). Duplicate
punches/overlapping shifts are produced in the steps.

### Steps

- **R1 (attribution ambiguity → 422, no fabrication).** Construct overlapping shift
  windows for `$u1` (two assignments whose windows both contain the punch
  instant) — `UNVERIFIED — operator to confirm` the exact overlapping-window
  construction — then `POST /api/attendance/punch` at the overlapping instant.
- **R2 (segment duplicate → review_required).** With W4 enabled for the org (per
  PQA-05), punch **two** `check_in` events into the same segment/workDate so the
  calculator sees `duplicateIn` (`w4c1-segment-calculator.ts:915`), then let the
  boundary evaluate. `UNVERIFIED — operator to confirm` the calculation trigger.

### Expected

- **R1** → HTTP 422 `WORK_DATE_ATTRIBUTION_AMBIGUOUS`; **no**
  `attendance_records`/`attendance_record_calculations` row fabricated for that
  instant.
- **R2** → a `attendance_record_calculations` row with `outcome='review_required'`
  and (enforced) `projection_effect='none'`, `expected_segment_count=0`, all
  `projected_*` NULL; the record's `visibility_state='retired'`,
  `visibility_reason='review_placeholder'`. No authoritative projection is written:
  `SELECT outcome, projection_effect, expected_segment_count, projected_status FROM attendance_record_calculations WHERE org_id LIKE 'qa_synth_%' AND outcome='review_required';`

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_record_calculations WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_segments     WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records             WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_events              WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_assignments   WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments      WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shifts              WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                      WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                          WHERE id LIKE 'qa_synth_%')
  AS pqa_06_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-06.sql` exists — create = this case’s harness `harness/pqa-06-ambiguous.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-06"`: `status`, `syntheticDataOnly=true`, `reason` = the
422 for R1 and the `review_required`/`projection_effect='none'` row for R2 (or
BLOCKED with the UNVERIFIED note if W4 could not be enabled).

---

## PQA-08 — Fingerprint freeze

**Objective (matrix).** Changing a shift definition does not mutate an old
snapshot; a new mismatch becomes review-required.

### Product surface

- Payload fingerprint:
  `packages/core-backend/src/attendance/w4c3b-request-snapshots.ts:430` —
  `export function computeAttendanceRequestPayloadFingerprintV1(payload): string`
  (SHA-256 over the normalized canonical payload, `:430-444`).
- **Snapshots are append-only / immutable** (the "old snapshot is not mutated"
  half): the fingerprint index is deliberately **non-unique** so an A→B→A edit
  appends version 3 rather than overwriting
  (`zzzz20260725120000_...durable_storage.ts:645-649`); the business-edit path
  "append exactly one / next version" (`w4c3b-request-snapshots.ts:1093-1094`);
  and there is **no UPDATE/DELETE path** for the table in
  `packages/core-backend/src` (only SELECT/INSERT/CREATE).
- **Mismatch → review-required** (finding — the review-required mapping is NOT in
  the two files the risk matrix hint named; those only append snapshots /
  classify rollout defects). The actual "changed shift definition → live
  source-definition fingerprint no longer equals the frozen one → review" is in the
  calculation boundary:
  `packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts:1630-1635`
  (`fingerprintMismatch` → `outcome = 'review_required'`,
  `outcomeReasonCode = 'context_mismatch'`), backed by the lower-level frozen
  context/attribution identity guard
  `packages/core-backend/src/attendance/w4c1-segment-calculator.ts:853-862`
  (`return review('context_mismatch')`). For completeness, the read-only rollout
  gate that instead counts a payload-stale **defect** (not a review outcome) is
  `w4c3a-rollout-control.ts:1008-1013` inside
  `classifyAttendanceRequestSnapshotDefectsV1` (`:931`) — cite it as the defect
  path, never as the review-required source.

### Tables / columns (with creation sites)

- `attendance_request_calculation_snapshots` —
  `zzzz20260725120000_...durable_storage.ts:625`; `org_id` (`:626`), `request_id`
  (`:627`), `version` (`:628`), `payload jsonb` (`:631`), `payload_fingerprint text`
  (`:632`), `attribution_snapshot jsonb` (`:633`); PK
  `(org_id, request_id, version)` (`:637`); non-unique fingerprint index
  (`:645-649`); fingerprint format `CHECK payload_fingerprint ~ '^[0-9a-f]{64}$'`.
- `attendance_record_calculations.outcome` / `.source_definition_fingerprint`
  (`:681` / `:668`) — the review outcome persists here (see PQA-06 for the
  `review_required` shape constraint).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-08.sql` exists — create = this case’s harness `harness/pqa-08-fingerprint-freeze.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin + user in
`$orgShadow` (W4 enabled, per PQA-05). The request, snapshot, shift, and
re-evaluation are produced by the product/boundary in the steps.

### Steps (all W4-boundary/runtime — UNVERIFIED — operator to confirm)

1. Create an attendance request against a shift for `$u1` and let the W4
   boundary freeze its `attendance_request_calculation_snapshots` version 1 (record
   its `payload_fingerprint`).
2. Change the shift definition (`PUT /api/attendance/shifts/{shift_id}` — e.g. move
   a segment time), producing a new live source-definition fingerprint.
3. Re-evaluate the request/record via the boundary.

The exact host wiring that mints the snapshot and re-evaluates is
`UNVERIFIED — operator to confirm`; the code paths are cited above.

### Expected

- The version-1 snapshot row is **byte-for-byte unchanged** after step 2 (same
  `payload_fingerprint`, same `created_at`); any re-append is a **new** version row,
  never a mutation:
  `SELECT version, payload_fingerprint, created_at FROM attendance_request_calculation_snapshots WHERE org_id='$orgShadow' ORDER BY version;`
- The re-evaluation after the shift change yields
  `attendance_record_calculations.outcome='review_required'` with
  `outcome_reason_code='context_mismatch'` (and the enforced `projection_effect='none'`).

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_request_calculation_snapshots WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_calculations           WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_segments               WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_requests                      WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                       WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments                WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shifts                        WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                                WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                                    WHERE id LIKE 'qa_synth_%')
  AS pqa_08_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-08.sql` exists — create = this case’s harness `harness/pqa-08-fingerprint-freeze.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section). Note the
snapshot table FK to `attendance_requests` is `ON DELETE RESTRICT` — delete
snapshots before requests (the cleanup does).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-08"`: `status`, `syntheticDataOnly=true`, `reason` = the
unchanged v1 snapshot + the `review_required`/`context_mismatch` outcome (or BLOCKED
with the UNVERIFIED note).

---

## PQA-09 — Outbox retry

**Objective (matrix).** One synthetic dispatch failure followed by retry produces
one source/result effect and no duplicate DML.

### Product surface

- Dispatcher (the entry function):
  `packages/core-backend/src/attendance/w4c2-outbox-dispatcher.ts:84` —
  `export async function dispatchAttendanceResultEventOutboxV1(connection, options)`.
  It claims one row (`SELECT … FOR UPDATE SKIP LOCKED WHERE delivery_state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`, `:110-114`),
  dispatches via `options.emit` (`:123`), marks `delivered` on success (`:136-140`)
  or increments `attempts` + sets `next_attempt_at` on failure (`:145-151`); returns
  `{ claimed, delivered, failed }` (`:161`).
- **No duplicate DML** guarantee: the dispatcher performs DML on the outbox table
  ONLY (module header `:15-16`); both UPDATEs are gated on
  `AND delivery_state='pending'` (`:140`, `:149`) so a redelivery matches zero
  rows; a DB trigger makes a delivered row immutable and forbids attempt-count
  regression (`zzzz20260725120000_...durable_storage.ts:1510-1537`, rewritten to
  an allowlist form at `zzzz20260727100000_...:583-585`).
- **No HTTP route** — worker/scheduler-only. Host port wrapper
  `drainResultEventOutbox` (`packages/core-backend/src/index.ts:2212`, calls the
  dispatcher `:2222`); registered only as a background job
  `attendance-w4-result-outbox-drain` (`plugins/plugin-attendance/index.cjs:49618-49622`),
  env-gated on `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`. To drive a retry in
  QA, call `drainResultEventOutbox({ emit })` (or
  `dispatchAttendanceResultEventOutboxV1(client, { emit })`) directly —
  `UNVERIFIED — operator to confirm` the node/test-harness invocation.

### Tables / columns (with creation sites)

- `attendance_result_event_outbox` —
  `zzzz20260725120000_...durable_storage.ts:590`; `org_id text NOT NULL` (`:592`),
  `entrypoint` (`:593`), `event_kind` (`:595`), `payload jsonb` (`:596`),
  `payload_schema_version` (`:597`), `business_key_fingerprint` (`:598`),
  `delivery_state text DEFAULT 'pending'` (`:599`, `CHECK IN ('pending','delivered')`
  `:609`), `attempts integer DEFAULT 0` (`:600`, `CHECK >= 0` `:610`),
  `next_attempt_at timestamptz` (`:601`), `delivered_at` (`:603`); `identity_kind`
  (added `zzzz20260727100000_...:487`, `SET NOT NULL :509`), `scheduled_run_id`
  (added `:488`), `operation_id` made nullable (`:490`).
- No new business DML on retry ⇒ counts unchanged in `attendance_result_operations`
  (`:470`) and `attendance_records` (`:54`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-09.sql` exists — create = this case’s harness `harness/pqa-09-outbox-retry.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin + user in
`$orgShadow`. **The outbox row is produced by the product** (a W4
calculation or scheduled run for the synthetic org enqueues one — see PQA-10) — a
hand-seeded outbox row is intentionally avoided because `identity_kind`/the partial
unique identity indexes/the update-guard trigger make a hand INSERT fragile.
`UNVERIFIED — operator to confirm` the production path.

### Steps (worker/runtime — UNVERIFIED — operator to confirm)

1. Produce exactly one `pending` outbox row for `$orgShadow` (via PQA-10's
   `POST /api/attendance/auto-absence/run`, which enqueues via
   `enqueueAttendanceScheduledRunEventOutboxV1`,
   `packages/core-backend/src/attendance/w4c2-scheduled-run.ts:328/347`).
2. Record baseline counts: `attendance_result_operations` and `attendance_records`
   for the org.
3. **Failure pass:** call `drainResultEventOutbox({ emit })` with an `emit` that
   throws.
4. **Retry pass:** call it again with an `emit` that resolves (pass
   `retryBackoffMs: 0` or clear `next_attempt_at`, since a failure sets
   `next_attempt_at = now()+30s`, `w4c2-outbox-dispatcher.ts:148/150`).

### Expected

- After the failure pass: the row stays `delivery_state='pending'`, `attempts=1`,
  `next_attempt_at` set.
- After the retry pass: `delivery_state='delivered'`, `attempts=2`, `delivered_at`
  set — **exactly one** delivered transition.
- Baseline counts in `attendance_result_operations` and `attendance_records` are
  **unchanged** across both passes (no duplicate business DML):
  `SELECT delivery_state, attempts FROM attendance_result_event_outbox WHERE org_id='$orgShadow';`

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_result_event_outbox       WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operations         WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operation_batches  WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_runs            WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_targets     WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_target_outcomes WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                   WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                            WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                                WHERE id LIKE 'qa_synth_%')
  AS pqa_09_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-09.sql` exists — create = this case’s harness `harness/pqa-09-outbox-retry.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-09"`: `status`, `syntheticDataOnly=true`, `reason` = the
pending→delivered transition with `attempts=2` and the unchanged business-row counts
(or BLOCKED with the UNVERIFIED note).

---

## PQA-10 — Scheduled identity/outcome/outbox

**Objective (matrix).** Re-evaluate scheduled (b2) identity, target outcome, and
outbox durability on the current exact source SHA without inventing PASS.

### Product surface

- Admin trigger route (EXISTS):
  `plugins/plugin-attendance/index.cjs:48153-48155` —
  `context.api.http.addRoute('POST', '/api/attendance/auto-absence/run', withPermission('attendance:admin', …))`;
  handler calls `runAutoAbsenceForOrgDate(db, { … initiator: 'admin_run' })`
  (`index.cjs:48208/48215`) → `w4Boundary.executeScheduledRun` (`index.cjs:22968`)
  → `createOrResumeAttendanceScheduledRunV1`.
  (Note: the risk-matrix hint "~L43739" is inaccurate — that line is a payroll-CSV
  export; the real route is 48152-48155.)
- Identity / idempotence:
  `packages/core-backend/src/attendance/w4c2-scheduled-run.ts:593` —
  `createOrResumeAttendanceScheduledRunV1`. Identity key = `(orgId, initiator,
  workDate)` (advisory lock `w4c0-identity.ts:1111`; resume-existing-running
  `w4c2-scheduled-run.ts:558/621-622`; monotonic generation `:634`).
- Target outcomes (idempotent, one per target):
  `recordAttendanceScheduledRunTargetOutcomeV1` (`w4c2-scheduled-run.ts:857`, INSERT
  `:901`), enforced by `uq_asrto_target UNIQUE (org_id, target_id)`.
- Outbox durability: `enqueueAttendanceScheduledRunEventOutboxV1`
  (`w4c2-scheduled-run.ts:328`, INSERT into `attendance_result_event_outbox`
  `delivery_state='pending'` `:347/350`); finalize
  `finalizeAttendanceScheduledRunV1` (`:1056`).
- Sweep worker (NO route — worker only):
  `packages/core-backend/src/attendance/w4c2-scheduled-run-ops-worker.ts:228` —
  `export async function sweepAttendanceScheduledRunsOnceV1(pool, options)`; claims
  due runs via `UPDATE … SET last_attempt_at=now() … WHERE state='running' … FOR UPDATE SKIP LOCKED`
  (`w4c2-scheduled-run.ts:1232-1240`). Host port `sweepScheduledRuns`
  (`packages/core-backend/src/index.ts:2235`), background job
  `attendance-w4-scheduled-run-sweep` (`plugins/plugin-attendance/index.cjs:49643/49655`).

### Tables / columns (all in zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts)

- `attendance_scheduled_runs` — CREATE `:120`; `run_id uuid PK` (`:121`), `org_id`
  (`:122`), `entrypoint` (`:123`), `initiator` (`:124`), `work_date` (`:125`),
  `generation` (`:126`), `state text DEFAULT 'running'` (`:131`, `CHECK IN ('running','completed','abandoned')` `:144`);
  identity uniqueness `uq_asr_generation (org_id, initiator, work_date, generation)`
  (`:140`) and partial `uq_asr_one_running (org_id, initiator, work_date) WHERE state='running'`
  (`:179-181`); `last_attempt_at` added by
  `zzzz20260805120000_w4c2_scheduled_run_sweep_fairness.ts:35`.
- `attendance_scheduled_run_targets` — CREATE `:237`; `org_id` (`:239`), `run_id`
  (`:240`), `ordinal` (`:242`), `user_id uuid` (`:243`), `target_kind` (`:244`).
- `attendance_scheduled_run_target_outcomes` — CREATE `:348`; `org_id` (`:350`),
  `run_id` (`:351`), `target_id` (`:352`), `terminal_outcome text` (`:353`,
  `CHECK IN ('completed','failed')`); `uq_asrto_target UNIQUE (org_id, target_id)`
  (`:356`).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-10.sql` exists — create = this case’s harness `harness/pqa-10-scheduled-sweep.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin +
absence-eligible user in `$orgShadow` (W4 enabled). Scheduled-run rows are
produced by the route/worker in the steps.

### Steps

The reworked harness `harness/pqa-10-scheduled-sweep.mjs` performs S1–S3 route-lessly
through the SAME exported product functions (identity via
`createOrResumeAttendanceScheduledRunV1`, sweep via
`sweepAttendanceScheduledRunsOnceV1`), using the `'cron'` scheduled entrypoint. The
HTTP `POST /api/attendance/auto-absence/run` trigger below (initiator `'admin_run'`)
is the **operator-verified equivalent** of the same identity/idempotence/sweep
invariants — it drives `createOrResumeAttendanceScheduledRunV1` through the plugin
boundary. Both prove the same contract; the harness is PASS-eligible from Node, the
HTTP path stays `UNVERIFIED — operator to confirm`.

Session for `$admin` + env `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`:
`UNVERIFIED — operator to confirm`.

- **S1 (trigger — identity).** Harness: `createOrResumeAttendanceScheduledRunV1`
  mints the `($orgShadow, 'cron', 2026-01-05)` running run with one `generate`
  target. Operator equivalent: as admin `POST /api/attendance/auto-absence/run`
  `{ "orgId": "$orgShadow", "workDate": "2026-01-05" }` (exact body fields
  `UNVERIFIED — operator to confirm`).
- **S2 (re-trigger — identity idempotence).** Harness: a second
  `createOrResumeAttendanceScheduledRunV1` on the SAME identity returns
  `kind='resumed'` (same generation) and leaves exactly ONE running row
  (`uq_asr_one_running`) — asserted. Operator equivalent: repeat S1.
- **S3 (sweep).** Harness: `sweepAttendanceScheduledRunsOnceV1(pool, { … })` claims
  the due running run (stamps `last_attempt_at`) and — the target not yet sealed —
  reports it `notReady` WITHOUT finalizing; asserted `scanned≥1`, `notReady≥1`,
  `finalized=0`, and `last_attempt_at` set. Operator equivalent: the
  `sweepScheduledRuns` port — `UNVERIFIED — operator to confirm` the invocation.

### Expected

- After S1+S2: **at most one** `attendance_scheduled_runs` row with `state='running'`
  for `($orgShadow, 'admin_run', 2026-01-05)` (enforced by
  `uq_asr_one_running`); a re-trigger resumes rather than duplicating (`generation`
  does not fork a second running row):
  `SELECT generation, state FROM attendance_scheduled_runs WHERE org_id='$orgShadow' ORDER BY generation;`
- Each target has exactly one `attendance_scheduled_run_target_outcomes` row
  (`uq_asrto_target`); `terminal_outcome ∈ ('completed','failed')`.
- Outbox rows for the run are durable (`delivery_state='pending'` until drained):
  `SELECT count(*) FROM attendance_result_event_outbox WHERE org_id='$orgShadow';`

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_scheduled_run_target_outcomes WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_targets         WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_runs                WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_event_outbox           WHERE org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                       WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                                WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users                                    WHERE id LIKE 'qa_synth_%')
  AS pqa_10_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-10.sql` exists — create = this case’s harness `harness/pqa-10-scheduled-sweep.mjs` + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section) — deletes
target_outcomes → targets → runs → outbox (FK order) → records/memberships/users.

### Evidence (summary.json fields)

Set `cases[] where id="PQA-10"`: `status`, `syntheticDataOnly=true`, `reason` = the
single-running-run-per-identity observation, one-outcome-per-target, outbox
durability, and residue (or BLOCKED with the UNVERIFIED note — do not invent PASS
from unit/integration suites or the stale W4C-2 package).

---

## PQA-04 — Legacy compatibility

**Objective (matrix).** A synthetic org outside the test allowlist retains existing
response/projection shape and writes no W4 rows.

### Product surface

For an org **not** in `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`
(`w4c0-identity.ts:363/381`), `resolveSegmentCalculationPosture` resolves to
`legacy_projection_only` (`w4c0-identity.ts:475-487`), and:

- the write preflight returns `legacy_no_operation` — **no operation row, hence no
  calculation/segment rows**:
  `packages/core-backend/src/attendance/w4c0-operation-registry.ts:604-608`;
- the outbox is refused for a legacy org (`W4C0_OUTBOX_LEGACY_FORBIDDEN`):
  `w4c0-operation-registry.ts:827-831`;
- the control-side transition also fails closed for a non-allowlisted org
  (`W4C3A_ROLLOUT_CONTROL_ORG_NOT_ALLOWLISTED`,
  `w4c3a-rollout-control.ts:1162-1163`; bootstrap guard `:508-509`).

The legacy `attendance_records` projection (its existing `status`/`work_minutes`/…
shape) is written by the pre-W4 path and is untouched by W4.

### Tables / columns — the "NO W4 rows" assertion set

For `$orgLegacy` these W4 tables must contain **zero** rows
(`org_id = '$orgLegacy'`):
`attendance_record_calculations` (`zzzz20260725120000_...:655`),
`attendance_record_segments` (`:860`), `attendance_result_operations` (`:470`),
`attendance_result_operation_batches` (`:428`), `attendance_result_event_outbox`
(`:590`), `attendance_calculation_rollout_state` (`:993`),
`attendance_calculation_rollout_events` (`:1011`). The legacy
`attendance_records` (`zzzz20260114090000_...:54`) row **is** present (unchanged
shape).

### Synthetic fixtures — create

Apply the reworked Node flow (no `fixtures/pqa-04.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (create section): admin + user in
**`$orgLegacy`**. Critically, `$orgLegacy` MUST NOT appear in
`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` — verify the env
(`UNVERIFIED — operator to confirm`).

### Steps

- **L1.** As `$u1`: `POST /api/attendance/punch`
  `{ "eventType": "check_in", "occurredAt": "2026-01-05T09:00:00+08:00", "timezone": "Asia/Shanghai", "orgId": "$orgLegacy" }`
  (and a `check_out` later the same day) — the legacy path writes an
  `attendance_records` projection; the W4 path is a no-op.

### Expected

- The `POST /api/attendance/punch` responses have the **existing** legacy shape
  (HTTP 2xx, legacy record projection) — no W4-specific fields forced.
- A legacy `attendance_records` row exists for `$orgLegacy` with the usual
  `status`/`work_minutes`.
- **Zero** rows in every W4 table listed above for `org_id='$orgLegacy'`:
  ```sql
  SELECT
      (SELECT count(*) FROM attendance_record_calculations           WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_record_segments               WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_result_operations             WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_result_operation_batches      WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_result_event_outbox           WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_calculation_rollout_state     WHERE org_id='$orgLegacy')
    + (SELECT count(*) FROM attendance_calculation_rollout_events    WHERE org_id='$orgLegacy')
    AS w4_rows;   -- must be 0
  ```

### Residue SQL (rows this case created)

```sql
SELECT
    (SELECT count(*) FROM attendance_records  WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_events   WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs           WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM users               WHERE id LIKE 'qa_synth_%')
  AS pqa_04_residue;
```

### Cleanup

Apply the reworked Node flow (no `fixtures/pqa-04.sql` exists — create = the operator HTTP/UI steps in this section + `provision-synth-directory.mjs`; cleanup = `reset-isolated-db.mjs` drop/recreate) (cleanup section).

### Evidence (summary.json fields)

Set `cases[] where id="PQA-04"`: `status`, `syntheticDataOnly=true`, `reason` = the
legacy projection present + the `w4_rows = 0` observation and residue count.

---

## After all ten cases

1. Run every case's cleanup. 2. Run `scripts/ops/windows-qa/residue-check.sql`; put
the single integer in `summary.json.residue` (must be 0). 3. Affirm the shared
safety fields (`isolatedDatabase`, `databaseName=metasheet_windows_qa`,
`hostPlatform=windows`, `windowsPowerShellVersion=5.1.x`,
`customerOrExternalDestination=false`, `externalNotificationsSent=false`). 4. Run
the qa-runner (README §Flow). Do not invent PASS; the stale package SHAs listed in
the pin are not current evidence.
