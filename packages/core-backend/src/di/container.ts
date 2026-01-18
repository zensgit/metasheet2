import { Injector } from '@wendellhu/redi'
import { IConfigService, ILogger, ICollabService, ICollectionManager, ICoreAPI, IPluginLoader, IPLMAdapter, IAthenaAdapter, IDedupCADAdapter, ICADMLAdapter, IVisionAdapter, IFormulaService, ICommentService } from './identifiers'
import { ConfigService } from '../services/ConfigService'
import { Logger } from '../core/logger'
import { CollabService } from '../services/CollabService'
import { eventBus } from '../integration/events/event-bus'
import { CollectionManager } from '../core/database/CollectionManager'
import { PluginLoader } from '../core/plugin-loader'
import { PLMAdapter } from '../data-adapters/PLMAdapter'
import { FormulaService } from '../services/FormulaService'
import { CommentService } from '../services/CommentService'
import type { CoreAPI } from '../types/plugin'

export interface ContainerOptions {
  pluginDirs?: string[]
}

class AdapterStub {
  async getProducts() { return [] }
  async getProductBOM() { return [] }
  async listFolders() { return [] }
  async searchDocuments() { return [] }
  async getDocument() { return null }
  async uploadDocument() { return null }
  async search() { return [] }
  async compare() { return null }
  async analyze() { return null }
  async extractText() { return null }
  async predictCost() { return null }
  async generateDiff() { return null }
}

export function createContainer(options: ContainerOptions = {}): Injector {
  const injector = new Injector()

  injector.add([IConfigService, { useFactory: () => ConfigService.getInstance() }])
  injector.add([ILogger, { useFactory: () => new Logger('System') }])

  injector.add([
    ICollabService,
    {
      useFactory: (logger: Logger) => new CollabService(logger, eventBus),
      deps: [ILogger],
    },
  ])

  injector.add([ICollectionManager, { useClass: CollectionManager }])
  injector.add([IFormulaService, { useClass: FormulaService }])
  injector.add([
    ICommentService,
    {
      useFactory: (collabService: CollabService, logger: Logger) => new CommentService(collabService, logger),
      deps: [ICollabService, ILogger],
    },
  ])

  injector.add([
    IPluginLoader,
    {
      useFactory: (coreAPI: CoreAPI) => new PluginLoader(
        coreAPI,
        options.pluginDirs ? { pluginDirs: options.pluginDirs } : undefined,
      ),
      deps: [ICoreAPI],
    },
  ])

  const adapterStub = new AdapterStub()
  injector.add([
    IPLMAdapter,
    {
      useFactory: (config: IConfigService, logger: ILogger) => new PLMAdapter(config, logger),
      deps: [IConfigService, ILogger],
    },
  ])
  injector.add([IAthenaAdapter, { useValue: adapterStub }])
  injector.add([IDedupCADAdapter, { useValue: adapterStub }])
  injector.add([ICADMLAdapter, { useValue: adapterStub }])
  injector.add([IVisionAdapter, { useValue: adapterStub }])

  return injector
}
