import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import {
  ICollabService,
  ILogger,
  type CommentInboxItem,
  type CommentMentionCandidate,
  type CommentQueryOptions,
  type CommentUnreadSummary,
} from '../di/identifiers'
import type { CollabService } from './CollabService'
import { db } from '../db/db'
import { nowTimestamp } from '../db/type-helpers'
import { buildCommentInboxRoom, buildCommentRecordRoom, buildCommentSheetRoom } from './commentRooms'

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

export interface Comment {
  id: string
  spreadsheetId: string
  rowId: string
  fieldId?: string
  content: string
  authorId: string
  parentId?: string
  resolved: boolean
  createdAt: string
  updatedAt: string
  mentions: string[]
}

export interface CommentPresenceSummary {
  spreadsheetId: string
  rowId: string
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
  spreadsheetId: string
  rowId: string
  fieldId?: string
  commentId: string
  authorId?: string
}

export class CommentService {
  static inject = [ICollabService, ILogger]

  constructor(
    private collabService: CollabService,
    private logger: ILogger,
  ) {}

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

    this.publishCommentUpdated(comment, normalizedUserId)

    for (const mentionUserId of mentions) {
      if (!mentionUserId || mentionUserId === normalizedUserId || previousMentions.includes(mentionUserId)) continue
      this.collabService.sendTo(mentionUserId, 'comment:mention', {
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
      await trx.deleteFrom('meta_comments').where('id', '=', commentId).execute()
    })

    this.publishCommentDeleted(existing, normalizedUserId)
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

      if (!parent) {
        throw new CommentValidationError('Parent comment not found')
      }
      if (parent.parent_id) {
        throw new CommentValidationError('Replying to replies is not supported')
      }
      if (parent.spreadsheet_id !== data.spreadsheetId || parent.row_id !== data.rowId) {
        throw new CommentValidationError('Reply must target the same record thread')
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

    await db
      .insertInto('meta_comments')
      .values({
        id,
        spreadsheet_id: data.spreadsheetId,
        row_id: data.rowId,
        field_id: effectiveFieldId ?? null,
        content: data.content,
        author_id: data.authorId,
        parent_id: data.parentId ?? null,
        resolved: false,
        mentions: JSON.stringify(mentions),
      })
      .execute()

    const comment = await this.getComment(id)
    if (!comment) {
      throw new Error('Created comment could not be reloaded')
    }

    // Auto-mark as read for the author so their own comments never appear as "unread"
    await this.markCommentRead(id, data.authorId)

    const createdPayload = {
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
    this.collabService.broadcastTo(
      buildCommentInboxRoom(),
      'comment:activity',
      {
        kind: 'created',
        spreadsheetId: data.spreadsheetId,
        rowId: data.rowId,
        fieldId: effectiveFieldId,
        commentId: comment.id,
        authorId: data.authorId,
      } satisfies CommentActivityPayload,
    )
    for (const mentionUserId of mentions) {
      if (mentionUserId && mentionUserId !== data.authorId) {
        this.collabService.sendTo(mentionUserId, 'comment:mention', createdPayload)
      }
    }

    return comment
  }

  async getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: Comment[]; total: number }> {
    let query = db.selectFrom('meta_comments').where('spreadsheet_id', '=', spreadsheetId)

    if (options?.rowId) {
      query = query.where('row_id', '=', options.rowId)
    }

    if (options?.fieldId) {
      query = query.where('field_id', '=', options.fieldId)
    }

    if (typeof options?.resolved === 'boolean') {
      query = query.where('resolved', '=', options.resolved)
    }

    const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)))
    const offset = Math.max(0, Number(options?.offset ?? 0))

    const totalObj = await query.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst()
    const total = totalObj ? Number((totalObj as { c: string | number }).c) : 0

    const rows = await query.selectAll().orderBy('created_at', 'asc').limit(limit).offset(offset).execute()

    return { items: rows.map((row) => this.mapRowToComment(row)), total }
  }

  async listMentionCandidates(
    spreadsheetId: string,
    options?: { q?: string; limit?: number },
  ): Promise<{ items: CommentMentionCandidate[]; total: number }> {
    const normalizedSheetId = spreadsheetId.trim()
    if (!normalizedSheetId) return { items: [], total: 0 }

    const limit = Math.min(100, Math.max(1, Number(options?.limit ?? 50)))
    const normalizedQuery = options?.q?.trim().toLowerCase() ?? ''
    const likeQuery = `%${normalizedQuery}%`
    const startsWithQuery = `${normalizedQuery}%`

    let baseQuery = db
      .selectFrom('users')
      .where('is_active', '=', true)

    if (normalizedQuery) {
      baseQuery = baseQuery.where((eb) => eb.or([
        sql<boolean>`lower(coalesce(name, '')) like ${likeQuery}`,
        sql<boolean>`lower(email) like ${likeQuery}`,
        sql<boolean>`lower(id) like ${likeQuery}`,
      ]))
    }

    const totalRow = await baseQuery
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .executeTakeFirst()
    const total = totalRow ? Number((totalRow as { c: string | number }).c) : 0

    let rowsQuery = baseQuery
      .select(['id', 'name', 'email'])

    if (normalizedQuery) {
      rowsQuery = rowsQuery
        .orderBy(
          sql<number>`case
            when lower(coalesce(name, '')) like ${startsWithQuery} then 0
            when lower(email) like ${startsWithQuery} then 1
            when lower(id) like ${startsWithQuery} then 2
            else 3
          end`,
        )
    }

    const rows = await rowsQuery
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()

    return {
      items: rows.map((row) => {
        const label = row.name?.trim() || row.email.trim() || row.id
        const subtitle = row.name?.trim() && row.email.trim() && row.name.trim() !== row.email.trim()
          ? row.email.trim()
          : undefined
        return {
          id: row.id,
          label,
          subtitle,
        }
      }),
      total,
    }
  }

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
      .select((eb) => [
        'c.id',
        'c.spreadsheet_id',
        'c.row_id',
        'c.field_id',
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

  async getCommentPresenceSummary(
    spreadsheetId: string,
    rowIds?: string[],
    mentionUserId?: string,
  ): Promise<{ items: CommentPresenceSummary[]; total: number }> {
    const normalizedRowIds = [...new Set((rowIds ?? []).map((rowId) => rowId.trim()).filter((rowId) => rowId.length > 0))]
    const normalizedMentionUserId = typeof mentionUserId === 'string' && mentionUserId.trim().length > 0 ? mentionUserId.trim() : null

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
        spreadsheetId,
        rowId,
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
  ): Promise<{
    spreadsheetId: string
    unresolvedMentionCount: number
    unreadMentionCount: number
    mentionedRecordCount: number
    unreadRecordCount: number
    items: Array<{
      rowId: string
      mentionedCount: number
      unreadCount: number
      mentionedFieldIds: string[]
    }>
  }> {
    const normalizedUserId = mentionUserId.trim()
    if (!normalizedUserId) {
      return {
        spreadsheetId,
        unresolvedMentionCount: 0,
        unreadMentionCount: 0,
        mentionedRecordCount: 0,
        unreadRecordCount: 0,
        items: [],
      }
    }

    const rows = (await db
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
      .groupBy(['c.row_id', 'c.field_id'])
      .execute()) as MentionGroupedCountRow[]

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
        rowId,
        mentionedCount: data.count,
        unreadCount: data.unread,
        mentionedFieldIds: [...data.fieldIds].sort(),
      }))

    return {
      spreadsheetId,
      unresolvedMentionCount: items.reduce((sum, item) => sum + item.mentionedCount, 0),
      unreadMentionCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
      mentionedRecordCount: items.length,
      unreadRecordCount: items.filter((item) => item.unreadCount > 0).length,
      items,
    }
  }

  async markMentionsRead(spreadsheetId: string, userId: string): Promise<void> {
    const normalizedUserId = userId.trim()
    if (!normalizedUserId || !spreadsheetId) return

    await sql`
      insert into meta_comment_reads (comment_id, user_id, read_at, created_at)
      select c.id, ${normalizedUserId}, now(), now()
      from meta_comments as c
      where c.spreadsheet_id = ${spreadsheetId}
        and c.resolved = false
        and c.author_id <> ${normalizedUserId}
        and c.mentions @> ${JSON.stringify([normalizedUserId])}::jsonb
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
      this.collabService.broadcastTo(
        buildCommentInboxRoom(),
        'comment:activity',
        {
          kind: 'resolved',
          spreadsheetId: result.spreadsheet_id,
          rowId: result.row_id,
          fieldId: result.field_id ?? undefined,
          commentId,
        } satisfies CommentActivityPayload,
      )
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

  private publishCommentUpdated(comment: Comment, authorId: string): void {
    const payload = {
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
    this.collabService.broadcastTo(
      buildCommentInboxRoom(),
      'comment:activity',
      {
        kind: 'updated',
        spreadsheetId: comment.spreadsheetId,
        rowId: comment.rowId,
        fieldId: comment.fieldId,
        commentId: comment.id,
        authorId,
      } satisfies CommentActivityPayload,
    )
  }

  private publishCommentDeleted(row: CommentRow, authorId: string): void {
    const payload = {
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
    this.collabService.broadcastTo(
      buildCommentInboxRoom(),
      'comment:activity',
      {
        kind: 'deleted',
        spreadsheetId: row.spreadsheet_id,
        rowId: row.row_id,
        fieldId: row.field_id ?? undefined,
        commentId: row.id,
        authorId,
      } satisfies CommentActivityPayload,
    )
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
