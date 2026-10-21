// S3a (comments shared FE kit extraction): the transport-agnostic contract useMultitableComments
// actually calls. Extracted from usage — these are the exact 7 methods (name, params, return
// shape) the composable invokes today, no more, no less. `multitable/api/client.ts`'s
// `MultitableApiClient` is the FIRST implementation (`implements CommentsApiClient`); a future
// approval-native storage backend implements this same interface as its second.
import type { MultitableComment } from './types'

/**
 * The (containerId, targetId, targetFieldId?) triple every comment call is scoped to. Kept
 * intentionally narrow — the pre-extraction composable's own local type additionally unioned in
 * multitable's `MetaCommentsScope` (base/sheet/view/record ids), but nothing in this file or the
 * composable ever reads those extra fields; TypeScript's structural typing already lets any
 * wider object (MetaCommentsScope included) satisfy this shape, so the union added nothing but a
 * multitable-only type name into an otherwise domain-neutral module. Verified by type-check
 * against every existing multitable call site (see PR description).
 */
export interface CommentsTarget {
  containerId: string
  targetId: string
  targetFieldId?: string | null
}

export interface CommentsApiClient {
  listComments(params: CommentsTarget): Promise<{ comments: MultitableComment[] }>
  createComment(
    input: CommentsTarget & { content: string; parentId?: string; mentions?: string[] },
  ): Promise<{ comment: MultitableComment }>
  resolveComment(commentId: string): Promise<void>
  updateComment(commentId: string, input: { content: string; mentions?: string[] }): Promise<{ comment: MultitableComment }>
  deleteComment(commentId: string): Promise<void>
  addReaction(commentId: string, emoji: string): Promise<void>
  removeReaction(commentId: string, emoji: string): Promise<void>
}
