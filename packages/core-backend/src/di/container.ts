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

type StubImplementation = 'stub'

class AdapterStub {
  readonly implementation: StubImplementation = 'stub'
  private connected = false

  constructor(
    readonly adapterId: string,
    readonly supportedOperations: string[],
  ) {}

  isConnected() { return this.connected }
  isConfigured() { return false }
  async connect() { this.connected = false }
  async disconnect() { this.connected = false }
  async healthCheck() { return false }

  getRuntimeStatus() {
    return {
      id: this.adapterId,
      implementation: this.implementation,
      configured: this.isConfigured(),
      connected: this.isConnected(),
      healthSupported: true,
      supportedOperations: [...this.supportedOperations],
    }
  }

  async getProducts() { return { data: [], metadata: { totalCount: 0 } } }
  async getProductBOM() { return { data: [], metadata: { totalCount: 0 } } }
  async getProductById() { return null }
  async listFolders() { return [] }
  async searchDocuments() { return { data: [], metadata: { totalCount: 0 } } }
  async getDocument() { return null }
  async uploadDocument() { return null }
  async getVersionHistory() { return { data: [], metadata: { totalCount: 0 } } }
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

  const athenaStub = new AdapterStub('athena', ['documents', 'search', 'preview', 'versions', 'workflow', 'collaboration'])
  const dedupStub = new AdapterStub('dedup-cad', ['compare', 'generateDiff'])
  const cadMlStub = new AdapterStub('cad-ml', ['analyze', 'predictCost'])
  const visionStub = new AdapterStub('vision', ['extractText'])
  injector.add([
    IPLMAdapter,
    {
      useFactory: (config: IConfigService, logger: ILogger) => new PLMAdapter(config, logger),
      deps: [IConfigService, ILogger],
    },
  ])
  injector.add([IAthenaAdapter, { useValue: athenaStub }])
  injector.add([IDedupCADAdapter, { useValue: dedupStub }])
  injector.add([ICADMLAdapter, { useValue: cadMlStub }])
  injector.add([IVisionAdapter, { useValue: visionStub }])

  return injector
}
