# Attendance RD-4/5 report-digest staging smoke runbook

**Date:** 2026-07-02

**Status:** PREPARED. This runbook does **not** claim a staging PASS. It is the
operator checklist for closing RD-4/RD-5 (report-digest config card + producer /
worker send proof) inside the staging window coordinated by
`docs/development/attendance-staging-window-bundle-20260702.md` (smoke #2 of 3).

Do not mark the report-digest arc complete from this document alone. The
closeout happens only after a real run records the PASS stamp in the section
below.

**Scope** (per the report-digest design lock
`docs/development/attendance-report-digest-subscription-design-lock-20260626.md`
§9, RD-4 + RD-5 rows):

- RD-4: admin config card hydrates from settings, saves through the real PUT,
  rejects invalid input, preserves sibling settings;
- RD-5: producer writes per-subject delivery rows (proven separately from
  sending), the delivery worker visibly sends or visibly fails those rows, and
  cleanup residue is `0`.

It does not add runtime code, a manual bulk-send button, a new channel, or new
recipients vocabulary.

## Known family deviation — deterministic source_keys (READ FIRST)

Every other smoke in this family stamps its business keys
(`ae4-smoke:<STAMP>:…`, `otbank-v18-smoke:<STAMP>:…`). **The digest producer
cannot be stamped**: its `source_key` is deterministic by design —

```text
attendance_report_digest:{orgId}:{cadence}:{periodKey}:subject:{subjectUserId}:{recipientRole}:{recipientUserId}:channel:{channel}
```

— that determinism IS the idempotency mechanism (`ON CONFLICT (org_id,
source_key) DO NOTHING` against the unique `(org_id, source_key)` index). The
window plan's business-key prefix `rd45-smoke:<STAMP>:` therefore has **no
occupant** in this smoke; only the row-id prefix `rd45-smoke-<suffix>-…`
(users, memberships, the disposable org id) is stamp-carrying. Consequences:

1. **Residue discipline tracks the deterministic keys explicitly.** The helper
   prints a `RUN LOG — deterministic digest keys` block (periodKey, the exact
   source_key prefix, every full key). Copy it into the worksheet below; the
   residue SQL is anchored on `org_id + source_type + left(source_key, …)`,
   never on a stamp.
2. **Same-day reruns collide with themselves.** A rerun on the same UTC day
   against the same org regenerates the SAME keys; the helper aborts at
   preflight if rows already exist under the run's prefix (clean first, then
   rerun).
3. The design-lock §4 key template omits the `:subject:{subjectUserId}:`
   segment; **the shipped implementation (with the segment) supersedes the
   doc** — the helper's parser rejects the drifted shape.

## Track structure (resolves bundle §9.4)

The backend scheduler job registers the producer with **no orgId** — the
scheduled producer is hardwired to the `default` org. The window plan's rule
that "RD-4/5 MUST use a disposable **single-member** smoke org" is therefore
only achievable through the shipped in-process test seam
(`__attendanceReportDigestForTests.runAttendanceReportDigestOnce`, same
pattern the C5-5 delivery smoke used for in-process services against
`DATABASE_URL`).

| Track | What | Org | Required for the PASS stamp? |
|---|---|---|---|
| **A — seam (PRIMARY, helper default)** | in-process seam invocation with `{orgId, now, todayKey}` pinned | disposable single-member `rd45-smoke-…-org` | **Yes** |
| **B — real scheduler tick (VARIANT)** | backend scheduler produces on its own tick | `default` (forced by the wiring) | No — optional, owner-gated at run time |

**Track B risk statement (read before opting in):** it writes pending digest
rows naming **every active default-org member** (deterministic keys, cleaned
afterwards by prefix), and if the backend env drifts worker-on, those rows
would be **sent to real staging users**. Track B therefore hard-requires the
delivery worker gate unset/false and `ACK_DEFAULT_ORG_FANOUT=1`. It
strengthens the closeout (proves the registration → tick → producer chain on
the deployed process) but is **not** required for
`RD45_REPORT_DIGEST_STAGING_SMOKE_PASS`.

## The three env gate layers — and an amendment to bundle §3.4

Three DISTINCT gates, one per layer (do not conflate them):

