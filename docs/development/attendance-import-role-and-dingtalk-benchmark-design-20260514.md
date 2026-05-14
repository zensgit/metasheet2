# Attendance Import Role and DingTalk Benchmark Design

Date: 2026-05-14

## Scope

This slice makes attendance import a delegated capability instead of requiring
full attendance administration.

The change is intentionally narrow:

- Add `attendance:import` to RBAC seeds and legacy attendance permission
  migrations.
- Add `attendance_importer` as a role template and access preset.
- Keep attendance admins import-capable.
- Allow import execution, batch review, batch export, rollback, integration list,
  integration run history, and integration sync with either `attendance:import`
  or `attendance:admin`.
- Keep integration create, update, and delete admin-only.
- Expose the importer role in the Attendance Admin Center provisioning UI.

## Rationale

DingTalk-style attendance operations often split daily import execution from
rule and integration configuration ownership. Import operators need to preview,
commit, inspect, export, and roll back imported data, but they should not receive
full attendance rule, shift, payroll, or integration-secret administration.

## Non-Goals

- No attendance table or import engine behavior changes.
- No integration credential edit delegation.
- No mobile punch, anti-cheat, Wi-Fi, GPS, Bluetooth, or face verification work.
- No report-field multitable work in this slice.

## Safety

The delegated helper is:

```text
withAttendanceImportPermission = withAnyPermission(['attendance:import', 'attendance:admin'])
```

That keeps all import-capable routes explicit and prevents accidental expansion
of unrelated attendance admin surfaces.
