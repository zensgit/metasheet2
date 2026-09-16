import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import {
  ICollabService,
  ILogger,
  type CommentAddressRecord,
  type CommentInboxItem,
  type CommentMentionCandidate,
  type CommentPresenceViewer,
  type CommentQueryOptions,
  type CommentReactionSummary,
  type CommentUnreadSummary,
} from '../di/identifiers'
import type { CollabService } from './CollabService'
import { db } from '../db/db'
import { nowTimestamp } from '../db/type-helpers'
import { buildCommentInboxRoom, buildCommentRecordRoom, buildCommentSheetRoom } from './commentRooms'
import { insertCommittedAuditKysely, type OapiWriteAuditContext } from '../multitable/oapi-write-audit'
import { notifyRecordSubscribersWithKysely } from '../multitable/record-subscription-service'
import { JS_TRIM_WHITESPACE } from '../utils/js-trim-whitespace'
import {
  escapeMentionLikeTerm,
  MENTION_CANDIDATES_MAX_ITEMS,
  MENTION_CANDIDATES_MIN_QUERY_LENGTH,
  MENTION_LABELS_MAX_IDS,
} from './comment-mention-bounds'

/**
 * The label a mention editor shows for a user — ONE derivation shared by the mention search
 * (listMentionCandidates) and the edit-time labels (#5808), so the name a picked person gets written
 * into `@[label](id)` with is the name an old comment's untokenised mention is shown with. Empty when
 * the row has neither a name nor an email.
 */
function mentionUserLabel(row: { name?: string | null; email?: string | null }): string {
  return row.name?.trim() || row.email?.trim() || ''
}

/**
 * Server-side emoji allowlist for comment reactions (B6, design-lock §3.2).
 * An emoji is a display token, not a protocol enum, so the palette is validated
 * here in code (reject unknown → 400) rather than via a DB CHECK constraint —
 * extending it is a one-line change, no migration. Authored in NFC so the
 * membership check (which NFC-normalizes input) is consistent.
 */
export const COMMENT_REACTION_EMOJIS = [
  '👍', '👎', '❤️', '😄', '🎉', '😮', '😢', '🚀',
] as const

const COMMENT_REACTION_EMOJI_SET: ReadonlySet<string> = new Set(
  COMMENT_REACTION_EMOJIS.map((e) => e.normalize('NFC')),
)

/**
 * Validate + NFC-normalize a reaction emoji (B6, design-lock §3.3). NFC makes
 * storage canonical so a later remove (which normalizes too) always matches the
 * stored bytes — this is the structural guard against the multi-codepoint trap
 * (e.g. `❤️` = ❤ + U+FE0F). Throws CommentValidationError on an emoji outside
 * the server allowlist. Exported for direct unit testing of the guard.
 */
export function normalizeCommentReactionEmoji(emoji: string): string {
  const normalized = (typeof emoji === 'string' ? emoji : '').normalize('NFC').trim()
  if (!normalized || !COMMENT_REACTION_EMOJI_SET.has(normalized)) {
    throw new CommentValidationError('Unsupported reaction emoji')
  }
  return normalized
}

export class CommentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentValidationError'
  }
}

export class CommentNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentNotFoundError'
  }
}

export class CommentAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentAccessError'
  }
}

export class CommentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentConflictError'
  }
}

/**
 * #5831 — the one answer to a reply whose `parentId` is unknown OR names a comment outside the reply's
 * own record thread (another sheet or another row). Keeps "same record thread" for existing clients.
 */
export const REPLY_PARENT_OUTSIDE_THREAD_MESSAGE = 'Reply must target an existing comment in the same record thread'

export interface Comment {
  id: string
  spreadsheetId: string
  rowId: string
  fieldId?: string
  /** Canonical container alias for `spreadsheetId` (DB column `container_id`). */
  containerId: string
  /** Canonical target alias for `rowId` (DB column `target_id`). */
  targetId: string
  /** Canonical field-scope alias for `fieldId` (DB column `target_field_id`); null when record-level. */
  targetFieldId: string | null
  content: string
  authorId: string
  parentId?: string
  resolved: boolean
  createdAt: string
  updatedAt: string
  mentions: string[]
  /** Aggregated emoji reactions (B6); populated by getComments, else undefined. */
  reactions?: CommentReactionSummary[]
  /** #5808: labels for this comment's own `mentions`; see CommentQueryOptions.mentionLabelsAuthorId. */
  mentionLabels?: Record<string, string>
}

export interface CommentPresenceSummary {
  /** Canonical container alias for `spreadsheetId`. */
  containerId: string
  spreadsheetId: string
  rowId: string
  /** Canonical target alias for `rowId`. */
  targetId: string
  unresolvedCount: number
  fieldCounts: Record<string, number>
  mentionedCount: number
  mentionedFieldCounts: Record<string, number>
}

type CommentRow = {
  id: string
  spreadsheet_id: string
  row_id: string
  field_id: string | null
  target_id: string
  target_field_id: string | null
  container_id: string
  content: string
  author_id: string
  parent_id: string | null
  resolved: boolean
  created_at: string | Date
  updated_at: string | Date
  mentions: string | string[] | null
}

type CommentInboxRow = CommentRow & {
  unread: boolean
  mentioned: boolean
  base_id: string | null
  sheet_id: string | null
  view_id: string | null
  record_id: string | null
  /** G-10 (docket #68): display names projected alongside the existing ids — see getInbox(). */
  base_name: string | null
  sheet_name: string | null
  view_name: string | null
  field_name: string | null
}

type GroupedCountRow = {
  row_id: string
  field_id: string | null
  comment_count: number
}

type MentionGroupedCountRow = {
  row_id: string
  field_id: string | null
  mentioned_count: number
  unread_count: number
}

type CommentActivityPayload = {
  kind: 'created' | 'updated' | 'resolved' | 'deleted'
  /** Canonical container alias for `spreadsheetId`. */
  containerId: string
  /** Canonical target alias for `rowId`. */
  targetId: string
  /** Canonical field-scope alias for `fieldId`; null when record-level. */
  targetFieldId: string | null
  spreadsheetId: string
  rowId: string
  fieldId?: string
  commentId: string
  authorId?: string
}

export type CommentTargetReadChecker = (input: {
  spreadsheetId: string
  rowId: string
  userId: string
}) => Promise<boolean>

export class CommentService {
  static inject = [ICollabService, ILogger]

  constructor(
    private collabService: CollabService,
    private logger: ILogger,
  ) {}

