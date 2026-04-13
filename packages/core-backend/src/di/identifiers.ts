import { createIdentifier } from '@wendellhu/redi';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import type { AthenaDocument, DocumentVersion } from '../data-adapters/AthenaAdapter';
import type { QueryResult } from '../data-adapters/BaseAdapter';
import type { ApprovalHistoryEntry, ApprovalRequest, BOMItem, PLMItemMetadata, PLMProduct } from '../data-adapters/PLMAdapter';
import type { ConfigValue } from '../services/ConfigService';
import type { CollectionDefinition } from '../types/collection';
import type { Repository } from '../core/database/Repository';
import type { PluginLoader } from '../core/plugin-loader';
import type { CoreAPI } from '../types/plugin';

/**
 * Service Identifiers
 * 用于 IoC 容器中的依赖注入
 */

// 核心服务
export const IConfigService = createIdentifier<IConfigService>('config-service');
export const ILogger = createIdentifier<ILogger>('logger');
export const IPluginLoader = createIdentifier<PluginLoader>('plugin-loader');
export const IMessageBus = createIdentifier<IMessageBus>('message-bus');
export const ICollabService = createIdentifier<ICollabService>('collab-service');
export const ICollectionManager = createIdentifier<ICollectionManager>('collection-manager');
export const ICoreAPI = createIdentifier<CoreAPI>('core-api');

// 接口定义 (为了解耦，理想情况下应该在独立的文件中，这里为了方便先放在一起或在实现文件中)

export interface IConfigService {
  get<T extends ConfigValue = ConfigValue>(key: string, defaultValue?: T): Promise<T | undefined>;
  set(key: string, value: ConfigValue, sourceName?: string): Promise<void>;
  getAll(): Promise<Record<string, ConfigValue>>;
  reload(): Promise<void>;
  validate(): Promise<{ valid: boolean; errors: string[] }>;
}

export interface IMessageBus {
  publish<T = unknown>(topic: string, payload: T, options?: Record<string, unknown>): Promise<void>;
  subscribe<T = unknown, R = unknown>(
    topic: string,
    handler: (message: T) => Promise<R> | R,
    plugin?: string,
  ): string;
  unsubscribe(subscriptionId: string): boolean;
}

export interface ILogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface ICollabService {
  initialize(httpServer: HttpServer): void;
  broadcast(event: string, data: unknown): void;
  broadcastTo(room: string, event: string, data: unknown): void;
  sendTo(userId: string, event: string, data: unknown): void;
  join(room: string, options?: { userId?: string; socketId?: string }): Promise<void>;
  leave(room: string, options?: { userId?: string; socketId?: string }): Promise<void>;
  onConnection(handler: (socket: Socket) => void): void;
}

export interface ICollectionManager {
  register(definition: CollectionDefinition): void;
  getDefinition(sheetId: string): Promise<CollectionDefinition | null>;
  getRepository(name: string): Repository;
  sync(): Promise<void>;
}

export interface IAdapterLifecycle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export interface IPLMAdapterService extends IAdapterLifecycle {
  getProducts(options?: Record<string, unknown>): Promise<QueryResult<PLMProduct>>;
  getProductBOM(productId: string, options?: { depth?: number; effectiveAt?: string }): Promise<QueryResult<BOMItem>>;
  getProductById(productId: string, options?: Record<string, unknown>): Promise<PLMProduct | null>;
  getItemMetadata(itemType: string): Promise<QueryResult<PLMItemMetadata>>;
  getApprovals(options?: Record<string, unknown>): Promise<QueryResult<ApprovalRequest>>;
  getApprovalById(approvalId: string): Promise<QueryResult<ApprovalRequest>>;
  getApprovalHistory(approvalId: string): Promise<QueryResult<ApprovalHistoryEntry>>;
  approveApproval(approvalId: string, version: number, comment?: string): Promise<QueryResult<Record<string, unknown>>>;
  rejectApproval(approvalId: string, version: number, comment: string): Promise<QueryResult<Record<string, unknown>>>;
}

