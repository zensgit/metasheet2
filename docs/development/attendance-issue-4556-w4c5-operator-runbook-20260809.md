# Attendance issue 4556 — W4C-5 Operator Transition Runbook

Date: 2026-08-09
Status: DRAFT — build in progress, stub commit
Scope: `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md`
(`OD-W4C-61=(a)`, ratified at `2a2a5eee4f00abceff94ed6360e8c051708e35f7`, owner comment
`5189421034` on PR 4747)

## Non-authorization notice

This document and the tooling it describes authorize **no** staging access, **no**
flag change, **no** deployment, **no** seven-day soak, **no** production/customer
data use, **no** external notification, and **no** closure of issue 4556. Every
step below runs only against a locally migrated scratch PostgreSQL database and a
single named synthetic org. `SEGMENT_CALCULATION_IMPLEMENTED`
(`plugins/plugin-attendance/lib/attendance-shift-service.cjs:60`) is untouched by
this line of work — flipping it is a separate implementation-readiness decision
the owner has not made.

This file is a stub. The executable steps are being built on this branch; see
subsequent commits for the full runbook and the `plan`/`apply` CLI it documents.
