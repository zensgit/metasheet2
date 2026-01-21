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
  partNumber?: string
  revision?: string
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
  product_number?: string
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
  productId?: string
  requesterId?: string
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
  find_num?: string | number
  refdes?: string
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
  includeChildFields?: boolean
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

export interface BOMCompareFieldSpec {
  field: string
  severity: string
  normalized: string
  description?: string
}

export interface BOMCompareModeSpec {
  mode: string
  line_key?: string
  include_relationship_props?: string[]
  aggregate_quantities?: boolean
  aliases?: string[]
  description?: string
}

export interface BOMCompareSchemaResponse {
  line_fields: BOMCompareFieldSpec[]
  compare_modes: BOMCompareModeSpec[]
  line_key_options: string[]
  defaults?: Record<string, unknown>
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

export interface BOMSubstituteMutationResponse {
  ok: boolean
  substitute_id: string
  bom_line_id?: string
  substitute_item_id?: string
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
  preview_url?: string
  download_url?: string
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CadPropertiesResponse {
  file_id: string
  properties: Record<string, unknown>
  updated_at?: string | null
  source?: string | null
  cad_document_schema_version?: number | null
}

export interface CadEntityNote {
  entity_id: number
  note: string
  color?: string | null
}

export interface CadViewStateResponse {
  file_id: string
  hidden_entity_ids: number[]
  notes: CadEntityNote[]
  updated_at?: string | null
  source?: string | null
  cad_document_schema_version?: number | null
}

export interface CadReviewResponse {
  file_id: string
  state?: string | null
  note?: string | null
  reviewed_at?: string | null
  reviewed_by_id?: number | null
}

export interface CadDiffResponse {
  file_id: string
  other_file_id: string
  properties: Record<string, unknown>
  cad_document_schema_version: Record<string, number | null>
}

export interface CadChangeLogEntry {
  id: string
  action: string
  payload: Record<string, unknown>
  created_at: string
  user_id?: number | null
}

export interface CadChangeLogResponse {
  file_id: string
  entries: CadChangeLogEntry[]
}

export interface CadMeshStatsResponse {
  file_id: string
  stats: Record<string, unknown>
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

export interface DocumentQueryOptions {
  limit?: number
  offset?: number
  role?: string
  includeMetadata?: boolean
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
  item_type_id?: string
  state?: string
  created_on?: string
  modified_on?: string
  item_number?: string
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

interface YuantusItemFile {
  id?: string
  file_id?: string
  filename?: string
  file_name?: string
  file_role?: string
  description?: string
  file_type?: string
  mime_type?: string
  file_size?: number
  document_type?: string
  document_version?: string
  preview_url?: string
  download_url?: string
  author?: string
  source_system?: string
  source_version?: string
  created_at?: string
  updated_at?: string
}

interface YuantusFileMetadata {
  id?: string
  filename?: string
  file_name?: string
  file_role?: string
  file_type?: string
  mime_type?: string
  file_size?: number
  document_type?: string
  document_version?: string
  preview_url?: string
  download_url?: string
  created_at?: string
  updated_at?: string
  author?: string
  source_system?: string
  source_version?: string
}

interface YuantusEco {
  id: string
  name?: string
  eco_type?: string
  product_id?: string
  product_number?: string
  product_name?: string
  state?: string
  created_by_id?: string | number
  created_by_name?: string
  requester_id?: string | number
  requester_name?: string
  created_at?: string
  updated_at?: string
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

