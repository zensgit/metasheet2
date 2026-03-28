# Attendance v2.7.1 Import Compatibility Design

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Context

The v2.7.1 follow-up feedback still reports import-flow confusion in two places:

- external/manual callers use `fileId` from `/api/attendance/import/upload`, while runtime expects `csvFileId`
- `/api/attendance/import/template` returns JSON only, even when callers request CSV directly

This creates a compatibility gap even though the upload channel and CSV template route already exist.

## Goals

- Accept `fileId` as a backward-compatible alias for `csvFileId` across preview/commit job paths.
- Allow `/api/attendance/import/template` to return CSV when the caller explicitly requests `text/csv` or `format=csv`.
- Keep the existing `/api/attendance/import/template.csv` route unchanged.

## Non-goals

- Adding a new `GET /api/attendance/import/preview/:fileId` route.
- Redesigning import preview diagnostics or mapping UX.
- Changing the current web client flow, which already uses `csvFileId` and `/template.csv`.

## Design

### 1. Upload reference aliasing

Extend import payload parsing to accept:

- `csvFileId`
- `fileId`

Runtime should canonicalize both to a single resolved upload reference before:

- reading uploaded CSV text
- estimating row counts
- enqueuing async preview/commit jobs
- sanitizing queued payloads

This keeps the server aligned with the upload response shape, which already returns `fileId`.

### 2. Template content negotiation

`GET /api/attendance/import/template` should keep JSON as the default response, but return CSV when either condition is true:

- `Accept: text/csv`
- `?format=csv`

This gives external tooling a more intuitive “same route, requested format” behavior without breaking the current UI, which still prefers `/template.csv`.

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`

## Risks and mitigations

- Alias support could diverge between sync and async paths.
  - Mitigation: use one upload-reference resolver across preview, commit, and async job setup.
- Template negotiation could accidentally replace the JSON default.
  - Mitigation: only switch to CSV for explicit `Accept`/`format` requests; preserve JSON otherwise.
