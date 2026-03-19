# Backend No Explicit Any Slice 1 Development Report

Date: 2026-03-19

## Scope

This batch starts the backend `@typescript-eslint/no-explicit-any` cleanup with a low-risk slice.

Files changed:

- `packages/core-backend/src/routes/attendance-admin.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/src/index.ts`

## Changes

### 1. Attendance audit CSV export typing

In `attendance-admin.ts`:

- introduced a local export row type for audit CSV generation
- normalized `meta` parsing through typed helpers
- removed `any` casts when reading exported audit fields

### 2. Comment row mapping typing

In `CommentService.ts`:

- introduced a `CommentRow` mapping type
- replaced the `mapRowToComment(row: any)` path with typed row mapping
- removed the inline `any` from the count query callback

### 3. Plugin raw query guard

In `index.ts`:

- added a `RawQueryConfig` runtime/type guard
- replaced the `queryConfig as any` raw query handoff with explicit validation and typed forwarding

## Outcome

- reduced backend `no-explicit-any` warnings from `108` to `92`
- kept the batch limited to isolated route/service/server adapter points