    if (this.apiMode === 'yuantus' && !this.mockMode) {
      if (this.yuantusCredentials) {
        const needsRefresh = !this.authToken || this.authTokenExpiresAt <= Date.now() + this.authBufferMs
        if (needsRefresh) {
          const refreshed = await this.fetchYuantusToken()
          if (!refreshed) {
            this.logger.warn('PLM Yuantus login failed; check PLM_USERNAME/PLM_PASSWORD/PLM_TENANT_ID/PLM_ORG_ID')
          }
        }
      } else if (this.authToken && this.authTokenExpiresAt <= Date.now() + this.authBufferMs) {
        this.logger.warn('PLM Yuantus token near expiry but no credentials available for refresh')
      }
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

  private resolveUrl(path?: string): string | undefined {
    if (!path) return undefined
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path
    }
    const base = String(this.config.connection.baseURL || this.config.connection.url || '')
    if (!base) return path
    return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
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
    const headers = (this.config.connection.headers as Record<string, string> | undefined) || {}
    headers.Authorization = `Bearer ${token}`
    this.config.connection.headers = headers
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
    const code = raw.internal_reference || raw.code || ''
    const version = raw.version || '1.0'
    return {
      id: String(raw.id),
      name: raw.name || '',
      code,
      version,
      status: raw.engineering_state || raw.status || 'draft',
      description: raw.description,
      partNumber: code || undefined,
      revision: version || undefined,
      created_at: raw.created_at || raw.create_date || new Date().toISOString(),
      updated_at: raw.updated_at || raw.write_date || new Date().toISOString()
    }
  }

  private mapDocumentFields(raw: PLMDocumentRaw): PLMDocument {
    return {
      id: String(raw.id),
      name: raw.name || '',
      engineering_code: raw.engineering_code,
      engineering_revision: raw.engineering_revision,
      document_type: raw.document_type || 'other',
      description: raw.description,
      engineering_state: raw.engineering_state || 'unknown',
      file_size: raw.file_size,
      mime_type: raw.mime_type,
      is_production_doc: raw.is_production_doc,
      created_at: raw.created_at || raw.create_date || new Date().toISOString(),
      updated_at: raw.updated_at || raw.write_date || new Date().toISOString(),
    }
  }

