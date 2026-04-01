# Attendance v2.7.1 CSV Import Diagnostics Design

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Context

The v2.7.1 follow-up test pass still reported CSV import confusion:

- users can upload CSV and request a commit token
- preview and commit routes exist
- commit can still fail with `No rows to import`
- operators need faster feedback about which CSV headers were actually recognized

The current admin UI already renders `csvWarnings`, so the fastest improvement is to enrich backend diagnostics rather than redesign the import screen.

## Goals

- Surface detected CSV columns during preview and commit.
- Surface which import mappings were actually recognized from the uploaded header row.
- Surface which template columns are still missing relative to the active profile.
- Replace the generic `No rows to import` / `No rows to preview` message with a header-aware explanation when the CSV only contains a header row or empty rows.

## Non-goals

- Adding a new `GET /api/attendance/import/preview/:fileId` alias.
- Redesigning the import payload schema.
- Rebuilding the import UI beyond existing `csvWarnings` rendering.
- Changing async queue thresholds or import batching behavior.

## Design

### 1. Header diagnostics helper

Add backend helpers that:

- read the first non-empty CSV header row from either `csvText` or `csvFileId`
- normalize header names for comparison
- compare headers against the active mapping profile / effective mapping
- compare headers against the selected profile's template columns

The helper emits four diagnostic buckets:

- detected CSV columns
- recognized import columns (`sourceField→targetField`)
- missing template columns
- unmapped CSV columns

### 2. Reuse existing `csvWarnings` surface

Instead of inventing a new UI contract, append header diagnostics to `csvWarnings`.

That keeps the scope narrow because both:

- `/api/attendance/import/preview`
- `/api/attendance/import/commit`

already return `csvWarnings`, and the current admin UI already renders them.

### 3. Replace generic empty-row messages

When CSV parsing yields zero materialized rows:

- if a header row exists, return a message that says the CSV only contained the header row or empty rows, and echo detected columns
- otherwise keep a generic payload-source hint

This makes the error more actionable without falsely blaming field mapping for every `No rows to import` case.

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Risks and mitigations

- Diagnostics could become noisy for large headers.
  - Mitigation: summarize long lists and cap the number of displayed items per warning.
- Diagnostics could drift from the effective mapping path.
  - Mitigation: build warnings from the already-resolved effective mapping/profile inside preview and commit.
- We could improve sync paths but forget the current admin warning surface.
  - Mitigation: reuse `csvWarnings` instead of inventing a second response field that the UI does not read.
