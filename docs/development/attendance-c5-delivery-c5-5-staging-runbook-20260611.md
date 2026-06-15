# C5-5 staging smoke runbook - attendance delivery outbox and DingTalk fan-out

**Date:** 2026-06-11
**Script:** `scripts/ops/staging-attendance-c5-delivery-smoke.ts`
**Goal:** the final C5 completion gate. A fake-channel run proves delivery state flow only and keeps C5 **🟡**. A real DingTalk work-notification run proves external delivery and can flip C5 **🟡 -> ✅**.

## What This Smoke Proves

The script exercises the C5 delivery chain against staging:

- unscheduled reminder source creates one dispatch for a scheduled-shift user with no assignment;
- unscheduled reminder and comp-time expiry reminder each fan out to subject + owner + sub_owner;
- delivery worker claims pending rows, sends six primary rows, and never re-sends sent rows on repeat;
- retry probe records `retrying` and then terminal `failed` with visible `last_error`;
- C5-4 read-only admin API returns the rows and counters;
- cleanup restores residue to 0.

Two channel modes are intentionally separate:

| Mode | Env | Completion meaning |
|---|---|---|
| Fake channel | `C5_CHANNEL_MODE=fake` | C5-5a only: proves outbox, state flow, retry/idempotency, fan-out, and admin counters. C5 remains 🟡. |
| Real DingTalk | `C5_CHANNEL_MODE=dingtalk` + `ALLOW_REAL_DINGTALK_SEND=1` | C5-5b: sends real DingTalk work notifications. With PASS + residue=0, C5 can flip ✅. |

## Prerequisites

1. **Deploy a main build containing C5-4 and this runbook PR.** The staging backend must include C5-0 through C5-4 and this script. Verify build SHA before running.
2. **Staging DB migrated through C5.** Required tables include:
   - `attendance_unscheduled_reminder_dispatch`
   - `attendance_leave_balances`
   - `attendance_notification_deliveries`
   - `attendance_group_managers`
   - DingTalk directory tables for real mode.
3. **Reachability to staging API and DB.** Run on the staging host, or through a tunnel:
   - `BASE_URL=http://127.0.0.1:8082`
   - `DATABASE_URL=postgresql://...`
4. **No unrelated C5 source candidates or due delivery rows.** The unscheduled/comp-time producers scan globally, and the C5 worker claim is global. The script refuses to run if non-smoke source candidates or due non-smoke delivery rows exist. `ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES=1` only bypasses the worker due-row guard, and only on a disposable staging DB; it does not bypass source-candidate refusal.
5. **Synthetic org only by default.** The script creates a synthetic `org-c5-delivery-*` org. If `ORG_ID` is overridden, cleanup is refused unless `ALLOW_C5_SMOKE_CUSTOM_ORG_CLEANUP=1`.
6. **Real DingTalk mode only:** provide a staging DingTalk recipient:
   - `DINGTALK_SMOKE_EXTERNAL_USER_ID=<real_dingtalk_userid>` for all three smoke recipients, or role-specific `DINGTALK_SMOKE_SUBJECT_USER_ID`, `DINGTALK_SMOKE_OWNER_USER_ID`, `DINGTALK_SMOKE_SUB_OWNER_USER_ID`;
   - real DingTalk work-notification runtime config must be present. The smoke supports either backend env vars (`DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_AGENT_ID`) or `DINGTALK_SMOKE_CONFIG_INTEGRATION_ID=<existing_dingtalk_integration_id>`, which copies that integration's stored config into the temporary synthetic integrations.
7. **Real DingTalk mode only:** run the read-only preflight below before sending any real work notifications.

## Run Fake-Channel Smoke

This is safe as a mechanism smoke and does not send real external messages:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
C5_CHANNEL_MODE=fake \
EXPECTED_DEPLOY_SHA=<deployed-sha> \
pnpm exec tsx scripts/ops/staging-attendance-c5-delivery-smoke.ts
```

Expected final stamp:

```text
C5_FAKE_CHANNEL_STAGING_SMOKE_PASS deploy=<sha> stamp=c5-delivery-... channel=fake residue=0
```

Record the result, but keep the tracker at 🟡.

### 2026-06-12 fake-channel staging evidence

On 2026-06-12, staging was deployed to `a1d8a6c62e5feb526d5d854dbc7805770c904941` (the #2528
runbook/script commit) and migrated from 185 to 190 applied migrations, including
`zzzz20260611120000_create_attendance_notification_deliveries`. The first migration attempt failed with
Postgres `53100 No space left on device` while the root filesystem was at 100%; the operator cleanup removed
unused Docker images/build cache only (no volumes or DB data) and left the root filesystem at about 52% used
before retrying the migrations successfully.

The fake-channel smoke then ran from the deployed backend container and passed:

```text
C5_FAKE_CHANNEL_STAGING_SMOKE_PASS deploy=a1d8a6c62e5feb526d5d854dbc7805770c904941 stamp=c5-delivery-mqajq5o8 channel=fake residue=0
```

It covered both source producers, subject + owner + sub_owner fan-out, delivery worker sent/retry/failed
state flow, repeat idempotency, C5-4 admin counters, and cleanup residue 0. This evidence is **C5-5a only**:
it keeps C5 at 🟡 because no real DingTalk work notification was sent.

## Run Real DingTalk Smoke

This sends six real DingTalk work notifications: two sources times subject, owner, and sub_owner. Use a test DingTalk user or a staging-only recipient.

### Preflight Real DingTalk Inputs

The preflight is read-only: it checks C5 tables, DingTalk config availability, recipient inputs, token availability, and due delivery rows. It does not seed smoke rows and does not send DingTalk messages. It also omits secret values from stdout, JSON, and Markdown outputs.

Run this first from the same staging context that will run the real smoke:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DINGTALK_SMOKE_EXTERNAL_USER_ID=<real_dingtalk_userid> \
SMOKE_TOKEN=<staging-admin-jwt> \
node scripts/ops/attendance-c5-real-dingtalk-preflight.mjs \
  --database-url "$DATABASE_URL" \
  --env-file docker/app.staging.env
```