  private mapYuantusProductFields(hit: YuantusSearchHit): PLMProduct {
    const props = hit.properties || {}
    const name = String(hit.name || props.name || props.item_name || props.title || '')
    const partNumber = String(
      hit.item_number ||
        props.item_number ||
        props.part_number ||
        props.number ||
        props.code ||
        props.internal_reference ||
        ''
    )
    const revision = String(props.revision || props.version || props.rev || props.version_label || '')
    const status = String(hit.state || props.state || props.status || '')
    const description = (hit.description || props.description) ? String(hit.description || props.description) : undefined
    const createdAt = this.toIsoString(hit.created_at)
    const updatedAt = this.toIsoString(hit.updated_at) || createdAt

    const itemType =
      hit.item_type_id ||
      (props.item_type_id as string | undefined) ||
      (props.item_type as string | undefined) ||
      (props.itemType as string | undefined) ||
      (props.type as string | undefined)

    return {
      id: String(hit.id),
      name: name || String(hit.id),
      code: partNumber,
      version: revision,
      status,
      description,
      partNumber: partNumber || undefined,
      revision: revision || undefined,
      itemType: itemType ? String(itemType) : undefined,
      properties: props,
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  private mapYuantusItemFields(item: YuantusItem): PLMProduct {
    const props = item.properties || {}
    const name = String(props.name || props.item_name || props.title || '')
    const partNumber = String(
      item.item_number ||
        props.item_number ||
        props.part_number ||
        props.number ||
        props.code ||
        props.internal_reference ||
        ''
    )
    const revision = String(props.revision || props.version || props.rev || props.version_label || '')
    const status = String(item.state || props.state || '')
    const description = props.description ? String(props.description) : undefined
    const createdAt = this.toIsoString(item.created_on || props.created_at || props.created_on || props.create_date)
    const updatedAt = this.toIsoString(item.modified_on || props.updated_at || props.modified_on || props.write_date) || createdAt
    const itemType =
      item.type ||
      item.item_type_id ||
      (props.item_type_id as string | undefined) ||
      (props.item_type as string | undefined) ||
      (props.itemType as string | undefined) ||
      (props.type as string | undefined)

    return {
      id: String(item.id),
      name: name || String(item.id),
      code: partNumber,
      version: revision,
      status,
      description,
      partNumber: partNumber || undefined,
      revision: revision || undefined,
      itemType: itemType ? String(itemType) : undefined,
      properties: props,
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  private async fetchYuantusSearchHit(
    itemId: string,
    itemType?: string
  ): Promise<YuantusSearchHit | null> {
    if (!itemId) return null
    const params: Record<string, unknown> = {
      q: itemId,
      limit: 5,
    }
    if (itemType) {
      params.item_type = itemType
    }

    try {
      const result = await this.query<YuantusSearchResponse>('/api/v1/search/', [params])
      const payload = result.data[0]
      const hits = payload?.hits ?? []
      const needle = String(itemId).trim().toLowerCase()
      const matches = (value?: unknown) => {
        if (value === undefined || value === null) return false
        return String(value).trim().toLowerCase() === needle
      }
      const match = hits.find((hit) => {
        const props = hit.properties || {}
        return (
          matches(hit.id) ||
          matches(hit.item_number) ||
          matches(props.item_number) ||
          matches(props.part_number) ||
          matches(props.number) ||
          matches(props.code) ||
          matches(props.internal_reference)
        )
      })
      return match || null
    } catch (_err) {
      return null
    }
  }

  private mergeYuantusProductDetail(
    base: PLMProduct,
    hit: YuantusSearchHit
  ): PLMProduct {
    const hitProps = hit.properties || {}
    const baseProps = base.properties || {}
    const mergedProps = { ...hitProps, ...baseProps }
    const baseNameIsId = base.name === base.id
    const hitName = hit.name || hitProps.name || hitProps.item_name
    const name = (!base.name || baseNameIsId) && hitName ? String(hitName) : base.name
    const partNumber = base.partNumber || String(
      hit.item_number ||
        hitProps.item_number ||
        hitProps.part_number ||
        hitProps.number ||
        hitProps.code ||
        hitProps.internal_reference ||
        ''
    )
    const revision = base.revision || String(
      hitProps.revision || hitProps.version || hitProps.rev || hitProps.version_label || ''
    )
    const code = base.code || partNumber
    const version = base.version || revision
    const status = base.status || String(hit.state || hitProps.state || '')
    const description = base.description ?? (
      hit.description || hitProps.description ? String(hit.description || hitProps.description) : undefined
    )
    const createdAt = base.created_at ? base.created_at : this.toIsoString(hit.created_at)
    const updatedAt = base.updated_at ? base.updated_at : (this.toIsoString(hit.updated_at) || createdAt)
    const hitItemType =
      hit.item_type_id ||
      (hitProps.item_type_id as string | undefined) ||
      (hitProps.item_type as string | undefined) ||
      (hitProps.itemType as string | undefined) ||
      (hitProps.type as string | undefined)
    const itemType = base.itemType || hitItemType

    return {
      ...base,
      name: name || base.name,
      code: code || base.code,
      version: version || base.version,
      status: status || base.status,
      description,
      partNumber: partNumber || base.partNumber,
      revision: revision || base.revision,
      itemType: itemType || base.itemType,
      properties: mergedProps,
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  private mapYuantusDocumentFields(entry: YuantusItemFile, metadata?: YuantusFileMetadata | null): PLMDocument {
    const fileId = String(entry.file_id || entry.id || '')
    const filename = metadata?.filename || metadata?.file_name || entry.filename || entry.file_name || fileId
    const documentType = String(metadata?.document_type || entry.document_type || entry.file_type || 'other')
    const documentVersion = metadata?.document_version || entry.document_version
    const fileSize = this.toNumber(metadata?.file_size ?? entry.file_size, 0)
    const mimeType = metadata?.mime_type || entry.mime_type || entry.file_type
    const createdAt = this.toIsoString(metadata?.created_at || entry.created_at) || new Date().toISOString()
    const updatedAt = this.toIsoString(metadata?.updated_at || entry.updated_at || entry.created_at) || createdAt
    const fileRole = String(metadata?.file_role || entry.file_role || '')
    const author = metadata?.author || entry.author
    const sourceSystem = metadata?.source_system || entry.source_system
    const sourceVersion = metadata?.source_version || entry.source_version
    const previewUrl = this.resolveUrl(metadata?.preview_url || entry.preview_url)
    const downloadUrl = this.resolveUrl(metadata?.download_url || entry.download_url)

    return {
      id: fileId || String(entry.id || ''),
      name: filename || fileId,
      engineering_code: fileId || undefined,
      engineering_revision: documentVersion || undefined,
      document_type: documentType,
      description: entry.description,
      engineering_state: fileRole || 'unknown',
      file_size: fileSize,
      mime_type: mimeType,
      is_production_doc: fileRole === 'production' || fileRole === 'primary',
      preview_url: previewUrl,
      download_url: downloadUrl,
      metadata: {
        file_id: fileId || entry.id,
        filename: filename || undefined,
        file_role: fileRole || undefined,
        document_type: documentType || undefined,
        document_version: documentVersion || undefined,
        file_size: fileSize,
        mime_type: mimeType || undefined,
        preview_url: previewUrl,
        download_url: downloadUrl,
        created_at: createdAt,
        updated_at: updatedAt,
        author: author || undefined,
        source_system: sourceSystem || undefined,
        source_version: sourceVersion || undefined,
      },
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  private mapYuantusApprovalStatus(state?: string): ApprovalRequest['status'] {
    const normalized = (state || '').toLowerCase()
    if (['approved', 'done'].includes(normalized)) {
      return 'approved'
    }
    if (['rejected', 'canceled', 'cancelled'].includes(normalized)) {
      return 'rejected'
    }
    return 'pending'
  }

  private mapYuantusEcoApproval(eco: YuantusEco, product?: PLMProduct): ApprovalRequest {
    const requesterId = eco.requester_id
      ? String(eco.requester_id)
      : eco.created_by_id
        ? String(eco.created_by_id)
        : 'unknown'
    const requesterName = eco.requester_name || eco.created_by_name || requesterId
    const productId = eco.product_id ? String(eco.product_id) : undefined
    const productNumber = eco.product_number || product?.partNumber || product?.code
    const productName = eco.product_name || product?.name
    return {
      id: eco.id,
      request_type: eco.eco_type || 'eco',
      title: eco.name || eco.id,
      requester_id: requesterId,
      requester_name: requesterName,
      status: this.mapYuantusApprovalStatus(eco.state),
      created_at: this.toIsoString(eco.created_at || eco.updated_at) || new Date().toISOString(),
      product_id: productId,
      product_number: productNumber,
      product_name: productName,
    }
  }

  private async fetchYuantusFileMetadata(fileId: string): Promise<YuantusFileMetadata | null> {
    if (!fileId) return null
    try {
      const result = await this.query<YuantusFileMetadata>(`/api/v1/file/${fileId}`)
      return result.data[0] ?? null
    } catch (_err) {
      return null
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
      if (result.error) {
        throw result.error
      }
      const rawItem = result.data[0]
      const item = rawItem && typeof rawItem === 'object' && 'items' in rawItem && Array.isArray((rawItem as { items?: YuantusItem[] }).items)
        ? (rawItem as { items?: YuantusItem[] }).items?.[0]
        : (rawItem as YuantusItem | undefined)
      if (!item) {
        const hit = await this.fetchYuantusSearchHit(id, itemType)
        if (!hit) return null
        const mappedHit = this.mapYuantusProductFields(hit)
        if (hit.id && String(hit.id) !== String(id)) {
          try {
            const detailResult = await this.select<YuantusItem>('/api/v1/aml/apply', {
              method: 'POST',
              data: { type: itemType, action: 'get', id: hit.id },
            })
            if (detailResult.error) {
              throw detailResult.error
            }
            const detailItem = detailResult.data[0]
            if (detailItem) {
              return this.mergeYuantusProductDetail(this.mapYuantusItemFields(detailItem), hit)
            }
          } catch (_err) {
            return mappedHit
          }
        }
        return mappedHit
      }
      const mapped = this.mapYuantusItemFields(item)
      if (mapped.created_at && mapped.updated_at) {
        return mapped
      }
      const hit = await this.fetchYuantusSearchHit(id, itemType)
      return hit ? this.mergeYuantusProductDetail(mapped, hit) : mapped
    }
    const result = await this.select<PLMProductRaw>(`${this.productsPath()}${id}`)
    if (result.data.length === 0) return null
    return this.mapProductFields(result.data[0])
  }

  async getProductDocuments(
    productId: string,
    options?: DocumentQueryOptions
  ): Promise<QueryResult<PLMDocument>> {
    if (this.mockMode) {
      const mockDocs: PLMDocument[] = [
        {
          id: 'doc-1',
          name: 'Spec.pdf',
          document_type: 'specification',
          engineering_state: 'released',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]
      return { data: mockDocs, metadata: { totalCount: mockDocs.length } }
    }

    if (this.apiMode === 'yuantus') {
      const params: Record<string, unknown> = {}
      if (options?.role) params.role = options.role

      const result = await this.query<YuantusItemFile>(`/api/v1/file/item/${productId}`, [params])
      const includeMetadata = options?.includeMetadata !== false
      const mapped = await Promise.all(
        result.data.map(async (entry) => {
          const fileId = String(entry.file_id || entry.id || '')
          const metadata = includeMetadata ? await this.fetchYuantusFileMetadata(fileId) : null
          return this.mapYuantusDocumentFields(entry, metadata)
        })
      )
      const offset = options?.offset ?? 0
      const limit = options?.limit
      const sliced = typeof limit === 'number' ? mapped.slice(offset, offset + limit) : mapped.slice(offset)

      return {
        data: sliced,
        metadata: { totalCount: mapped.length },
        error: result.error,
      }
    }

    const params: Record<string, unknown> = { product_id: productId }
    if (options?.limit) params.limit = options.limit
    if (options?.offset) params.skip = options.offset
    const result = await this.select<PLMDocumentRaw>(this.documentsPath(), { params })
    const mapped = result.data.map(raw => this.mapDocumentFields(raw))

    return {
      data: mapped,
      metadata: result.metadata,
      error: result.error,
    }
  }

  async getProductBOM(
    productId: string,
    options?: { depth?: number; effectiveAt?: string }
  ): Promise<QueryResult<BOMItem>> {
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
      const params: Record<string, unknown> = {}
      if (typeof options?.depth === 'number') {
        params.depth = options.depth
      }
      if (options?.effectiveAt) {
        params.effective_date = options.effectiveAt
      }
      const result = await this.query<YuantusBomNode>(`/api/v1/bom/${productId}/tree`, [params])
      const root = result.data[0]
      if (!root) {
        return { data: [], metadata: { totalCount: 0 }, error: result.error }
      }
      const items = this.flattenYuantusBomTree(root, productId)
      return { data: items, metadata: { totalCount: items.length }, error: result.error }
    }
    return this.query<BOMItem>(`/api/products/${productId}/bom`)
  }

  async getApprovals(options?: ApprovalQueryOptions): Promise<QueryResult<ApprovalRequest>> {
    if (this.mockMode) {
      return {
        data: [],
        metadata: { totalCount: 0 },
      }
    }

    if (this.apiMode === 'yuantus') {
      const params: Record<string, unknown> = {}
      if (options?.productId) params.product_id = options.productId
      if (options?.requesterId) params.created_by_id = options.requesterId
      if (options?.limit) params.limit = options.limit
      if (options?.offset) params.offset = options.offset

      const result = await this.query<YuantusEco>('/api/v1/eco', [params])
      const filtered = options?.status
        ? result.data.filter((eco) => this.mapYuantusApprovalStatus(eco.state) === options.status)
        : result.data
      const productIds = new Set<string>()
      for (const eco of filtered) {
        if (eco.product_id) {
          productIds.add(String(eco.product_id))
        }
      }

      const productMap = new Map<string, PLMProduct>()
      if (productIds.size > 0) {
        await Promise.all(
          Array.from(productIds).map(async (productId) => {
            try {
              const product = await this.getProductById(productId)
              if (product) {
                productMap.set(productId, product)
              }
            } catch (_err) {
              // Ignore product lookup failures to keep approvals responsive.
            }
          })
        )
      }

      const mapped = filtered.map((eco) => {
        const product = eco.product_id ? productMap.get(String(eco.product_id)) : undefined
        return this.mapYuantusEcoApproval(eco, product)
      })

      return {
        data: mapped,
        metadata: { totalCount: mapped.length },
        error: result.error,
      }
    }

    const params: Record<string, unknown> = {}
    if (options?.status) params.status = options.status
    if (options?.requesterId) params.user_id = options.requesterId
    if (options?.limit) params.limit = options.limit
    if (options?.offset) params.skip = options.offset

    return this.select<ApprovalRequest>(this.approvalRequestsPath(), { params })
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
    if (typeof params.includeChildFields === 'boolean') {
      queryParams.include_child_fields = params.includeChildFields
    }
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

  async getBomCompareSchema(): Promise<QueryResult<BOMCompareSchemaResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          line_fields: [
            { field: 'quantity', severity: 'major', normalized: 'float', description: 'BOM quantity on the relationship line.' },
            { field: 'uom', severity: 'major', normalized: 'upper-case string', description: 'Unit of measure for the BOM quantity.' },
            { field: 'find_num', severity: 'minor', normalized: 'trimmed string', description: 'BOM position/find number.' },
            { field: 'refdes', severity: 'minor', normalized: 'sorted unique list', description: 'Reference designator(s) for BOM line.' },
            { field: 'effectivity_from', severity: 'major', normalized: 'ISO datetime string', description: 'Effectivity start datetime (ISO).' },
            { field: 'effectivity_to', severity: 'major', normalized: 'ISO datetime string', description: 'Effectivity end datetime (ISO).' },
            { field: 'effectivities', severity: 'major', normalized: 'sorted tuples (type,start,end,payload)', description: 'Expanded effectivity records attached to the line.' },
            { field: 'substitutes', severity: 'minor', normalized: 'sorted tuples (item_id,rank,note)', description: 'Substitute items for the BOM line.' },
          ],
          compare_modes: [
            { mode: 'only_product', line_key: 'child_config', include_relationship_props: [], aggregate_quantities: false, aliases: ['only'], description: 'Compare by parent/child config only.' },
            { mode: 'summarized', line_key: 'child_config', include_relationship_props: ['quantity', 'uom'], aggregate_quantities: true, aliases: ['summary'], description: 'Aggregate quantities for identical children.' },
            { mode: 'num_qty', line_key: 'child_config_find_num_qty', include_relationship_props: ['quantity', 'uom', 'find_num'], aggregate_quantities: false, aliases: ['numqty'], description: 'Compare by child config + find_num + quantity.' },
            { mode: 'by_position', line_key: 'child_config_find_num', include_relationship_props: ['quantity', 'uom', 'find_num'], aggregate_quantities: false, aliases: ['by_pos', 'position'], description: 'Compare by child config + find_num.' },
            { mode: 'by_reference', line_key: 'child_config_refdes', include_relationship_props: ['quantity', 'uom', 'refdes'], aggregate_quantities: false, aliases: ['by_ref', 'reference'], description: 'Compare by child config + refdes.' },
          ],
          line_key_options: [
            'child_config',
            'child_id',
            'relationship_id',
            'child_config_find_num',
            'child_config_refdes',
            'child_config_find_refdes',
            'child_id_find_num',
            'child_id_refdes',
            'child_id_find_refdes',
            'child_config_find_num_qty',
            'child_id_find_num_qty',
            'line_full',
          ],
          defaults: {
            max_levels: 10,
            line_key: 'child_config',
            include_substitutes: false,
            include_effectivity: false,
          },
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('BOM compare schema is not supported for this PLM API mode') }
    }

    return this.query<BOMCompareSchemaResponse>('/api/v1/bom/compare/schema')
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

  async addBomSubstitute(
    bomLineId: string,
    substituteItemId: string,
    properties?: Record<string, unknown>
  ): Promise<QueryResult<BOMSubstituteMutationResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          ok: true,
          substitute_id: `mock-${Date.now()}`,
          bom_line_id: bomLineId,
          substitute_item_id: substituteItemId,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('BOM substitutes are not supported for this PLM API mode') }
    }

    const payload: Record<string, unknown> = { substitute_item_id: substituteItemId }
    if (properties && Object.keys(properties).length) {
      payload.properties = properties
    }

    return this.insert<BOMSubstituteMutationResponse>(`/api/v1/bom/${bomLineId}/substitutes`, payload)
  }

  async removeBomSubstitute(
    bomLineId: string,
    substituteId: string
  ): Promise<QueryResult<BOMSubstituteMutationResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          ok: true,
          substitute_id: substituteId,
          bom_line_id: bomLineId,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('BOM substitutes are not supported for this PLM API mode') }
    }

    return this.delete<BOMSubstituteMutationResponse>(`/api/v1/bom/${bomLineId}/substitutes/${substituteId}`, {})
  }

  async getCadProperties(fileId: string): Promise<QueryResult<CadPropertiesResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          properties: { material: 'AL-6061', finish: 'anodized' },
          updated_at: new Date().toISOString(),
          source: 'mock',
          cad_document_schema_version: 1,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD properties are not supported for this PLM API mode') }
    }