  private commentTargetReadChecker: CommentTargetReadChecker = async () => true

  setCommentTargetReadChecker(checker: CommentTargetReadChecker): void {
    this.commentTargetReadChecker = checker
  }

  /**
   * Update a comment's content and optionally its mentions.
   *
   * Mention precedence: if `data.mentions` is provided, those user IDs are
   * stored directly. Otherwise, mentions are auto-parsed from `data.content`
   * using the `@[Display Name](user-id)` format.
   */
  async updateComment(commentId: string, userId: string, data: {
    content: string
    mentions?: string[]
  }): Promise<Comment> {
    const existing = await this.getRequiredCommentRow(commentId)
    const normalizedUserId = this.normalizeUserId(userId)
    this.assertCommentAuthor(existing, normalizedUserId, 'Only the author can edit this comment')
    if (existing.resolved) {
      throw new CommentConflictError('Resolved comments cannot be edited')
    }

    const previousMentions = this.parseMentionList(existing.mentions)
    const mentions = this.normalizeMentions(data.mentions ?? this.parseMentions(data.content))

    await db
      .updateTable('meta_comments')
      .set({
        content: data.content,
        mentions: JSON.stringify(mentions),
        updated_at: nowTimestamp(),
      })
      .where('id', '=', commentId)
      .execute()

    const comment = await this.getComment(commentId)
    if (!comment) {
      throw new Error('Updated comment could not be reloaded')
    }

    await this.publishCommentUpdated(comment, normalizedUserId)

    for (const mentionUserId of mentions) {
      if (!mentionUserId || mentionUserId === normalizedUserId || previousMentions.includes(mentionUserId)) continue
      if (!(await this.canNotifyUserAboutCommentTarget(comment.spreadsheetId, comment.rowId, mentionUserId))) continue
      this.collabService.sendTo(mentionUserId, 'comment:mention', {
        containerId: comment.containerId,
        targetId: comment.targetId,
        targetFieldId: comment.targetFieldId,
        spreadsheetId: comment.spreadsheetId,
        rowId: comment.rowId,
        fieldId: comment.fieldId,
        comment,
      })
    }

    return comment
  }

