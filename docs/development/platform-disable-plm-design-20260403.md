# Platform Disable PLM Design

## Goal

Allow the `platform/multitable` on-prem package to keep the full platform shell while explicitly disabling PLM.

## Approach

1. Add a runtime switch:
   - `ENABLE_PLM=1` keeps current behavior
   - `ENABLE_PLM=0` hides PLM in the platform shell
2. Frontend gates:
   - expose a `plm` capability in product features
   - hide the `/plm` nav item when `plm=false`
   - protect `/plm` and `/plm/audit` with `requiredFeature: 'plm'`
3. Backend gates:
   - include `features.plm` in `/api/auth/login` and `/api/auth/me`
   - degrade `PRODUCT_MODE=plm-workbench` to `platform` when PLM is disabled
   - short-circuit `/api/plm-workbench` and `/api/federation/plm/*` with `404 FEATURE_DISABLED`
4. On-prem config:
   - expose `ENABLE_PLM=1` in `app.env.multitable-onprem.template`
   - validate `ENABLE_PLM` in multitable preflight
   - allow healthcheck to assert `features.plm` when `EXPECT_PLM_ENABLED` is provided

## Non-goals

- No attempt to remove PLM source files from the codebase
- No change to attendance-only packaging
- No PLM business logic refactor
