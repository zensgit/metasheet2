import { Optional } from '@wendellhu/redi'
import { IConfigService, ILogger } from '../di/identifiers'
import { HTTPAdapter } from './HTTPAdapter'
import { QueryResult, DataSourceConfig } from './BaseAdapter'

export interface AthenaDocument {
  id: string
  name: string
  type: string
  size: number
  path: string
  folder_id?: string
  version: string
  status: 'draft' | 'in_review' | 'approved' | 'archived'
  created_by: string
  created_at: string
  updated_at: string
  checked_out_by?: string
  checked_out_at?: string
  metadata?: Record<string, unknown>
}

export interface DocumentVersion {
  id: string
  document_id: string
  version: string
  file_size: number
  created_by: string
  created_at: string
  comment?: string
}

export interface AthenaFolder {
  id: string
  name: string
  parent_id?: string
  path: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface DocumentSearchParams {
  query?: string
  folder_id?: string
  type?: string
  status?: string
  created_by?: string
  created_after?: string
  created_before?: string
  limit?: number
  offset?: number
}

interface AthenaSearchResponse {
  content?: Array<Record<string, unknown>>
  totalElements?: number
}

interface AthenaNodeResponse {
  id?: string
  name?: string
  path?: string
  nodeType?: string
  size?: number
  contentType?: string
  currentVersionLabel?: string
  isFolder?: boolean
  locked?: boolean
  createdBy?: string
  createdDate?: string
  lastModifiedBy?: string
  lastModifiedDate?: string
}

export class AthenaAdapter extends HTTPAdapter {
  private mockMode = false;
  private authToken: string | null = null;
  private authTokenExpiresAt = 0;
  private authTokenPromise: Promise<string | null> | null = null;
  private authBufferMs = 60_000;
  private keycloakConfig: {
    url: string;
    realm: string;
    clientId: string;
    clientSecret?: string;
    username: string;
    password: string;
  } | null = null;

  static inject = [IConfigService, ILogger, [new Optional(), 'athena_config']];

  constructor(
    private configService: IConfigService,
    private logger: ILogger,
    config?: DataSourceConfig
  ) {
    super(config || {
      id: 'athena',
      name: 'Athena Adapter',
      type: 'athena',
      connection: { url: 'http://localhost:8002' }
    });
  }

