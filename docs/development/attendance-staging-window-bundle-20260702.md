# Attendance staging window bundle — AE-4 + RD-4/5 + OT-bank v1-8 (+ optional MP-6 · HMR-5)

**Date:** 2026-07-02

**Status:** PREPARED. This plan does **not** claim any staging PASS. It is the
single operating plan for one staging window that runs the three core
attendance smokes — plus up to two optional smokes (MP-6, HMR-5) — back-to-back
on ONE deployed SHA. Each smoke's PASS is
recorded in its own runbook; this document coordinates deploy, ordering,
isolation, and the consolidated closeout.

**Precedent:** the bundled-window format follows
`docs/development/attendance-staging-smoke-ns4-ta4-20260624.md` (one doc, two
self-contained smokes, per-smoke deployed-code gates, per-smoke stamps,
zero-residue discipline). Its recorded lesson binds this window: the two
precedent smokes did NOT land on one SHA and one stamp lost its exact deploy
SHA — so in this window, **capture the exact deploy SHA into every stamp at
run time**, never from memory.

## 1. The five smokes (three core + two optional)

| # | Smoke | Runbook | Helper | Final stamp shape |
|---|---|---|---|---|
| 1 | **AE-4** anomaly-result-edit closeout | `docs/development/attendance-ae4-anomaly-result-edit-staging-smoke-runbook-20260701.md` | `scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs` (`AE4_RESULT_EDIT_API_DB_SMOKE_PASS`) | `AE4_RESULT_EDIT_STAGING_SMOKE_PASS deploy=<sha> stamp=<ae4-smoke-...> org=<org> notifyRecord=<uuid> skipRecord=<uuid> residue=0` |
| 2 | **RD-4/5** report-digest config card + producer/worker | `docs/development/attendance-rd45-report-digest-staging-smoke-runbook-20260702.md` | `scripts/ops/staging-attendance-report-digest-rd45-smoke.mjs` (`RD45_REPORT_DIGEST_API_DB_SMOKE_PASS`) | `RD45_REPORT_DIGEST_STAGING_SMOKE_PASS deploy=<sha> stamp=<rd45-smoke-...> org=<rd45-smoke-...-org> produced=<n> dedupOk=1 sendProof=<sent\|failed_recipient_not_bound\|failed_channel_not_configured> residue=0` |
| 3 | **OT-bank v1-8** 三例验收 + settlement | `docs/development/attendance-overtime-bank-v18-staging-smoke-runbook-20260702.md` | `scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs` (`OTBANK_V18_API_DB_SMOKE_PASS`) | `OTBANK_V18_STAGING_SMOKE_PASS deploy=<sha> stamp=<otbank-v18-smoke-...> org=<org> cycle=<uuid> residue=0` |
| 4 | **MP-6** makeup-punch (optional) | `docs/development/attendance-makeup-punch-mp6-staging-smoke-runbook-20260703.md` | `scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs` (`MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS`) | `MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS deploy=<sha> stamp=<mp6-smoke-...> org=<org> quota=1 approvals=1 residue=0` |
| 5 | **HMR-5** manual missed-punch reminder (optional) | `docs/development/attendance-manual-missed-punch-reminder-hmr5-staging-runbook-20260626.md` | `scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs` (`HMR5_API_DB_SMOKE_PASS`) | `HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS deploy=<sha> stamp=hmr5-... channel=<channel> residue=0` |

Each helper prints an `*_API_DB_SMOKE_PASS` line that is **not** the final
stamp; the final `*_STAGING_SMOKE_PASS` stamps are recorded by the operator in
the respective runbooks after the manual/decision steps there.

**Optional 4th smoke (MP-6 makeup-punch).** Row 4 is an OPTIONAL addition to
this window — it can run standalone OR as the 4th smoke on the SAME deploy SHA.
Run it AFTER OT-bank v1-8, since it also touches `attendance_requests` /
`attendance_records` and the approval-engine tables; its distinct `mp6-smoke-`
stamp keeps it fully isolated from the three core smokes above (which are not
rewritten here). MP-6 enforcement is subject-scoped — no org-wide enumeration, so
the OT-bank settlement-population guard does not apply — but enabling
`makeupPunchPolicy` flips a GLOBAL settings row, so run it under the window's
single-tenant posture (its runbook OQ-3 records that decision). MP-6 writes NO
notification deliveries.