    return this.query<CadPropertiesResponse>(`/api/v1/cad/files/${fileId}/properties`)
  }

  async updateCadProperties(
    fileId: string,
    payload: Record<string, unknown>
  ): Promise<QueryResult<CadPropertiesResponse>> {
    if (this.mockMode) {
      const properties = (payload.properties && typeof payload.properties === 'object')
        ? payload.properties as Record<string, unknown>
        : payload
      return {
        data: [{
          file_id: fileId,
          properties,
          updated_at: new Date().toISOString(),
          source: 'mock',
          cad_document_schema_version: 1,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD properties are not supported for this PLM API mode') }
    }

    return this.select<CadPropertiesResponse>(`/api/v1/cad/files/${fileId}/properties`, {
      method: 'PATCH',
      data: payload,
    })
  }

  async getCadViewState(fileId: string): Promise<QueryResult<CadViewStateResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          hidden_entity_ids: [12, 19],
          notes: [{ entity_id: 12, note: 'check hole position', color: '#FFB020' }],
          updated_at: new Date().toISOString(),
          source: 'mock',
          cad_document_schema_version: 1,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD view state is not supported for this PLM API mode') }
    }

    return this.query<CadViewStateResponse>(`/api/v1/cad/files/${fileId}/view-state`)
  }

  async updateCadViewState(
    fileId: string,
    payload: Record<string, unknown>
  ): Promise<QueryResult<CadViewStateResponse>> {
    if (this.mockMode) {
      const hidden = Array.isArray(payload.hidden_entity_ids) ? payload.hidden_entity_ids as number[] : []
      const notes = Array.isArray(payload.notes) ? payload.notes as CadEntityNote[] : []
      return {
        data: [{
          file_id: fileId,
          hidden_entity_ids: hidden,
          notes,
          updated_at: new Date().toISOString(),
          source: 'mock',
          cad_document_schema_version: 1,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD view state is not supported for this PLM API mode') }
    }

    return this.select<CadViewStateResponse>(`/api/v1/cad/files/${fileId}/view-state`, {
      method: 'PATCH',
      data: payload,
    })
  }

  async getCadReview(fileId: string): Promise<QueryResult<CadReviewResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          state: 'approved',
          note: 'dimensions ok',
          reviewed_at: new Date().toISOString(),
          reviewed_by_id: 42,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD review is not supported for this PLM API mode') }
    }

    return this.query<CadReviewResponse>(`/api/v1/cad/files/${fileId}/review`)
  }

  async updateCadReview(
    fileId: string,
    payload: Record<string, unknown>
  ): Promise<QueryResult<CadReviewResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          state: typeof payload.state === 'string' ? payload.state : 'approved',
          note: typeof payload.note === 'string' ? payload.note : null,
          reviewed_at: new Date().toISOString(),
          reviewed_by_id: 42,
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD review is not supported for this PLM API mode') }
    }

    return this.insert<CadReviewResponse>(`/api/v1/cad/files/${fileId}/review`, payload)
  }

