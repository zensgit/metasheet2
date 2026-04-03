# Attendance Reports Analytics Design

Date: 2026-04-04

## Scope

Implement the first `Reports 2.0` slice for attendance without changing backend routes, contracts, or approval-center files.

This slice is intentionally frontend-only and limited to the attendance reports surface in:

- `apps/web/src/views/AttendanceView.vue`

## Problem

After `#626`, the employee experience correctly split `Overview` and `Reports`, but the reports view still behaved like two raw tables:

- request report table
- attendance records table

That made the reports tab technically separate from overview, but not yet useful as an analysis surface.

## Goals

1. Make the reports page feel analytical rather than list-only.
2. Keep the implementation local to the frontend.
3. Avoid any overlap with the approval-center work happening in parallel.

## Changes

### 1. Add a report snapshot card

Add a dedicated reports-only summary block that shows:

- filtered request volume
- filtered request minutes
- visible request groups
- visible records
- flagged records
- visible work minutes

This gives the reports page a clear “at a glance” layer before the user drops into tables.

### 2. Add local report filters

Add frontend-only filters for:

- request status
- request type
- record status

These filters work on already-loaded report data and do not trigger new API calls.

### 3. Keep table content scoped to the active filters

The request report and record tables now reflect the local filters and show a clearer empty state when a filter removes all visible rows.

## Non-goals

- No backend changes
- No OpenAPI changes
- No approval-center changes
- No new routes
- No new export format

## Follow-up

Future report slices can build on this with:

- period comparisons
- manager-facing rollups
- stronger export/report presets
- per-status trend cards
