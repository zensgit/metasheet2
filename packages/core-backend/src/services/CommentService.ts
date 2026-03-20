import {
  ICollabService,
  ILogger,
  type CommentCreateInput,
  type CommentListScope,
  type CommentQueryOptions,
} from '../di/identifiers';
import { CollabService } from './CollabService';
import { db } from '../db/db';

export type CommentTargetType = 'spreadsheet_row' | 'meta_record';
export type CommentContainerType = 'spreadsheet' | 'meta_sheet';

export interface Comment {
  id: string;
  targetType: CommentTargetType;
  targetId: string;
  targetFieldId?: string;
  containerType: CommentContainerType | string;
  containerId: string;
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

  async createComment(data: CommentCreateInput): Promise<Comment> {
    const normalized = this.normalizeCreateInput(data);
    const id = `cmt_${Date.now()}`;
    const mentions = this.parseMentions(normalized.content);

    await db.insertInto('meta_comments').values({
      id,
      spreadsheet_id: normalized.spreadsheetId,
      row_id: normalized.rowId,
      field_id: normalized.fieldId ?? null,
      target_type: normalized.targetType,
      target_id: normalized.targetId,
      target_field_id: normalized.targetFieldId ?? null,
      container_type: normalized.containerType,
      container_id: normalized.containerId,
      content: normalized.content,
      author_id: normalized.authorId,
      parent_id: normalized.parentId ?? null,
      resolved: false,
      mentions: JSON.stringify(mentions) as any,
    }).execute();

    const comment = await this.getComment(id);
    
    if (comment) {
      // Broadcast
      this.collabService.broadcast('comment:created', {
        spreadsheetId: normalized.spreadsheetId,
        containerId: normalized.containerId,
        targetId: normalized.targetId,
        comment,
      });
    }

    return comment!;
  }

  async getComments(scope: CommentListScope, options?: CommentQueryOptions): Promise<{ items: Comment[]; total: number }> {
    const normalized = this.normalizeListScope(scope, options);
    let query = db.selectFrom('meta_comments')
      .where('container_id', '=', normalized.containerId)
      .where('container_type', '=', normalized.containerType);

    if (normalized.targetId) {
      query = query.where('target_id', '=', normalized.targetId);
    }

    if (normalized.targetType) {
      query = query.where('target_type', '=', normalized.targetType);
    }

    if (normalized.targetFieldId) {
      query = query.where('target_field_id', '=', normalized.targetFieldId);
    }

    if (typeof normalized.resolved === 'boolean') {
      query = query.where('resolved', '=', normalized.resolved);
    }

    const limit = Math.min(200, Math.max(1, Number(normalized.limit ?? 50)));
    const offset = Math.max(0, Number(normalized.offset ?? 0));

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
      this.collabService.broadcast('comment:resolved', {
        spreadsheetId: result.spreadsheet_id,
        containerId: result.container_id,
        targetId: result.target_id,
        commentId,
      });
    }
  }

  async updateComment(commentId: string, data: { content?: string; resolved?: boolean }): Promise<Comment | null> {
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date(),
    }

    if (typeof data.content === 'string') {
      updatePayload.content = data.content
      updatePayload.mentions = JSON.stringify(this.parseMentions(data.content)) as any
    }

    if (typeof data.resolved === 'boolean') {
      updatePayload.resolved = data.resolved
    }

    const result = await db
      .updateTable('meta_comments')
      .set(updatePayload)
      .where('id', '=', commentId)
      .returningAll()
      .executeTakeFirst()

    if (!result) return null

    const comment = this.mapRowToComment(result)
    this.collabService.broadcast('comment:updated', {
      spreadsheetId: result.spreadsheet_id,
      containerId: result.container_id,
      targetId: result.target_id,
      comment,
    })

    return comment
  }

  async deleteComment(commentId: string): Promise<boolean> {
    const existing = await db
      .selectFrom('meta_comments')
      .selectAll()
      .where('id', '=', commentId)
      .executeTakeFirst()

    if (!existing) return false

    await db
      .deleteFrom('meta_comments')
      .where('id', '=', commentId)
      .execute()

    this.collabService.broadcast('comment:deleted', {
      spreadsheetId: existing.spreadsheet_id,
      containerId: existing.container_id,
      targetId: existing.target_id,
      commentId,
    })

    return true
  }

  private async getComment(id: string): Promise<Comment | undefined> {
    const row = await db.selectFrom('meta_comments').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? this.mapRowToComment(row) : undefined;
  }

  private mapRowToComment(row: any): Comment {
    const targetType = (typeof row.target_type === 'string' && row.target_type.length > 0
      ? row.target_type
      : 'spreadsheet_row') as CommentTargetType;
    const targetId = typeof row.target_id === 'string' && row.target_id.length > 0 ? row.target_id : row.row_id;
    const targetFieldId = row.target_field_id || row.field_id || undefined;
    const containerType = (typeof row.container_type === 'string' && row.container_type.length > 0
      ? row.container_type
      : 'spreadsheet') as CommentContainerType | string;
    const containerId = typeof row.container_id === 'string' && row.container_id.length > 0 ? row.container_id : row.spreadsheet_id;

    return {
      id: row.id,
      targetType,
      targetId,
      targetFieldId,
      containerType,
      containerId,
      spreadsheetId: containerId,
      rowId: targetId,
      fieldId: targetFieldId,
      content: row.content,
      authorId: row.author_id,
      parentId: row.parent_id || undefined,
      resolved: row.resolved,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      mentions: typeof row.mentions === 'string' ? JSON.parse(row.mentions) : (row.mentions || [])
    };
  }

  private normalizeCreateInput(data: CommentCreateInput): Required<Omit<CommentCreateInput, 'fieldId' | 'targetFieldId' | 'parentId'>> & {
    fieldId?: string;
    targetFieldId?: string;
    parentId?: string;
  } {
    if (typeof data.spreadsheetId === 'string' && typeof data.rowId === 'string') {
      return {
        spreadsheetId: data.spreadsheetId,
        rowId: data.rowId,
        fieldId: data.fieldId,
        targetType: 'spreadsheet_row',
        targetId: data.rowId,
        targetFieldId: data.fieldId,
        containerType: 'spreadsheet',
        containerId: data.spreadsheetId,
        content: data.content,
        authorId: data.authorId,
        parentId: data.parentId,
      };
    }

    return {
      spreadsheetId: data.containerId!,
      rowId: data.targetId!,
      fieldId: data.targetFieldId,
      targetType: (data.targetType ?? 'meta_record') as CommentTargetType,
      targetId: data.targetId!,
      targetFieldId: data.targetFieldId,
      containerType: (data.containerType ?? 'meta_sheet') as CommentContainerType,
      containerId: data.containerId!,
      content: data.content,
      authorId: data.authorId,
      parentId: data.parentId,
    };
  }

  private normalizeListScope(scope: CommentListScope, options?: CommentQueryOptions) {
    const containerId = scope.containerId ?? scope.spreadsheetId
    const containerType = scope.containerType ?? (scope.containerId ? 'meta_sheet' : 'spreadsheet')
    return {
      containerId: containerId!,
      containerType,
      targetType: options?.targetType ?? (options?.rowId ? 'spreadsheet_row' : undefined),
      targetId: options?.targetId ?? options?.rowId,
      targetFieldId: options?.targetFieldId ?? options?.fieldId,
      resolved: options?.resolved,
      limit: options?.limit,
      offset: options?.offset,
    }
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
