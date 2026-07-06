# W1-2 B4 G-8 — comments sheet-visibility gate: dev & verification (2026-07-06)

**Owner decision A** (enforce sheet-read on the comments surface) — dev + verification record for PR #3732.

## Problem (confirmed leak, pre-fix)
`routes/comments.ts` gated every route only by the coarse global `rbacGuard('comments', read|write)` (no sheetId); `CommentService` queried purely by `spreadsheet_id`. No call to any per-sheet capability check. So any holder of `comments:read`/`comments:write` — the shipped `plm-collaborator` preset (`comments:read`, no `multitable:*`) or the generic `user` role (both codes via migration `zzzz20260320163000`) — could read private comment content and write comments on a sheet the interactive multitable read path 403s them from. Empirically reproduced 4/5 RED against pre-fix main @ `1db165fe5`.

## Fix (this PR)
`ensureSheetReadable(req, res, spreadsheetId)` in `routes/comments.ts` — resolves the actor's sheet capabilities via the same `resolveSheetReadableCapabilities` chokepoint the record read path uses, and rejects (403) when `!canRead`. The global `comments:*` code (rbacGuard) supplies the `canComment` half; this adds the missing per-sheet `canRead` half — the codebase's own intended contract (`permission-service.ts` `applySheetPermissionScope`: `canComment && canRead`). Applied to the **9 spreadsheetId-taking routes**: GET `/api/comments`, `/summary`, `/mention-candidates`, `/mention-summary`, `/multitable/:id/mention-candidates`, `/multitable/:id/comments/presence`; POST `/api/comments`, `/mention-summary/mark-read`, `/multitable/:id/comments/mark-all-read`. Denied returns 403, same shape as `GET /records` on a no-read sheet → no new existence oracle.

## Verification
- **Golden**: `multitable-permmatrix-b4-g8-comments-visibility-realdb.test.ts` — the differential authored as the original RED finding, unweakened. Now **6/6 GREEN** against the gate on a fresh migrated Postgres:
  - control: same actor `GET /api/multitable/records` → 403 (genuine no-read sheet)
  - G-8a `GET /api/comments` → ≠200; G-8b `/summary` + `/presence` → ≠200; G-8c `POST /api/comments` → ≠201; G-8d body carries no `COMMENT_CONTENT`/rowId/fieldId
- **Differential validity**: 4/5 RED against pre-fix main @ `1db165fe5` → 6/6 GREEN with the gate = the golden discriminates the fix, not a vacuous pass.
- Backend `tsc --noEmit` clean. Wired into `plugin-tests.yml` real-DB allowlist + step name (guards against regression).

## Residual (follow-up, distinct mechanism — NOT in this PR)
- `:commentId`-addressed mutations (patch/delete/read/reactions/resolve) — need a per-comment `spreadsheet_id` lookup before the read gate.
- User-scoped `inbox` / `unread-count` — cross-sheet aggregates; need result filtering by the actor's readable-sheet set, not a single-sheet 403.

## Cross-refs
- Finding record: `/tmp/finding-comments-cross-sheet-visibility-leak-20260706.md`.
- Sibling owner-gated runtime findings: W1-3 field-write gate (landed #3676), LOCK-12 partialSuccess batch (`/tmp/finding-lock12-partialsuccess-per-record-batch-20260706.md`, open).
