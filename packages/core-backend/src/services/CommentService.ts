
import { ICollabService, ILogger, type CommentQueryOptions } from '../di/identifiers';
import type { CollabService } from './CollabService';
import { db } from '../db/db';
import { buildCommentRecordRoom, buildCommentSheetRoom } from './commentRooms';

export class CommentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommentValidationError'
  }
}

export interface Comment {
  id: string;
  spreadsheetId: string;
  rowId: string;
  fieldId?: string;
  content: string;
  authorId: string;
  parentId?: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  mentions: string[];
}

export interface CommentPresenceSummary {
  spreadsheetId: string;
  rowId: string;
  unresolvedCount: number;
  fieldCounts: Record<string, number>;
  mentionedCount: number;
  mentionedFieldCounts: Record<string, number>;
}

type CommentRow = {
  id: string;
  spreadsheet_id: string;
  row_id: string;
  field_id: string | null;
  content: string;
  author_id: string;
  parent_id: string | null;
  resolved: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  mentions: string | string[] | null;
}

type CommentPresenceRow = {
  row_id: string;
  field_id: string | null;
  mentions: string | string[] | null;
}

export class CommentService {
  static inject = [ICollabService, ILogger];

  constructor(
    private collabService: CollabService,
    private logger: ILogger
  ) {
  }

