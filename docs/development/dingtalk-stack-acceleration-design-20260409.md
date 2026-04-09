# DingTalk Stack Acceleration Design

Date: 2026-04-09
Stack: `#725 -> #723 -> #724`

## Objective

Move the DingTalk PR stack to the shortest safe merge path without adding new product scope.

This pass is limited to:

- keeping `#725` current with `main`
- preparing `#723` and `#724` for clean retarget after upstream merges
- keeping review gates explicit and decision-complete

## Chosen Strategy

### 1. Update `#725` before review and merge

`#725` is the only PR in the stack that can be safely brought to the latest `main` immediately.

The chosen update strategy is:

- rebase the PR1 head onto latest `origin/main`
- resolve only update-induced issues
- rerun the narrow PR1 verification set
- force-push the refreshed head back to the PR branch

This keeps the stack narrow and avoids compounding outdated-base noise into `#723` and `#724`.

### 2. Keep `#723` and `#724` stacked until upstream merge

Neither `#723` nor `#724` is retargeted in this pass.

Reason:

- retargeting early would create duplicated review churn while `#725` is still open
- the correct time to retarget `#723` is immediately after `#725` merges
- the correct time to retarget `#724` is immediately after `#723` merges

### 3. Prepare retarget-review gates now

This pass still prepares the next two steps so implementation can continue immediately after upstream merge:

- `#723` gate after retarget:
  - diff contains only PR2 directory-sync changes
  - full GitHub checks run, not just `pr-validate`
  - review focuses on directory sync management and run history behavior
- `#724` gate after retarget:
  - diff contains only PR3 attendance/notification/admin-control changes
  - full GitHub checks run
  - review focuses on attendance hardening, DingTalk robot behavior, grant gating, and delegated-admin controls

## Public Interface Constraints

No new public DingTalk routes are introduced in this pass.

Existing PR1 route contract remains:

- `GET /api/auth/dingtalk/launch`
- `POST /api/auth/dingtalk/callback`
- `/login/dingtalk/callback`

Production rollout policy target remains unchanged:

- `DINGTALK_AUTH_REQUIRE_GRANT=1`
- `DINGTALK_AUTH_AUTO_LINK_EMAIL=1`
- `DINGTALK_AUTH_AUTO_PROVISION=0`
