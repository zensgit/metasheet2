# Attendance Windows-native QA v2 — PQA-01..10 per-case runbook

**Draft / HOLD. Synthetic data only. No deployment, staging, customer UAT, flag
enablement, external notification, or issue-closure authorization.**

Pinned exact product source SHA (`SOURCE_SHA`, unchanged by this QA-tooling
revision): `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`.

Isolated database (the only accepted name): `metasheet_windows_qa`.

This runbook is the *product-matrix* half of the package. The qa-runner
(`scripts/ops/attendance-windows-native-qa-runner.mjs`) validates SAFETY + SHA
binding only; **the operator** determines each case's PASS/FAIL by executing the
scenario below against synthetic data and comparing observed vs expected, then
records it in `<evidence-dir>/summary.json` (copied from
`scripts/ops/windows-qa/summary.template.json`).

Execution order is owner-specified by risk (README §"Execution order"):
**PQA-07 → 03 → 01 → 02 → 05 → 06 → 08 → 09 → 10 → 04**. The sections below are in
that order; each is self-contained.

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
5. **Synthetic marking.** Every synthetic identifier is prefixed `qa_synth_`.
   Because `*.id` columns are `uuid` (cannot carry a text prefix), synthetic
   marking and all residue/cleanup keying use **text** columns only — `org_id`,
   `user_id`, and shift `name` — never `id`.

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

Apply `scripts/ops/windows-qa/fixtures/pqa-07.sql` (create section). It seeds:

- orgs (text ids only; no `orgs` table row is required — `org_id` is free-text on
  `user_orgs`/`attendance_records`): `qa_synth_org_a`, `qa_synth_org_b`.
- users: `qa_synth_u1` (active), `qa_synth_u2` (active, same-org other user),
  `qa_synth_u3` (active user row, but INACTIVE org membership). All carry
  `permissions '["attendance:read"]'::jsonb`.
- `user_orgs`: `(qa_synth_u1, qa_synth_org_a, true)`,
  `(qa_synth_u2, qa_synth_org_a, true)`, `(qa_synth_u3, qa_synth_org_a, false)`.
- `attendance_records`: one row for `qa_synth_u1` and one for `qa_synth_u2`, both
  in `qa_synth_org_a`, `current_calculation_id` left NULL (a record with no
  calculation returns HTTP 200 with `calculation: null` — see
  `AttendanceW4CalculationDetail.ts:528-531` — a clean positive control needing no
  hand-crafted calculation row).

### Steps (exact API calls)

Session acquisition (obtaining a logged-in session/token for `qa_synth_u1` and
`qa_synth_u3` that carries `attendance:read`) requires the running server's login
flow: `UNVERIFIED — operator to confirm`. The RBAC evaluation of
`rbacGuard('attendance', 'read')` against the seeded `users.permissions` is also
operator-observed at runtime. Capture the two seeded record ids as
`{u1_record_id}` / `{u2_record_id}` from the fixture output.

- **P1 (positive control).** As `qa_synth_u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail`
- **P2 (same-org other-user via param).** As `qa_synth_u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail?userId=qa_synth_u2`
- **P2b (same-org other-user via foreign recordId — subject-scoped SQL).** As
  `qa_synth_u1`:
  `GET /api/attendance/records/{u2_record_id}/calculation-detail`
- **P3 (cross-org).** As `qa_synth_u1`:
  `GET /api/attendance/records/{u1_record_id}/calculation-detail?orgId=qa_synth_org_b`
- **P4 (inactive membership).** As `qa_synth_u3`:
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

Apply `scripts/ops/windows-qa/fixtures/pqa-07.sql` (cleanup section) — deletes the
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

Apply `scripts/ops/windows-qa/fixtures/pqa-03.sql` (create section): one admin
user `qa_synth_admin` (`permissions '["attendance:admin"]'`) and its active
membership in `qa_synth_org_a`. No shift is pre-seeded — the valid step T1 creates
one.

### Steps (exact API calls)

Session/RBAC for `qa_synth_admin` carrying `attendance:admin`:
`UNVERIFIED — operator to confirm`. All bodies below are the request JSON.

- **T1 (valid IANA).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_tz", "timezone": "Asia/Shanghai", "segments": [{ "startTime": "09:00", "endTime": "18:00" }], "orgId": "qa_synth_org_a" }`
- **T2 (invalid identifier).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_tz_bad", "timezone": "Not/AZone", "segments": [{ "startTime": "09:00", "endTime": "18:00" }], "orgId": "qa_synth_org_a" }`
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

Apply `scripts/ops/windows-qa/fixtures/pqa-03.sql` (cleanup section) — deletes the
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

Apply `scripts/ops/windows-qa/fixtures/pqa-01.sql` (create section): admin user
`qa_synth_admin` + active membership in `qa_synth_org_a`. The shift itself is
created by step A1 (this case is authoring).

### Steps (exact API calls)

Session/RBAC for `qa_synth_admin`: `UNVERIFIED — operator to confirm`.

- **A1 (create two-segment shift).** `POST /api/attendance/shifts`
  `{ "name": "qa_synth_shift_2seg", "timezone": "Asia/Shanghai", "segments": [ { "startTime": "09:00", "endTime": "12:00" }, { "startTime": "13:00", "endTime": "18:00" } ], "orgId": "qa_synth_org_a" }`
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

Apply `scripts/ops/windows-qa/fixtures/pqa-01.sql` (cleanup section) — deletes the
synthetic shift's segments, the shift, the membership, and the admin user.

### Evidence (summary.json fields)

Set `cases[] where id="PQA-01"`: `status`, `syntheticDataOnly=true`, `reason` =
observed segment ordering/times/timezone from A2 and the residue count.
