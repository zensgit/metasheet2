# M5 staging smoke runbook — 一天多班次

This is the final staging gate for the `一天多班次` SHOULD item.

It proves that the M1-M4 chain is live on staging:

- `multiShiftDay` settings round-trip and enable slot writes;
- direct slot 0 + slot 1 assignments can coexist when shift windows do not
  overlap;
- same-slot and overlapping-window conflicts still reject;
- effective-calendar exposes ordered `effective.slots[]` and total
  `plannedMinutes`;
- comprehensive planned-hours preview sums the slots;
- fixed-schedule apply/rebuild writes only slot 0 and preserves the exact
  existing non-zero direct row, then effective-calendar still reports both
  slots;
- auto-shift A1 stays single-slot and skips a user/day that already has a
  non-zero assignment;
- settings are restored and smoke residue is zero.

## Prerequisites

1. Staging runs a main build containing:
   - #2426 M1 slot schema + conflict guard;
   - #2427 M2 effective-calendar/planned-minute projection;
   - #2428 M3 fixed/auto producer compatibility;
   - #2429 M4 admin card.
2. Backend env has `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`; the smoke
   checks the auto-shift compatibility branch and fails if the endpoint is
   disabled. Enabling the org setting is not enough: if the env key is missing or
   false, update the staging env file and re-deploy/restart the backend before
   running this smoke.
3. Migrations are current through the `slot_index` migration.
4. You have a staging admin token. If `/api/auth/dev-token` is disabled, mint a
   staging token using the host helper and pass `SMOKE_TOKEN`.

## Run

From the staging host or a shell that can reach the backend and DB:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
SMOKE_TOKEN="$TOKEN" \
node scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs
```

When running inside the staging backend container, use the container-local API:

```bash
BASE_URL=http://127.0.0.1:8900 \
DATABASE_URL="$DATABASE_URL" \
SMOKE_TOKEN="$TOKEN" \
node /app/staging-attendance-multi-shift-m5-smoke.mjs
```

Expected final line:

```text
=== PASS — ... passed, 0 failed ===  stamp multi-shift-m5-...
```

## Closeout

Flip the tracker row `一天多班次` from **🟡** to **✅** only after a staging PASS.
Record:

- deploy SHA / image tag;
- smoke stamp;
- log path;
- residue counts;
- any staging-only migration/deploy notes.

Template:

> **回填（YYYY-MM-DD 一天多班次 M5 staging closeout）**：一天多班次 staging smoke PASS（deploy `<sha>`，stamp `multi-shift-m5-...`，log `<path>`）：direct slot0+slot1 coexist when shift windows do not overlap；same-slot and overlapping-window conflicts reject；effective-calendar exposes ordered `effective.slots[]` and total planned minutes；comprehensive planned preview sums slots；fixed-schedule apply/rebuild preserves the exact existing non-zero direct slot and effective-calendar still reports both slots；auto-shift A1 skips existing non-zero slot user/day；settings restored；cleanup residue=0。一天多班次（M1 #2426 → M2 #2427 → M3 #2428 → M4 #2429 → M5 staging）闭环 ✅。

## Failure Signals

- `AUTO_SHIFT_MATCHING_APPLY_DISABLED` / `AUTO_SHIFT_MATCHING_DISABLED`:
  staging backend env does not enable the A1 compatibility branch, or the org
  setting did not persist in `mode='apply'`. Re-deploy/restart staging with the
  env flag before treating the smoke as meaningful.
- effective-calendar has no `slots[]`: deployed backend predates M2 or
  `multiShiftDay.enabled` did not persist.
- planned minutes are 240 instead of 480: slot summing regressed.
- fixed rebuild leaves only slot 0, rewrites slot 1, or effective-calendar stops
  reporting both slots: producer compatibility regressed and manual non-zero
  slots are being clobbered or hidden.
