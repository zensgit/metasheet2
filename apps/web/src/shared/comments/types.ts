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
}
