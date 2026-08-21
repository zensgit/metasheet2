// S3a (comments shared FE kit extraction): the comment wire-payload normalizer family, moved
// verbatim from multitable/api/client.ts. `multitable/api/client.ts` now imports these same
// names from here (for its own internal use in normalizeCommentsList/normalizeCommentInbox) and
// re-exports them under the same names, so every existing external consumer
// (`comments-realtime.ts`, `multitable-client.spec.ts`, both importing from `'../api/client'`)
// keeps working unchanged.
//
// Naming residue (disclosed, not fixed here): same rationale as types.ts — kept as
// `normalizeMultitableComment` etc. rather than renamed, to avoid an alias layer that buys this
// slice nothing.
import type { MultitableComment, MultitableCommentReaction } from './types'

export type RawComment = Partial<MultitableComment> & {
  spreadsheetId?: string
  rowId?: string
}

type MultitableCommentIdentityPayload = {
  containerId?: unknown
  spreadsheetId?: unknown
  targetId?: unknown
  rowId?: unknown
}

type MultitableCommentFieldPayload = {
  fieldId?: unknown
  targetFieldId?: unknown
}

type MultitableCommentMentionsPayload = {
  mentions?: unknown
}

function normalizeCommentId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function normalizeOptionalCommentId(value: unknown): string | undefined {
  const normalized = normalizeCommentId(value)
  return normalized.length > 0 ? normalized : undefined
}

export function normalizeMultitableCommentIdentity(payload: MultitableCommentIdentityPayload | null | undefined) {
  const containerId = normalizeCommentId(payload?.containerId) || normalizeCommentId(payload?.spreadsheetId)
  const targetId = normalizeCommentId(payload?.targetId) || normalizeCommentId(payload?.rowId)

  return {
    containerId,
    targetId,
    spreadsheetId: containerId || undefined,
    rowId: targetId || undefined,
  }
}

export function normalizeMultitableCommentFieldId(payload: MultitableCommentFieldPayload | null | undefined): string | null {
  const fieldId = normalizeCommentId(payload?.fieldId) || normalizeCommentId(payload?.targetFieldId)
  return fieldId.length > 0 ? fieldId : null
}

export function normalizeMultitableCommentMentions(payload: MultitableCommentMentionsPayload | null | undefined): string[] {
  if (!Array.isArray(payload?.mentions)) return []
  return payload.mentions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

/**
 * Normalize the per-comment `reactions` aggregate (B6). The whitelist normalizer
 * drops unknown raw fields, so reactions MUST be carried explicitly here or the
 * backend's reactions array is silently lost on the wire (wire-vs-fixture drift).
 * Returns undefined when absent (so a comment whose reactions weren't hydrated is
 * distinguishable from one with zero reactions).
 */
export function normalizeMultitableCommentReactions(
  payload: { reactions?: unknown } | null | undefined,
): MultitableCommentReaction[] | undefined {
  if (!Array.isArray(payload?.reactions)) return undefined
  const out: MultitableCommentReaction[] = []
  for (const raw of payload.reactions) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.emoji !== 'string' || !r.emoji) continue
    out.push({
      emoji: r.emoji,
      count: typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : 0,
      reactedByMe: r.reactedByMe === true,
    })
  }
  return out
}

export function normalizeMultitableComment(payload: RawComment | null | undefined): MultitableComment {
  const identity = normalizeMultitableCommentIdentity(payload)
  const fieldId = normalizeMultitableCommentFieldId(payload)
  return {
    id: normalizeCommentId(payload?.id),
    containerId: identity.containerId,
    targetId: identity.targetId,
    spreadsheetId: identity.spreadsheetId,
    rowId: identity.rowId,
    fieldId,
    targetFieldId: fieldId,
    parentId: normalizeOptionalCommentId(payload?.parentId),
    mentions: normalizeMultitableCommentMentions(payload),
    authorId: normalizeCommentId(payload?.authorId),
    authorName: typeof payload?.authorName === 'string' ? payload.authorName : undefined,
    content: typeof payload?.content === 'string' ? payload.content : '',
    resolved: payload?.resolved === true,
    createdAt: typeof payload?.createdAt === 'string' ? payload.createdAt : '',
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : undefined,
    reactions: normalizeMultitableCommentReactions(payload),
  }
}
