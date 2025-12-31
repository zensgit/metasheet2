import { Inject, Optional } from '@wendellhu/redi'
import { IConfigService, ILogger } from '../di/identifiers'
import { HTTPAdapter } from './HTTPAdapter'
import { QueryResult, DataSourceConfig } from './BaseAdapter'

export interface PLMProduct {
  id: string
  name: string
  code: string
  version: string
  status: string
  description?: string
  itemType?: string
  properties?: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface PLMProductRaw {
  id: number
  name: string
  internal_reference?: string
  code?: string
  version?: string
  engineering_state?: string
  status?: string
  description?: string
  created_at?: string
  updated_at?: string
  create_date?: string
  write_date?: string
}

export interface PLMQueryOptions {
  limit?: number
  offset?: number
  status?: string
  search?: string
  itemType?: string
}

export interface ApprovalRequest {
  id: string
  request_type: string
  title: string
  requester_id: string
  requester_name: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  product_id?: string
  product_name?: string
}

export interface ApprovalRecord {
  id: string
  request_id: string
  approver_id: string
  approver_name: string
  action: 'approve' | 'reject'
  comment?: string
  created_at: string
}

export interface ApprovalQueryOptions {
  status?: string
  limit?: number
  offset?: number
}

export interface PLMDrawing {
  id: string
  product_id: string
  file_name: string
  file_size: number
  file_path: string
  version: string
  uploaded_by: string
  uploaded_at: string
  metadata?: Record<string, unknown>
}

export interface SimilarityResult {
  drawing_id: string
  similar_drawings: Array<{
    id: string
    file_name: string
    similarity_score: number
    product_id: string
    product_name: string
  }>
}

export interface BOMItem {
  id: string
  product_id: string
  parent_item_id?: string
  component_id: string
  component_name: string
  component_code: string
  quantity: number
  unit: string
  level: number
  sequence: number
  created_at: string
  updated_at: string
}

export interface BOMCompareParams {
  leftId: string
  rightId: string
  leftType?: 'item' | 'version'
  rightType?: 'item' | 'version'
  maxLevels?: number
  lineKey?: string
  compareMode?: string
  includeSubstitutes?: boolean
  includeEffectivity?: boolean
  includeRelationshipProps?: string[]
  effectiveAt?: string
}

export interface BOMCompareSummary {
  added: number
  removed: number
  changed: number
  changed_major?: number
  changed_minor?: number
  changed_info?: number
}

export interface BOMCompareFieldDiff {
  field: string
  left?: unknown
  right?: unknown
  normalized_left?: unknown
  normalized_right?: unknown
  severity?: string
}

export interface BOMCompareEntry {
  parent_id?: string
  child_id?: string
  relationship_id?: string
  line_key?: string
  parent_config_id?: string
  child_config_id?: string
  level?: number
  path?: Array<Record<string, unknown>>
  properties?: Record<string, unknown>
  parent?: Record<string, unknown>
  child?: Record<string, unknown>
}

export interface BOMCompareChangedEntry extends BOMCompareEntry {
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  changes?: BOMCompareFieldDiff[]
  severity?: string
}

export interface BOMCompareResponse {
  summary: BOMCompareSummary
  added: BOMCompareEntry[]
  removed: BOMCompareEntry[]
  changed: BOMCompareChangedEntry[]
}

export interface WhereUsedEntry {
  relationship: Record<string, unknown>
  parent: Record<string, unknown>
  level: number
}

export interface WhereUsedResponse {
  item_id: string
  count: number
  parents: WhereUsedEntry[]
}

export interface BOMSubstituteEntry {
  id: string
  relationship?: Record<string, unknown>
  part?: Record<string, unknown>
  substitute_part?: Record<string, unknown>
  rank?: string | number | null
}

export interface BOMSubstitutesResponse {
  bom_line_id: string
  count: number
  substitutes: BOMSubstituteEntry[]
}

export interface PLMDocument {
  id: string
  name: string
  engineering_code?: string
  engineering_revision?: string
  document_type: string
  description?: string
  engineering_state: string
  file_size?: number
  mime_type?: string
  is_production_doc?: boolean
  created_at: string
  updated_at: string
}

interface PLMDocumentRaw {
  id: number
  name: string
  engineering_code?: string
  engineering_revision?: string
  document_type?: string
  description?: string
  engineering_state?: string
  file_size?: number
  mime_type?: string
  is_production_doc?: boolean
  created_at?: string
  updated_at?: string
  create_date?: string
  write_date?: string
}

type PLMApiMode = 'legacy' | 'yuantus'

interface YuantusSearchHit {
  id: string
  item_type_id?: string
  config_id?: string
  state?: string
  item_number?: string
  name?: string
  description?: string
  created_at?: string
  updated_at?: string
  properties?: Record<string, unknown>
}

interface YuantusSearchResponse {
  total?: number
  hits?: YuantusSearchHit[]
}

interface YuantusItem {
  id: string
  type?: string
  state?: string
  created_on?: string
  modified_on?: string
  properties?: Record<string, unknown>
}

interface YuantusBomNode {
  id: string
  item_number?: string
  name?: string
  state?: string
  created_on?: string
  modified_on?: string
  properties?: Record<string, unknown>
  children?: YuantusBomChild[]
}

interface YuantusBomRelationship {
  id?: string
  source_id?: string
  related_id?: string
  quantity?: number
  uom?: string
  find_num?: string | number
  refdes?: string
  created_on?: string
  modified_on?: string
  properties?: Record<string, unknown>
}

interface YuantusBomChild {
  child: YuantusBomNode
  relationship: YuantusBomRelationship
}

export class PLMAdapter extends HTTPAdapter {
  private mockMode = false;
  private apiMode: PLMApiMode = 'legacy';
  private authToken: string | null = null;
  private authTokenExpiresAt = 0;
  private authTokenPromise: Promise<string | null> | null = null;
  private authBufferMs = 60_000;
  private yuantusItemType = 'Part';
  private yuantusCredentials: {
    username: string;
    password: string;
    tenantId?: string;
    orgId?: string;
  } | null = null;

