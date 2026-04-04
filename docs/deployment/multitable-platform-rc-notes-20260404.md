# MetaSheet Platform RC Notes

Date: 2026-04-04
Recommended deployment profile: `PRODUCT_MODE=platform` + `ENABLE_PLM=0`

## Current milestone

- Functional milestone candidate: `multitable-onprem-run10-20260404`
- RC polish follow-up: server-side package apply helper + delivery summary hardening

## What stabilized across run2 -> run10

### Platform shell

- Platform mode now grants attendance self-service access to ordinary employees.
- `ENABLE_PLM=0` hides PLM entry points and returns `FEATURE_DISABLED` for PLM APIs.
- The shell shows a single `考勤` entry and routes legacy plugin attendance paths back to `/attendance`.

### Attendance experience

- Employee mode is now split cleanly into `总览` and `报表`.
- Reports gained summary cards, local filters, time-range quick switches, trend cards, and management metrics.
- The employee overview now acts like a workbench with status focus, request follow-up, quick actions, and human-readable status explanations.

### Attendance operations

- Import and preview flows now show an operator-facing `Current import plan`.
- Preview mode shows a `Preview outcome` summary and clears stale rows or warnings before retry.
- Empty preview failures now keep the page in a readable zero-state instead of reusing the previous preview data.

### Approval and permissions

- Approval inbox no longer drops the whole session because of `APPROVAL_USER_REQUIRED`.
- Request approval flows, settlement checks, and ordinary employee attendance visibility are stable on the current platform profile.
- Ordinary employees are blocked from `/api/events`.

## Coverage confirmed during RC

- Authentication and permissions
- Platform navigation and PLM isolation
- Attendance request -> approve -> settlement record loop
- Attendance reports, filters, and time slices
- Attendance import template, preview, commit, export, and idempotency smoke
- On-prem package build, verify, upgrade, and healthcheck gates

## Recommended post-RC follow-up

1. Run one real CSV import end-to-end on the target environment.
2. Confirm rejected requests can be resubmitted cleanly by employees.
3. Keep new work in product slices, not hotfix rerolls, unless a real P0/P1 appears.