| Env | Layer | Track A (primary) | Track B (variant) |
|---|---|---|---|
| `ATTENDANCE_SCHEDULER_ENABLED` | process gate — must be exactly `'true'` or the shared scheduler never starts and no job (producer OR worker) ever runs | backend `true` (the delivery worker rides the same tick) | backend `true` |
| `ATTENDANCE_REPORT_DIGEST_ENABLED` | producer gate — read by whichever **process** runs the producer | backend **UNSET/false (MUST)**; the helper sets it `true` inside its own process around the seam call only | backend `true` |
| `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` | send gate — registers the delivery worker job on the same tick | backend `true` (window state; sends are contained to the smoke org's synthetic member and double as the RD-5 send proof) | backend **UNSET/false (MUST)** — rows must stay `pending` |
| `ATTENDANCE_SCHEDULER_INTERVAL_MS` | tick period — default hourly, min-clamp 5000 ms; there is **no immediate first run**: the first tick fires **one FULL interval** after process start | shrink (e.g. `15000`) so the worker resolves rows quickly | shrink (e.g. `15000`) |
| channel envs | `ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED=true` registers the deterministic fake sender under the work-notification channel name; the real-channel env or the SMTP env registers real senders | fake recommended (see send-posture table) | irrelevant (worker off) |

**Amendment to the window bundle §3.4:** the bundle lists
`ATTENDANCE_REPORT_DIGEST_ENABLED=true` among the set-once-at-window-start
flags. Under Track A that is **wrong and unsafe**: the digest policy lives in
the single GLOBAL settings row, so the policy this smoke enables is visible to
the backend too — if the backend's producer gate were on, its scheduler would
fan out one row per active **default-org** member and the window's live worker
would send them. Under Track A the backend producer gate **stays off for the
whole window**; the helper asserts a **no-default-org-leakage** guard and its
residue block includes the default-org digest delta. Only a Track B opt-in
sets the backend producer gate (and then the worker gate must be off —
mutually exclusive states, each requiring a container recreate).

Settings-visibility latency: the backend caches the settings row in-process
for up to 60 s, and a first tick fires only one FULL interval after boot — all
Track B waits (and the helper's built-in timeouts) budget `interval × 2 + 60 s
+ margin`.

## What this proves

1. **Producer grain** — the producer writes exactly one `pending` row per
   resolved active subject (active membership AND active user; the seeded
   inactive membership is excluded), with `source_type=
   'attendance_report_digest'`, per-subject `source_key` (the `:subject:`
   segment), `recipient_role='subject'` in the column vocab and `self` in the
   key's config vocab, one consistent allowlisted channel
   (`dingtalk_work_notification` | `email_smtp`), deterministic `source_id`,
   and a digest payload (`kind`/`cadence`/`period.periodKey`).
2. **Recipient containment** — zero rows name a recipient outside the resolved
   subject set.
3. **Replay idempotency** — a second producer invocation creates zero new rows;
   TOTAL row count for the period is unchanged (`ON CONFLICT` dedup).
4. **Disabled paths** — producer-gate off and policy off each produce zero new
   rows (both are proven deterministically on the seam track).
5. **RD-5 send split** — separately from (1), the live delivery worker visibly
   resolves every smoke-org row: `sent`, or `failed` with a recognized
   visible reason (send-posture table below).
6. **No default-org leakage** — enabling the GLOBAL policy for the smoke did
   not produce any default-org rows (Track A).
7. **RD-4 config card** — browser probe of the admin card (hydrate / save /
   reject invalid / preserve siblings).
8. **Restore + residue** — settings restored byte-identical for the digest
   policy; residue `0` across every touched surface, deterministic keys
   included.
9. The deliveries GET route has **no source filter param** (status +
   pagination only) — the smoke proves the documented client-side
   `source_key`-prefix filtering works against the real route.

## Prerequisites

1. Deploy ONE main build (the window's `DEPLOY_SHA`) that includes the RD-1
   config contract, the RD-2/RD-3 producer chain, and the RD-4 admin config
   card (bundle §2).
2. Staging migrations current through `attendance_notification_deliveries`
   (the `zzzz20260611120000` migration with the unique `(org_id, source_key)`
   index).
3. `BASE_URL` → staging API; `DATABASE_URL` → the SAME staging database (the
   helper runs an API↔DB coherence probe and aborts on mismatch).
4. Auth: preferred is the environment's approved smoke-token path
   (`ADMIN_TOKEN` with `attendance:read`, `attendance:write`,
   `attendance:admin`); the helper's dev-token fallback exists for
   non-production stacks only and is expected to 404 on staging (bundle §9.5 /
   OQ-4).
5. Track A runs the seam **in-process**: execute the helper from a prepared
   metasheet2 checkout at the deployed SHA with dependencies installed (`pg` +
   `plugins/plugin-attendance/index.cjs` requireable — see OQ-2 for the
   pnpm-layout `NODE_PATH` caveat), on a host that can
   reach `DATABASE_URL` — the same execution locus the C5-5 delivery smoke
   used (OQ-2).
6. Backend container env verified for the chosen track per the layer table
   above — read the live container env first (bundle §9.3 / OQ-3); env changes
   require a container recreate, never mid-smoke.
7. Use only synthetic ids with the `rd45-smoke-` prefix. The disposable org id
   itself is stamped (`<STAMP>-org`).

## Suggested environment

```bash
BASE_URL=http://127.0.0.1:8082
DATABASE_URL=postgresql://<redacted>@<staging-db>/metasheet
DEPLOY_SHA=<deployed-main-sha>          # never a local branch SHA
STAMP=rd45-smoke-$(date +%s)            # /^rd45-smoke-[A-Za-z0-9-]+$/
TRIGGER_MODE=seam                       # primary track
SCHEDULER_INTERVAL_MS=15000             # MUST equal the backend's ATTENDANCE_SCHEDULER_INTERVAL_MS
ADMIN_TOKEN='<staging admin bearer token>'
# ORG_ID defaults to ${STAMP}-org on the seam track — do not point it at a real org.
```

## Helper

```bash
BASE_URL="$BASE_URL" DATABASE_URL="$DATABASE_URL" DEPLOY_SHA="$DEPLOY_SHA" \
STAMP="$STAMP" TRIGGER_MODE=seam SCHEDULER_INTERVAL_MS="$SCHEDULER_INTERVAL_MS" \
ADMIN_TOKEN="$ADMIN_TOKEN" \
node scripts/ops/staging-attendance-report-digest-rd45-smoke.mjs | tee /tmp/rd45-smoke-run-$STAMP.log
```

The helper drives the real staging HTTP API for settings writes and the
deliveries read route, uses direct PG for exact assertions and stamped/
prefix-scoped cleanup, and invokes the producer through the shipped seam. A
successful run prints:

```text
RD45_REPORT_DIGEST_API_DB_SMOKE_PASS deploy=<sha> stamp=<rd45-smoke-...> org=<org> produced=<n> dedupOk=1 residue=0
```

This is **not** the final RD-4/5 PASS stamp: it does not operate the RD-4
config card in a browser, and the send-posture decision below must be recorded
by the operator. Keep the `tee`'d log — its RUN LOG block is the deterministic
-key residue record.

Helper phases (all assertions also listed as manual SQL below): preflight
(tables via `to_regclass`, deterministic-key collision guard, digest-row
baselines, UTC-midnight guard for Track B) → settings snapshot → seed → enable
policy (`daily`, `sendAt='00:00'`, `timezone='UTC'`, `recipients=['self']` —
due on every producer run all day, since due-ness is anchor-day + local time ≥
sendAt, not minute-equality) → produce → grain/containment/API-visibility →
replay → disabled paths → send posture → leakage guard → strict settings
restore → cleanup → residue.

## Steps

### Step 0 — window preflight

Covered by the bundle (§3): health + `build.commit == DEPLOY_SHA`, migration
alignment, auth round-trip, env flags per the layer table, settings baseline
snapshot.

### Step 1 — seed (helper-automated)

One disposable org `<STAMP>-org` with exactly **one active member**
(`<STAMP>-member`) — the window plan's single-member rule — plus one user with
an **inactive membership** (`<STAMP>-inactive`) to prove active-only subject
resolution. No attendance records/requests are seeded: a zero-activity digest
payload is a valid producer proof (row production, not report content, is
under test).

### Step 2 — produce and assert grain (helper-automated)

Track A: the helper requires the plugin CJS, builds the harness-shaped db
adapter over `DATABASE_URL`, sets the producer gate in its OWN process, and
calls the seam once with pinned `{orgId, now, todayKey}`. Expected result:
`ran=true`, daily cadence `rowsCreated=1`, `rowsExisting=0`.

Manual verification SQL (also the worksheet source):

```sql
SELECT source_key, source_id, recipient_user_id, recipient_role, channel, status,
       payload->>'kind' AS kind, payload->'period'->>'periodKey' AS period_key
FROM attendance_notification_deliveries
WHERE org_id = :smoke_org
  AND source_type = 'attendance_report_digest'
  AND left(source_key, length(:source_key_prefix)) = :source_key_prefix
ORDER BY source_key;
```

Expected: exactly one row per active subject; `:subject:` segment present in
every key; `recipient_role='subject'`; key role segment `self`; channel equal
across rows and ∈ {`dingtalk_work_notification`, `email_smtp`} (the value is
resolved from the **producing process's** default-channel env — leave
`ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL` unset in the helper env, or set it
identically to the backend, so the stamped channel matches what the worker's
registry can serve); zero rows with a recipient outside the subject set.

Because the deliveries GET route has no source filter, the helper additionally
pages `GET /api/attendance/notification-deliveries?status=all&page=…&pageSize=200`
and filters client-side by the source_key prefix — the count must equal the DB
count.

### Step 3 — replay idempotency (helper-automated)

Second seam invocation (same pinned todayKey): `rowsCreated=0`,
`rowsExisting=<n>`, and the **total** row count for the period unchanged. The
count is status-tolerant on purpose — the window's live worker may already
have moved rows `pending→sending→sent` between steps; dedup is proven by
count, not by status.

### Step 4 — disabled paths (helper-automated)

- Producer gate off (env deleted in the seam process) → `{ran:false,
  reason:'disabled'}`.
- Policy off (`PUT {"attendanceReportDigestPolicy":{"enabled":false}}`) → the
  helper waits out the plugin module's 60 s in-process settings cache, then
  the seam returns `{ran:false, reason:'disabled'}` with the env gate ON.
- Row count unchanged after both.

### Step 5 — RD-5 send posture (helper-automated; operator records the posture)

The window keeps the delivery worker ON (bundle §3.4); under the disposable
smoke org its fan-out is contained to the synthetic member, so the send doubles
as the RD-5 proof. The helper polls until every smoke-org row reaches a
terminal, explainable state:

| Backend channel env | Expected terminal state | Posture |
|---|---|---|
| `ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED=true` (recommended) | `status='sent'`, `delivered_at` set | **default / strongest** — a visible send through the real worker state machine |
| real work-notification channel env enabled | `status='failed'`, `last_error='dingtalk_recipient_not_bound'` (synthetic users have no directory binding) | acceptable — a visible, attributable failure (the design lock demands "sends **or fails** visibly") |
| no channel env registered | `status='failed'`, `last_error='attendance_delivery_channel_not_configured'` | weakest — visible but proves only the claim/fail path; prefer the fake channel |

Anything else — rows stuck `pending`/`retrying`, or `failed` with an
unrecognized error — is a smoke FAIL, not a posture. Record the observed
posture in the worksheet; it becomes the `sendProof=` field of the final
stamp. (`WORKER_EXPECTED=0` runs assert rows REMAIN `pending` instead — a
producer-only proof that is NOT sufficient for the final stamp on its own.)

### Step 6 — default-org leakage guard (helper-automated)

Default-org digest-row count must equal its preflight baseline (normally 0).
A delta means the backend has the producer gate set — a broken Track A
precondition: disable it, then clean the leaked rows by the deterministic
prefix on org `default` (never org-wide), and treat the run as FAILED.

### Step 7 — RD-4 config card browser probe (manual — required for the final stamp)

As the staging admin, open the attendance admin surface, report-digest section
(the card's controls carry `data-report-digest*` selectors; the admin rail has
a dedicated report-digest anchor):

1. The card hydrates from the live settings (with the smoke policy restored,
   it must show the PRE-smoke values — proving it reads, not caches).
2. Enable the daily cadence, set a valid `sendAt`, save → re-GET settings shows
   the change; unrelated policy keys are untouched (deep-merge preserved).
3. Enter an invalid `sendAt` (e.g. `25:00`) → save is blocked or the PUT
   returns 400 VALIDATION_ERROR; no partial write.
4. Empty recipients on an enabled cadence → rejected.
5. Restore the card to the pre-smoke values; verify via GET.

No send is triggered by any of this (the producer gate stays off on the
backend), so the probe is safe after cleanup.

### Step 8 — cleanup + residue (helper-automated; re-run SQL manually at window close)

Cleanup order is load-bearing: **restore/disable the policy BEFORE deleting
rows** — while the policy and a producer gate are both live, the still-open
period is re-inserted by the next producer run (deleted rows resurrect). The
helper restores settings strictly (re-GET + byte-compare of
`attendanceReportDigestPolicy`; the restore body explicitly re-asserts the
policy because PUT deep-merges — an empty-snapshot PUT is a NO-OP), then
deletes: smoke-org digest rows (org-scoped `source_type` delete is safe only
because the org is disposable and stamped), stamped memberships, stamped
users.

## Residue worksheet + SQL

Record from the helper RUN LOG: `STAMP`, `ORG_ID`, `periodKey`,
`sourceKeyPrefix`, all `source_key` values, observed send posture.

```sql
-- deterministic-key surface (the family deviation: anchored on recorded keys, not a stamp)
SELECT count(*) AS prefix_deliveries FROM attendance_notification_deliveries
 WHERE org_id = :smoke_org AND source_type = 'attendance_report_digest'
   AND left(source_key, length(:source_key_prefix)) = :source_key_prefix;
SELECT count(*) AS org_digest_deliveries FROM attendance_notification_deliveries
 WHERE org_id = :smoke_org AND source_type = 'attendance_report_digest';       -- bundle §7 shape
SELECT count(*) AS default_org_digest_deliveries FROM attendance_notification_deliveries
 WHERE org_id = 'default' AND source_type = 'attendance_report_digest';        -- leakage: must equal preflight baseline (normally 0)

-- stamped surfaces (bundle §7 shape)
SELECT count(*) AS stray_deliveries_to_smoke_users FROM attendance_notification_deliveries
 WHERE left(recipient_user_id, 11) = 'rd45-smoke-';
SELECT count(*) AS user_orgs FROM user_orgs WHERE left(user_id, 11) = 'rd45-smoke-';
SELECT count(*) AS users FROM users WHERE left(id, 11) = 'rd45-smoke-';

-- settings: GET /api/attendance/settings attendanceReportDigestPolicy equals the pre-smoke snapshot
```

Every count `0` (deltas `0` where a nonzero baseline was explicitly accepted at
preflight). A stray row anywhere is a failed smoke, not a harmless warning.

## Track B — optional default-org real-scheduler variant (owner-gated)

Run ONLY after the risk statement above is accepted, and never with the
delivery worker gate on.

1. Backend env (container recreate): `ATTENDANCE_SCHEDULER_ENABLED=true`,
   `ATTENDANCE_REPORT_DIGEST_ENABLED=true`, `ATTENDANCE_SCHEDULER_INTERVAL_MS=15000`,
   delivery worker gate **unset/false**. Remember: the first tick fires one
   FULL interval after process start, and a settings PUT may be invisible to
   the backend for up to 60 s (in-process cache).
2. Helper: `TRIGGER_MODE=scheduler ACK_DEFAULT_ORG_FANOUT=1 ORG_ID=default` +
   the common env. The helper refuses to start within 30 minutes of UTC
   midnight (the due periodKey would flip mid-run) unless explicitly
   overridden.
3. The helper polls for rows under the deterministic prefix (timeout
   `2×interval + 60 s + margin`), asserts one row per active default-org
   member, **pending-only** throughout (the worker-off proof), replay dedup by
   waiting two further ticks, disabled path by policy-off + cache/tick wait,
   then cleans by deterministic prefix only.
4. Roll the env back (recreate) before resuming the window plan's flag state.

## Expected PASS stamp

Use this exact shape after the helper PASS, the RD-4 browser probe, the send
posture record, and the residue block all succeed:

```text
RD45_REPORT_DIGEST_STAGING_SMOKE_PASS deploy=<sha> stamp=<rd45-smoke-...> org=<rd45-smoke-...-org> produced=<n> dedupOk=1 sendProof=<sent|failed_recipient_not_bound|failed_channel_not_configured> residue=0
```

Backfill text:

> **回填（YYYY-MM-DD RD-4/5 report-digest staging closeout）**：staging smoke
> `RD45_REPORT_DIGEST_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp `<stamp>`，
> disposable single-member org）：producer wrote per-subject pending rows with
> the `:subject:` grain through the shipped seam; inactive membership excluded;
> replay created zero new rows (ON CONFLICT dedup); producer-gate-off and
> policy-off both produced nothing; the live delivery worker visibly resolved
> every row（posture `<sendProof>`）; no default-org leakage; RD-4 config card
> hydrated/saved/rejected-invalid in the browser; settings restored
> byte-identical; deterministic keys recorded and cleaned; residue=0. RD-4/RD-5
> closed ✅.

## On FAIL

- Helper aborts at the deterministic-key collision guard: a same-day run left
  rows; clean via the residue SQL, then rerun (fresh STAMP still required).
- `produced` ≠ active subject count, or a row without the `:subject:` segment:
  producer grain regressed — do not pass.
- Any row's recipient outside the resolved subject set: recipient containment
  broken — do not pass; do NOT let the worker send.
- Replay increases the count: idempotency regressed (unique index or ON
  CONFLICT path) — do not pass.
- Disabled path still produces: gate layering regressed — do not pass.
- Rows stuck `pending`/`retrying` with the worker expected on: send gate or
  channel env not effective on the deployed process — fix env, rerun.
- `failed` with an unrecognized `last_error`: not a posture; investigate before
  any rerun.
- Default-org digest delta ≠ 0: backend producer gate was on — disable it,
  clean by deterministic prefix on org `default` only, run FAILED.
- Settings restore mismatch: **blocks the whole window** (bundle §4) until
  settings are verified restored.

## Safety

- Only synthetic `rd45-smoke-*` users/org; the primary track never writes a
  row naming a real user.
- The globally-shared settings row is snapshotted and strictly restored; the
  policy default is all-off.
- The helper never mutates backend env; it never touches the send gate; the
  producer gate is set only inside the helper's own process for the seam call.
- Cleanup is org/prefix-scoped; never delete by `source_type` alone on the
  default org.
- Track B (the only mode that touches the default org) is fail-closed behind
  `ACK_DEFAULT_ORG_FANOUT=1` + worker-off + UTC-midnight guard.
- Enabling the shared scheduler also runs its other registered jobs each tick
  (e.g. the comp-time expiry sweep) — see OQ-3 before flipping it on.

## Open questions (resolve on the host before the window)

**OQ-1 — RESOLVED: admin tokens are org-independent.** Verified against the
code: `withPermission`/`withAnyPermission` (index.cjs:19841-19913) check only
DB-level grants (`isAdmin` via `user_roles`, `userHasPermission` via
`user_permissions`/`role_permissions`) with no org binding, and `getOrgId`
(index.cjs:5823-5831) takes `body.orgId ?? query.orgId ?? user.orgId ??
x-org-id` — so the helper's `?orgId=<rd45-smoke-…-org>` is honored by any
staging token whose user passes the admin check; no smoke-org-minted token is
needed. The only residual risk is host-side gateway/proxy middleware outside
this repo; the read-only preflight GET stays as belt-and-braces, and the
helper fails loudly (not skips) if the route answers non-200.

**OQ-2 — seam execution locus (narrowed).** The backend image DOES ship the
plugin (`Dockerfile.backend:44` COPYs `plugins/` into the runner stage), so
the in-container option is repo-derivable; the remaining unknowns are only
whether `pg` resolves from the helper's location in-image and whether the
staging stack runs this Dockerfile. The safe default remains a prepared
checkout at the deployed SHA on a host with `DATABASE_URL` access (the C5-5
precedent) — with one concrete caveat: in a standard pnpm checkout `pg` is a
dependency of `packages/core-backend` only (strict layout, no hoist), so
`import('pg')` from `scripts/ops/` fails with `ERR_MODULE_NOT_FOUND` unless
you run with `NODE_PATH=packages/core-backend/node_modules` (or from a cwd
where `pg` resolves). The helper fails loudly at exit 2 either way.
`PLUGIN_INDEX_PATH` overrides the default relative path if the locus differs.

**OQ-3 — live env-flag state and co-registered scheduler jobs.** The current
values of the scheduler/producer/worker/channel envs on the staging host, and
which OTHER env-gated jobs would begin running once
`ATTENDANCE_SCHEDULER_ENABLED=true` ticks (comp-time expiry runs every cycle;
reminder jobs register under their own gates), must be read from the live
container before the window (bundle §9.3). Only add what is missing; plan the
rollback.

**OQ-4 — token mint path.** Which mint path counts as the approved staging
smoke-token path is unstated in the family docs (bundle §9.5); the operator
picks one and uses it for all three window smokes. Note: on non-staging
rehearsal runs where `GET /api/auth/dev-token` IS available, each mint
persists a `user_sessions` row for the stamped synthetic admin; those session
rows are expected out-of-ledger (not in the residue gate, no FK to `users`)
and do not occur on staging, where the dev-token route returns `404`.

**OQ-5 — backend instance topology (Track B only).** Whether the staging stack
runs a single backend instance, and whether the scheduler leader lock is
enabled, is host state: with multiple instances or a leader lock, tick timing
and the 60 s settings-cache staleness apply per instance and the Track B wait
math must be re-derived on the host.