If staging uses stored DingTalk integration config rather than backend env vars, add:

```bash
DINGTALK_SMOKE_CONFIG_INTEGRATION_ID=<existing_dingtalk_integration_id>
```

Expected ready output:

```json
{"ok":true,"overallStatus":"ready","missingCheckIds":[],"jsonPath":"output/attendance-c5-real-dingtalk-preflight/summary.json","mdPath":"output/attendance-c5-real-dingtalk-preflight/summary.md"}
```

If the preflight returns `overallStatus:"blocked"`, fix the listed checks before running the real smoke. Do not use `--allow-blocked` as a completion signal; it is only for capturing a blocked report artifact.

### 2026-06-12 preflight deployment evidence

After #2530 added the preflight, staging was deployed to `890a2ad5091552fcd8feffa669a2c35d76683d44` but exposed a
deployment substrate gap: the backend runner image did not include `scripts/ops`, so the preflight script was not
available inside `/app`. #2531 fixed that by copying `/app/scripts` into the backend runner image and gating the
Dockerfile contract in `DingTalk P4 ops regression gate`.

Staging was then deployed to `ed02917626dd302299cc3001e55c519d6004b7de`; `/health` reported the same build commit and
image tag, and the backend container directly passed:

```text
preflight-script-in-image-ok
```

The read-only preflight then ran from the deployed backend container. It did not seed rows and did not send DingTalk
messages. Current result:

```text
overallStatus=blocked
missingCheckIds=dingtalk-config,recipient,auth-token
tables=pass
due-deliveries=pass (0 due rows)
directory-state=0 active DingTalk integrations, 0 accounts, 0 links
```

Before running the real smoke, provide:

- DingTalk work-notification config: backend env with app key/secret/agent id, or `DINGTALK_SMOKE_CONFIG_INTEGRATION_ID`;
- a test recipient via `DINGTALK_SMOKE_EXTERNAL_USER_ID` or the three role-specific recipient ids;
- a staging admin token via `SMOKE_TOKEN`/`TOKEN`, or the deploy-host token fallback.

### 2026-06-14 preflight refresh

After dispatch D5 closeout, staging was on deploy `9179c65bb4a6d0014801896645f6108e94466a79`. The C5 preflight was
rerun from the deployed backend container with a deploy-host minted temporary admin token. Current result:

```text
overallStatus=blocked
missingCheckIds=dingtalk-config,recipient
tables=pass
auth-token=pass
due-deliveries=pass (0 due rows)
directory-state=0 active DingTalk integrations, 0 accounts, 0 links
```

The container/host env has `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET`, but still lacks the work-notification
agent id (`DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID`). Before running the real smoke, provide that agent id and
a test recipient external user id. The auth-token requirement can be satisfied by the existing deploy-host fallback.

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
C5_CHANNEL_MODE=dingtalk \
ALLOW_REAL_DINGTALK_SEND=1 \
DINGTALK_SMOKE_EXTERNAL_USER_ID=<real_dingtalk_userid> \
EXPECTED_DEPLOY_SHA=<deployed-sha> \
pnpm exec tsx scripts/ops/staging-attendance-c5-delivery-smoke.ts
```

If staging uses stored DingTalk integration config rather than backend env vars, use this variant:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
C5_CHANNEL_MODE=dingtalk \
ALLOW_REAL_DINGTALK_SEND=1 \
DINGTALK_SMOKE_EXTERNAL_USER_ID=<real_dingtalk_userid> \
DINGTALK_SMOKE_CONFIG_INTEGRATION_ID=<existing_dingtalk_integration_id> \
EXPECTED_DEPLOY_SHA=<deployed-sha> \
pnpm exec tsx scripts/ops/staging-attendance-c5-delivery-smoke.ts
```

