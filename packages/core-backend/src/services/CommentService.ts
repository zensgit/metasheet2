import { sql } from 'kysely'
import { ICollabService, ILogger, type CommentInboxItem, type CommentQueryOptions } from '../di/identifiers';
import type { CollabService } from './CollabService';
import { db } from '../db/db';
import { nowTimestamp } from '../db/type-helpers';

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

type CommentInboxRow = CommentRow & {
  unread: boolean
  base_id: string | null
  sheet_id: string | null
  view_id: string | null
  record_id: string | null
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
    mentions?: string[];
  }): Promise<Comment> {
    const id = `cmt_${Date.now()}`;
    const mentions = data.mentions ?? this.parseMentions(data.content);

    await db.insertInto('meta_comments').values({
      id,
      spreadsheet_id: data.spreadsheetId,
      row_id: data.rowId,
      field_id: data.fieldId ?? null,
      content: data.content,
      author_id: data.authorId,
      parent_id: data.parentId ?? null,
      resolved: false,
      mentions: JSON.stringify(mentions),
    }).execute();

    const comment = await this.getComment(id);
    
    if (comment) {
      this.collabService.broadcastTo(`sheet:${data.spreadsheetId}`, 'comment:created', { spreadsheetId: data.spreadsheetId, comment });
      for (const mentionUserId of mentions) {
        if (mentionUserId && mentionUserId !== data.authorId) {
          this.collabService.sendTo(mentionUserId, 'comment:mention', { spreadsheetId: data.spreadsheetId, comment });
        }
      }
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

  async resolveComment(commentId: string): Promise<void> {
    const result = await db.updateTable('meta_comments')
      .set({ resolved: true, updated_at: nowTimestamp() })
      .where('id', '=', commentId)
      .returningAll()
      .executeTakeFirst();

    if (result) {
      this.collabService.broadcastTo(`sheet:${result.spreadsheet_id}`, 'comment:resolved', { spreadsheetId: result.spreadsheet_id, commentId });
    }
  }

  async getInbox(userId: string, options?: Pick<CommentQueryOptions, 'limit' | 'offset'>): Promise<{ items: CommentInboxItem[]; total: number }> {
    const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)))
    const offset = Math.max(0, Number(options?.offset ?? 0))
    const mentionPredicate = sql<boolean>`c.mentions @> ${JSON.stringify([userId])}::jsonb`

    const totalRow = await db
      .selectFrom('meta_comments as c')
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .where('c.author_id', '!=', userId)
      .where(mentionPredicate)
      .executeTakeFirst()
    const total = totalRow ? Number((totalRow as { c: string | number }).c) : 0

    const rows = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join
        .onRef('r.comment_id', '=', 'c.id')
        .on('r.user_id', '=', userId))
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
      ])
      .where('c.author_id', '!=', userId)
      .where(mentionPredicate)
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
    const mentionPredicate = sql<boolean>`c.mentions @> ${JSON.stringify([userId])}::jsonb`
    const row = await db
      .selectFrom('meta_comments as c')
      .leftJoin('meta_comment_reads as r', (join) => join
        .onRef('r.comment_id', '=', 'c.id')
        .on('r.user_id', '=', userId))
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .where('c.author_id', '!=', userId)
      .where(mentionPredicate)
      .where(sql<boolean>`r.comment_id is null`)
      .executeTakeFirst()
    return row ? Number((row as { c: string | number }).c) : 0
  }

  async markCommentRead(commentId: string, userId: string): Promise<void> {
    await db
      .insertInto('meta_comment_reads')
      .values({
        comment_id: commentId,
        user_id: userId,
        read_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(['comment_id', 'user_id']).doUpdateSet({
        read_at: new Date().toISOString(),
      }))
      .execute()
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

  private mapInboxRowToComment(row: CommentInboxRow): CommentInboxItem {
    return {
      ...this.mapRowToComment(row),
      unread: row.unread,
      baseId: row.base_id,
      sheetId: row.sheet_id ?? row.spreadsheet_id,
      viewId: row.view_id,
      recordId: row.record_id ?? row.row_id,
    }
  }

  private parseMentions(content: string): string[] {
    const regex = /@\[([^\]]+)\]\(([^)]+)\)/g;
    const mentions: string[] = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      mentions.push(match[2]);
    }
    return mentions;
  }
}
