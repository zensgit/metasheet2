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
  async getProductDocuments() { return { data: [], metadata: { totalCount: 0 } } }
  async getApprovals() { return { data: [], metadata: { totalCount: 0 } } }
  async getApprovalHistory() { return { data: [], metadata: { totalCount: 0 } } }
  async getWhereUsed(itemId = '') { return { data: [{ item_id: itemId, count: 0, parents: [] }], metadata: { totalCount: 0 } } }
  async getBomCompareSchema() { return { data: [{ line_fields: [], compare_modes: [], line_key_options: [], defaults: {} }], metadata: { totalCount: 1 } } }
  async getBomCompare() {
    return {
      data: [{
        summary: { added: 0, removed: 0, changed: 0, changed_major: 0, changed_minor: 0, changed_info: 0 },
        added: [],
        removed: [],
        changed: [],
      }],
      metadata: { totalCount: 1 },
    }
  }
  async getBomSubstitutes(bomLineId = '') {
    return { data: [{ bom_line_id: bomLineId, count: 0, substitutes: [] }], metadata: { totalCount: 0 } }
  }
  async addBomSubstitute(_bomLineId = '', _substituteItemId = '') {
    return { data: [{ ok: true, substitute_id: '', bom_line_id: '', substitute_item_id: '' }], metadata: { totalCount: 1 } }
  }
  async removeBomSubstitute(_bomLineId = '', substituteId = '') {
    return { data: [{ ok: true, substitute_id: substituteId }], metadata: { totalCount: 1 } }
  }
  async approveApproval(approvalId = '', version = 0) { return { data: [{ id: approvalId, version }], metadata: { totalCount: 1 } } }
  async rejectApproval(approvalId = '', version = 0) { return { data: [{ id: approvalId, version }], metadata: { totalCount: 1 } } }
  async getCadProperties(fileId = '') { return { data: [{ file_id: fileId, properties: {} }], metadata: { totalCount: 1 } } }
  async getCadViewState(fileId = '') { return { data: [{ file_id: fileId, hidden_entity_ids: [], notes: [] }], metadata: { totalCount: 1 } } }
  async getCadReview(fileId = '') { return { data: [{ file_id: fileId, state: null }], metadata: { totalCount: 1 } } }
  async getCadHistory(fileId = '') { return { data: [{ file_id: fileId, entries: [] }], metadata: { totalCount: 1 } } }
  async getCadDiff(fileId = '', otherFileId = '') {
    return { data: [{ file_id: fileId, other_file_id: otherFileId, properties: {}, cad_document_schema_version: {} }], metadata: { totalCount: 1 } }
  }
  async getCadMeshStats(fileId = '') { return { data: [{ file_id: fileId, stats: {} }], metadata: { totalCount: 1 } } }
  async updateCadProperties(fileId = '') { return { data: [{ file_id: fileId, properties: {} }], metadata: { totalCount: 1 } } }
  async updateCadViewState(fileId = '') { return { data: [{ file_id: fileId, hidden_entity_ids: [], notes: [] }], metadata: { totalCount: 1 } } }
  async updateCadReview(fileId = '') { return { data: [{ file_id: fileId, state: null }], metadata: { totalCount: 1 } } }
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