  async connect(): Promise<void> {
    const envBaseUrl = process.env.ATHENA_BASE_URL || process.env.ATHENA_URL
    const envToken = process.env.ATHENA_API_TOKEN || process.env.ATHENA_AUTH_TOKEN || process.env.ATHENA_TOKEN
    const envApiKey = process.env.ATHENA_API_KEY || process.env.ATHENA_KEY
    const envKeycloakUrl = process.env.ATHENA_KEYCLOAK_URL || process.env.KEYCLOAK_URL
    const envKeycloakRealm = process.env.ATHENA_KEYCLOAK_REALM || process.env.KEYCLOAK_REALM
    const envKeycloakClientId = process.env.ATHENA_KEYCLOAK_CLIENT_ID || process.env.KEYCLOAK_CLIENT_ID
    const envKeycloakClientSecret = process.env.ATHENA_KEYCLOAK_CLIENT_SECRET || process.env.KEYCLOAK_CLIENT_SECRET
    const envKeycloakUser = process.env.ATHENA_KEYCLOAK_USER || process.env.KEYCLOAK_USER
    const envKeycloakPassword = process.env.ATHENA_KEYCLOAK_PASSWORD || process.env.KEYCLOAK_PASSWORD

    const athenaUrl = (await this.configService.get<string>('athena.url')) || envBaseUrl
    const keycloakUrl = (await this.configService.get<string>('athena.keycloak.url')) || envKeycloakUrl
    const keycloakRealm = (await this.configService.get<string>('athena.keycloak.realm')) || envKeycloakRealm
    const keycloakClientId = (await this.configService.get<string>('athena.keycloak.clientId')) || envKeycloakClientId
    const keycloakClientSecret = (await this.configService.get<string>('athena.keycloak.clientSecret')) || envKeycloakClientSecret
    const keycloakUser = (await this.configService.get<string>('athena.keycloak.username')) || envKeycloakUser
    const keycloakPassword = (await this.configService.get<string>('athena.keycloak.password')) || envKeycloakPassword
    const token = (
      (await this.configService.get<string>('athena.apiToken')) ||
      (await this.configService.get<string>('athena.token')) ||
      (await this.configService.get<string>('athena.authToken')) ||
      envToken
    )
    const apiKey = (await this.configService.get<string>('athena.apiKey')) || envApiKey
    const mockSetting = await this.configService.get<boolean>('athena.mock')
    const isMock = typeof mockSetting === 'boolean' ? mockSetting : !athenaUrl

    if (athenaUrl) {
      this.config.connection.url = athenaUrl
      this.config.connection.baseURL = athenaUrl
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

    this.mockMode = isMock
    this.keycloakConfig = (keycloakUrl && keycloakRealm && keycloakClientId && keycloakUser && keycloakPassword)
      ? {
          url: keycloakUrl,
          realm: keycloakRealm,
          clientId: keycloakClientId,
          clientSecret: keycloakClientSecret,
          username: keycloakUser,
          password: keycloakPassword,
        }
      : null;

    if (!this.mockMode && (this.authToken || this.keycloakConfig)) {
      this.setTokenProvider({
        getToken: async () => this.getKeycloakToken(),
        onAuthError: () => this.invalidateAuthToken(),
      });
    }

    if (this.mockMode) {
      this.logger.info('Athena Adapter starting in MOCK mode');
      this.connected = true;
      this.onConnect();
      return;
    }

    this.logger.info(`Athena Adapter connecting to ${this.config.connection.url}`);
    await super.connect();
  }

  async healthCheck(): Promise<boolean> {
    if (this.mockMode) return true;
    try {
      const result = await this.query<{ status: string }>('/api/v1/health');
      return !!result.data?.[0]?.status;
    } catch {
      return this.testConnection();
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

  private async getKeycloakToken(): Promise<string | null> {
    if (this.authToken && this.authTokenExpiresAt > Date.now() + this.authBufferMs) {
      return this.authToken
    }
    if (!this.keycloakConfig) {
      return this.authToken
    }
    if (this.authTokenPromise) {
      return this.authTokenPromise
    }

    this.authTokenPromise = this.fetchKeycloakToken()
    try {
      return await this.authTokenPromise
    } finally {
      this.authTokenPromise = null
    }
  }

  private async fetchKeycloakToken(): Promise<string | null> {
    const keycloak = this.keycloakConfig
    if (!keycloak) return null

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: keycloak.clientId,
      username: keycloak.username,
      password: keycloak.password,
    })
    if (keycloak.clientSecret) {
      params.set('client_secret', keycloak.clientSecret)
    }

    try {
      const response = await fetch(`${keycloak.url}/realms/${keycloak.realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
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

  async listFolders(parentId?: string): Promise<QueryResult<AthenaFolder>> {
    if (this.mockMode) {
      return {
        data: [
          { id: 'f1', name: 'Project A', path: '/Project A', created_by: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { id: 'f2', name: 'Design', parent_id: 'f1', path: '/Project A/Design', created_by: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        ],
        metadata: { totalCount: 2 }
      };
    }
    const params = parentId ? { parent_id: parentId } : {};
    return this.query<AthenaFolder>('/api/v1/folders', [params]);
  }

  async searchDocuments(params: DocumentSearchParams): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      return this.getMockDocuments(params);
    }
    const limit = params.limit ?? 20
    const offset = params.offset ?? 0
    const query = (params.query ?? '').trim()

    if (!query && params.folder_id) {
      const page = Math.floor(offset / Math.max(limit, 1))
      const result = await this.query<AthenaSearchResponse>(
        `/api/v1/folders/${params.folder_id}/contents`,
        [{ page, size: limit }]
      )
      const payload = result.data?.[0] || {}
      const content = Array.isArray(payload.content) ? payload.content : []
      const filtered = content.filter((node) => this.isDocumentNode(node as AthenaNodeResponse))
      const mappedData = filtered.map((node) => this.mapNodeToDocument(node as AthenaNodeResponse))
      return {
        data: mappedData,
        metadata: { totalCount: payload.totalElements ?? mappedData.length },
        error: result.error,
      }
    }

    if (!query && !params.folder_id) {
      const rootsResult = await this.query<Record<string, unknown>>('/api/v1/folders/roots')
      const roots = Array.isArray(rootsResult.data) ? rootsResult.data : []
      const root = roots[0] as { id?: string } | undefined
      if (!root?.id) {
        return {
          data: [],
          metadata: { totalCount: 0 },
          error: rootsResult.error,
        }
      }

      const page = Math.floor(offset / Math.max(limit, 1))
      const result = await this.query<AthenaSearchResponse>(
        `/api/v1/folders/${root.id}/contents`,
        [{ page, size: limit }]
      )
      const payload = result.data?.[0] || {}
      const content = Array.isArray(payload.content) ? payload.content : []
      const filtered = content.filter((node) => this.isDocumentNode(node as AthenaNodeResponse))
      const mappedData = filtered.map((node) => this.mapNodeToDocument(node as AthenaNodeResponse))
      return {
        data: mappedData,
        metadata: { totalCount: payload.totalElements ?? mappedData.length },
        error: result.error,
      }
    }

    const page = Math.floor(offset / Math.max(limit, 1))
    const searchParams = {
      q: query,
      page,
      size: limit,
    }
    const result = await this.query<AthenaSearchResponse>('/api/v1/search', [searchParams])
    const payload = result.data?.[0] || {}
    const content = Array.isArray(payload.content) ? payload.content : []
    const filtered = content.filter((item) => this.isDocumentNode(item as AthenaNodeResponse))
    const mappedData = filtered.map((item) => this.mapSearchResult(item as Record<string, unknown>))

    return {
      data: mappedData,
      metadata: { totalCount: payload.totalElements ?? mappedData.length },
      error: result.error,
    }
  }

  private getMockDocuments(params?: DocumentSearchParams): QueryResult<AthenaDocument> {
    const docs: AthenaDocument[] = [
      { id: 'd1', name: 'Requirements.docx', type: 'document', size: 1024, path: '/Project A/Requirements.docx', version: '1.0', status: 'approved', created_by: 'user1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 'd2', name: 'Design.dwg', type: 'cad', size: 20480, path: '/Project A/Design/Design.dwg', version: '0.5', status: 'draft', created_by: 'user2', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    ];
    return { data: docs, metadata: { totalCount: docs.length } };
  }

  async getDocument(documentId: string): Promise<AthenaDocument | null> {
    if (this.mockMode) {
      const docs = this.getMockDocuments().data;
      return docs.find(d => d.id === documentId) || null;
    }
    const result = await this.query<AthenaNodeResponse>(`/api/v1/nodes/${documentId}`);
    const raw = result.data[0]
    return raw ? this.mapNodeToDocument(raw) : null;
  }

  // Preserve other methods with mock checks...
  async uploadDocument(params: any): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      return {
        data: [{
          id: `mock_doc_${Date.now()}`,
          name: params.name,
          type: params.type,
          size: 1000,
          path: `/uploads/${params.name}`,
          version: '1.0',
          status: 'draft',
          created_by: params.uploadedBy,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }],
        metadata: { totalCount: 1 }
      };
    }
    return this.select<AthenaDocument>('/api/v1/documents', {
      method: 'POST',
      data: params,
    })
  }

  async downloadDocument(documentId: string): Promise<Buffer> {
    if (this.mockMode) {
      return Buffer.from(`mock document ${documentId}`)
    }
    return this.download(`/api/v1/documents/${documentId}/download`)
  }

  async downloadVersion(documentId: string, versionId: string): Promise<Buffer> {
    if (this.mockMode) {
      return Buffer.from(`mock document ${documentId} version ${versionId}`)
    }
    return this.download(`/api/v1/documents/${documentId}/versions/${versionId}/download`)
  }

  async getVersionHistory(documentId: string): Promise<QueryResult<DocumentVersion>> {
    if (this.mockMode) {
      return {
        data: [
          {
            id: `ver_${documentId}_1`,
            document_id: documentId,
            version: '1.0',
            file_size: 1024,
            created_by: 'admin',
            created_at: new Date().toISOString(),
            comment: 'Initial version',
          },
        ],
        metadata: { totalCount: 1 },
      }
    }
    const result = await this.query<Record<string, unknown>>(`/api/v1/documents/${documentId}/versions`)
    const mappedData = result.data.map((raw) => this.mapVersion(raw))
    return {
      data: mappedData,
      metadata: result.metadata,
      error: result.error,
    }
  }

  private mapSearchResult(raw: Record<string, unknown>): AthenaDocument {
    const id = String(raw.id ?? '')
    const name = String(raw.name ?? '')
    const mimeType = String(raw.mimeType ?? raw.mime_type ?? raw.contentType ?? '')
    const size = Number(raw.fileSize ?? raw.size ?? 0)
    const path = String(raw.path ?? '')
    const createdBy = String(raw.createdBy ?? '')
    const createdAt = raw.createdDate ? String(raw.createdDate) : new Date().toISOString()
    const updatedAt = raw.lastModifiedDate ? String(raw.lastModifiedDate) : new Date().toISOString()

    return {
      id,
      name,
      type: mimeType || 'document',
      size: Number.isFinite(size) ? size : 0,
      path,
      version: '',
      status: 'draft',
      created_by: createdBy,
      created_at: createdAt,
      updated_at: updatedAt,
    }
  }

  private isDocumentNode(raw: AthenaNodeResponse): boolean {
    if (typeof raw.isFolder === 'boolean') {
      return !raw.isFolder
    }
    if (raw.nodeType) {
      return String(raw.nodeType).toUpperCase() === 'DOCUMENT'
    }
    return true
  }

  private mapNodeToDocument(raw: AthenaNodeResponse): AthenaDocument {
    const id = String(raw.id ?? '')
    const name = String(raw.name ?? '')
    const mimeType = String(raw.contentType ?? '')
    const size = Number(raw.size ?? 0)
    const path = String(raw.path ?? '')
    const createdBy = String(raw.createdBy ?? '')
    const createdAt = raw.createdDate ? String(raw.createdDate) : new Date().toISOString()
    const updatedAt = raw.lastModifiedDate ? String(raw.lastModifiedDate) : new Date().toISOString()

    return {
      id,
      name,
      type: mimeType || 'document',
      size: Number.isFinite(size) ? size : 0,
      path,
      version: raw.currentVersionLabel ?? '',
      status: 'draft',
      created_by: createdBy,
      created_at: createdAt,
      updated_at: updatedAt,
      checked_out_by: raw.locked ? raw.lastModifiedBy : undefined,
      checked_out_at: raw.locked ? updatedAt : undefined,
    }
  }

  private mapVersion(raw: Record<string, unknown>): DocumentVersion {
    return {
      id: String(raw.id ?? ''),
      document_id: String(raw.documentId ?? raw.document_id ?? ''),
      version: String(raw.versionLabel ?? raw.version ?? ''),
      file_size: Number(raw.size ?? raw.file_size ?? 0),
      created_by: String(raw.creator ?? raw.created_by ?? ''),
      created_at: raw.createdDate ? String(raw.createdDate) : new Date().toISOString(),
      comment: raw.comment ? String(raw.comment) : undefined,
    }
  }

  async getVersion(documentId: string, versionId: string): Promise<DocumentVersion | null> {
    if (this.mockMode) {
      const versions = this.getMockDocuments().data
      void versions
      return {
        id: versionId,
        document_id: documentId,
        version: '1.0',
        file_size: 1024,
        created_by: 'admin',
        created_at: new Date().toISOString(),
        comment: 'Mock version',
      }
    }
    const result = await this.query<DocumentVersion>(`/api/v1/documents/${documentId}/versions/${versionId}`)
    return result.data[0] || null
  }

  async checkinDocument(params: {
    documentId: string
    file: Buffer | Blob
    fileName: string
    comment?: string
    userId: string
  }): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(params.documentId)
      if (!doc) {
        return { data: [], error: new Error(`Document not found: ${params.documentId}`) }
      }
      return {
        data: [
          {
            ...doc,
            version: `${Number.parseFloat(doc.version || '1') + 0.1}`,
            updated_at: new Date().toISOString(),
            checked_out_by: undefined,
            checked_out_at: undefined,
          },
        ],
        metadata: { totalCount: 1 },
      }
    }

    return this.select<AthenaDocument>(`/api/v1/documents/${params.documentId}/checkin`, {
      method: 'POST',
      data: params,
    })
  }

  async checkoutDocument(documentId: string, userId: string): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [{ ...doc, checked_out_by: userId, checked_out_at: new Date().toISOString() }],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}/checkout`, {
      method: 'POST',
      data: { userId },
    })
  }

  async cancelCheckout(documentId: string, userId?: string): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [{ ...doc, checked_out_by: undefined, checked_out_at: undefined }],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}/checkout`, {
      method: 'DELETE',
      data: userId ? { userId } : undefined,
    })
  }

  async restoreVersion(documentId: string, versionId: string): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [{ ...doc, version: versionId, updated_at: new Date().toISOString() }],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}/versions/${versionId}/restore`, {
      method: 'POST',
    })
  }

