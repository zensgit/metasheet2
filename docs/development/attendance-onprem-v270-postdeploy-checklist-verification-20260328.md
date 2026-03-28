# Attendance On-Prem v2.7.0 Post-Deploy Checklist Verification

Date: 2026-03-28

## Goal

Verify that the new `v2.7.0` post-deploy checklist is aligned with existing repository deployment and acceptance materials.

## Inputs checked

### Existing 30-minute deployment verification

Source:

- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)

Confirmed reused checks:

- service health
- login and `features.mode`
- API smoke
- upload/idempotency/export
- manual UI walkthrough

### Existing UAT template

Source:

- [attendance-uat-signoff-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/docs/deployment/attendance-uat-signoff-template-20260306.md)

Confirmed reused business flows:

- homepage availability
- check in / check out
- request creation
- admin configuration
- import preview / commit
- report visibility

### Existing healthcheck script

Source:

- [attendance-onprem-healthcheck.sh](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-onprem-v270-postdeploy-20260328/scripts/ops/attendance-onprem-healthcheck.sh)

Confirmed assumptions:

- process manager checks remain script-owned
- backend health, web root, and `/api/plugins` are already covered
- product mode verification via `/api/auth/me` is supported when `AUTH_TOKEN` is available

## Validation performed

Commands:

```bash
git diff --check
rg -n "v2\\.7\\.0|attendance-smoke-api|attendance-onprem-healthcheck|mode= attendance|SMOKE PASS" \
  docs/deployment/attendance-onprem-v270-postdeploy-checklist-20260328.md \
  docs/development/attendance-onprem-v270-postdeploy-checklist-design-20260328.md \
  docs/development/attendance-onprem-v270-postdeploy-checklist-verification-20260328.md
```

## Result

The new checklist is consistent with existing deployment assets and narrows them into a usable post-deploy acceptance path for `v2.7.0`.

It does not introduce new runtime assumptions. It only:

- updates package naming to `v2.7.0`
- shortens the operator path
- makes package-version confirmation explicit
