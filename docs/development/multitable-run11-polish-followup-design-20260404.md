# Multitable Run11 Polish Follow-up Design

Date: 2026-04-04

## Scope

Address the three validated post-`run11` RC blockers without widening the release surface:

1. Windows package deployment wrappers must work on plain Windows Server 2022 without bash/WSL.
2. Attendance CSV import must recognize standard `user_id/work_date/check_in/check_out` headers through both preview and commit.
3. Punch failures such as `PUNCH_TOO_SOON` must surface a visible status message, hint, and retry affordance.

## Design

### 1. Windows-native package apply path

- Add `scripts/ops/multitable-onprem-apply-package.ps1` as the PowerShell-native archive apply entrypoint.
- Keep the existing `.sh` helper for Linux/WSL flows.
- Update packaged `deploy.bat` wrappers to call the PowerShell helper instead of `bash`.
- Extend package verification so future rerolls fail if `deploy.bat` regresses back to the bash helper.

### 2. CSV alias normalization

- Extend the shared attendance import mapping table with:
  - `user_id -> userId`
  - `work_date -> workDate`
  - `check_in -> firstInAt`
  - `check_out -> lastOutAt`
- Extend required-field aliases so validation and punch-required checks follow the same alias map.
- Normalize CSV row extraction to read `work_date` and `user_id` directly.

### 3. Punch failure feedback

- Reuse the existing rich attendance status pipeline instead of the plain `setStatus(readErrorMessage(...))` path.
- Route punch API failures through `createApiError(...)` and `setStatusFromError(...)`.
- Make `PUNCH_TOO_SOON` render a human-readable message even when the backend only returns the raw error code.

## Non-goals

- No approval-center changes.
- No backend route shape changes beyond the shared import alias support.
- No new toast system; the existing status block remains the feedback surface for this slice.