  async deleteDocument(documentId: string): Promise<QueryResult<unknown>> {
    if (this.mockMode) {
      return { data: [], metadata: { totalCount: 0 } }
    }
    return this.select(`/api/v1/documents/${documentId}`, { method: 'DELETE' })
  }

  async updateDocument(documentId: string, update: Record<string, unknown>): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [{ ...doc, ...update, updated_at: new Date().toISOString() } as AthenaDocument],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}`, {
      method: 'PUT',
      data: update,
    })
  }

  async copyDocument(documentId: string, targetFolderId: string, newName?: string): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [
          {
            ...doc,
            id: `copy_${Date.now()}`,
            name: newName || doc.name,
            folder_id: targetFolderId,
            path: `${targetFolderId}/${newName || doc.name}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}/copy`, {
      method: 'POST',
      data: { targetFolderId, newName },
    })
  }

  async moveDocument(documentId: string, targetFolderId: string): Promise<QueryResult<AthenaDocument>> {
    if (this.mockMode) {
      const doc = await this.getDocument(documentId)
      if (!doc) return { data: [], error: new Error(`Document not found: ${documentId}`) }
      return {
        data: [{ ...doc, folder_id: targetFolderId, updated_at: new Date().toISOString() }],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaDocument>(`/api/v1/documents/${documentId}/move`, {
      method: 'POST',
      data: { targetFolderId },
    })
  }

  async createFolder(params: { name: string; parentId?: string; createdBy: string }): Promise<QueryResult<AthenaFolder>> {
    if (this.mockMode) {
      const now = new Date().toISOString()
      return {
        data: [
          {
            id: `folder_${Date.now()}`,
            name: params.name,
            parent_id: params.parentId,
            path: params.parentId ? `${params.parentId}/${params.name}` : `/${params.name}`,
            created_by: params.createdBy,
            created_at: now,
            updated_at: now,
          },
        ],
        metadata: { totalCount: 1 },
      }
    }
    return this.select<AthenaFolder>('/api/v1/folders', { method: 'POST', data: params })
  }

  async deleteFolder(folderId: string): Promise<QueryResult<unknown>> {
    if (this.mockMode) {
      return { data: [], metadata: { totalCount: 0 } }
    }
    return this.select(`/api/v1/folders/${folderId}`, { method: 'DELETE' })
  }
}