  static inject = [IConfigService, ILogger, [new Optional(), 'plm_config']];

  constructor(
    private configService: IConfigService,
    private logger: ILogger,
    config?: DataSourceConfig
  ) {
    super(config || {
      id: 'plm',
      name: 'PLM Adapter',
      type: 'plm',
      connection: { url: 'http://localhost:8001' }
    });
  }

  async connect(): Promise<void> {
    const envBaseUrl = process.env.PLM_BASE_URL || process.env.PLM_URL
    const envToken = process.env.PLM_API_TOKEN || process.env.PLM_AUTH_TOKEN || process.env.PLM_TOKEN
    const envApiKey = process.env.PLM_API_KEY || process.env.PLM_KEY
    const envApiMode = process.env.PLM_API_MODE
    const envTenantId = process.env.PLM_TENANT_ID
    const envOrgId = process.env.PLM_ORG_ID
    const envUsername = process.env.PLM_USERNAME
    const envPassword = process.env.PLM_PASSWORD
    const envItemType = process.env.PLM_ITEM_TYPE

    const plmUrl = await this.configService.get<string>('plm.url')
    const apiMode = (await this.configService.get<string>('plm.apiMode')) || envApiMode
    const tenantId = (await this.configService.get<string>('plm.tenantId')) || envTenantId
    const orgId = (await this.configService.get<string>('plm.orgId')) || envOrgId
    const username = (await this.configService.get<string>('plm.username')) || envUsername
    const password = (await this.configService.get<string>('plm.password')) || envPassword
    const apiKey = (await this.configService.get<string>('plm.apiKey')) || envApiKey
    const itemType = (await this.configService.get<string>('plm.itemType'))
      || (typeof this.config.options?.itemType === 'string' ? this.config.options.itemType : undefined)
      || envItemType
    const token = (
      (await this.configService.get<string>('plm.apiToken')) ||
      (await this.configService.get<string>('plm.token')) ||
      (await this.configService.get<string>('plm.authToken')) ||
      envToken
    )
    const resolvedUrl = plmUrl || envBaseUrl
    const mockSetting = await this.configService.get<boolean>('plm.mock')
    const isMock = typeof mockSetting === 'boolean' ? mockSetting : !resolvedUrl

    if (resolvedUrl) {
      this.config.connection.url = resolvedUrl;
      // Also update baseURL for axios client if it's already created (though connect calls create)
      this.config.connection.baseURL = resolvedUrl;
    }

    if (token) {
      const headers = (this.config.connection.headers as Record<string, string> | undefined) || {}
      delete headers.authorization
      headers.Authorization = `Bearer ${token}`
      this.config.connection.headers = headers
      this.cacheAuthToken(token)
    }

    if (apiKey) {
      const credentials = (this.config.credentials as Record<string, string> | undefined) || {}
      credentials.apiKey = apiKey
      this.config.credentials = credentials
    }

    this.mockMode = isMock;
    this.apiMode = this.resolveApiMode(
      apiMode || (typeof this.config.options?.apiMode === 'string' ? this.config.options.apiMode : undefined),
      this.config.connection.headers as Record<string, string> | undefined,
      tenantId || (typeof this.config.options?.tenantId === 'string' ? this.config.options.tenantId : undefined),
      orgId || (typeof this.config.options?.orgId === 'string' ? this.config.options.orgId : undefined)
    );
    this.applyTenantOrgHeaders(
      tenantId || (typeof this.config.options?.tenantId === 'string' ? this.config.options.tenantId : undefined),
      orgId || (typeof this.config.options?.orgId === 'string' ? this.config.options.orgId : undefined)
    );
    this.yuantusCredentials = username && password
      ? { username, password, tenantId: tenantId || undefined, orgId: orgId || undefined }
      : null;
    if (itemType) {
      this.yuantusItemType = itemType
    }

    if (this.apiMode === 'yuantus' && (this.authToken || this.yuantusCredentials)) {
      this.setTokenProvider({
        getToken: async () => this.getYuantusToken(),
        onAuthError: () => this.invalidateAuthToken(),
      });
    }

    if (this.mockMode) {
      this.logger.info('PLM Adapter starting in MOCK mode');
      this.connected = true;
      // Emit connect event
      this.onConnect();
      return;
    }

    this.logger.info(`PLM Adapter connecting to ${this.config.connection.url}`);
    await super.connect();
  }