  async deleteComment(commentId: string, userId: string): Promise<void> {
    const existing = await this.getRequiredCommentRow(commentId)
    const normalizedUserId = this.normalizeUserId(userId)
    this.assertCommentAuthor(existing, normalizedUserId, 'Only the author can delete this comment')

    const childComment = await db
      .selectFrom('meta_comments')
      .select('id')
      .where('parent_id', '=', commentId)
      .executeTakeFirst()

    if (childComment) {
      throw new CommentConflictError('Comments with replies cannot be deleted')
    }

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('meta_comment_reads').where('comment_id', '=', commentId).execute()
      // B6: app-level cascade (no DB FK in the comments sub-domain).
      await trx.deleteFrom('meta_comment_reactions').where('comment_id', '=', commentId).execute()
      await trx.deleteFrom('meta_comments').where('id', '=', commentId).execute()
    })

    await this.publishCommentDeleted(existing, normalizedUserId)
  }

  /**
   * Create a new comment, optionally as a reply to an existing thread.
   *
   * Mention precedence: if `data.mentions` is provided, those user IDs are
   * stored directly. Otherwise, mentions are auto-parsed from `data.content`
   * using the `@[Display Name](user-id)` format.
   */
  async createComment(data: {
    spreadsheetId: string
    rowId: string
    fieldId?: string
    content: string
    authorId: string
    parentId?: string
    mentions?: string[]
    /** OAPI-2a (§6): present only for a token comment-create → committed audit row inserted atomically with the comment (fail-closed). No-op for session. */
    oapiAudit?: OapiWriteAuditContext
  }): Promise<Comment> {
    const id = `cmt_${randomUUID()}`
    const mentions = this.normalizeMentions(data.mentions ?? this.parseMentions(data.content))
    let effectiveFieldId = data.fieldId?.trim() || undefined

    if (data.parentId) {
      const parent = await db
        .selectFrom('meta_comments')
        .selectAll()
        .where('id', '=', data.parentId)
        .executeTakeFirst()

      // #5831: the route gated only THIS record thread (its sheet and row). An unknown parent and a
      // parent anywhere else get the same answer, and the reply-depth check runs only on a parent inside
      // the thread — otherwise the message would tell whether a comment id exists on a sheet or row the
      // caller may not read (the approval-comment parent check follows the same rule).
      if (!parent || parent.spreadsheet_id !== data.spreadsheetId || parent.row_id !== data.rowId) {
        throw new CommentValidationError(REPLY_PARENT_OUTSIDE_THREAD_MESSAGE)
      }
      if (parent.parent_id) {
        throw new CommentValidationError('Replying to replies is not supported')
      }

      const parentFieldId = parent.field_id ?? undefined
      if (parentFieldId) {
        if (effectiveFieldId && effectiveFieldId !== parentFieldId) {
          throw new CommentValidationError('Reply must target the same field thread')
        }
        effectiveFieldId = parentFieldId
      } else if (effectiveFieldId) {
        throw new CommentValidationError('Record-level threads cannot be narrowed to a field reply')
      }
    }

    const commentValues = {
      id,
      spreadsheet_id: data.spreadsheetId,
      row_id: data.rowId,
      field_id: effectiveFieldId ?? null,
      target_type: 'meta_record',
      target_id: data.rowId,
      target_field_id: effectiveFieldId ?? null,
      container_type: 'meta_sheet',
      container_id: data.spreadsheetId,
      content: data.content,
      author_id: data.authorId,
      parent_id: data.parentId ?? null,
      resolved: false,
      mentions: JSON.stringify(mentions),
    }
    if (data.oapiAudit) {
      // OAPI-2a §6: a token comment-create + its committed audit row are atomic (fail-closed) — a failed
      // audit insert rolls back the comment. Session creates take the unchanged bare insert below.
      const auditCtx = data.oapiAudit
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('meta_comments').values(commentValues).execute()
        await insertCommittedAuditKysely(trx, auditCtx, { detail: { commentId: id } })
      })
    } else {
      await db.insertInto('meta_comments').values(commentValues).execute()
    }

    const comment = await this.getComment(id)
    if (!comment) {
      throw new Error('Created comment could not be reloaded')
    }

    // Auto-mark as read for the author so their own comments never appear as "unread"
    await this.markCommentRead(id, data.authorId)

    const createdPayload = {
      containerId: data.spreadsheetId,
      targetId: data.rowId,
      targetFieldId: effectiveFieldId ?? null,
      spreadsheetId: data.spreadsheetId,
      rowId: data.rowId,
      fieldId: effectiveFieldId,
      comment,
    }
    this.collabService.broadcastTo(
      buildCommentRecordRoom({ spreadsheetId: data.spreadsheetId, rowId: data.rowId }),
      'comment:created',
      createdPayload,
    )
    this.collabService.broadcastTo(
      buildCommentSheetRoom({ spreadsheetId: data.spreadsheetId }),
      'comment:created',
      createdPayload,
    )
    await this.publishCommentActivity({
      kind: 'created',
      containerId: data.spreadsheetId,
      targetId: data.rowId,
      targetFieldId: effectiveFieldId ?? null,
      spreadsheetId: data.spreadsheetId,
      rowId: data.rowId,
      fieldId: effectiveFieldId,
      commentId: comment.id,
      authorId: data.authorId,
    })
    for (const mentionUserId of mentions) {
      if (mentionUserId && mentionUserId !== data.authorId) {
        if (!(await this.canNotifyUserAboutCommentTarget(data.spreadsheetId, data.rowId, mentionUserId))) continue
        this.collabService.sendTo(mentionUserId, 'comment:mention', createdPayload)
      }
    }
    try {
      await notifyRecordSubscribersWithKysely(db, {
        sheetId: data.spreadsheetId,
        recordId: data.rowId,
        eventType: 'comment.created',
        actorId: data.authorId,
        commentId: comment.id,
      })
    } catch (error) {
      this.logger.warn('Failed to notify record subscribers for comment', error as Error)
    }

    return comment
  }

  async getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: Comment[]; total: number }> {
    let query = db.selectFrom('meta_comments').where('spreadsheet_id', '=', spreadsheetId)

    const rowId = options?.targetId ?? options?.rowId
    const fieldId = options?.targetFieldId ?? options?.fieldId

    if (rowId) {
      query = query.where('row_id', '=', rowId)
    }

    if (fieldId) {
      query = query.where('field_id', '=', fieldId)
    }

    if (typeof options?.resolved === 'boolean') {
      query = query.where('resolved', '=', options.resolved)
    }
    const excludedRowIds = this.normalizeRowIdList(options?.excludeRowIds)
    if (excludedRowIds.length > 0) {
      query = query.where('row_id', 'not in', excludedRowIds)
    }

    const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)))
    const offset = Math.max(0, Number(options?.offset ?? 0))

    const totalObj = await query.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst()
    const total = totalObj ? Number((totalObj as { c: string | number }).c) : 0

    const rows = await query.selectAll().orderBy('created_at', 'asc').limit(limit).offset(offset).execute()

    const items = rows.map((row) => this.mapRowToComment(row))
    // Hydrate emoji reactions (B6). Single grouped query over the page's ids;
    // reactedByMe uses the optional viewer. Empty page → no query (guarded).
    const reactionsByComment = await this.listReactionsForComments(
      items.map((c) => c.id),
      options?.viewerId,
    )
    for (const item of items) {
      item.reactions = reactionsByComment.get(item.id) ?? []
    }

    // #5808: edit-time mention labels — see hydrateOwnMentionLabels.
    const labelAuthorId = options?.mentionLabelsAuthorId?.trim()
    if (labelAuthorId) {
      await this.hydrateOwnMentionLabels(items, labelAuthorId)
    }

    return { items, total }
  }

  /**
   * #5808 — labels for mentions an edit has to keep.
   *
   * A comment created with an explicit `mentions` array (e.g. through the API) need not carry its
   * mentions as `@[label](id)` tokens in the body, and since #5795 the UI no longer preloads a roster
   * to find their names. This puts the name next to the id the caller already receives.
   *
   * WHAT IT CAN NAME (all four hold):
   *  - only ids in the `mentions` of a comment ON THIS PAGE — a page the route has already filtered
   *    by the G-8 sheet-read gate and the row-level read deny;
   *  - only on comments AUTHORED BY `authorId` (the only comments the UI lets that user edit), and
   *    each comment gets labels for its OWN mentions only;
   *  - only ACTIVE users (`is_active = true`, the same set the mention search returns). A deactivated
   *    or deleted user gets no entry, deterministically — the client shows a neutral placeholder;
   *  - at most MENTION_LABELS_MAX_IDS distinct ids per page (first appearance in page order), the
   *    mention search's own per-request ceiling. Later ids get no entry.
   * The label is the one the mention search already returns for the same person (name, else email).
   * ONE batched `users` query per page; none when there is nothing to resolve.
   */
  private async hydrateOwnMentionLabels(items: Comment[], authorId: string): Promise<void> {
    const ownItems = items.filter((item) => item.authorId === authorId)
    for (const item of ownItems) {
      item.mentionLabels = {}
    }
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of ownItems) {
      for (const id of item.mentions) {
        if (seen.has(id)) continue
        if (ids.length >= MENTION_LABELS_MAX_IDS) break
        seen.add(id)
        ids.push(id)
      }
    }
    if (ids.length === 0) return

    const rows = await db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('id', 'in', ids)
      .where('is_active', '=', true)
      .execute()

    // Only ids this call asked for, and only a non-empty label (never the raw id as a "name").
    const labelById = new Map<string, string>()
    for (const row of rows) {
      const label = mentionUserLabel(row)
      if (label && seen.has(row.id)) labelById.set(row.id, label)
    }
    for (const item of ownItems) {
      const labels: Record<string, string> = {}
      for (const id of item.mentions) {
        const label = labelById.get(id)
        if (label !== undefined) labels[id] = label
      }
      item.mentionLabels = labels
    }
  }

  /**
   * @-mention candidates: active users matching `q` (name / email / id substring).
   *
   * #5795 — BOUNDED DISCLOSURE, ELIGIBILITY UNCHANGED. The candidate set is still "every active user
   * in the deployment" (the predicate below is untouched: `is_active = true` plus the term); what
   * changed is how much of it one call can see:
   *  - no term ⇒ no rows. A term-less call used to return the first active users of the deployment
   *    (50 by default, up to 100 on request; label + email subtitle); it now returns an empty list
   *    WITHOUT issuing any query. The routes answer such a
   *    call before reaching here (with a `requiresQuery` marker); this is the second layer, so the
   *    service stays bounded for any other caller.
   *  - the term is a LITERAL substring (LIKE metacharacters escaped), so a typed `%` / `_` searches
   *    for that character. That is search correctness, not a disclosure bound: the term is matched
   *    against name, email AND id, so `-` (in every UUID-shaped id) or `@` (in every well-formed
   *    email address) still matches (almost) every active user, and — since only a name/email/id that
   *    STARTS with the character ranks earlier below, which a UUID or an email never does — comes back
   *    essentially in the old term-less created_at, id order. Against a deliberate caller the
   *    per-request bound is the LIMIT alone (see comment-mention-bounds.ts).
   *  - SQL LIMIT is capped at MENTION_CANDIDATES_MAX_ITEMS + 1 (the +1 is the route's `hasMore`
   *    probe row), so no call hydrates more than that many names/emails.
   *  - no COUNT. The old `total` was a deployment-wide count of matching active users (for a
   *    term-less call: the size of the whole user base) and was returned to any comments:read
   *    holder. It is no longer computed at all; the routes report the clamped page size instead.
   *
   * #5809 — `match: 'exact-email'` swaps the substring predicate for EMAIL EQUALITY: the stored email,
   * trimmed with the characters JS `trim()` strips (JS_TRIM_WHITESPACE, bound as a parameter) and
   * lower-cased, must equal the trimmed, lower-cased term. It is used by the legacy person importer,
   * which must know whether THE owner of an address exists — a substring page of 50 can be filled by
   * `wangli@…`, `zhangli@…` before `li@…` shows up. It only narrows: a row whose trimmed email equals
   * the term also contains it, so (with per-character case folding) the exact rows for a term are a
   * subset of the substring rows for the same term. Everything else is shared: the term requirement,
   * `is_active`, the LIMIT ceiling, the ordering and the row mapping. Any other `match` is the
   * substring search.
   */
  async listMentionCandidates(
    spreadsheetId: string,
    options?: { q?: string; limit?: number; match?: 'exact-email' },
  ): Promise<{ items: CommentMentionCandidate[] }> {
    const normalizedSheetId = spreadsheetId.trim()
    if (!normalizedSheetId) return { items: [] }

    const normalizedQuery = options?.q?.trim().toLowerCase() ?? ''
    if (normalizedQuery.length < MENTION_CANDIDATES_MIN_QUERY_LENGTH) return { items: [] }

    const requestedLimit = Number(options?.limit ?? MENTION_CANDIDATES_MAX_ITEMS)
    const limit = Math.min(
      MENTION_CANDIDATES_MAX_ITEMS + 1,
      Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : MENTION_CANDIDATES_MAX_ITEMS),
    )
    const escapedQuery = escapeMentionLikeTerm(normalizedQuery)
    const likeQuery = `%${escapedQuery}%`
    const startsWithQuery = `${escapedQuery}%`
    const exactEmail = options?.match === 'exact-email'

    const rows = await db
      .selectFrom('users')
      .where('is_active', '=', true)
      .where((eb) => eb.or(exactEmail
        ? [sql<boolean>`lower(btrim(coalesce(email, ''), ${JS_TRIM_WHITESPACE})) = ${normalizedQuery}`]
        : [
          sql<boolean>`lower(coalesce(name, '')) like ${likeQuery}`,
          sql<boolean>`lower(email) like ${likeQuery}`,
          sql<boolean>`lower(id) like ${likeQuery}`,
        ]))
      .select(['id', 'name', 'email'])
      .orderBy(
        sql<number>`case
          when lower(coalesce(name, '')) like ${startsWithQuery} then 0
          when lower(email) like ${startsWithQuery} then 1
          when lower(id) like ${startsWithQuery} then 2
          else 3
        end`,
      )
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()

    return {
      items: rows.map((row) => {
        const label = mentionUserLabel(row) || row.id
        const subtitle = row.name?.trim() && row.email.trim() && row.name.trim() !== row.email.trim()
          ? row.email.trim()
          : undefined
        return {
          id: row.id,
          label,
          subtitle,
        }
      }),
    }
  }

  /**
   * G-10 (docket #68, G-10 audit #4323) name-projection note:
   *
   * This method's WHERE clause is UNCHANGED by the name projection below — every predicate line is
   * untouched, so the row set returned is identical, row for row, to what it was before this change.
   * The new `base_name`/`sheet_name`/`view_name`/`field_name` columns are pure SELECT-list additions
   * (LEFT JOINs / correlated scalar subqueries keyed off ids already in the row), so they cannot
   * surface a row that wasn't already being returned, and cannot attach a name to any row this
   * endpoint wasn't already serializing the id (and content) for.
   *
   * That said: unlike `getComments`/`getCommentPresenceSummary`/etc., THIS aggregate has no per-sheet
   * `resolveSheetReadableCapabilities` gate — see the G-8 doc comment on `ensureSheetReadable` in
   * `routes/comments.ts` ("user-scoped cross-sheet `inbox`/`unread-count` aggregates... would need
   * result filtering by the actor's readable-sheet set") and
   * `docs/development/multitable-g8-comments-sheet-read-gate-verification-20260706.md` ("Residual
   * follow-up... NOT in this PR"). That gap is pre-existing, already tracked, and out of scope here —
   * this change does not widen it (no WHERE relaxation), and the projected names carry exactly the
   * same boundary the existing id/content fields already have on this endpoint today, no more and no
   * less. This PR makes no independent claim, positive or negative, about this method's row-selection
   * robustness beyond that — it is verified unchanged, not verified correct.
   */
  async getInbox(userId: string, options?: Pick<CommentQueryOptions, 'limit' | 'offset'>): Promise<{ items: CommentInboxItem[]; total: number }> {
    const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)))
    const offset = Math.max(0, Number(options?.offset ?? 0))
    const mentionPredicate = sql<boolean>`c.mentions @> ${JSON.stringify([userId])}::jsonb`
    const inboxPredicate = sql<boolean>`(${mentionPredicate}) or r.comment_id is null`

    const totalRow = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', userId))
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .where('c.author_id', '!=', userId)
      .where(inboxPredicate)
      .executeTakeFirst()
    const total = totalRow ? Number((totalRow as { c: string | number }).c) : 0

    const rows = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', userId))
      .leftJoin('meta_sheets as s', 's.id', 'c.spreadsheet_id')
      // G-10: field name lookup for field-level comments; null-safe (LEFT JOIN) since c.field_id is
      // nullable for record-level comments and a field can be deleted after a comment references it.
      .leftJoin('meta_fields as f', 'f.id', 'c.field_id')
      .select((eb) => [
        'c.id',
        'c.spreadsheet_id',
        'c.row_id',
        'c.field_id',
        // Carry the canonical container/target columns so inbox items expose the
        // same containerId/targetId/targetFieldId linkage that mapRowToComment
        // maps — this is an explicit projection, not selectAll(), so they must
        // be listed or they'd round-trip as undefined.
        'c.container_id',
        'c.target_id',
        'c.target_field_id',
        'c.content',
        'c.author_id',
        'c.parent_id',
        'c.resolved',
        'c.created_at',
        'c.updated_at',
        'c.mentions',
        eb.ref('s.base_id').as('base_id'),
        eb.ref('s.id').as('sheet_id'),
        eb.ref('c.row_id').as('record_id'),
        sql<string | null>`(
          select v.id
          from meta_views as v
          where v.sheet_id = c.spreadsheet_id
          order by v.created_at asc, v.id asc
          limit 1
        )`.as('view_id'),
        sql<boolean>`case when r.comment_id is null then true else false end`.as('unread'),
        sql<boolean>`case when ${mentionPredicate} then true else false end`.as('mentioned'),
        // G-10 (docket #68) — additive display-name projection. `meta_bases` isn't in the Kysely
        // Database type (every other call site in this codebase reaches it via raw SQL too — see
        // permission-service.ts/univer-meta.ts), so it's a correlated scalar subquery keyed off the
        // already-joined `s.base_id`, mirroring the existing view_id subquery's shape rather than
        // adding a new typed table. meta_sheets/meta_fields ARE typed, so those two are plain column
        // refs off the joins above.
        eb.ref('s.name').as('sheet_name'),
        sql<string | null>`(
          select b.name
          from meta_bases as b
          where b.id = s.base_id
        )`.as('base_name'),
        eb.ref('f.name').as('field_name'),
        sql<string | null>`(
          select v.name
          from meta_views as v
          where v.sheet_id = c.spreadsheet_id
          order by v.created_at asc, v.id asc
          limit 1
        )`.as('view_name'),
      ])
      .where('c.author_id', '!=', userId)
      .where(inboxPredicate)
      .orderBy('c.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute()

    return {
      items: rows.map((row) => this.mapInboxRowToComment(row as unknown as CommentInboxRow)),
      total,
    }
  }

  async getUnreadCount(userId: string): Promise<number> {
    const row = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', userId))
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .where('c.author_id', '!=', userId)
      .where(sql<boolean>`r.comment_id is null`)
      .executeTakeFirst()

    return row ? Number((row as { c: string | number }).c) : 0
  }

  /**
   * Return combined unread summary with both general unread count and
   * mention-specific unread count in a single DB round-trip.
   *
   * - `unreadCount`: comments the user has not read (no read record, excluding own).
   * - `mentionUnreadCount`: subset of the above where the user is @-mentioned.
   */
  async getUnreadSummary(userId: string): Promise<CommentUnreadSummary> {
    const mentionPredicate = sql<boolean>`c.mentions @> ${JSON.stringify([userId])}::jsonb`

    const row = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) =>
        join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', userId),
      )
      .select([
        sql<number>`count(*)::int`.as('unread_count'),
        sql<number>`count(*) filter (where ${mentionPredicate})::int`.as('mention_unread_count'),
      ])
      .where('c.author_id', '!=', userId)
      .where(sql<boolean>`r.comment_id is null`)
      .executeTakeFirst()

    return {
      unreadCount: row ? Number((row as { unread_count: string | number }).unread_count) : 0,
      mentionUnreadCount: row ? Number((row as { mention_unread_count: string | number }).mention_unread_count) : 0,
    }
  }

  /**
   * #5831 — the comment's sheet, row and author (or null for an unknown id). The comment-id routes
   * (edit/delete/read/reactions/resolve) call this BEFORE their sheet gate, so it deliberately reads
   * only these three immutable addressing columns of `meta_comments` by primary key: no content, no
   * other table. The closure guard pins that shape (PRE_GATE_CALLS).
   */
  async getCommentAddress(commentId: string): Promise<CommentAddressRecord | null> {
    const row = await db
      .selectFrom('meta_comments')
      .select(['spreadsheet_id', 'row_id', 'author_id'])
      .where('id', '=', commentId)
      .executeTakeFirst()
    if (!row) return null
    return { spreadsheetId: row.spreadsheet_id, rowId: row.row_id, authorId: row.author_id }
  }

  async markCommentRead(commentId: string, userId: string): Promise<void> {
    const now = new Date().toISOString()
    await db
      .insertInto('meta_comment_reads')
      .values({
        comment_id: commentId,
        user_id: userId,
        read_at: now,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['comment_id', 'user_id']).doUpdateSet({
          read_at: now,
        }),
      )
      .execute()
  }

  /**
   * Add an emoji reaction (B6). Idempotent via the (comment_id,user_id,emoji)
   * primary key + ON CONFLICT DO NOTHING. Mirrors markCommentRead's upsert shape.
   */
  async addReaction(commentId: string, userId: string, emoji: string): Promise<void> {
    const normalizedUserId = this.normalizeUserId(userId)
    const normalizedEmoji = normalizeCommentReactionEmoji(emoji)
    // 404 a missing comment (same guard updateComment/deleteComment use).
    await this.getRequiredCommentRow(commentId)

    await db
      .insertInto('meta_comment_reactions')
      .values({
        comment_id: commentId,
        user_id: normalizedUserId,
        emoji: normalizedEmoji,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(['comment_id', 'user_id', 'emoji']).doNothing())
      .execute()
  }

  /**
   * Remove the caller's emoji reaction (B6). Idempotent: removing a reaction
   * that does not exist is a no-op. Self-scoped: filters on user_id so a user
   * can only remove their own reaction.
   */
  async removeReaction(commentId: string, userId: string, emoji: string): Promise<void> {
    const normalizedUserId = this.normalizeUserId(userId)
    const normalizedEmoji = normalizeCommentReactionEmoji(emoji)

    await db
      .deleteFrom('meta_comment_reactions')
      .where('comment_id', '=', commentId)
      .where('user_id', '=', normalizedUserId)
      .where('emoji', '=', normalizedEmoji)
      .execute()
  }

  /**
   * Aggregate reactions for a set of comments into per-comment summaries
   * ({ emoji, count, reactedByMe }). Empty input → empty map (guards the
   * `IN ()` SQL error on an empty comment list). Ordered by emoji for stable
   * output. `reactedByMe` is false when no viewer is supplied.
   */
  async listReactionsForComments(
    commentIds: string[],
    viewerId?: string,
  ): Promise<Map<string, CommentReactionSummary[]>> {
    const result = new Map<string, CommentReactionSummary[]>()
    if (!commentIds.length) return result

    const viewer = viewerId?.trim() || ''
    const rows = await db
      .selectFrom('meta_comment_reactions')
      .select(({ fn }) => [
        'comment_id',
        'emoji',
        fn.countAll<number>().as('count'),
        fn.max(sql<number>`CASE WHEN user_id = ${viewer} THEN 1 ELSE 0 END`).as('reacted_by_me'),
      ])
      .where('comment_id', 'in', commentIds)
      .groupBy(['comment_id', 'emoji'])
      .orderBy('emoji', 'asc')
      .execute()

    for (const row of rows) {
      const list = result.get(row.comment_id) ?? []
      list.push({
        emoji: row.emoji,
        count: Number(row.count),
        reactedByMe: Number(row.reacted_by_me) > 0,
      })
      result.set(row.comment_id, list)
    }
    return result
  }

  async getCommentPresenceSummary(
    spreadsheetId: string,
    rowIds?: string[],
    mentionUserId?: string,
    excludeRowIds?: string[],
  ): Promise<{ items: CommentPresenceSummary[]; total: number }> {
    const normalizedRowIds = [...new Set((rowIds ?? []).map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0))]
    const normalizedMentionUserId = typeof mentionUserId === 'string' && mentionUserId.trim().length > 0 ? mentionUserId.trim() : null
    const excludedRowIds = this.normalizeRowIdList(excludeRowIds)

    // Single combined query with conditional aggregation instead of two separate queries
    const mentionJsonb = normalizedMentionUserId
      ? JSON.stringify([normalizedMentionUserId])
      : null

    let query = db
      .selectFrom('meta_comments')
      .select([
        'row_id',
        'field_id',
        sql<number>`count(*)::int`.as('comment_count'),
        ...(mentionJsonb
          ? [sql<number>`count(*) filter (where mentions @> ${mentionJsonb}::jsonb)::int`.as('mentioned_count')]
          : [sql<number>`0::int`.as('mentioned_count')]),
      ])
      .where('spreadsheet_id', '=', spreadsheetId)
      .where('resolved', '=', false)

    if (normalizedRowIds.length > 0) {
      query = query.where('row_id', 'in', normalizedRowIds)
    }
    if (excludedRowIds.length > 0) {
      query = query.where('row_id', 'not in', excludedRowIds)
    }

    const rows = (await query.groupBy(['row_id', 'field_id']).execute()) as Array<
      GroupedCountRow & { mentioned_count: number }
    >

    const summaryByRow = new Map<
      string,
      {
        unresolvedCount: number
        fieldCounts: Record<string, number>
        mentionedCount: number
        mentionedFieldCounts: Record<string, number>
      }
    >()

    for (const row of rows) {
      const current = summaryByRow.get(row.row_id) ?? {
        unresolvedCount: 0,
        fieldCounts: {},
        mentionedCount: 0,
        mentionedFieldCounts: {},
      }
      current.unresolvedCount += row.comment_count
      if (row.field_id) {
        current.fieldCounts[row.field_id] = (current.fieldCounts[row.field_id] ?? 0) + row.comment_count
      }
      current.mentionedCount += row.mentioned_count
      if (row.field_id && row.mentioned_count > 0) {
        current.mentionedFieldCounts[row.field_id] = (current.mentionedFieldCounts[row.field_id] ?? 0) + row.mentioned_count
      }
      summaryByRow.set(row.row_id, current)
    }

    const orderedRowIds = normalizedRowIds.length > 0
      ? normalizedRowIds.filter((rowId) => summaryByRow.has(rowId))
      : [...summaryByRow.keys()].sort()

    const items = orderedRowIds.map((rowId) => {
      const summary = summaryByRow.get(rowId)!
      return {
        containerId: spreadsheetId,
        spreadsheetId,
        rowId,
        targetId: rowId,
        unresolvedCount: summary.unresolvedCount,
        fieldCounts: summary.fieldCounts,
        mentionedCount: summary.mentionedCount,
        mentionedFieldCounts: summary.mentionedFieldCounts,
      }
    })

    return { items, total: items.length }
  }

  async getMentionSummary(
    spreadsheetId: string,
    mentionUserId: string,
    excludeRowIds?: string[],
  ): Promise<{
    /** Canonical container alias for `spreadsheetId`. */
    containerId: string
    spreadsheetId: string
    unresolvedMentionCount: number
    unreadMentionCount: number
    mentionedRecordCount: number
    unreadRecordCount: number
    items: Array<{
      /** Canonical container alias for `spreadsheetId`. */
      containerId: string
      rowId: string
      /** Canonical target alias for `rowId`. */
      targetId: string
      mentionedCount: number
      unreadCount: number
      mentionedFieldIds: string[]
    }>
  }> {
    const normalizedUserId = mentionUserId.trim()
    const excludedRowIds = this.normalizeRowIdList(excludeRowIds)
    if (!normalizedUserId) {
      return {
        containerId: spreadsheetId,
        spreadsheetId,
        unresolvedMentionCount: 0,
        unreadMentionCount: 0,
        mentionedRecordCount: 0,
        unreadRecordCount: 0,
        items: [],
      }
    }

    let query = db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', normalizedUserId))
      .select([
        'c.row_id',
        'c.field_id',
        sql<number>`count(*)::int`.as('mentioned_count'),
        sql<number>`count(*) filter (where r.comment_id is null)::int`.as('unread_count'),
      ])
      .where('c.spreadsheet_id', '=', spreadsheetId)
      .where('c.resolved', '=', false)
      .where('c.author_id', '!=', normalizedUserId)
      .where(sql<boolean>`c.mentions @> ${JSON.stringify([normalizedUserId])}::jsonb`)
    if (excludedRowIds.length > 0) {
      query = query.where('c.row_id', 'not in', excludedRowIds)
    }
    const rows = (await query.groupBy(['c.row_id', 'c.field_id']).execute()) as MentionGroupedCountRow[]

    const byRow = new Map<string, { count: number; unread: number; fieldIds: Set<string> }>()
    for (const row of rows) {
      const current = byRow.get(row.row_id) ?? { count: 0, unread: 0, fieldIds: new Set<string>() }
      current.count += row.mentioned_count
      current.unread += row.unread_count
      if (row.field_id) current.fieldIds.add(row.field_id)
      byRow.set(row.row_id, current)
    }

    const items = [...byRow.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([rowId, data]) => ({
        containerId: spreadsheetId,
        rowId,
        targetId: rowId,
        mentionedCount: data.count,
        unreadCount: data.unread,
        mentionedFieldIds: [...data.fieldIds].sort(),
      }))

    return {
      containerId: spreadsheetId,
      spreadsheetId,
      unresolvedMentionCount: items.reduce((sum, item) => sum + item.mentionedCount, 0),
      unreadMentionCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
      mentionedRecordCount: items.length,
      unreadRecordCount: items.filter((item) => item.unreadCount > 0).length,
      items,
    }
  }

  /**
   * Mark every unread comment in a spreadsheet as read for the given user.
   * Own comments are excluded from the batch (consistent with inbox logic).
   *
   * @returns The number of read records that were inserted or updated.
   */
  async markAllCommentsRead(spreadsheetId: string, userId: string, excludeRowIds?: string[]): Promise<number> {
    const normalizedUserId = userId.trim()
    const normalizedSheetId = spreadsheetId.trim()
    if (!normalizedUserId || !normalizedSheetId) return 0
    const excludedRowIds = this.normalizeRowIdList(excludeRowIds)

    // Collect IDs of all unread comments (not authored by this user)
    let query = db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) =>
        join.onRef('r.comment_id', '=', 'c.id').on('r.user_id', '=', normalizedUserId),
      )
      .select('c.id')
      .where('c.spreadsheet_id', '=', normalizedSheetId)
      .where('c.author_id', '!=', normalizedUserId)
      .where(sql<boolean>`r.comment_id is null`)
    if (excludedRowIds.length > 0) {
      query = query.where('c.row_id', 'not in', excludedRowIds)
    }
    const unreadRows = await query.execute()

    if (unreadRows.length === 0) return 0

    const now = new Date().toISOString()
    await db
      .insertInto('meta_comment_reads')
      .values(unreadRows.map((row) => ({
        comment_id: row.id,
        user_id: normalizedUserId,
        read_at: now,
        created_at: now,
      })))
      .onConflict((oc) =>
        oc.columns(['comment_id', 'user_id']).doUpdateSet({ read_at: now }),
      )
      .execute()

    return unreadRows.length
  }

  /**
   * Return comment presence summary, optionally enriched with the identities
   * of users currently viewing the spreadsheet's comment room.
   *
   * When `includeViewers` is true, a `viewers` array is appended to the result
   * containing each distinct userId present in the sheet's comment room.
   */
  async getCommentPresenceSummaryWithViewers(
    spreadsheetId: string,
    rowIds?: string[],
    mentionUserId?: string,
    includeViewers?: boolean,
    excludeRowIds?: string[],
  ): Promise<{ items: CommentPresenceSummary[]; total: number; viewers?: CommentPresenceViewer[] }> {
    const base = await this.getCommentPresenceSummary(spreadsheetId, rowIds, mentionUserId, excludeRowIds)

    if (!includeViewers) {
      return base
    }

    const { buildCommentSheetRoom } = await import('./commentRooms')
    const room = buildCommentSheetRoom({ spreadsheetId })
    const memberIds = await this.collabService.getRoomMembers(room)
    const viewers: CommentPresenceViewer[] = memberIds.map((userId) => ({ userId }))

    return { ...base, viewers }
  }

  async markMentionsRead(spreadsheetId: string, userId: string, excludeRowIds?: string[]): Promise<void> {
    const normalizedUserId = userId.trim()
    if (!normalizedUserId || !spreadsheetId) return
    const excludedRowIds = this.normalizeRowIdList(excludeRowIds)
    const rowDenyPredicate = excludedRowIds.length > 0
      ? sql`and c.row_id <> all(${excludedRowIds}::text[])`
      : sql``

    await sql`
      insert into meta_comment_reads (comment_id, user_id, read_at, created_at)
      select c.id, ${normalizedUserId}, now(), now()
      from meta_comments as c
      where c.spreadsheet_id = ${spreadsheetId}
        and c.resolved = false
        and c.author_id <> ${normalizedUserId}
        and c.mentions @> ${JSON.stringify([normalizedUserId])}::jsonb
        ${rowDenyPredicate}
      on conflict (comment_id, user_id)
      do update set read_at = excluded.read_at
    `.execute(db)
  }

  async resolveComment(commentId: string): Promise<void> {
    const result = await db
      .updateTable('meta_comments')
      .set({ resolved: true, updated_at: nowTimestamp() })
      .where('id', '=', commentId)
      .returningAll()
      .executeTakeFirst()

    if (result) {
      const resolvedPayload = {
        containerId: result.container_id,
        targetId: result.target_id,
        targetFieldId: result.target_field_id ?? null,
        spreadsheetId: result.spreadsheet_id,
        rowId: result.row_id,
        fieldId: result.field_id ?? undefined,
        commentId,
      }
      this.collabService.broadcastTo(
        buildCommentRecordRoom({ spreadsheetId: result.spreadsheet_id, rowId: result.row_id }),
        'comment:resolved',
        resolvedPayload,
      )
      this.collabService.broadcastTo(
        buildCommentSheetRoom({ spreadsheetId: result.spreadsheet_id }),
        'comment:resolved',
        resolvedPayload,
      )
      await this.publishCommentActivity({
        kind: 'resolved',
        containerId: result.container_id,
        targetId: result.target_id,
        targetFieldId: result.target_field_id ?? null,
        spreadsheetId: result.spreadsheet_id,
        rowId: result.row_id,
        fieldId: result.field_id ?? undefined,
        commentId,
      })
    }
  }

  private normalizeUserId(userId: string): string {
    const normalized = userId.trim()
    if (!normalized) {
      throw new CommentAccessError('Authenticated user required')
    }
    return normalized
  }

  private async getRequiredCommentRow(commentId: string): Promise<CommentRow> {
    const row = await db
      .selectFrom('meta_comments')
      .selectAll()
      .where('id', '=', commentId)
      .executeTakeFirst()

    if (!row) {
      throw new CommentNotFoundError('Comment not found')
    }

    return row
  }

  private assertCommentAuthor(row: Pick<CommentRow, 'author_id'>, userId: string, message: string): void {
    if (row.author_id !== userId) {
      throw new CommentAccessError(message)
    }
  }

  private normalizeRowIdList(rowIds?: string[]): string[] {
    return [...new Set((rowIds ?? []).map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0))]
  }

  private async canNotifyUserAboutCommentTarget(spreadsheetId: string, rowId: string, userId: string): Promise<boolean> {
    try {
      return await this.commentTargetReadChecker({ spreadsheetId, rowId, userId })
    } catch (error) {
      this.logger.warn('Comment mention read-target check failed', error instanceof Error ? error : undefined)
      return false
    }
  }

  private async publishCommentActivity(payload: CommentActivityPayload): Promise<void> {
    const getSubscriberIds = (this.collabService as { getCommentInboxSubscriberIds?: () => string[] })
      .getCommentInboxSubscriberIds
    if (!getSubscriberIds) return
    const subscriberIds = getSubscriberIds.call(this.collabService)
    for (const userId of subscriberIds) {
      if (!(await this.canNotifyUserAboutCommentTarget(payload.spreadsheetId, payload.rowId, userId))) continue
      this.collabService.broadcastTo(
        buildCommentInboxRoom({ userId }),
        'comment:activity',
        payload,
      )
    }
  }

  private async publishCommentUpdated(comment: Comment, authorId: string): Promise<void> {
    const payload = {
      containerId: comment.containerId,
      targetId: comment.targetId,
      targetFieldId: comment.targetFieldId,
      spreadsheetId: comment.spreadsheetId,
      rowId: comment.rowId,
      fieldId: comment.fieldId,
      comment,
    }
    this.collabService.broadcastTo(
      buildCommentRecordRoom({ spreadsheetId: comment.spreadsheetId, rowId: comment.rowId }),
      'comment:updated',
      payload,
    )
    this.collabService.broadcastTo(
      buildCommentSheetRoom({ spreadsheetId: comment.spreadsheetId }),
      'comment:updated',
      payload,
    )
    await this.publishCommentActivity({
      kind: 'updated',
      containerId: comment.containerId,
      targetId: comment.targetId,
      targetFieldId: comment.targetFieldId,
      spreadsheetId: comment.spreadsheetId,
      rowId: comment.rowId,
      fieldId: comment.fieldId,
      commentId: comment.id,
      authorId,
    })
  }

  private async publishCommentDeleted(row: CommentRow, authorId: string): Promise<void> {
    const payload = {
      containerId: row.container_id,
      targetId: row.target_id,
      targetFieldId: row.target_field_id ?? null,
      spreadsheetId: row.spreadsheet_id,
      rowId: row.row_id,
      fieldId: row.field_id ?? undefined,
      commentId: row.id,
    }
    this.collabService.broadcastTo(
      buildCommentRecordRoom({ spreadsheetId: row.spreadsheet_id, rowId: row.row_id }),
      'comment:deleted',
      payload,
    )
    this.collabService.broadcastTo(
      buildCommentSheetRoom({ spreadsheetId: row.spreadsheet_id }),
      'comment:deleted',
      payload,
    )
    await this.publishCommentActivity({
      kind: 'deleted',
      containerId: row.container_id,
      targetId: row.target_id,
      targetFieldId: row.target_field_id ?? null,
      spreadsheetId: row.spreadsheet_id,
      rowId: row.row_id,
      fieldId: row.field_id ?? undefined,
      commentId: row.id,
      authorId,
    })
  }

  private async getComment(id: string): Promise<Comment | undefined> {
    const row = await db.selectFrom('meta_comments').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? this.mapRowToComment(row) : undefined
  }

  private mapRowToComment(row: CommentRow): Comment {
    const mentions = this.parseMentionList(row.mentions)

    return {
      id: row.id,
      spreadsheetId: row.spreadsheet_id,
      rowId: row.row_id,
      fieldId: row.field_id || undefined,
      // Canonical container/target aliases carried from their own DB columns so
      // read paths (getComment/getComments) expose the same target linkage that
      // createComment writes. targetFieldId stays `null` (not coerced to
      // undefined) to match the API contract for record-level comments.
      containerId: row.container_id,
      targetId: row.target_id,
      targetFieldId: row.target_field_id ?? null,
      content: row.content,
      authorId: row.author_id,
      parentId: row.parent_id || undefined,
      resolved: row.resolved,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      mentions,
    }
  }

  private mapInboxRowToComment(row: CommentInboxRow): CommentInboxItem {
    return {
      ...this.mapRowToComment(row),
      unread: row.unread,
      mentioned: row.mentioned,
      baseId: row.base_id,
      sheetId: row.sheet_id ?? row.spreadsheet_id,
      viewId: row.view_id,
      recordId: row.record_id ?? row.row_id,
      // G-10 (docket #68): additive display names — see getInbox()'s doc comment for the
      // no-WHERE-relaxation boundary and the pre-existing G-8 caveat these inherit.
      baseName: row.base_name,
      sheetName: row.sheet_name,
      viewName: row.view_name,
      fieldName: row.field_name,
    }
  }

  private parseMentionList(mentions: unknown): string[] {
    const parsed =
      typeof mentions === 'string'
        ? (() => {
            try {
              return JSON.parse(mentions) as unknown
            } catch {
              return []
            }
          })()
        : mentions
    return Array.isArray(parsed) ? this.normalizeMentions(parsed) : []
  }

  /**
   * Extract user IDs from mention tokens embedded in comment content.
   *
   * Expected format: `@[Display Name](user-id)`
   * - `Display Name` is the human-readable label shown in the UI.
   * - `user-id` is the stable user identifier stored in the mentions array.
   *
   * This method is only called when no explicit `mentions` array is provided
   * in the request body (see mention precedence documentation above).
   *
   * @returns De-duplicated, trimmed array of mentioned user IDs.
   */
  private parseMentions(content: string): string[] {
    const regex = /@\[([^\]]+)\]\(([^)]+)\)/g
    const mentions: string[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      mentions.push(match[2])
    }
    return this.normalizeMentions(mentions)
  }

  /**
   * De-duplicate and trim a list of mention user IDs.
   * Non-string and empty-string entries are silently dropped.
   *
   * @returns A new array of unique, trimmed, non-empty user ID strings.
   */
  private normalizeMentions(mentions: Iterable<unknown>): string[] {
    const normalized = new Set<string>()
    for (const mention of mentions) {
      if (typeof mention !== 'string') continue
      const value = mention.trim()
      if (value) normalized.add(value)
    }
    return [...normalized]
  }
}
