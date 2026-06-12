# 小组织挂部门 SO3 staging smoke runbook

**Date:** 2026-06-12
**Script:** `scripts/ops/staging-attendance-small-org-so3-smoke.mjs`
**Scope:** SO3 closeout prep only. This runbook and script do **not** flip the
tracker to ✅; the tracker flips only after a real staging PASS stamp.

## What This Proves

The smoke runs against staging through the real schedule-group APIs used by the
admin cockpit:

- admin creates a parent schedule group plus two department-bound children;
- admin adds a lead member to the in-scope child;
- admin creates the scoped actor's `view/edit` department scope and `dispatch`
  schedule-group/user scope;
- a non-admin scoped actor cannot create schedule groups with central
  `attendance:admin`;
- the scoped actor can list/read only the matching child group, not the parent or
  sibling;
- the scoped actor can edit safe child fields, but cannot move the child out of
  its department scope;
- member add/delete succeeds only for the scoped schedule group and user;
- cleanup removes the smoke groups, members, and scheduler scopes with residue
  `0`.

This is the final SO3 staging gate for the `小组织挂部门` line. It does not test
visual layout in a browser; it tests the same HTTP contracts that
`AttendanceView.vue` uses for the cockpit.

## Prerequisites

1. Deploy a main build that includes:
   - SO0 parent/department hardening `#2534`;
   - SO1 admin cockpit `#2535`;
   - SO2 scoped actor smoke/runtime guard `#2536`.
2. Staging migrations must include the existing advanced scheduling tables:
   - `attendance_schedule_groups`;
   - `attendance_schedule_group_members`;
   - `attendance_scheduler_scopes`.
3. Run from the repo root on the staging host, or from a tunnel where both API
   and DB are reachable.
4. `pg` must be resolvable from Node.
5. Authentication:
   - default path: staging allows `/api/auth/dev-token`, and the script mints an
     admin token plus a non-admin scoped token;
   - fallback path: provide `ADMIN_TOKEN`, `SCOPED_TOKEN`, and
     `SCOPED_USER_ID`. The scoped token subject must equal `SCOPED_USER_ID`.

The scoped user defaults to a synthetic `smallorg-so3-*` subject. The script
refuses a non-synthetic scoped subject. This is intentional: the smoke creates
and deletes scheduler scopes and attendance rows for the scoped subject, so it
must never target a real user.

Before any API mutation, the script runs a read-only DB preflight that verifies
the cleanup/assertion channel is reachable and the small-org tables exist. If
`DATABASE_URL` is wrong or staging is missing the tables, the smoke aborts before
creating schedule groups, members, or scopes.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
node scripts/ops/staging-attendance-small-org-so3-smoke.mjs
```

Fallback when dev-token is disabled:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
ADMIN_TOKEN='<admin bearer>' \
SCOPED_TOKEN='<non-admin scoped bearer>' \
SCOPED_USER_ID='<scoped-token-subject>' \
node scripts/ops/staging-attendance-small-org-so3-smoke.mjs
```

Optional:

```bash
ORG_ID=default
```

The scoped subject must remain synthetic; use a disposable `smallorg-so3-*` user
for fallback tokens.

## Expected Output

```text
SO3 small-org staging smoke @ http://127.0.0.1:8082 (org default, stamp smallorg-so3-...)
  PASS  admin auth/list reachable (200)
  PASS  create schedule group smallorg-so3-...-root
  PASS  create schedule group smallorg-so3-...-child
  PASS  create schedule group smallorg-so3-...-sibling
  PASS  admin workbench API sees parent/child/dept tree
  PASS  admin adds lead member to child group
  PASS  create view/edit department scope for scoped actor
  PASS  create dispatch scope for one child group/user
  PASS  scoped actor has no central attendance:admin create permission
  PASS  scoped list contains only department-matching child group
  PASS  scoped actor can read child detail
  PASS  scoped actor cannot read sibling detail
  PASS  scoped actor can view child members
  PASS  scoped actor can edit child description
  PASS  scoped actor cannot move child out of its department scope
  PASS  failed scope move leaves child department unchanged
  PASS  scoped actor can dispatch allowed user into child group
  PASS  dispatch scope blocks unlisted user
  PASS  dispatch scope blocks sibling group
  PASS  scoped actor can remove allowed dispatched member
  PASS  dispatch scope blocks deleting sibling member
  PASS  blocked sibling member delete leaves row intact
--- cleanup ---
  PASS  cleanup residue = 0 (groups 0, members 0, scopes 0)

=== PASS — ... passed, 0 failed ===  SMALL_ORG_SO3_STAGING_SMOKE_PASS deploy=<sha> stamp=smallorg-so3-... residue=0
```

## On PASS

Flip the tracker row `调度 / 换班 / 小组织` to reflect `小组织挂部门` ✅
while keeping `调度 / 换班` separate, and add a dated backfill like:

> **回填（YYYY-MM-DD 小组织挂部门 SO3 staging closeout）**：staging smoke
> `SMALL_ORG_SO3_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp
> `<stamp>`）：admin created parent/child/sibling schedule groups with
> department refs; scoped non-admin actor had no central `attendance:admin`;
> scoped list/detail saw only the matching child; scoped edit succeeded for
> child description but 403 blocked moving `departmentRef` out of scope; scoped
> dispatch add/delete worked only for the allowed child/user; sibling/user
> attempts stayed 403; cleanup residue=0. SO0 #2534 → SO1 #2535 → SO2 #2536 →
> SO3 staging closed `小组织挂部门` ✅. 调度 / 换班仍 separate OPTIONAL.

## On FAIL

- token/auth failure: verify `BASE_URL`, token, and staging JWT secret. If
  dev-token is disabled, use the fallback token path.
- schedule-group create fails: staging may not include SO0/SO1/SO2 or the
  advanced scheduling migrations.
- scoped list includes parent/sibling: schedule-group view filtering regressed.
- scoped edit of description fails: department-scoped edit branch is not
  reachable.
- scope move succeeds: proposed-row authorization regressed; do not flip ✅.
- member add/delete succeeds for sibling or unlisted user: dispatch target
  matching regressed.
- residue nonzero: inspect rows with the printed `smallorg-so3-*` stamp before
  re-running.

## Safety

- Creates only stamped schedule groups and synthetic user ids.
- Direct SQL cleanup targets the created group ids, stamped group codes, the
  synthetic member user ids, and scheduler scope ids created by this smoke.
- Runs a DB/table preflight before any API writes, so a bad `DATABASE_URL` cannot
  leave API-created residue without a cleanup channel.
- Does not deploy, restart services, or mutate global settings.
- Does not claim browser/UI visual verification; it proves the backend API
  contracts used by the admin cockpit.
