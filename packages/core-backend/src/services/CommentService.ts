import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { ICollabService, ILogger, type CommentInboxItem, type CommentQueryOptions } from '../di/identifiers'
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
  kind: 'created' | 'resolved'
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

    let unresolvedQuery = db
      .selectFrom('meta_comments')
      .select(['row_id', 'field_id', sql<number>`count(*)::int`.as('comment_count')])
      .where('spreadsheet_id', '=', spreadsheetId)
      .where('resolved', '=', false)

    if (normalizedRowIds.length > 0) {
      unresolvedQuery = unresolvedQuery.where('row_id', 'in', normalizedRowIds)
    }

    const unresolvedRows = (await unresolvedQuery.groupBy(['row_id', 'field_id']).execute()) as GroupedCountRow[]

    let mentionedRows: GroupedCountRow[] = []
    if (normalizedMentionUserId) {
      let mentionedQuery = db
        .selectFrom('meta_comments')
        .select(['row_id', 'field_id', sql<number>`count(*)::int`.as('comment_count')])
        .where('spreadsheet_id', '=', spreadsheetId)
        .where('resolved', '=', false)
        .where(sql<boolean>`mentions @> ${JSON.stringify([normalizedMentionUserId])}::jsonb`)

      if (normalizedRowIds.length > 0) {
        mentionedQuery = mentionedQuery.where('row_id', 'in', normalizedRowIds)
      }

      mentionedRows = (await mentionedQuery.groupBy(['row_id', 'field_id']).execute()) as GroupedCountRow[]
    }

    const summaryByRow = new Map<
      string,
      {
        unresolvedCount: number
        fieldCounts: Record<string, number>
        mentionedCount: number
        mentionedFieldCounts: Record<string, number>
      }
    >()

    for (const row of unresolvedRows) {
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
      summaryByRow.set(row.row_id, current)
    }

    for (const row of mentionedRows) {
      const current = summaryByRow.get(row.row_id) ?? {
        unresolvedCount: 0,
        fieldCounts: {},
        mentionedCount: 0,
        mentionedFieldCounts: {},
      }
      current.mentionedCount += row.comment_count
      if (row.field_id) {
        current.mentionedFieldCounts[row.field_id] = (current.mentionedFieldCounts[row.field_id] ?? 0) + row.comment_count
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

  private parseMentions(content: string): string[] {
    const regex = /@\[([^\]]+)\]\(([^)]+)\)/g
    const mentions: string[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      mentions.push(match[2])
    }
    return this.normalizeMentions(mentions)
  }

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