  private withTrailingSlash(path: string): string {
    return path.endsWith('/') ? path : `${path}/`
  }

  private resolveApiMode(
    value?: string,
    headers?: Record<string, string>,
    tenantId?: string,
    orgId?: string
  ): PLMApiMode {
    const normalized = (value || '').toLowerCase()
    if (normalized === 'yuantus' || normalized === 'v1') {
      return 'yuantus'
    }
    if (normalized === 'legacy' || normalized === 'v0') {
      return 'legacy'
    }
    if (tenantId || orgId) {
      return 'yuantus'
    }
    if (headers && (headers['x-tenant-id'] || headers['x-org-id'])) {
      return 'yuantus'
    }
    return 'legacy'
  }

  private applyTenantOrgHeaders(tenantId?: string, orgId?: string): void {
    if (!tenantId && !orgId) {
      return
    }
    const headers = (this.config.connection.headers as Record<string, string> | undefined) || {}
    let updated = false
    if (tenantId && !headers['x-tenant-id']) {
      headers['x-tenant-id'] = tenantId
      updated = true
    }
    if (orgId && !headers['x-org-id']) {
      headers['x-org-id'] = orgId
      updated = true
    }
    if (updated) {
      this.config.connection.headers = headers
    }
  }

  private cacheAuthToken(token: string): void {
    this.authToken = token
    this.authTokenExpiresAt = this.getTokenExpiry(token)
  }

  private invalidateAuthToken(): void {
    this.authToken = null
    this.authTokenExpiresAt = 0
  }

  private getTokenExpiry(token: string): number {
    try {
      const payload = token.split('.')[1]
      if (!payload) {
        return Date.now() + 55 * 60 * 1000
      }
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp?: number }
      if (decoded.exp) {
        return decoded.exp * 1000
      }
    } catch (_err) {
      // ignore parse errors
    }
    return Date.now() + 55 * 60 * 1000
  }

  private async getYuantusToken(): Promise<string | null> {
    if (this.authToken && this.authTokenExpiresAt > Date.now() + this.authBufferMs) {
      return this.authToken
    }
    if (!this.yuantusCredentials) {
      return this.authToken
    }
    if (this.authTokenPromise) {
      return this.authTokenPromise
    }

    this.authTokenPromise = this.fetchYuantusToken()
    try {
      return await this.authTokenPromise
    } finally {
      this.authTokenPromise = null
    }
  }

