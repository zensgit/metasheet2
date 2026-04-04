# Multitable Comment Mention Authoring Development Report

## Scope
- Add a read-scoped mention candidate endpoint for multitable comment authoring.
- Tokenize selected mentions on comment submit while preserving explicit `mentions[]`.
- Feed sheet-level mention candidates into the multitable comments drawer without changing inbox or realtime semantics.

## Changes
- Backend comments API:
  - Added `GET /api/comments/mention-candidates` in [comments.ts](/private/tmp/metasheet2-comment-mention-composer-20260404/packages/core-backend/src/routes/comments.ts).
  - Added `CommentMentionCandidate` and `listMentionCandidates()` contract in [identifiers.ts](/private/tmp/metasheet2-comment-mention-composer-20260404/packages/core-backend/src/di/identifiers.ts).
  - Implemented active-user candidate lookup with query filtering and stable ordering in [CommentService.ts](/private/tmp/metasheet2-comment-mention-composer-20260404/packages/core-backend/src/services/CommentService.ts).
- Frontend authoring flow:
  - Added `listCommentMentionSuggestions()` in [client.ts](/private/tmp/metasheet2-comment-mention-composer-20260404/apps/web/src/multitable/api/client.ts).
  - Updated [MetaCommentComposer.vue](/private/tmp/metasheet2-comment-mention-composer-20260404/apps/web/src/multitable/components/MetaCommentComposer.vue) to:
    - prune stale selected mentions when the draft text no longer contains them
    - serialize selected mentions into `@[label](id)` tokens on submit
  - Updated [MetaCommentsDrawer.vue](/private/tmp/metasheet2-comment-mention-composer-20260404/apps/web/src/multitable/components/MetaCommentsDrawer.vue) to merge backend-provided candidates with thread-derived suggestions.
  - Updated [MultitableWorkbench.vue](/private/tmp/metasheet2-comment-mention-composer-20260404/apps/web/src/multitable/views/MultitableWorkbench.vue) to load sheet-scoped mention suggestions and pass them to the comments drawer.
- Contracts:
  - Added mention-candidate schemas and path docs in [base.yml](/private/tmp/metasheet2-comment-mention-composer-20260404/packages/openapi/src/base.yml) and [comments.yml](/private/tmp/metasheet2-comment-mention-composer-20260404/packages/openapi/src/paths/comments.yml).
  - Regenerated `packages/openapi/dist/*`.

## Notes
- The current composer keeps the visible draft text human-readable and only tokenizes on submit.
- Candidate lookup intentionally reuses the active `users` table already used by the hidden people-sheet preparation path.
- Claude Code CLI was only used as a read-only sidecar option during planning; implementation and integration were completed in this slice directly.
