import { createIdentifier } from '@wendellhu/redi';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import type { AthenaDocument, DocumentVersion } from '../data-adapters/AthenaAdapter';
import type { QueryResult } from '../data-adapters/BaseAdapter';
import type { ApprovalHistoryEntry, ApprovalRequest, BOMItem, PLMProduct } from '../data-adapters/PLMAdapter';
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

export interface CommentQueryOptions {
    rowId?: string;
    resolved?: boolean;
    limit?: number;
    offset?: number;
}

export interface CommentCreateInput {
    spreadsheetId: string;
    rowId: string;
    fieldId?: string;
    content: string;
    authorId: string;
    parentId?: string;
    mentions?: string[];
}

export interface CommentUpdateInput {
    content: string;
    mentions?: string[];
}

export interface CommentRecord {
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

export interface CommentInboxItem extends CommentRecord {
    unread: boolean;
    mentioned: boolean;
    baseId?: string | null;
    sheetId?: string | null;
    viewId?: string | null;
    recordId?: string | null;
}

export interface CommentPresenceSummaryRecord {
    spreadsheetId: string;
    rowId: string;
    unresolvedCount: number;
    fieldCounts: Record<string, number>;
    mentionedCount: number;
    mentionedFieldCounts: Record<string, number>;
}

export interface CommentMentionSummaryItem {
    rowId: string;
    mentionedCount: number;
    unreadCount: number;
    mentionedFieldIds: string[];
}

export interface CommentMentionSummary {
    spreadsheetId: string;
    unresolvedMentionCount: number;
    unreadMentionCount: number;
    mentionedRecordCount: number;
    unreadRecordCount: number;
    items: CommentMentionSummaryItem[];
}

export interface CommentMentionCandidate {
    id: string;
    label: string;
    subtitle?: string;
}

export interface ICommentService {
    createComment(data: CommentCreateInput): Promise<CommentRecord>;
    updateComment(commentId: string, userId: string, data: CommentUpdateInput): Promise<CommentRecord>;
    deleteComment(commentId: string, userId: string): Promise<void>;
    getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: CommentRecord[]; total: number }>;
    listMentionCandidates(
      spreadsheetId: string,
      options?: { q?: string; limit?: number },
    ): Promise<{ items: CommentMentionCandidate[]; total: number }>;
    getInbox(userId: string, options?: Pick<CommentQueryOptions, 'limit' | 'offset'>): Promise<{ items: CommentInboxItem[]; total: number }>;
    getUnreadCount(userId: string): Promise<number>;
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
