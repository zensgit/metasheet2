import { createIdentifier } from '@wendellhu/redi';
import { ConfigValue } from '../services/ConfigService';
import { CollectionDefinition } from '../types/collection';
import { Repository } from '../core/database/Repository';
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
export const IMessageBus = createIdentifier<any>('message-bus'); // 暂时使用 any
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
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

export interface ICollabService {
  initialize(httpServer: any): void; // Using any for HttpServer to avoid direct dependency import in identifiers for now
  broadcast(event: string, data: unknown): void;
  broadcastTo(room: string, event: string, data: unknown): void;
  sendTo(userId: string, event: string, data: unknown): void;
  joinRoom(room: string, userId: string): void;
  close(): Promise<void>;
  onConnection(handler: (socket: any) => void): void;
}

export interface ICollectionManager {
  register(definition: CollectionDefinition): void;
  getDefinition(sheetId: string): Promise<CollectionDefinition | null>;
  getRepository(name: string): Repository;
  sync(): Promise<void>;
}
 

export const IPLMAdapter = createIdentifier<any>('plm-adapter');
export const IAthenaAdapter = createIdentifier<any>('athena-adapter');
export const IDedupCADAdapter = createIdentifier<any>('dedup-cad-adapter');
export const ICADMLAdapter = createIdentifier<any>('cad-ml-adapter');
export const IVisionAdapter = createIdentifier<any>('vision-adapter');
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

export interface ICommentService {
    createComment(data: any): Promise<any>;
    getComments(spreadsheetId: string, options?: CommentQueryOptions): Promise<{ items: any[]; total: number }>;
    resolveComment(commentId: string): Promise<void>;
}

export interface IPresenceService {
    // Methods if needed public
}

export interface IDashboardService {
    createDashboard(name: string, ownerId: string, description?: string): Promise<any>;
    getDashboard(id: string): Promise<any | null>;
    addWidget(dashboardId: string, widgetConfig: any): Promise<any>;
}

export interface IConditionalFormattingService {
    addRule(spreadsheetId: string, rule: any): void;
    getCellStyle(spreadsheetId: string, row: number, col: number, value: any): any;
}

export interface IAutomationService {
    registerTrigger(trigger: any): void;
}

export interface IViewService {
    getViewData(spreadsheetId: string, options: { filter?: any; sort?: any }): Promise<{ rows: any[]; total: number }>;
}

export interface ISpreadsheetService {
    updateCell(userId: string, role: string, spreadsheetId: string, recordId: string | number, fieldId: string, rawValue: any): Promise<{ success: boolean; value?: any; error?: string; computed?: any }>;
}

export interface IHistoryService {
  pushUndoRedo(item: any): void;
  undo(unitId: string): any;
  redo(unitId: string): any;
  getStatus(unitId: string): { undos: number; redos: number };
}


export interface IAccessControlService {
  can(role: string | string[], resource: string, action: string): boolean;
  defineRole(options: any): void;
}


export interface IFormulaService {
  calculate(functionName: string, ...args: any[]): any;
  calculateFormula(expression: string, contextResolver?: (key: string) => any): any;
  getAvailableFunctions(): string[];
}