export interface IAthenaAdapterService extends IAdapterLifecycle {
  listFolders(parentId?: string): Promise<unknown>;
  searchDocuments(params: Record<string, unknown>): Promise<QueryResult<AthenaDocument>>;
  getDocument(id: string): Promise<AthenaDocument | null>;
  uploadDocument(params: Record<string, unknown>): Promise<unknown>;
  getVersionHistory(documentId: string): Promise<QueryResult<DocumentVersion>>;
}

export interface IDedupCADAdapterService {
  search(fileId: string, threshold?: number): Promise<unknown>;
  compare(sourceId: string, targetId: string): Promise<unknown>;
}

export interface ICADMLAdapterService {
  analyze(fileId: string): Promise<unknown>;
  extractText(fileId: string): Promise<unknown>;
  predictCost(fileId: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface IVisionAdapterService {
  generateDiff(sourceId: string, targetId: string): Promise<unknown>;
}

export const IPLMAdapter = createIdentifier<IPLMAdapterService>('plm-adapter');
export const IAthenaAdapter = createIdentifier<IAthenaAdapterService>('athena-adapter');
export const IDedupCADAdapter = createIdentifier<IDedupCADAdapterService>('dedup-cad-adapter');
export const ICADMLAdapter = createIdentifier<ICADMLAdapterService>('cad-ml-adapter');
export const IVisionAdapter = createIdentifier<IVisionAdapterService>('vision-adapter');
export const IFormulaService = createIdentifier<IFormulaService>('formula-service');
export const IAccessControlService = createIdentifier<IAccessControlService>('access-control-service');
export const IHistoryService = createIdentifier<IHistoryService>('history-service');
export const ISpreadsheetService = createIdentifier<ISpreadsheetService>('spreadsheet-service');
export const IViewService = createIdentifier<IViewService>('view-service');
export const IAutomationService = createIdentifier<IAutomationService>('automation-service');
export const IConditionalFormattingService = createIdentifier<IConditionalFormattingService>('conditional-formatting-service');
export const IDashboardService = createIdentifier<IDashboardService>('dashboard-service');
export const IPresenceService = createIdentifier<IPresenceService>('presence-service');
export const ICommentService = createIdentifier<ICommentService>('comment-service');

/**
 * ============================================================================
 * Comment API Types
 * ============================================================================
 *
 * Naming convention (API contract layer):
 *
 * | API field        | DB column        | Frontend alias   | Description                        |
 * |------------------|------------------|------------------|------------------------------------|
 * | spreadsheetId    | spreadsheet_id   | containerId      | The sheet/table that owns the row   |
 * | rowId            | row_id           | targetId         | The record the comment is attached  |
 * | fieldId          | field_id         | targetFieldId    | Optional cell-level scope           |
 *
 * DB column names are intentionally kept as snake_case; the service layer maps
 * them to camelCase for API responses. Frontend composables may alias
 * `spreadsheetId` as `containerId` and `rowId` as `targetId` -- both refer to
 * the same underlying identifiers.
 *
 * Deprecated DB columns (exist in schema but unused in code):
 *   - target_type, target_id, target_field_id, container_type, container_id
 *   These were added by migration zzzz20260318123000_formalize_meta_comments
 *   but are NOT read or written anywhere. They are kept for migration safety
 *   and should NOT be used in new code.
 *
 * Mention parsing precedence:
 *   When creating or updating a comment, mentions can be supplied two ways:
 *   1. Explicit `mentions: string[]` array in the request body.
 *   2. Auto-parsed from `content` using the `@[Display Name](user-id)` format.
 *   If an explicit `mentions` array is provided, it takes precedence and
 *   content-based parsing is skipped entirely.
 * ============================================================================
 */

/** Options for querying comments within a spreadsheet. */
export interface CommentQueryOptions {
    /** Filter to a specific record (row). Alias: targetId on frontend. */
    rowId?: string;
    /** Filter to a specific cell field. */
    fieldId?: string;
    /** Filter by resolved status. */
    resolved?: boolean;
    /** Page size (clamped to 1..200, default 50). */
    limit?: number;
    /** Pagination offset (default 0). */
    offset?: number;
}

/**
 * Input for creating a new comment.
 *
 * Mention precedence: if `mentions` is provided, those user IDs are used
 * directly. Otherwise, mentions are auto-parsed from `content` using the
 * `@[Display Name](user-id)` format.
 */
export interface CommentCreateInput {
    /**
     * The spreadsheet/table ID that owns the target record.
     * @deprecated Prefer using `containerId` in frontend code; `spreadsheetId` is the canonical API name.
     */
    spreadsheetId: string;
    /**
     * The record (row) ID the comment is attached to.
     * @deprecated Prefer using `targetId` in frontend code; `rowId` is the canonical API name.
     */
    rowId: string;
    /** Optional cell-level field scope. */
    fieldId?: string;
    /** Comment body. May contain `@[Display Name](user-id)` mention tokens. */
    content: string;
    /** User ID of the comment author. */
    authorId: string;
    /** Parent comment ID for threading (replies). */
    parentId?: string;
    /**
     * Explicit mention list. When provided, takes precedence over auto-parsed
     * mentions from `content`.
     */
    mentions?: string[];
}

/**
 * Input for updating an existing comment.
 *
 * Mention precedence: if `mentions` is provided, those user IDs are used
 * directly. Otherwise, mentions are auto-parsed from `content`.
 */
export interface CommentUpdateInput {
    /** Updated comment body. */
    content: string;
    /**
     * Explicit mention list. When provided, takes precedence over auto-parsed
     * mentions from `content`.
     */
    mentions?: string[];
}

/** A single comment record as returned by the API. */
export interface CommentRecord {
    id: string;
    /**
     * The spreadsheet/table ID. Frontend may alias as `containerId`.
     * @deprecated Prefer `containerId` in frontend composables; `spreadsheetId` is the canonical API name.
     */
    spreadsheetId: string;
    /**
     * The record (row) ID. Frontend may alias as `targetId`.
     * @deprecated Prefer `targetId` in frontend composables; `rowId` is the canonical API name.
     */
    rowId: string;
    /** Optional cell-level field scope. */
    fieldId?: string;
    /** Comment body text. */
    content: string;
    /** Author user ID. */
    authorId: string;
    /** Parent comment ID if this is a reply. */
    parentId?: string;
    /** Whether this comment thread has been resolved. */
    resolved: boolean;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** ISO 8601 last-update timestamp. */
    updatedAt: string;
    /** User IDs mentioned in this comment. */
    mentions: string[];
}

/** An inbox entry extends CommentRecord with read/mention state and navigation context. */
export interface CommentInboxItem extends CommentRecord {
    /** True if the current user has NOT read this comment. */
    unread: boolean;
    /** True if the current user is mentioned in this comment. */
    mentioned: boolean;
    /** The base (workspace) ID for deep-link navigation. */
    baseId?: string | null;
    /** The sheet ID for deep-link navigation. */
    sheetId?: string | null;
    /** The default view ID for deep-link navigation. */
    viewId?: string | null;
    /** The record ID for deep-link navigation. */
    recordId?: string | null;
}

/** Per-row comment presence summary used by the sheet grid indicator. */
export interface CommentPresenceSummaryRecord {
    spreadsheetId: string;
    rowId: string;
    unresolvedCount: number;
    fieldCounts: Record<string, number>;
    mentionedCount: number;
    mentionedFieldCounts: Record<string, number>;
}

/** Per-row mention summary item. */
export interface CommentMentionSummaryItem {
    rowId: string;
    mentionedCount: number;
    unreadCount: number;
    mentionedFieldIds: string[];
}

/** Aggregated mention summary for a spreadsheet scoped to a single user. */
export interface CommentMentionSummary {
    spreadsheetId: string;
    unresolvedMentionCount: number;
    unreadMentionCount: number;
    mentionedRecordCount: number;
    unreadRecordCount: number;
    items: CommentMentionSummaryItem[];
}

/** A candidate user for @-mention autocomplete. */
export interface CommentMentionCandidate {
    id: string;
    label: string;
    subtitle?: string;
}

/**
 * Combined unread summary returned by `getUnreadSummary()`.
 *
 * - `unreadCount`: total comments the user has not read (regardless of mention).
 * - `mentionUnreadCount`: subset of unread comments where the user is explicitly mentioned.
 *
 * The general `unreadCount` drives the notification badge; `mentionUnreadCount`
 * drives the "mentions" tab indicator. These can differ because `getInbox()`
 * includes both no-read-record items AND mentioned items, while `getUnreadCount()`
 * historically only counted no-read-record items.
 */
export interface CommentUnreadSummary {
    /** Total unread comments (no read record, excluding own comments). */
    unreadCount: number;
    /** Unread comments where the user is explicitly @-mentioned. */
    mentionUnreadCount: number;
}

export interface ICommentService {
    /**
     * Create a comment.
     *
     * Mention precedence: if `data.mentions` is provided, those user IDs are
     * stored directly. Otherwise, mentions are auto-parsed from `data.content`
     * using the `@[Display Name](user-id)` format.
     */
    createComment(data: CommentCreateInput): Promise<CommentRecord>;
    /**
     * Update a comment's content and optionally its mentions.
     *
     * Mention precedence: if `data.mentions` is provided, those user IDs are
     * stored directly. Otherwise, mentions are auto-parsed from `data.content`.
     */
    updateComment(commentId: string, userId: string, data: CommentUpdateInput): Promise<CommentRecord>;
    deleteComment(commentId: string, userId: string): Promise<void>;
    getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: CommentRecord[]; total: number }>;
    listMentionCandidates(
      spreadsheetId: string,
      options?: { q?: string; limit?: number },
    ): Promise<{ items: CommentMentionCandidate[]; total: number }>;
    getInbox(userId: string, options?: Pick<CommentQueryOptions, 'limit' | 'offset'>): Promise<{ items: CommentInboxItem[]; total: number }>;
    /** @deprecated Use `getUnreadSummary()` for richer unread data. */
    getUnreadCount(userId: string): Promise<number>;
    /**
     * Return combined unread summary with both general unread count
     * and mention-specific unread count in a single call.
     */
    getUnreadSummary(userId: string): Promise<CommentUnreadSummary>;
    markCommentRead(commentId: string, userId: string): Promise<void>;
    getCommentPresenceSummary(
      spreadsheetId: string,
      rowIds?: string[],
      mentionUserId?: string,
    ): Promise<{ items: CommentPresenceSummaryRecord[]; total: number }>;
    getMentionSummary(spreadsheetId: string, mentionUserId: string): Promise<CommentMentionSummary>;
    markMentionsRead(spreadsheetId: string, userId: string): Promise<void>;
    resolveComment(commentId: string): Promise<void>;
}

export interface IPresenceService {
    // Methods if needed public
}

export interface IDashboardService {
    createDashboard(name: string, ownerId: string, description?: string): Promise<unknown>;
    getDashboard(id: string): Promise<unknown | null>;
    addWidget(dashboardId: string, widgetConfig: Record<string, unknown>): Promise<unknown>;
}

export interface IConditionalFormattingService {
    addRule(spreadsheetId: string, rule: Record<string, unknown>): void;
    getCellStyle(spreadsheetId: string, row: number, col: number, value: unknown): unknown;
}

export interface IAutomationService {
    registerTrigger(trigger: Record<string, unknown>): void;
}

export interface IViewService {
    getViewData(
      spreadsheetId: string,
      options: { filter?: Record<string, unknown>; sort?: Record<string, unknown> },
    ): Promise<{ rows: Record<string, unknown>[]; total: number }>;
}

export interface ISpreadsheetService {
    updateCell(
      userId: string,
      role: string,
      spreadsheetId: string,
      recordId: string | number,
      fieldId: string,
      rawValue: unknown,
    ): Promise<{ success: boolean; value?: unknown; error?: string; computed?: unknown }>;
}

export interface IHistoryService {
  pushUndoRedo(item: unknown): void;
  undo(unitId: string): unknown;
  redo(unitId: string): unknown;
  getStatus(unitId: string): { undos: number; redos: number };
}


export interface IAccessControlService {
  can(role: string | string[], resource: string, action: string): boolean;
  defineRole(options: Record<string, unknown>): void;
}


export interface IFormulaService {
  calculate(functionName: string, ...args: unknown[]): unknown;
  calculateFormula(expression: string, contextResolver?: (key: string) => unknown): unknown;
  getAvailableFunctions(): string[];
}
