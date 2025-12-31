import { Injector } from '@wendellhu/redi';
import { IConfigService, ILogger, ICollabService, ICollectionManager, ICoreAPI, IPluginLoader, IPLMAdapter, IAthenaAdapter, IDedupCADAdapter, ICADMLAdapter, IVisionAdapter, IFormulaService, IAccessControlService, IHistoryService, ISpreadsheetService, IViewService, IAutomationService, IConditionalFormattingService, IDashboardService, IPresenceService, ICommentService } from './identifiers';
import { ConfigService } from '../services/ConfigService';
import { CollabService } from '../services/CollabService';
import { CollectionManager } from '../core/database/CollectionManager';
import { PluginLoader } from '../core/plugin-loader';
import { PLMAdapter } from '../data-adapters/PLMAdapter';
import { AthenaAdapter } from '../data-adapters/AthenaAdapter';
import { DedupCADAdapter } from '../data-adapters/DedupCADAdapter';
import { CADMLAdapter } from '../data-adapters/CADMLAdapter';
import { VisionAdapter } from '../data-adapters/VisionAdapter';
import { FormulaService } from '../services/FormulaService';
import { AccessControlService } from '../services/AccessControlService';
import { HistoryService } from '../services/HistoryService';
import { SpreadsheetService } from '../services/SpreadsheetService';
import { ViewService } from '../services/ViewService';
import { AutomationService } from '../libs/automation/AutomationService';
import { ConditionalFormattingService } from '../services/ConditionalFormattingService';
import { DashboardService } from '../services/DashboardService';
import { PresenceService } from '../services/PresenceService';
import { CommentService } from '../services/CommentService';
import { EventBus, eventBus } from '../events/EventBus';
import { Logger } from '../core/logger';
import type { CoreAPI } from '../types/plugin';

export interface ContainerOptions {
  pluginDirs?: string[]
}

/**
 * IoC 容器工厂
 * 用于创建和配置依赖注入容器
 */
export function createContainer(options: ContainerOptions = {}): Injector {
  const injector = new Injector();

  // 绑定 ConfigService
  // ConfigService 是单例的，并且目前的设计是 ConfigService.getInstance()
  // 我们可以适配它，或者直接使用类绑定（如果构造函数无参数且适用）
  injector.add([IConfigService, { useFactory: () => ConfigService.getInstance() }]);

  // 绑定 Logger
  // Logger 需要 context，我们这里绑定一个默认的 System Logger
  injector.add([ILogger, { useFactory: () => new Logger('System') }]);

  // 绑定 EventBus (Singleton)
  injector.add([EventBus, { useValue: eventBus }]);

  // 绑定 CollabService
  injector.add([ICollabService, {
    useFactory: (logger: Logger, eventBus: EventBus) => new CollabService(logger, eventBus),
    deps: [ILogger, EventBus]
  }]);

  // 绑定 CollectionManager
  injector.add([ICollectionManager, { useClass: CollectionManager }]);

  // 绑定 PluginLoader
  injector.add([IPluginLoader, {
    useFactory: (coreAPI: CoreAPI) => new PluginLoader(
      coreAPI,
      options.pluginDirs ? { pluginDirs: options.pluginDirs } : undefined,
    ),
    deps: [ICoreAPI],
  }]);

  // 绑定 PLMAdapter
  injector.add([IPLMAdapter, {
    useFactory: (config: IConfigService, logger: ILogger) => new PLMAdapter(config, logger),
    deps: [IConfigService, ILogger],
  }]);

  // 绑定 AthenaAdapter
  injector.add([IAthenaAdapter, {
    useFactory: (config: IConfigService, logger: ILogger) => new AthenaAdapter(config, logger),
    deps: [IConfigService, ILogger],
  }]);

  // 绑定 DedupCADAdapter
  injector.add([IDedupCADAdapter, {
    useFactory: (config: IConfigService, logger: ILogger) => new DedupCADAdapter(config, logger),
    deps: [IConfigService, ILogger],
  }]);

  // 绑定 CADMLAdapter
  injector.add([ICADMLAdapter, {
    useFactory: (config: IConfigService, logger: ILogger) => new CADMLAdapter(config, logger),
    deps: [IConfigService, ILogger],
  }]);

  // 绑定 VisionAdapter
  injector.add([IVisionAdapter, {
    useFactory: (config: IConfigService, logger: ILogger) => new VisionAdapter(config, logger),
    deps: [IConfigService, ILogger],
  }]);

  // 绑定 FormulaService
  injector.add([IFormulaService, { useClass: FormulaService }]);

  // 绑定 AccessControlService
  injector.add([IAccessControlService, { useClass: AccessControlService }]);

  // 绑定 HistoryService
  injector.add([IHistoryService, { useClass: HistoryService }]);

  // 绑定 SpreadsheetService
  injector.add([ISpreadsheetService, {
    useFactory: (acl: AccessControlService, formula: FormulaService, history: HistoryService, collections: CollectionManager, eventBus: EventBus) => {
      return new SpreadsheetService(acl, formula, history, collections, eventBus);
    },
    deps: [IAccessControlService, IFormulaService, IHistoryService, ICollectionManager, EventBus]
  }]);

  // 绑定 ViewService
  injector.add([IViewService, {
    useFactory: (collections: CollectionManager) => new ViewService(collections),
    deps: [ICollectionManager]
  }]);

  // 绑定 AutomationService
  injector.add([IAutomationService, { useClass: AutomationService }]);

  // 绑定 ConditionalFormattingService
  injector.add([IConditionalFormattingService, { useClass: ConditionalFormattingService }]);

  // 绑定 DashboardService
  injector.add([IDashboardService, { useClass: DashboardService }]);

  // 绑定 PresenceService
  injector.add([IPresenceService, { useClass: PresenceService }]);

  // 绑定 CommentService
  injector.add([ICommentService, {
    useFactory: (collab: CollabService, logger: Logger) => new CommentService(collab, logger),
    deps: [ICollabService, ILogger]
  }]);

  return injector;
}
