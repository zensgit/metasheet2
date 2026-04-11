# Multitable Platform RC Notes

Date: 2026-04-04
Scope: customer-facing release notes for the `multitable/platform` on-prem line

## Current RC Candidate

`multitable-onprem-run10-20260404` is the current RC milestone candidate.

Recommended deployment mode:

```env
PRODUCT_MODE=platform
ENABLE_PLM=0
```

This keeps the platform shell enabled while allowing PLM to remain disabled.

## What Changed From Run2 To Run10

The `run2 -> run10` progression focused on making the platform package usable for both administrators and employees:

1. `run2`
   - Fixed platform-mode employee attendance permissions.
   - Enabled `attendance:read` and `attendance:write` for normal employees.
   - Kept PLM disabled when `ENABLE_PLM=0`.

2. `run3`
   - Localized attendance entry titles for Chinese UI.
   - Reduced approval-center session dropouts.
   - Hid PLM audit links when PLM is disabled.

3. `run4`
   - Removed duplicate `Attendance` navigation entries.
   - Kept the platform shell aligned with `ENABLE_PLM=0`.

4. `run5`
   - Fixed approval-center access so normal users no longer get kicked back to login.
   - Removed the duplicate plugin attendance navigation path.

5. `run6`
   - Split the employee experience into clearer `Overview` and `Reports` tabs.
   - Kept the two surfaces separate instead of repeating the same content.

6. `run7`
   - Added reporting summary cards and local filters.
   - Made the reports page more analytical without changing backend behavior.

7. `run8`
   - Added report time-range switching: `This week`, `This month`, `Last month`, `This quarter`.
   - Added trend and management metric cards that refresh with the selected range.

8. `run9`
   - Expanded the employee self-service dashboard.
   - Added task focus, request-status guidance, and clearer next-step actions.

9. `run10`
   - Added import operation summaries in the admin import flow.
   - Added preview outcome summaries and better stale-preview cleanup.

## What The RC Is Good For

- Employee attendance self-service
- Platform shell with PLM disabled
- Attendance reporting and range-based analysis
- Admin import workflow visibility
- Approval-center access without session loss

## Known Follow-Ups

These are not blockers for the RC candidate, but they remain worth tracking:

- Deployment automation could be simplified further for field rollout.
- Full CSV import end-to-end verification still deserves a dedicated pass.
- Additional edge cases around import rejection and re-submission can be polished later.
- Non-critical logout-time 403 noise is still low priority.

## Verification Position

The current recommendation is to use `multitable-onprem-run10-20260404` as the RC baseline and continue only with polish or real blocker fixes.
