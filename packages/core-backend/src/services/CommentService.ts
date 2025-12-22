
import { ICollabService, ILogger, type CommentQueryOptions } from '../di/identifiers';
import { CollabService } from './CollabService';
import { db } from '../db/db';

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
      // Broadcast
      this.collabService.broadcast('comment:created', { spreadsheetId: data.spreadsheetId, comment });
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select((eb: any) => eb.fn.countAll().as('c'))
      .executeTakeFirst();
    const total = totalObj ? Number((totalObj as { c: string | number }).c) : 0;

    const rows = await query
      .selectAll()
      .orderBy('created_at', 'asc')
      .limit(limit)
      .offset(offset)
      .execute();

    return { items: rows.map(this.mapRowToComment), total };
  }

  async resolveComment(commentId: string): Promise<void> {
    const result = await db.updateTable('meta_comments')
      .set({ resolved: true, updated_at: new Date() })
      .where('id', '=', commentId)
      .returningAll()
      .executeTakeFirst();

    if (result) {
      this.collabService.broadcast('comment:resolved', { spreadsheetId: result.spreadsheet_id, commentId });
    }
  }

  private async getComment(id: string): Promise<Comment | undefined> {
    const row = await db.selectFrom('meta_comments').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.mapRowToComment(row) : undefined;
  }

  private mapRowToComment(row: any): Comment {
    return {
      id: row.id,
      spreadsheetId: row.spreadsheet_id,
      rowId: row.row_id,
      fieldId: row.field_id || undefined,
      content: row.content,
      authorId: row.author_id,
      parentId: row.parent_id || undefined,
      resolved: row.resolved,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      mentions: typeof row.mentions === 'string' ? JSON.parse(row.mentions) : (row.mentions || [])
    };
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
