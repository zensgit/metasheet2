# Attendance Strict Smoke Current Overview Adaptation - Development Notes

Date: 2026-05-23

## Summary

The production deployment moved to the newer Attendance information architecture:

- `Records` now lives under the `Reports` tab instead of the default `Overview` tab.
- Admin Center uses a focused section rail. Only the active `data-admin-section` is visible.
- Import payload templates can still contain display-only `columns` hints, while the current import API accepts either no `columns` for CSV imports or structured column objects.
- Mobile Admin Center can show the real admin console instead of the older `Desktop recommended` gate.

The strict production gates were still using older Playwright assumptions, so the deployment itself passed API smoke and provisioning but timed out in UI checks. This change adapts the verification scripts to the current UI without changing product runtime code.

## Scope

Changed scripts:

- `scripts/verify-attendance-production-flow.mjs`
- `scripts/verify-attendance-full-flow.mjs`

No runtime product code, migrations, API handlers, workflow files, K3/Data Factory/Bridge Agent code, or package build scripts are changed.

## Design

### 1. Records Discovery

Both scripts now treat `Records` as a tab-scoped surface:

1. Look for a visible `Records` card/section.
2. If it is not visible, click the `Reports` tab.
3. Wait for the `Records` card/section inside Reports.

The full-flow script switches back to `Overview` after Records assertions, because the `Anomalies` card remains an overview surface.

### 2. Admin Section Selection

Admin Center checks now use the product's stable rail attributes:

- `data-admin-quick-jump="true"`
- `data-admin-section="<section-id>"`

This avoids waiting for hidden headings. The scripts explicitly select:

- `attendance-admin-user-access`
- `attendance-admin-import`
- `attendance-admin-settings`
- `attendance-admin-default-rule`
- `attendance-admin-payroll-cycles`

The production flow also attempts `attendance-admin-import-batches`, but treats it as optional UI evidence because the current DOM nests that section under the import section; API batch-item verification remains the hard assertion.

### 3. Import Payload Compatibility

The production flow removes display-only string `columns` arrays before calling import preview/commit. Current import schema expects structured column objects if `columns` is supplied; the CSV path does not need `columns`, so deleting legacy template hints is the least invasive compatibility fix.

The full-flow recovery path applies the same sanitization before building upload-based import payloads.

### 4. Status Message Matching

The invalid JSON retry assertion now matches the start of the localized message instead of an exact full string. The current UI appends timezone context to the error message, so exact matching was brittle while the user-visible error itself was correct.

### 5. Mobile Admin Center

The mobile full-flow accepts either:

- the old `Desktop recommended` gate, or
- the current `Admin Console` surface.

This keeps the gate compatible with both deployed UI shapes.

## Deployment Impact

None. This is an ops/test-script adaptation only.

## Security

No secrets are stored in repo files. Live verification used a local `0600` token file and passed the token only through `AUTH_TOKEN`.

## Known Follow-Up

`attendance-admin-import-batches` is currently nested under the import admin section, so selecting it through the focused rail can make its parent hidden. This PR does not change product UI; it records the issue by warning and preserves API-level batch validation in the smoke path.
