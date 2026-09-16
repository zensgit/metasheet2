// S3a (comments shared FE kit extraction): domain-neutral comment types, moved verbatim from
// multitable/types.ts. `multitable/types.ts` now re-exports these same names so every existing
// multitable import (`import type { MultitableComment } from '../types'`, etc.) keeps working
// unchanged — this file is the new single source of truth, multitable/types.ts is a thin alias.
//
// Naming residue (disclosed, not fixed here): the symbols keep their pre-move "Multitable"-
// prefixed names on purpose — this is a move+interface refactor, not a redesign, and renaming
// would force touching every existing consumer (and the two aliased re-export names) for zero
// behavioral benefit this slice needs. A future approval-side consumer is free to import these
// under its own local alias.

export interface MetaCommentMentionSuggestion {
  id: string
  label: string
  subtitle?: string
}

/**
 * #5795 — one server-side @-mention search. The candidate endpoint no longer hands out a term-less
 * roster: an empty/too-short term answers `requiresQuery: true` with no items (render "type to
 * search", not "no match"), and a match set larger than the server ceiling answers `hasMore: true`.
 */
export interface MetaCommentMentionSearchResult {
  items: MetaCommentMentionSuggestion[]
  requiresQuery: boolean
  hasMore: boolean
}

/**
 * A host-supplied mention search (the multitable workbench binds it to its sheet + API client).
 * Components that receive one query the server as the user types instead of filtering a preloaded
 * roster; components that don't keep their static `suggestions` behaviour (approval comments, the
 * anonymous public form's rich-text editor).
 */
export type MetaCommentMentionSearch = (query: string) => Promise<MetaCommentMentionSearchResult>

/** Aggregated emoji reaction on a comment (B6). Mirrors the backend CommentReactionSummary. */
export interface MultitableCommentReaction {
  emoji: string
  count: number
  reactedByMe: boolean
}

/**
 * Reaction picker palette. Mirrors the backend allowlist
 * (CommentService.COMMENT_REACTION_EMOJIS); the backend rejects anything
 * off-list (400), so a drifted entry fails safe rather than corrupting data.
 */
export const COMMENT_REACTION_PALETTE = ['👍', '👎', '❤️', '😄', '🎉', '😮', '😢', '🚀']

export interface MultitableComment {
  id: string
  containerId: string
  targetId: string
  spreadsheetId?: string
  rowId?: string
  fieldId?: string | null
  targetFieldId?: string | null
  parentId?: string
  mentions: string[]
  authorId: string
  authorName?: string
  content: string
  resolved: boolean
  createdAt: string
  updatedAt?: string
  /** Aggregated emoji reactions (B6); from GET /api/comments. Absent until hydrated. */
  reactions?: MultitableCommentReaction[]
  /**
   * S3b (approval comments tab): whether this comment is a tombstone (S2 D2(b1) — author
   * retained, body cleared). ADDITIVE — multitable never sets this (its comments have no delete-
   * as-tombstone concept), so every existing multitable comment payload carries it `undefined`,
   * which the panel's `!== true` checks below treat identically to `false`. Never fabricated: a
   * comment this field is absent from is NOT assumed non-deleted by any consumer that cares about
   * the distinction — only the approval adapter (which always sets it, from the wire) reads it.
   */
  deleted?: boolean
  /**
   * S3b: the S2 `editedAt` timestamp (`ApprovalCommentView.editedAt`), carried but NOT rendered by
   * this kit yet (see MetaCommentsPanel.vue's own note) — disclosed, not silently dropped.
   * ADDITIVE, same multitable-inert reasoning as `deleted` above.
   */
  editedAt?: string | null
}
