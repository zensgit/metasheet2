# Attendance Policy Template Update - Verification Report (2026-01-30)

## Verification
- CI/CD: Build + Deploy workflows completed successfully for `feat(attendance): add policy template and derived fields`.
- API check after deploy:
  - `/api/attendance/rule-sets/template` still returns legacy policies (`security` + `holiday-default-8h` only).
  - `/api/attendance/import/template` does not yet expose `UserId/entryTime/resignTime` mappings.
  - This indicates the running service has not picked up the latest plugin bundle.

## Notes
- Derived policy fields are applied during import preview/import; no DB mutation required for evaluation.
- Recommended: restart the backend container or re-run deployment on the server to ensure the latest plugin is loaded.