  async getCadHistory(fileId: string): Promise<QueryResult<CadChangeLogResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          entries: [
            { id: 'chg-1', action: 'properties_updated', payload: { material: 'AL-6061' }, created_at: new Date().toISOString() },
          ],
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD history is not supported for this PLM API mode') }
    }

    return this.query<CadChangeLogResponse>(`/api/v1/cad/files/${fileId}/history`)
  }

  async getCadDiff(fileId: string, otherFileId: string): Promise<QueryResult<CadDiffResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          other_file_id: otherFileId,
          properties: {
            added: { finish: 'anodized' },
            removed: { coating: 'none' },
            changed: { weight_kg: { from: 1.1, to: 1.2 } },
          },
          cad_document_schema_version: { left: 1, right: 2 },
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD diff is not supported for this PLM API mode') }
    }

    return this.query<CadDiffResponse>(`/api/v1/cad/files/${fileId}/diff`, [{ other_file_id: otherFileId }])
  }

  async getCadMeshStats(fileId: string): Promise<QueryResult<CadMeshStatsResponse>> {
    if (this.mockMode) {
      return {
        data: [{
          file_id: fileId,
          stats: { triangles: 102400, vertices: 51200, watertight: true },
        }],
        metadata: { totalCount: 1 },
      }
    }
    if (this.apiMode !== 'yuantus') {
      return { data: [], error: new Error('CAD mesh stats are not supported for this PLM API mode') }
    }

    return this.query<CadMeshStatsResponse>(`/api/v1/cad/files/${fileId}/mesh-stats`)
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
      const componentCode = String(
        child.item_number ||
          childProps.item_number ||
          childProps.part_number ||
          childProps.code ||
          childProps.internal_reference ||
          ''
      )
      const createdAt = this.toIsoString(relationship.created_on ?? child.created_on) || new Date().toISOString()
      const updatedAt = this.toIsoString(relationship.modified_on ?? child.modified_on) || new Date().toISOString()
      const findNum = relationship.find_num ?? relProps.find_num
      const refdes = relationship.refdes ?? relProps.refdes

      items.push({
        id: String(relationship.id ?? `${rootId}:${child.id}`),
        product_id: rootId,
        parent_item_id: String(relationship.source_id ?? rootId),
        component_id: String(child.id ?? relationship.related_id ?? ''),
        component_name: componentName,
        component_code: componentCode,
        find_num: findNum ? String(findNum) : undefined,
        refdes: refdes ? String(refdes) : undefined,
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

    if (this.apiMode === 'yuantus') {
      return this.getApprovals({
        status,
        limit: options?.limit,
        offset: options?.offset,
        requesterId: userId,
      })
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
