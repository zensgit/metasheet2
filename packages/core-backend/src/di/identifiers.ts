import { createIdentifier } from '@wendellhu/redi';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import type { ConfigValue } from '../services/ConfigService';
import type { CollectionDefinition } from '../types/collection';
import type { Repository } from '../core/database/Repository';
import type { PluginLoader } from '../core/plugin-loader';
import type { AiApi, AthenaApi, CoreAPI, DedupApi, FormulaAPI, PLMApi, VisionApi } from '../types/plugin';

/**
 * Service Identifiers
 * 用于 IoC 容器中的依赖注入
 */

// 核心服务
export const IConfigService = createIdentifier<IConfigService>('config-service');
export const ILogger = createIdentifier<ILogger>('logger');
export const IPluginLoader = createIdentifier<PluginLoader>('plugin-loader');
export const IMessageBus = createIdentifier<unknown>('message-bus'); // 暂时使用 unknown
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
 

export const IPLMAdapter = createIdentifier<PLMApi>('plm-adapter');
export const IAthenaAdapter = createIdentifier<AthenaApi>('athena-adapter');
export const IDedupCADAdapter = createIdentifier<DedupApi>('dedup-cad-adapter');
export const ICADMLAdapter = createIdentifier<AiApi>('cad-ml-adapter');
export const IVisionAdapter = createIdentifier<VisionApi>('vision-adapter');
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

export interface CommentPayload {
  [key: string]: unknown;
}

export interface ICommentService {
    createComment(data: CommentPayload): Promise<CommentPayload>;
    getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: CommentPayload[]; total: number }>;
    resolveComment(commentId: string): Promise<void>;
}

export interface IPresenceService {
    // Methods if needed public
}

export interface IDashboardService {
    createDashboard(name: string, ownerId: string, description?: string): Promise<Record<string, unknown>>;
    getDashboard(id: string): Promise<Record<string, unknown> | null>;
    addWidget(dashboardId: string, widgetConfig: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface IConditionalFormattingService {
    addRule(spreadsheetId: string, rule: Record<string, unknown>): void;
    getCellStyle(spreadsheetId: string, row: number, col: number, value: unknown): unknown;
}

export interface IAutomationService {
    registerTrigger(trigger: Record<string, unknown>): void;
}

export interface IViewService {
    getViewData(spreadsheetId: string, options: { filter?: unknown; sort?: unknown }): Promise<{ rows: Record<string, unknown>[]; total: number }>;
}

export interface ISpreadsheetService {
    updateCell(userId: string, role: string, spreadsheetId: string, recordId: string | number, fieldId: string, rawValue: unknown): Promise<{ success: boolean; value?: unknown; error?: string; computed?: unknown }>;
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


export interface IFormulaService extends FormulaAPI {}