Expected final stamp:

```text
C5_REAL_DINGTALK_STAGING_SMOKE_PASS deploy=<sha> stamp=c5-delivery-... channel=dingtalk residue=0
```

On PASS, close C5 in the tracker with deploy SHA, stamp, channel mode, and residue.

### 2026-06-12 real-mode blocker

The same staging environment could not run the real DingTalk smoke yet: the deployed backend had no
`DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, or `DINGTALK_AGENT_ID` env values, and staging DB had no
`directory_integrations`, `directory_accounts`, or `directory_account_links` rows to copy from via
`DINGTALK_SMOKE_CONFIG_INTEGRATION_ID`. To run C5-5b, first provide either:

- backend DingTalk work-notification env config plus `DINGTALK_SMOKE_EXTERNAL_USER_ID`; or
- a stored active DingTalk integration id plus a test `DINGTALK_SMOKE_EXTERNAL_USER_ID`.

Do not mark C5 ✅ from the fake-channel PASS alone.

## Expected Output Shape

```text
C5 delivery staging smoke @ http://127.0.0.1:8082
  mode=dingtalk org=org-c5-delivery-... stamp=c5-delivery-... deploy=<sha>
  PASS  no due non-smoke delivery rows before worker claim
  PASS  unscheduled source sees the smoke subject as a candidate
  PASS  unscheduled source claimed exactly one smoke dispatch
  PASS  unscheduled source produced subject + owner + sub_owner deliveries
  PASS  comp-time expiry source sees the smoke lot as in-window
  PASS  comp-time expiry source produced subject + owner + sub_owner deliveries
  PASS  dingtalk worker claimed and sent the 6 primary C5 deliveries
  PASS  delivery rows exist for both sources x subject/owner/sub_owner
  PASS  repeat worker run does not resend already-sent primary deliveries
  PASS  fake retry probe enters retrying state on first attempt
  PASS  fake retry probe fails visibly after max attempts
  PASS  C5-4 admin observability API reads delivery rows
  PASS  cleanup residue = 0 (...)

=== PASS - ... passed, 0 failed ===  stamp c5-delivery-...
C5_REAL_DINGTALK_STAGING_SMOKE_PASS deploy=<sha> stamp=c5-delivery-... channel=dingtalk residue=0
```

## Tracker Closeout Template

Use this only after a real DingTalk PASS:

> **回填（YYYY-MM-DD C5-5 real DingTalk staging closeout）**：C5 外发通知与负责人 fan-out staging smoke **PASS** on deploy `<sha>`（stamp `<stamp>`，channel `dingtalk`）：unscheduled reminder + `comp_time` expiry reminder each created subject + owner + sub_owner delivery rows; real DingTalk work-notification worker sent all 6 primary rows exactly once; repeat worker did not resend; fake retry probe reached retrying then failed with visible error; C5-4 admin counters showed sent + failed rows; cleanup residue=0. 至此 C5-0 #2487 → C5-1a #2498 → C5-1b #2502 → C5-2 #2504 → C5-3 #2507 → C5-4 #2515 → C5-5 real DingTalk smoke 闭环 ✅。

## Failure Triage

- **Missing table:** staging is not migrated through C5. Stop and run the migration alignment/deploy SOP first.
- **Refuses non-smoke source candidates:** staging has other users/lots that the global C5 source producer would claim. Clean or isolate staging first; do not run a smoke that would write dispatch/outbox rows for unrelated data.
- **Refuses due non-smoke rows:** there are existing due outbox rows. Do not override unless the DB is disposable; inspect them first with `SELECT org_id, source_type, source_key, recipient_user_id, status FROM attendance_notification_deliveries WHERE status IN ('pending','retrying','sending')`.
- **Fake mode PASS but real mode fails with `dingtalk_recipient_not_bound`:** the temporary directory link did not map to a usable DingTalk account. Check `DINGTALK_SMOKE_EXTERNAL_USER_ID`.
- **Real mode fails with config/token errors:** staging DingTalk work-notification runtime config is missing or invalid. If staging uses stored config rather than env vars, pass `DINGTALK_SMOKE_CONFIG_INTEGRATION_ID`. Do not mark C5 ✅.
- **Residue not 0:** inspect rows containing the printed `stamp`; the script deletes only its synthetic org/users and should not touch unrelated data.

## Safety

- Default org and users are synthetic and stamp-prefixed.
- Cleanup deletes by the synthetic org and users only, and is gated before any destructive statement.
- A custom `ORG_ID` requires explicit `ALLOW_C5_SMOKE_CUSTOM_ORG_CLEANUP=1`.
- Real DingTalk mode refuses to start unless `ALLOW_REAL_DINGTALK_SEND=1`.
- The script refuses to run source producers when non-smoke candidates exist and refuses to run the global worker if due non-smoke rows exist, preventing accidental writes/sends from unrelated staging data.
