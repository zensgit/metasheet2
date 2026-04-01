# Attendance Rule Builder Layout Design

Date: 2026-04-01

## Problem

The rule-set admin page still rendered the structured rule builder like a squeezed side panel. Basic rule-set metadata, builder controls, preview output, and raw JSON all blended into one dense grid, which made the builder feel secondary instead of being the main workspace.

## Goals

- Keep the existing rule-set workflow and data contract unchanged.
- Promote the structured rule builder into the primary workbench.
- Separate basic rule-set metadata from advanced JSON editing.
- Preserve the current preview and scenario tooling.

## Change

Restructure the rule-set section in `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-rule-builder-layout-20260401/apps/web/src/views/AttendanceView.vue` into three explicit panels:

1. `attendance__rule-set-basics`
   - name, scope, version, default flag, description
2. `attendance__rule-builder-shell`
   - builder intro
   - summary chips
   - work schedule controls
   - working day chooser
   - preview workbench
3. `attendance__rule-set-advanced`
   - raw JSON inspection/edit panel

Supporting CSS changes make the builder overview two-column on desktop, collapse cleanly on mobile, and visually separate the advanced JSON area so it no longer reads like part of the main builder.

## Non-goals

- No backend/API changes
- No builder behavior changes
- No new attendance routes or features
