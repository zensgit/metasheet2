# Attendance Import/Export Ops Design

Date: 2026-04-04

## Goal

Start the attendance "import/export implementation capability" track with a pure-frontend slice that helps admins answer two questions quickly:

1. What import plan is currently configured?
2. What did the latest preview actually find before commit?

## Scope

- Target file: [AttendanceView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-import-export-ops-20260404/apps/web/src/views/AttendanceView.vue)
- No backend route changes
- No approval-center file changes
- Keep the existing import workflow intact

## Changes

### 1. Current import plan summary

Add an operator-facing summary panel inside the real admin import section with:

- input channel
- estimated rows
- preview lane
- import lane
- mapping profile summary
- user map summary
- group sync summary
- commit token readiness

This mirrors the existing isolated workflow section patterns, but lands them in the real page used by admins.

### 2. Preview outcome summary

Add a second summary panel before the preview table to surface:

- shown/total preview rows
- distinct users in preview
- warning count
- distinct policies/groups seen in preview
- preview/import lane context
- commit token readiness
- last preview task/job execution summary

### 3. Stale preview cleanup

Clear stale preview rows and warning banners when a new preview starts, so failed retries do not leave old preview evidence on screen.

## Why this slice

- High operator value
- Frontend-only
- Reuses existing state already present in `AttendanceView.vue`
- Does not overlap with approval-center work happening in parallel