  async createComment(data: {
    spreadsheetId: string;
    rowId: string;
    fieldId?: string;
    content: string;
    authorId: string;
    parentId?: string;
  }): Promise<Comment> {
    const id = `cmt_${Date.now()}`;
    const mentions = this.parseMentions(data.content);
    let effectiveFieldId = data.fieldId?.trim() || undefined

    if (data.parentId) {
      const parent = await db.selectFrom('meta_comments')
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

    await db.insertInto('meta_comments').values({
      id,
      spreadsheet_id: data.spreadsheetId,
      row_id: data.rowId,
      field_id: effectiveFieldId ?? null,
      content: data.content,
      author_id: data.authorId,
      parent_id: data.parentId ?? null,
      resolved: false,
      mentions: JSON.stringify(mentions),
    }).execute();

    const comment = await this.getComment(id);
    
    if (comment) {
      const createdPayload = { spreadsheetId: data.spreadsheetId, comment };
      this.collabService.broadcastTo(
        buildCommentRecordRoom({ spreadsheetId: data.spreadsheetId, rowId: data.rowId }),
        'comment:created',
        createdPayload,
      );
      this.collabService.broadcastTo(
        buildCommentSheetRoom({ spreadsheetId: data.spreadsheetId }),
        'comment:created',
        createdPayload,
      );
    }

    return comment!;
  }

  async getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: Comment[]; total: number }> {
    let query = db.selectFrom('meta_comments').where('spreadsheet_id', '=', spreadsheetId);

    if (options?.rowId) {
      query = query.where('row_id', '=', options.rowId);
    }

    if (typeof options?.resolved === 'boolean') {
      query = query.where('resolved', '=', options.resolved);
    }

    const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)));
    const offset = Math.max(0, Number(options?.offset ?? 0));

    const totalObj = await query
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .executeTakeFirst();
    const total = totalObj ? Number((totalObj as { c: string | number }).c) : 0;

    const rows = await query
      .selectAll()
      .orderBy('created_at', 'asc')
      .limit(limit)
      .offset(offset)
      .execute();

    return { items: rows.map((row) => this.mapRowToComment(row)), total };
  }

  async getCommentPresenceSummary(
    spreadsheetId: string,
    rowIds?: string[],
    mentionUserId?: string,
  ): Promise<{ items: CommentPresenceSummary[]; total: number }> {
    const normalizedRowIds = [...new Set((rowIds ?? [])
      .map((rowId) => rowId.trim())
      .filter((rowId) => rowId.length > 0))]
    const normalizedMentionUserId = typeof mentionUserId === 'string' && mentionUserId.trim().length > 0
      ? mentionUserId.trim()
      : null

    let query = db.selectFrom('meta_comments')
      .select(['row_id', 'field_id', 'mentions'])
      .where('spreadsheet_id', '=', spreadsheetId)
      .where('resolved', '=', false)

    if (normalizedRowIds.length > 0) {
      query = query.where('row_id', 'in', normalizedRowIds)
    }

    const rows = await query.execute() as CommentPresenceRow[]
    const summaryByRow = new Map<string, {
      unresolvedCount: number
      fieldCounts: Record<string, number>
      mentionedCount: number
      mentionedFieldCounts: Record<string, number>
    }>()

    for (const row of rows) {
      const current = summaryByRow.get(row.row_id) ?? {
        unresolvedCount: 0,
        fieldCounts: {},
        mentionedCount: 0,
        mentionedFieldCounts: {},
      }
      current.unresolvedCount += 1
      if (row.field_id) {
        current.fieldCounts[row.field_id] = (current.fieldCounts[row.field_id] ?? 0) + 1
      }
      if (normalizedMentionUserId && this.parseMentionList(row.mentions).includes(normalizedMentionUserId)) {
        current.mentionedCount += 1
        if (row.field_id) {
          current.mentionedFieldCounts[row.field_id] = (current.mentionedFieldCounts[row.field_id] ?? 0) + 1
        }
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
      return { spreadsheetId, unresolvedMentionCount: 0, unreadMentionCount: 0, mentionedRecordCount: 0, unreadRecordCount: 0, items: [] }
    }

    const lastReadAt = await this.getLastReadAt(normalizedUserId, spreadsheetId)

    const rows = await db.selectFrom('meta_comments')
      .select(['row_id', 'field_id', 'mentions', 'created_at'])
      .where('spreadsheet_id', '=', spreadsheetId)
      .where('resolved', '=', false)
      .execute() as Array<CommentPresenceRow & { created_at: string | Date }>

    const byRow = new Map<string, { count: number; unread: number; fieldIds: Set<string> }>()

    for (const row of rows) {
      const mentionList = this.parseMentionList(row.mentions)
      if (!mentionList.includes(normalizedUserId)) continue
      const current = byRow.get(row.row_id) ?? { count: 0, unread: 0, fieldIds: new Set<string>() }
      current.count += 1
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at))
      if (!lastReadAt || createdAt.getTime() > lastReadAt.getTime()) {
        current.unread += 1
      }
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

    const unresolvedMentionCount = items.reduce((sum, item) => sum + item.mentionedCount, 0)
    const unreadMentionCount = items.reduce((sum, item) => sum + item.unreadCount, 0)
    const unreadRecordCount = items.filter((item) => item.unreadCount > 0).length

    return {
      spreadsheetId,
      unresolvedMentionCount,
      unreadMentionCount,
      mentionedRecordCount: items.length,
      unreadRecordCount,
      items,
    }
  }

  async markMentionsRead(spreadsheetId: string, userId: string): Promise<void> {
    const normalizedUserId = userId.trim()
    if (!normalizedUserId || !spreadsheetId) return

    try {
      await db.insertInto('meta_comment_reads' as any)
        .values({ user_id: normalizedUserId, spreadsheet_id: spreadsheetId, last_read_at: new Date() } as any)
        .onConflict((oc: any) => oc.columns(['user_id', 'spreadsheet_id']).doUpdateSet({ last_read_at: new Date() } as any))
        .execute()
    } catch {
      // Table may not exist yet — silently ignore
    }
  }

  private async getLastReadAt(userId: string, spreadsheetId: string): Promise<Date | null> {
    try {
      const result = await db.selectFrom('meta_comment_reads' as any)
        .select('last_read_at')
        .where('user_id', '=', userId)
        .where('spreadsheet_id', '=', spreadsheetId)
        .executeTakeFirst() as { last_read_at?: string | Date } | undefined
      if (!result?.last_read_at) return null
      return result.last_read_at instanceof Date ? result.last_read_at : new Date(String(result.last_read_at))
    } catch {
      return null // Table may not exist yet
    }
  }

  async resolveComment(commentId: string): Promise<void> {
    const result = await db.updateTable('meta_comments')
      .set({ resolved: true, updated_at: new Date() })
      .where('id', '=', commentId)
      .returningAll()
      .executeTakeFirst();

    if (result) {
      const resolvedPayload = {
        spreadsheetId: result.spreadsheet_id,
        rowId: result.row_id,
        fieldId: result.field_id ?? undefined,
        commentId,
      };
      this.collabService.broadcastTo(
        buildCommentRecordRoom({ spreadsheetId: result.spreadsheet_id, rowId: result.row_id }),
        'comment:resolved',
        resolvedPayload,
      );
      this.collabService.broadcastTo(
        buildCommentSheetRoom({ spreadsheetId: result.spreadsheet_id }),
        'comment:resolved',
        resolvedPayload,
      );
    }
  }

  private async getComment(id: string): Promise<Comment | undefined> {
    const row = await db.selectFrom('meta_comments').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.mapRowToComment(row) : undefined;
  }

  private mapRowToComment(row: CommentRow): Comment {
    const mentions = typeof row.mentions === 'string'
      ? JSON.parse(row.mentions) as unknown
      : row.mentions

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
      mentions: Array.isArray(mentions) ? mentions.filter((value): value is string => typeof value === 'string') : []
    };
  }

  private parseMentionList(mentions: unknown): string[] {
    const parsed = typeof mentions === 'string'
      ? (() => {
        try {
          return JSON.parse(mentions) as unknown
        } catch {
          return []
        }
      })()
      : mentions
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  }

  private parseMentions(content: string): string[] {
    const regex = /@\[([^\]]+)\]\(([^)]+)\)/g;
    const mentions: string[] = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      mentions.push(match[1]); // userId is in the first group [userId]
    }
    return mentions;
  }
}
