# Platform Shell Nav / Approvals Follow-up Design

## Background

Playwright verification on the `platform` package with `ENABLE_PLM=0` exposed three shell-level regressions:

1. Attendance self-service users had no top-level `/attendance` navigation entry.
2. The shell still defaulted to `/grid` even when attendance was enabled and PLM was disabled.
3. The fix for the standalone approval inbox needed a regression lock so `/approvals` remained a first-class route in the main app shell.

## Change Scope

This follow-up stays in the frontend shell only.

- Add `/attendance` to the top navigation when the authenticated user has the `attendance` feature in platform mode.
- Resolve the default home path to `/attendance` when attendance is enabled and PLM is disabled.
- Lock the dedicated `/approvals` route and the hidden PLM links with frontend regression tests.

## Non-Goals

- No backend permission or workflow behavior changes.
- No redesign of the approval inbox itself.
- No change to `attendance-focused` or `plm-workbench` focused shells.