  private async fetchYuantusToken(): Promise<string | null> {
    const baseUrl = this.config.connection.baseURL || this.config.connection.url
    if (!baseUrl) return null
    const { username, password, tenantId, orgId } = this.yuantusCredentials || {}
    if (!username || !password) return null

    const payload: Record<string, string> = { username, password }
    if (tenantId) payload.tenant_id = tenantId
    if (orgId) payload.org_id = orgId

    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
          ...(orgId ? { 'x-org-id': orgId } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        return null
      }
      const data = (await response.json()) as { access_token?: string }
      if (data?.access_token) {
        this.cacheAuthToken(data.access_token)
        return data.access_token
      }
      return null
    } catch (_err) {
      return null
    }
  }

  private productsPath(): string { return this.withTrailingSlash('/api/products') }
  private bomsPath(): string { return this.withTrailingSlash('/api/boms') }
  private approvalRequestsPath(): string { return this.withTrailingSlash('/api/approval/requests') }
  private documentsPath(): string { return this.withTrailingSlash('/api/documents') }
  private drawingsPath(): string { return this.withTrailingSlash('/api/drawings') }
  private approvalsBasePath(): string { return this.withTrailingSlash('/api/approvals') }

  async healthCheck(): Promise<boolean> {
    if (this.mockMode) return true;
    try {
      if (this.apiMode === 'yuantus') {
        const result = await this.query<{ ok?: boolean; status?: string }>('/api/v1/health')
        if (result.data && result.data.length > 0) {
          const payload = result.data[0]
          if (typeof payload.ok === 'boolean') {
            return payload.ok
          }
          const status = payload.status
          return status === 'ok' || status === 'healthy' || status === 'UP'
        }
        return false
      }
      const result = await this.query<{ status: string }>('/health')
      if (result.data && result.data.length > 0) {
        const status = result.data[0].status
        return status === 'ok' || status === 'healthy' || status === 'UP'
      }
      return false
    } catch (_err) {
      return this.testConnection()
    }
  }

  async getProducts(options?: PLMQueryOptions): Promise<QueryResult<PLMProduct>> {
    if (this.mockMode) {
      return this.getMockProducts(options);
    }
    if (this.apiMode === 'yuantus') {
      return this.getYuantusProducts(options)
    }

    const params: Record<string, unknown> = {}
    if (options?.limit) params.limit = options.limit
    if (options?.offset) params.skip = options.offset
    if (options?.status) params.status = options.status
    if (options?.search) params.q = options.search

    const result = await this.select<PLMProductRaw>(this.productsPath(), { params })
    const mappedData = result.data.map(raw => this.mapProductFields(raw))

    return {
      data: mappedData,
      metadata: result.metadata,
      error: result.error
    }
  }

  private async getYuantusProducts(options?: PLMQueryOptions): Promise<QueryResult<PLMProduct>> {
    const params: Record<string, unknown> = {
      q: options?.search ?? '',
      limit: options?.limit ?? 20,
      item_type: options?.itemType ?? this.yuantusItemType,
    }
    if (options?.status) {
      params.state = options.status
    }

    const result = await this.query<YuantusSearchResponse>('/api/v1/search/', [params])
    const payload = result.data[0]
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      this.logger.warn('PLM Yuantus search returned detail; ensure /api/v1/search is called with GET query params.')
    }
    const hits = payload?.hits || []
    const mappedData = hits.map(hit => this.mapYuantusProductFields(hit))

    return {
      data: mappedData,
      metadata: { totalCount: payload?.total ?? mappedData.length },
      error: result.error,
    }
  }

  private toIsoString(value: unknown): string {
    if (!value) return ''
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'string') return value
    const parsed = new Date(String(value))
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
  }

  private toNumber(value: unknown, fallback = 0): number {
    const num = Number(value)
    return Number.isFinite(num) ? num : fallback
  }

  private getMockProducts(options?: PLMQueryOptions): QueryResult<PLMProduct> {
    const mockData: PLMProduct[] = [
      { id: '1', name: 'iPhone 15 Pro', code: 'PRD-APPLE-001', version: 'A', status: 'released', description: 'Flagship smartphone', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: '2', name: 'Tesla Model 3', code: 'PRD-TESLA-001', version: 'B', status: 'draft', description: 'Electric sedan', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: '3', name: 'DJI Mavic 3', code: 'PRD-DJI-001', version: 'C', status: 'confirmed', description: 'Drone', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    ];
    
    // Simple filtering
    let data = mockData;
    if (options?.search) {
      const q = options.search.toLowerCase();
      data = data.filter(p => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
    }
    if (options?.status) {
      data = data.filter(p => p.status === options.status);
    }

    return {
      data: data,
      metadata: { totalCount: mockData.length }
    };
  }

  private mapProductFields(raw: PLMProductRaw): PLMProduct {
    return {
      id: String(raw.id),
      name: raw.name || '',
      code: raw.internal_reference || raw.code || '',
      version: raw.version || '1.0',
      status: raw.engineering_state || raw.status || 'draft',
      description: raw.description,
      created_at: raw.created_at || raw.create_date || new Date().toISOString(),
      updated_at: raw.updated_at || raw.write_date || new Date().toISOString()
    }
  }

  private mapYuantusProductFields(hit: YuantusSearchHit): PLMProduct {
    const props = hit.properties || {}
    const name = String(hit.name || props.name || props.item_name || '')
    const code = String(hit.item_number || props.item_number || props.code || props.internal_reference || '')
    const version = String(props.version || props.revision || props.rev || '')
    const status = String(hit.state || props.state || '')
    const description = (hit.description || props.description) ? String(hit.description || props.description) : undefined

    return {
      id: String(hit.id),
      name: name || String(hit.id),
      code,
      version,
      status,
      description,
      created_at: this.toIsoString(hit.created_at),
      updated_at: this.toIsoString(hit.updated_at),
    }
  }

  private mapYuantusItemFields(item: YuantusItem): PLMProduct {
    const props = item.properties || {}
    const name = String(props.name || props.item_name || props.title || '')
    const code = String(props.item_number || props.number || props.code || props.internal_reference || '')
    const version = String(props.version || props.revision || props.rev || '')
    const status = String(item.state || props.state || '')
    const description = props.description ? String(props.description) : undefined
    const createdAt = this.toIsoString(item.created_on || props.created_at || props.created_on || props.create_date)
    const updatedAt = this.toIsoString(item.modified_on || props.updated_at || props.modified_on || props.write_date)

    return {
      id: String(item.id),
      name: name || String(item.id),
      code,
      version,
      status,
      description,
      itemType: item.type,
      properties: props,
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  async getProductById(id: string, options?: { itemType?: string }): Promise<PLMProduct | null> {
    if (this.mockMode) {
      const products = this.getMockProducts().data;
      return products.find(p => p.id === id) || null;
    }
    if (this.apiMode === 'yuantus') {
      const itemType = options?.itemType || this.yuantusItemType
      const result = await this.select<YuantusItem>('/api/v1/aml/apply', {
        method: 'POST',
        data: { type: itemType, action: 'get', id },
      })
      const item = result.data[0]
      return item ? this.mapYuantusItemFields(item) : null
    }
    const result = await this.select<PLMProductRaw>(`${this.productsPath()}${id}`)
    if (result.data.length === 0) return null
    return this.mapProductFields(result.data[0])
  }

  async getProductBOM(productId: string): Promise<QueryResult<BOMItem>> {
    if (this.mockMode) {
      return {
        data: [
          { id: '101', product_id: productId, component_id: '10', component_name: 'Screw M3', component_code: 'FAST-001', quantity: 4, unit: 'pcs', level: 1, sequence: 10, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { id: '102', product_id: productId, component_id: '11', component_name: 'Plate', component_code: 'MECH-001', quantity: 1, unit: 'pcs', level: 1, sequence: 20, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        ],
        metadata: { totalCount: 2 }
      };
    }
    if (this.apiMode === 'yuantus') {
      const result = await this.query<YuantusBomNode>(`/api/v1/bom/${productId}/tree`, [{ depth: 2 }])
      const root = result.data[0]
      if (!root) {
        return { data: [], metadata: { totalCount: 0 }, error: result.error }
      }
      const items = this.flattenYuantusBomTree(root, productId)
      return { data: items, metadata: { totalCount: items.length }, error: result.error }
    }
    return this.query<BOMItem>(`/api/products/${productId}/bom`)
  }

  async getWhereUsed(
    itemId: string,
    options?: { recursive?: boolean; maxLevels?: number }
  ): Promise<QueryResult<WhereUsedResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          item_id: itemId,
          count: 0,
          parents: [],
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('Where-used is not supported for this PLM API mode') }
    }

    const params: Record<string, unknown> = {}
    if (typeof options?.recursive === 'boolean') {
      params.recursive = options.recursive
    }
    if (typeof options?.maxLevels === 'number') {
      params.max_levels = options.maxLevels
    }

    return this.query<WhereUsedResponse>(`/api/v1/bom/${itemId}/where-used`, [params])
  }

  async getBomCompare(params: BOMCompareParams): Promise<QueryResult<BOMCompareResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          summary: { added: 1, removed: 1, changed: 1, changed_major: 1, changed_minor: 0, changed_info: 0 },
          added: [],
          removed: [],
          changed: [],
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('BOM compare is not supported for this PLM API mode') }
    }
    if (!params.leftId || !params.rightId) {
      return { data: [], error: new Error('leftId and rightId are required for BOM compare') }
    }

    const queryParams: Record<string, unknown> = {
      left_type: params.leftType ?? 'item',
      left_id: params.leftId,
      right_type: params.rightType ?? 'item',
      right_id: params.rightId,
      max_levels: params.maxLevels ?? 10,
    }

    if (params.lineKey) queryParams.line_key = params.lineKey
    if (params.compareMode) queryParams.compare_mode = params.compareMode
    if (typeof params.includeSubstitutes === 'boolean') {
      queryParams.include_substitutes = params.includeSubstitutes
    }
    if (typeof params.includeEffectivity === 'boolean') {
      queryParams.include_effectivity = params.includeEffectivity
    }
    if (params.includeRelationshipProps && params.includeRelationshipProps.length > 0) {
      queryParams.include_relationship_props = params.includeRelationshipProps.join(',')
    }
    if (params.effectiveAt) queryParams.effective_at = params.effectiveAt

    return this.query<BOMCompareResponse>('/api/v1/bom/compare', [queryParams])
  }

  async getBomSubstitutes(bomLineId: string): Promise<QueryResult<BOMSubstitutesResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          bom_line_id: bomLineId,
          count: 0,
          substitutes: [],
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('BOM substitutes are not supported for this PLM API mode') }
    }

    return this.query<BOMSubstitutesResponse>(`/api/v1/bom/${bomLineId}/substitutes`)
  }

  private flattenYuantusBomTree(root: YuantusBomNode, rootId: string): BOMItem[] {
    const children = Array.isArray(root.children) ? root.children : []
    return this.flattenYuantusBomChildren(children, rootId, 1)
  }

  private flattenYuantusBomChildren(children: YuantusBomChild[], rootId: string, level: number): BOMItem[] {
    const items: BOMItem[] = []
    for (const entry of children) {
      const child = entry?.child
      const relationship = entry?.relationship
      if (!child || !relationship) {
        continue
      }

      const relProps = relationship.properties || {}
      const childProps = child.properties || {}
      const quantity = this.toNumber(relationship.quantity ?? relProps.quantity, 0)
      const sequence = this.toNumber(relationship.find_num ?? relProps.find_num, 0)
      const unit = String(relationship.uom ?? relProps.uom ?? relProps.unit ?? 'EA')
      const componentName = String(child.name ?? childProps.name ?? childProps.item_name ?? '')
      const componentCode = String(child.item_number ?? childProps.item_number ?? childProps.code ?? childProps.internal_reference ?? '')
      const createdAt = this.toIsoString(relationship.created_on ?? child.created_on) || new Date().toISOString()
      const updatedAt = this.toIsoString(relationship.modified_on ?? child.modified_on) || new Date().toISOString()

      items.push({
        id: String(relationship.id ?? `${rootId}:${child.id}`),
        product_id: rootId,
        parent_item_id: String(relationship.source_id ?? rootId),
        component_id: String(child.id ?? relationship.related_id ?? ''),
        component_name: componentName,
        component_code: componentCode,
        quantity,
        unit,
        level,
        sequence,
        created_at: createdAt,
        updated_at: updatedAt,
      })

      if (Array.isArray(child.children) && child.children.length > 0) {
        items.push(...this.flattenYuantusBomChildren(child.children, rootId, level + 1))
      }
    }
    return items
  }

  async getMyPendingApprovals(userId: string, options?: ApprovalQueryOptions): Promise<QueryResult<ApprovalRequest>> {
    const status = options?.status ?? 'pending'
    if (this.mockMode) {
      return {
        data: [],
        metadata: { totalCount: 0 },
      }
    }

    const params: Record<string, unknown> = {
      status,
      user_id: userId,
    }
    if (options?.limit) params.limit = options.limit
    if (options?.offset) params.skip = options.offset

    return this.select<ApprovalRequest>(this.approvalRequestsPath(), { params })
  }

  async uploadDrawing(_params: unknown): Promise<QueryResult<PLMDrawing>> {
    return { data: [], error: new Error('uploadDrawing not implemented') }
  }
}