**Optional 5th smoke (HMR-5 manual missed-punch reminder).** Row 5 is an
OPTIONAL addition to this window — it can run standalone OR as a 5th smoke on
the SAME deploy SHA, in either order relative to MP-6. Their stamps are
mutually exclusive (`mp6-smoke-` vs `hmr5-smoke-`), and MP-6 runs on the
window's shared org while HMR-5 runs on its own disposable org (below), so no
row-level collision is possible even though both touch the same
`attendance_records` / `attendance_requests` tables.

Unlike MP-6, HMR-5 **does write** `attendance_notification_deliveries` (with
`source_type='manual_missed_punch_reminder'`) — the same shared table AE-4
(`attendance_result_edit`) and RD-4/5 (`attendance_report_digest`) also write.
Isolation from the other smokes relies on the same discipline §5 already establishes
for that table: every HMR-5 delivery query (assert, residue, cleanup) is
scoped `org_id + source_type='manual_missed_punch_reminder'`. HMR-5 also runs
its own users/records/requests/scopes on a disposable `hmr5-smoke-`-prefixed
org (like RD-4/5's disposable org, and unlike AE-4/MP-6/OT-bank, which share
the window's org), so its rows never share an `org_id` with the window-org
smokes' (AE-4 / OT-bank / MP-6) rows in the first place.

**Suggested order: run HMR-5 LAST in the window** (after OT-bank v1-8 and
MP-6, if both run). It is the only smoke of the five whose "worker delivery"
proof polls the SAME shared, already-running C5 delivery worker that AE-4's
and RD-4/5's own delivery rows are also live under — running it last means
its worker-status poll never has to race a still-in-progress AE-4/RD-4/5
assertion window for that shared worker's attention, and any leftover HMR-5
rows from a failed run are the last thing the consolidated residue sweep (§7)
needs to account for. HMR-5's own runbook records the final PASS stamp after
both its helper run and the runbook's manual admin-console UI
confirm-snapshot step (step 3) pass.

## 2. One deploy SHA for the whole window

Deploy ONE main build to the staging stack and run every smoke in the window
against it. The single `DEPLOY_SHA` must include every per-smoke code gate:

- **AE-4**: AE-1 result-edit route + audit table, AE-1b marker durability,
  AE-2/2.1 affected-employee notification + toggle, AE-3 admin modal (per the
  AE-4 runbook's prerequisites).
- **RD-4/5**: RD-1 config contract, RD-2/RD-3 producer chain, RD-4 admin
  config card (per the report-digest design lock,
  `docs/development/attendance-report-digest-subscription-design-lock-20260626.md`).
- **OT-bank v1-8**: v1-1..v1-6 plus the #3255 must-pay e2e and the #3303
  unconditional-settings-restore fix (per
  `docs/development/attendance-overtime-bank-design-verification-20260624.md`).
- **HMR-5** (if run this window): HMR-1 scheduler-scope `remind` action (#3269),
  HMR-2 owed-punch candidate read/filter route (#3270), HMR-3 manual reminder
  enqueue route (#3271), HMR-4 admin UI (#3272) — per the HMR-5 runbook's
  prerequisites and the design lock,
  `docs/development/attendance-manual-missed-punch-reminder-design-lock-20260626.md`.

Deploy-SHA verification (manual — no committed tool cross-checks the staging
stack's build against an expected SHA, see §9):

```bash
# through the web port tunnel (bare /health is not proxied at the web port — use /api/health):
curl -sS http://127.0.0.1:8082/api/health | jq -r .build.commit
# or backend-direct through the tunnel:
curl -sS http://127.0.0.1:18900/health | jq -r .build.commit
```

Both must equal the full `DEPLOY_SHA` you will write into every stamp. Do not
use a local branch SHA.

Staging deploys are operator-run over SSH (the CI deploy job targets the
prod-track stack, not the staging stack, and does not auto-mirror main): pin
the image tag to the full 40-char SHA in the staging stack's env/override,
pull, recreate `backend`/`web` with `--no-deps`, per
`docs/development/staging-deploy-d88ad587b-20260426.md` and the flag-pinning
override pattern in
`docs/development/multitable-global-history-staging-flag-operator-checklist-20260701.md`.

## 3. Shared window preflight (run ONCE, before smoke #1)

1. **Health + build**: API health OK on the deployed build; `build.commit`
   equals `DEPLOY_SHA` (commands above).
2. **Migration alignment** (deploy SOP discipline): list pending migrations
   from the running backend and classify them READ-ONLY before anything else:

   ```bash
   docker compose -f docker-compose.app.staging.yml exec -T backend \
     node packages/core-backend/dist/src/db/migrate.js --list > /tmp/staging-migrate-list.txt
   node scripts/ops/staging-migration-alignment-report.mjs \
     --migrate-list-file /tmp/staging-migrate-list.txt --out-dir /tmp/staging-migration-report
   ```

   If the report says do-not-run-full-migrate, STOP and follow
   `docs/development/staging-migration-alignment-runbook-verification-20260519.md`;
   do not improvise DDL. The window needs (at minimum) the AE audit table,
   `attendance_notification_deliveries` (shared by AE-4 and RD — the digest
   producer has no tables of its own; it writes the existing deliveries table
   and persists policy in the shared settings row), and the OT-bank
   `attendance_payroll_cycle_settlements` + `overtime_source` migrations.
3. **Auth round-trip**: with the staging-realm admin token,
   `GET /api/attendance/settings` must return `200`. A `401 Invalid token`
   means a wrong-realm token (staging signs with its own secret — re-mint,
   don't debug the route); a `503 DB_NOT_READY` means the schema gap above —
   STOP.
4. **Environment flags — set once, at window start**: only RD needs env gates
   (`ATTENDANCE_SCHEDULER_ENABLED=true`,
   `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true`, plus a routable
   notification channel per the RD runbook). **The backend's
   `ATTENDANCE_REPORT_DIGEST_ENABLED` stays UNSET/false for the whole window**
   (RD runbook amendment): the digest policy is a single GLOBAL settings row,
   so once the RD smoke enables it, a backend with the digest gate on would
   fan the next real scheduler tick out to real default-org members — the
   RD helper instead enables the gate process-locally around its seam call
   and asserts a no-default-org-leakage guard. Only the RD runbook's
   owner-gated Track B variant sets the backend gate, under its own guards.
   Env changes require a backend container recreate, so flip them together
   with the deploy (never mid-smoke), verify them in the running container
   env, and plan the rollback (remove flags + restart) for the window close.
   This is safe for the whole window: with the backend digest gate off, the
   producer never runs in the backend regardless of policy state, and AE-4 /
   v1-8 are settings-gated only.
5. **Settings snapshot**: save `GET /api/attendance/settings` to
   `/tmp/window-settings-before.json` as the window-level baseline, in
   addition to each smoke's own snapshot/restore.
6. **DB channel**: confirm `DATABASE_URL` reaches the SAME staging database as
   `BASE_URL` (each helper also runs its own API↔DB coherence probe and
   aborts on mismatch).

## 4. Execution order and rationale

Run strictly sequentially, never in parallel:

1. **AE-4 first.** It is the only smoke with a mandatory manual browser step
   (the AE-3 modal probe), so it runs while the operator's attention and the
   freshly-verified deploy are at their best. Its settings key
   (`attendanceResultEditPolicy`) is disjoint from every other smoke in the window.
2. **RD-4/5 second.** It is the only smoke that depends on the window's env
   flags (scheduler / delivery worker / digest producer) and on a disposable
   org; running it in the middle keeps the flag-dependent assertions well
   inside the window, after AE-4 has already restored its settings.
3. **OT-bank v1-8 third (last of the core three).** It touches the most settings keys
   (`overtimeSegmentation`, `compTimeFromOvertime`, `overtimeBankPolicy`,
   `leaveBalanceDeductionPolicy`, `attendanceBonusPolicy`) and closes a
   payroll cycle whose settlement population is org-wide — running it last
   means the other smokes never execute under partially-flipped money-path
   policies, and its population guard sees the quietest possible org state.
4. **MP-6 fourth (optional).** Runs AFTER OT-bank v1-8 because it also touches
   `attendance_requests` / `attendance_records` and the approval-engine tables
   (§1's MP-6 note); enabling `makeupPunchPolicy` flips a GLOBAL settings row,
   so it runs under the window's single-tenant posture (runbook OQ-3) and
   restores + verifies that key before HMR-5 starts. Skip cleanly if not run.
5. **HMR-5 fifth (optional, LAST in the window).** §1's ordering rationale:
   it is the only smoke whose worker-delivery proof polls the SAME shared C5
   delivery worker that AE-4's and RD-4/5's rows are live under — running it
   last avoids racing their assertion windows, and any leftover HMR-5 rows are
   the final thing the §7 sweep accounts for. Skip cleanly if not run.

Settings mutations across the five smokes are key-disjoint (MP-6 owns the
GLOBAL `makeupPunchPolicy` row; HMR-5 PUTs no settings keys at all — its
channel resolves from env, not attendance settings), and each smoke
snapshots + restores its own keys before the next starts — but ordering still
matters for blast-radius: a mid-run abort leaves that smoke's policies live
until its cleanup is completed, so finish (or fully clean up) one smoke before
starting the next. **A failed settings restore in any smoke blocks starting
the next smoke** until settings are verified restored.

## 5. Per-smoke isolation rules

**Stamps.** Every business row a smoke creates is stamped, and every cleanup /
residue query is anchored on the stamp — never on broad text or types:

| Smoke | User/stamp prefix | Business-key prefix |
|---|---|---|
| AE-4 | `ae4-smoke-<suffix>-…` | `ae4-smoke:<STAMP>:…` |
| RD-4/5 | `rd45-smoke-<suffix>-…` | `rd45-smoke:<STAMP>:…` (no occupant — digest source keys are deterministic; see the RD runbook's known-family-deviation section) |
| OT-bank v1-8 | `otbank-v18-smoke-<suffix>-…` | `otbank-v18-smoke:<STAMP>:…` |
| MP-6 (optional) | `mp6-smoke-<suffix>-…` | `mp6-smoke:<STAMP>:…` (attachment key only) |
| HMR-5 (optional) | `hmr5-smoke-<suffix>-…` (stamp regex-locked `^hmr5-smoke-[A-Za-z0-9-]+$`) | org-scoped: disposable `hmr5-smoke-`-prefixed org (default `<STAMP>-org`) + `source_type='manual_missed_punch_reminder'` |

The prefixes are mutually exclusive by construction, so residue queries cannot
collide. Helpers regex-lock their stamps and refuse unstamped ids.

**Settings.** `PUT /api/attendance/settings` merges per policy key, so each
smoke PUTs ONLY its own keys and siblings survive: AE-4 owns
`attendanceResultEditPolicy`; RD-4/5 owns `attendanceReportDigestPolicy`;
v1-8 owns the five overtime-bank keys listed in §4; MP-6 owns
`makeupPunchPolicy` (a GLOBAL settings row — single-tenant posture per its
runbook OQ-3); HMR-5 owns none (no settings PUT/restore in its helper). Because of the merge
semantics, restores must explicitly re-assert every touched key (PUT-ing an
empty snapshot is a NO-OP — the #3303 lesson); each smoke restores and
VERIFIES (re-GET + compare) before the next smoke begins.

**The shared deliveries table.** Three of the five smokes write
`attendance_notification_deliveries`: AE-4 with
`source_type='attendance_result_edit'` (source keys
`attendance_result_edit:<org>:<recordId>:%`), RD-4/5 with
`source_type='attendance_report_digest'` (unique idempotent source keys per
org/cadence/period/recipient/channel), and HMR-5 with
`source_type='manual_missed_punch_reminder'` (source keys
`…:recipient:<user>:channel:<channel>`, scoped to its disposable org). The
OT-bank smoke and MP-6 write none and assert zero. Rules:

- every delivery query (assert, residue, cleanup) is scoped
  `org + source_type + stamped source key` — never delete by `source_type`
  alone;
- the delivery worker is live for the WHOLE window (env flags, §3). During
  AE-4 either assert on delivery-row existence and audit back-link (not on
  send status), or park claimable rows first with the established pattern —
  bump `next_attempt_at` into the future for pre-existing pending rows and
  make only the row under test claimable;
- RD-5 must prove "producer writes row" and "worker sends/fails" as separate
  assertions (its design lock requires the split).

**Org scope.** AE-4 runs on the default org with stamped synthetic users.
RD-4/5 MUST use a disposable single-member smoke org, because the digest
producer fans out per active org member. HMR-5 likewise runs on its own
disposable `hmr5-smoke-`-prefixed org (the candidates route returns an
org-wide pool with no per-run filter — §1). OT-bank v1-8 defaults to the shared
org but fails closed if the settlement population would include any
non-synthetic user (its runbook OQ-2 records the operator decision; the
override env is explicit and dangerous).

**Payroll cycles.** Only v1-8 creates/closes a cycle, on a far-future period
chosen to overlap nothing; AE-4 SQL-seeds a stamped closed cycle only for its
409 guard. Neither touches production cycles.

## 6. Per-smoke independence

Each smoke is independently PASS/FAIL:

- a FAIL in one smoke does **not** void another smoke's recorded PASS (the
  precedent window closed one smoke on an earlier deploy than the other —
  legitimate, as long as every stamp names its exact deploy SHA);
- a FAILed smoke is cleaned up (helpers attempt best-effort cleanup and print
  the residue), its settings restore is verified, and the window may continue
  with the next smoke;
- what a FAIL does block: re-running THAT smoke requires a fresh STAMP, and a
  failed settings restore blocks the whole window (§4);
- if the window must be re-run on a newer deploy, previously-recorded PASS
  stamps stay valid for their SHA; re-stamp only what re-ran.

## 7. Consolidated final residue sweep (window close)

After every smoke that ran (and before rolling back env flags), run each
runbook's own residue block once more, then this cross-smoke sweep. Every
count must be `0`. Substitute the run stamps of every executed smoke; the per-run captured id
lists (request/approval/cycle/import ids) come from each helper's output and
runbook worksheet.

```sql
-- synthetic users and memberships, core families (optional MP-6/HMR-5 blocks below)
SELECT count(*) AS users FROM users
 WHERE left(id, 10) = 'ae4-smoke-' OR left(id, 11) = 'rd45-smoke-' OR left(id, 17) = 'otbank-v18-smoke-';
SELECT count(*) AS user_orgs FROM user_orgs
 WHERE left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';

-- attendance business rows by stamped meta/user
SELECT count(*) AS records FROM attendance_records
 WHERE meta->>'smokeStamp' IN (:ae4_stamp, :rd45_stamp, :otbank_stamp)
    OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';
SELECT count(*) AS requests FROM attendance_requests
 WHERE metadata->>'smokeStamp' IN (:ae4_stamp, :rd45_stamp, :otbank_stamp)
    OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';

-- the shared deliveries table, per source_type + stamped scoping (never source_type alone)
SELECT count(*) AS ae4_deliveries FROM attendance_notification_deliveries d
  JOIN attendance_record_result_edits e ON d.source_id = e.id::text AND e.org_id = d.org_id
 WHERE d.source_type = 'attendance_result_edit'
   AND left(e.idempotency_key, length('ae4-smoke:' || :ae4_stamp || ':')) = 'ae4-smoke:' || :ae4_stamp || ':';
SELECT count(*) AS rd45_deliveries FROM attendance_notification_deliveries
 WHERE source_type = 'attendance_report_digest' AND org_id = :rd45_smoke_org;
SELECT count(*) AS stray_deliveries_to_smoke_users FROM attendance_notification_deliveries
 WHERE left(recipient_user_id, 10) = 'ae4-smoke-' OR left(recipient_user_id, 11) = 'rd45-smoke-'
    OR left(recipient_user_id, 17) = 'otbank-v18-smoke-';

-- OT-bank money-path tables (cycle ids captured from the v1-8 run)
SELECT count(*) AS settlements FROM attendance_payroll_cycle_settlements WHERE cycle_id = ANY(:otbank_cycle_ids::uuid[]);
SELECT count(*) AS cycles FROM attendance_payroll_cycles
 WHERE metadata->>'smokeStamp' IN (:ae4_stamp, :otbank_stamp);
SELECT count(*) AS lots FROM attendance_leave_balances
 WHERE left(user_id, 17) = 'otbank-v18-smoke-' OR source_key = :otbank_poison_lot_key;
SELECT count(*) AS fixtures FROM attendance_overtime_rules WHERE name = :otbank_rule_name;
SELECT count(*) AS leave_types FROM attendance_leave_types WHERE code = :otbank_leave_type_code;
SELECT count(*) AS holidays FROM attendance_holidays WHERE name = :otbank_holiday_name;

-- approval-engine rows written by the v1-8 request chain (ids captured by the helper)
SELECT count(*) AS approval_instances FROM approval_instances WHERE id = ANY(:otbank_approval_ids::text[]);

-- MP-6 makeup-punch (optional 4th smoke) — subject-scoped rows by the mp6 stamp/prefix
-- (all zero; ids captured from the MP-6 helper run). 'mp6-smoke-' is 10 chars.
SELECT count(*) AS mp6_requests FROM attendance_requests
 WHERE org_id = :org_id AND (id = ANY(:mp6_request_ids::uuid[]) OR left(user_id, 10) = 'mp6-smoke-');
SELECT count(*) AS mp6_records FROM attendance_records
 WHERE org_id = :org_id AND left(user_id, 10) = 'mp6-smoke-';
SELECT count(*) AS mp6_events FROM attendance_events
 WHERE org_id = :org_id AND meta->>'requestId' = ANY(:mp6_request_ids::text[]);
SELECT count(*) AS mp6_approval_instances FROM approval_instances WHERE id = ANY(:mp6_approval_ids::text[]);
SELECT count(*) AS mp6_users FROM users WHERE left(id, 10) = 'mp6-smoke-';
SELECT count(*) AS mp6_user_orgs FROM user_orgs WHERE left(user_id, 10) = 'mp6-smoke-';
-- MP-6 writes NO deliveries — this must be 0 (never delete by source_type alone)
SELECT count(*) AS mp6_deliveries FROM attendance_notification_deliveries
 WHERE org_id = :org_id AND left(recipient_user_id, 10) = 'mp6-smoke-';

-- HMR-5 manual missed-punch reminder (optional 5th smoke) — disposable-org scoped.
-- 'hmr5-smoke-' is 11 chars; :hmr5_org is the run's disposable org id (default <STAMP>-org).
SELECT count(*) AS hmr5_deliveries FROM attendance_notification_deliveries
 WHERE org_id = :hmr5_org AND source_type = 'manual_missed_punch_reminder';
SELECT count(*) AS hmr5_stray_deliveries FROM attendance_notification_deliveries
 WHERE left(recipient_user_id, 11) = 'hmr5-smoke-';
SELECT count(*) AS hmr5_requests FROM attendance_requests WHERE org_id = :hmr5_org;
SELECT count(*) AS hmr5_records FROM attendance_records WHERE org_id = :hmr5_org;
SELECT count(*) AS hmr5_scopes FROM attendance_scheduler_scopes WHERE org_id = :hmr5_org;
SELECT count(*) AS hmr5_user_orgs FROM user_orgs WHERE org_id = :hmr5_org;
SELECT count(*) AS hmr5_user_roles FROM user_roles WHERE left(user_id, 11) = 'hmr5-smoke-';
SELECT count(*) AS hmr5_users FROM users WHERE left(id, 11) = 'hmr5-smoke-';

-- settings: compare the live document to the window baseline
-- (GET /api/attendance/settings vs /tmp/window-settings-before.json — policy keys equal)
```

The RD-4/5 runbook's own residue block (its digest/org tables) is part of this
sweep by reference; so is the HMR-5 runbook's (its disposable org mirrors
RD-4/5's). A stray row anywhere is a failed window close, not a
harmless warning — inspect before deleting anything by hand, and only delete
via the owning runbook's stamped cleanup.

Finally, roll back the RD env flags per §3 (remove flags + recreate the
backend container, verify health), and confirm the settings document equals
the window baseline.

## 8. Closure checklist

- [ ] Window preflight recorded (deploy SHA, migration report, auth
      round-trip, env flags) — once, in this doc's run notes or the first
      runbook's worksheet.
- [ ] AE-4: helper `AE4_RESULT_EDIT_API_DB_SMOKE_PASS` + manual AE-3 modal
      step done; final `AE4_RESULT_EDIT_STAGING_SMOKE_PASS` recorded in the
      AE-4 runbook with deploy SHA + residue 0; **close the AE umbrella issue
      #3317 with the stamp in the close note**.
- [ ] RD-4/5: producer-writes-row and worker-sends assertions both recorded;
      final stamp recorded in the RD-4/5 runbook with deploy SHA + residue 0;
      disposable org torn down.
- [ ] OT-bank v1-8: helper `OTBANK_V18_API_DB_SMOKE_PASS`; OQ-1 (三例 mapping)
      and OQ-2 (org/population) decisions recorded; final
      `OTBANK_V18_STAGING_SMOKE_PASS` recorded in the v1-8 runbook with deploy
      SHA + residue 0; the v1-8 row in the overtime-bank design-verification
      doc flips to done in a follow-up docs PR (not from this plan alone).
- [ ] MP-6 (optional): helper `MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS`; OQ-1 (token)
      and OQ-3 (single-tenant / org) decisions recorded; final
      `MP6_MAKEUP_PUNCH_STAGING_SMOKE_PASS` recorded in the MP-6 runbook with
      deploy SHA + residue 0. Skip cleanly if MP-6 is not run this window.
- [ ] HMR-5 (optional): helper `HMR5_API_DB_SMOKE_PASS`; manual admin-console
      confirm-snapshot step (runbook step 3) done; final
      `HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS` recorded in the
      HMR-5 runbook with deploy SHA + channel + residue 0; disposable org torn
      down; tracker §0.6 HMR-5 row flips ✅ in a follow-up docs PR. Skip
      cleanly if HMR-5 is not run this window.
- [ ] Consolidated residue sweep (§7) all-zero; env flags rolled back;
      settings equal the window baseline.
- [ ] Each stamp names the exact deployed SHA (the precedent window's missing
      SHA lesson).

## 9. Open questions / verify on the host before the window

1. **Staging DB reachability**: the staging compose file publishes no host
   port for the database; the working `DATABASE_URL` (published port or
   tunnel endpoint) lives in the host-local override files — verify on the
   host before the window.
2. **Compose tooling**: the older deploy postmortem used v1 syntax with the
   stop/rm/up-no-deps workaround; the newer operator checklist uses v2
   (`docker compose`) — confirm which the host has before scripting.
3. **Current env-flag state**: whether the scheduler / delivery-worker /
   channel envs are already set on the host env file is not knowable from the
   repo — read the live container env first; only add what is missing.
4. **RD-5 tick mechanism — resolved in the RD runbook**: the primary track is
   a deterministic in-process invocation of the digest-producer seam from a
   prepared checkout at the deployed SHA on a host with `DATABASE_URL` access
   (or in-container if the RD runbook's OQ-2 resolves on the host), scoped to
   the disposable smoke org (no force-tick HTTP route exists); the
   real-scheduler tick on the default org is an explicitly owner-gated
   optional variant. See the RD-4/5 runbook for the exact commands and guards.
5. **Token mint path**: dev-token is expected to 404 on staging
   (production node-env); which mint path (host-side token generator script vs
   in-container mint script) counts as the approved smoke-token path is
   unstated in the family docs — operator picks one and uses it for every smoke
   in the window (see the v1-8 runbook OQ-3).
6. **Deploy-SHA cross-check tooling**: no committed helper asserts
   `/health build.commit == DEPLOY_SHA` for the staging stack; §2's manual
   curl check is mandatory in this window and the per-helper `DEPLOY_SHA` env
   only names the stamp — it does not verify the build.
7. **RD-4/5 runbook filename — resolved**: the RD-4/5 runbook + helper landed
   in this bundle at the exact paths named in §1's table (this plan
   intentionally does not restate their content).
