export type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl: string
  getToken: () => Promise<string> | string
  fetch?: FetchLike
}

export interface ClientResponse<T = unknown> {
  status: number
  etag?: string
  json: T
}

export interface ClientTextResponse {
  status: number
  etag?: string
  text: string
  contentDisposition?: string
}

export interface RequestClient {
  request: <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ) => Promise<ClientResponse<T>>
  requestWithRetry: <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
    retries?: number,
  ) => Promise<ClientResponse<T>>
  requestText?: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<ClientTextResponse>
}

export interface ApiError {
  code?: string
  message?: string
  [key: string]: unknown
}

export interface ApiEnvelope<T> {
  ok?: boolean
  data?: T
  error?: ApiError
}

export interface DirectApiEnvelope<T, M = unknown> {
  success?: boolean
  data?: T
  metadata?: M
  error?: string | ApiError
}

export interface PaginationOptions {
  limit?: number
  offset?: number
}

export interface PlmListResponse<T = Record<string, unknown>> {
  items: T[]
  total?: number
  limit?: number
  offset?: number
}

export interface PlmApprovalHistoryResponse<T = Record<string, unknown>> {
  approvalId: string
  items: T[]
  total?: number
}

export interface ListPlmProductsParams extends PaginationOptions {
  query?: string
  status?: string
  itemType?: string
}

export interface GetPlmProductParams {
  itemType?: string
  itemNumber?: string
}

export interface GetPlmBomParams {
  depth?: number
  effectiveAt?: string
}

export interface ListPlmDocumentsParams extends PaginationOptions {
  productId: string
  role?: string
}

export interface ListPlmApprovalsParams extends PaginationOptions {
  productId?: string
  status?: string
  requesterId?: string
}

export interface GetPlmWhereUsedParams {
  itemId: string
  recursive?: boolean
  maxLevels?: number
}

export interface ComparePlmBomParams {
  leftId: string
  rightId: string
  leftType?: 'item' | 'version'
  rightType?: 'item' | 'version'
  lineKey?: string
  compareMode?: string
  maxLevels?: number
  includeChildFields?: boolean
  includeSubstitutes?: boolean
  includeEffectivity?: boolean
  includeRelationshipProps?: string[]
  effectiveAt?: string
}

export interface PlmApprovalActionParams {
  approvalId: string
  version: number
  reason?: string
  comment?: string
}

export type PlmWorkbenchTeamViewKind =
  | 'documents'
  | 'cad'
  | 'approvals'
  | 'workbench'
  | 'audit'

export type PlmTeamFilterPresetKind = 'bom' | 'where-used'

export type PlmWorkbenchBatchAction = 'archive' | 'restore' | 'delete'

export type PlmCollaborativeAuditResourceType =
  | 'plm-team-preset-batch'
  | 'plm-team-preset-default'
  | 'plm-team-view-batch'
  | 'plm-team-view-default'

export interface ListPlmCollaborativeAuditLogsParams {
  page?: number
  pageSize?: number
  q?: string
  actorId?: string
  action?: string
  resourceType?: PlmCollaborativeAuditResourceType | ''
  kind?: string
  from?: string
  to?: string
}

export interface GetPlmCollaborativeAuditSummaryParams {
  windowMinutes?: number
  limit?: number
}

export interface ExportPlmCollaborativeAuditLogsParams extends ListPlmCollaborativeAuditLogsParams {
  limit?: number
}

export interface PlmCollaborativeAuditLogsResponse<T = Record<string, unknown>> {
  items: T[]
  page?: number
  pageSize?: number
  total?: number
  metadata?: {
    resourceTypes?: PlmCollaborativeAuditResourceType[]
  }
}

export interface PlmCollaborativeAuditSummaryRow {
  action?: string
  resourceType?: PlmCollaborativeAuditResourceType
  total?: number
}

export interface PlmCollaborativeAuditSummaryResponse {
  windowMinutes?: number
  actions?: PlmCollaborativeAuditSummaryRow[]
  resourceTypes?: PlmCollaborativeAuditSummaryRow[]
}

export interface PlmCollaborativeAuditCsvExportResponse {
  filename: string
  csvText: string
}

export interface PlmWorkbenchBatchResult<T = Record<string, unknown>> {
  action?: string
  processedIds?: string[]
  skippedIds?: string[]
  items?: T[]
  metadata?: {
    requestedTotal?: number
    processedTotal?: number
    skippedTotal?: number
    processedKinds?: string[]
  }
}

export interface PlmTeamViewListMetadata {
  total?: number
  activeTotal?: number
  archivedTotal?: number
  tenantId?: string
  kind?: PlmWorkbenchTeamViewKind | 'all'
  defaultViewId?: string | null
}

export interface PlmTeamFilterPresetListMetadata {
  total?: number
  activeTotal?: number
  archivedTotal?: number
  tenantId?: string
  kind?: PlmTeamFilterPresetKind | 'all'
  defaultPresetId?: string | null
}

export interface PlmDirectListResponse<T = Record<string, unknown>, M = Record<string, unknown>> {
  items: T[]
  metadata?: M
}

export interface SavePlmWorkbenchTeamViewParams<TState = unknown> {
  kind: PlmWorkbenchTeamViewKind
  name: string
  state: TState
  isDefault?: boolean
}

export interface SavePlmTeamFilterPresetParams<TState = unknown> {
  kind: PlmTeamFilterPresetKind
  name: string
  state: TState
}

export interface AddPlmSubstituteParams {
  bomLineId: string
  substituteItemId: string
  properties?: Record<string, unknown>
}

export interface RemovePlmSubstituteParams {
  bomLineId: string
  substituteId: string
}

export interface GetPlmCadDiffParams {
  fileId: string
  otherFileId: string
}

export interface UpdatePlmCadPayload {
  fileId: string
  payload: Record<string, unknown>
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const searchParams = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return
    searchParams.set(key, String(value))
  })

  return searchParams.toString()
}

function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const query = buildQueryString(params)
  return query ? `${path}?${query}` : path
}

function withPagination(pagination?: PaginationOptions): PaginationOptions | undefined {
  if (!pagination) return undefined
  if (pagination.limit === undefined && pagination.offset === undefined) return undefined
  return {
    limit: pagination.limit ?? 100,
    offset: pagination.offset ?? 0,
  }
}

function toRequestClient(clientOrOptions: ClientOptions | RequestClient): RequestClient {
  if ('request' in clientOrOptions && 'requestWithRetry' in clientOrOptions) {
    return clientOrOptions
  }
  return createClient(clientOrOptions)
}

function buildApiEnvelopeError(error: ApiError | undefined, fallback: string): Error {
  const nextError = new Error(error?.message || fallback) as Error & ApiError
  if (!error || typeof error !== 'object') {
    return nextError
  }

  Object.assign(nextError, error)
  if (!nextError.message) {
    nextError.message = fallback
  }
  return nextError
}

function unwrapData<T>(response: ClientResponse<ApiEnvelope<T>>, fallback: string): T {
  const envelope = response.json

  if (response.status >= 400) {
    throw buildApiEnvelopeError(envelope?.error, fallback)
  }

  if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
    if (envelope.ok === false) {
      throw buildApiEnvelopeError(envelope.error, fallback)
    }
    return envelope.data as T
  }

  return response.json as unknown as T
}

function buildDirectApiError(error: string | ApiError | undefined, fallback: string): Error {
  if (typeof error === 'string' && error.trim()) {
    return new Error(error.trim())
  }

  const nextError = new Error(
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : fallback,
  ) as Error & ApiError
  if (!error || typeof error !== 'object') {
    return nextError
  }

  Object.assign(nextError, error)
  if (!nextError.message) {
    nextError.message = fallback
  }
  return nextError
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function unwrapDirectData<T>(response: ClientResponse<DirectApiEnvelope<T>>, fallback: string): T {
  return unwrapDirectEnvelope(response, fallback).data
}

function unwrapDirectEnvelope<T, M = unknown>(
  response: ClientResponse<DirectApiEnvelope<T, M>>,
  fallback: string,
): { data: T; metadata?: M } {
  const envelope = response.json
  const directError = envelope && typeof envelope === 'object' && 'error' in envelope
    ? (envelope as DirectApiEnvelope<T, M>).error
    : undefined

  if (response.status >= 400) {
    throw buildDirectApiError(directError, fallback)
  }

  if (envelope && typeof envelope === 'object' && ('success' in envelope || 'data' in envelope || 'error' in envelope)) {
    if ((envelope as DirectApiEnvelope<T, M>).success === false) {
      throw buildDirectApiError(directError, fallback)
    }
    return {
      data: (envelope as DirectApiEnvelope<T, M>).data as T,
      metadata: (envelope as DirectApiEnvelope<T, M>).metadata,
    }
  }

  return {
    data: response.json as unknown as T,
  }
}

async function requestPlmQuery<T>(
  client: RequestClient,
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const response = await client.request<ApiEnvelope<T>>('POST', '/api/federation/plm/query', body)
  return unwrapData(response, fallback)
}

async function requestPlmMutate<T>(
  client: RequestClient,
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const response = await client.request<ApiEnvelope<T>>('POST', '/api/federation/plm/mutate', body)
  return unwrapData(response, fallback)
}

async function requestPlmGet<T>(
  client: RequestClient,
  path: string,
  fallback: string,
): Promise<T> {
  const response = await client.request<ApiEnvelope<T>>('GET', path)
  return unwrapData(response, fallback)
}

async function requestDirectApi<T>(
  client: RequestClient,
  method: string,
  path: string,
  fallback: string,
  body?: unknown,
): Promise<T> {
  const response = await client.request<DirectApiEnvelope<T>>(method, path, body)
  return unwrapDirectData(response, fallback)
}

async function requestDirectEnvelope<T, M = unknown>(
  client: RequestClient,
  method: string,
  path: string,
  fallback: string,
  body?: unknown,
): Promise<{ data: T; metadata?: M }> {
  const response = await client.request<DirectApiEnvelope<T, M>>(method, path, body)
  return unwrapDirectEnvelope(response, fallback)
}

async function requestDirectText(
  client: RequestClient,
  method: string,
  path: string,
  fallback: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ClientTextResponse> {
  if (!client.requestText) {
    throw new Error(fallback)
  }

  const response = await client.requestText(method, path, body, headers)
  if (response.status >= 400) {
    const envelope = parseRecord(response.text)
    const directError = envelope && 'error' in envelope
      ? (envelope as DirectApiEnvelope<unknown>).error
      : undefined
    throw buildDirectApiError(directError, response.text.trim() || fallback)
  }

  return response
}

export function createClient(opts: ClientOptions): RequestClient {
  const f = opts.fetch || fetch

  async function buildHeaders(
    body?: unknown,
    ifMatch?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const token = await opts.getToken()
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(extraHeaders || {}),
    }

    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (ifMatch) {
      headers['if-match'] = ifMatch
    }

    return headers
  }

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<ClientResponse<T>> {
    const headers = await buildHeaders(body, ifMatch)

    const res = await f(joinUrl(opts.baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const etag = res.headers.get('etag') || undefined
    const json = await res.json().catch(() => ({} as T))

    return { status: res.status, etag, json }
  }

  async function requestText(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ClientTextResponse> {
    const headers = await buildHeaders(body, undefined, extraHeaders)
    const res = await f(joinUrl(opts.baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const etag = res.headers.get('etag') || undefined
    const text = await res.text()

    return {
      status: res.status,
      etag,
      text,
      contentDisposition: res.headers.get('content-disposition') || undefined,
    }
  }

  async function requestWithRetry<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
    retries = 1,
  ): Promise<ClientResponse<T>> {
    const response = await request<T>(method, path, body, etag)
    if (response.status === 409 && retries > 0) {
      const getPath = path.replace(/\/(approve|reject|return|revoke)$/, '')
      const latest = await request('GET', getPath)
      return request<T>(method, path, body, latest.etag)
    }
    return response
  }

  return { request, requestWithRetry, requestText }
}

export function createPlmFederationClient(clientOrOptions: ClientOptions | RequestClient) {
  const client = toRequestClient(clientOrOptions)

  return {
    async listProducts<T = Record<string, unknown>>(
      params: ListPlmProductsParams = {},
    ): Promise<PlmListResponse<T>> {
      const filters: Record<string, unknown> = {}

      if (params.query) filters.query = params.query
      if (params.status) filters.status = params.status
      if (params.itemType) filters.itemType = params.itemType

      return requestPlmQuery<PlmListResponse<T>>(
        client,
        {
          operation: 'products',
          pagination: withPagination(params),
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        },
        'Failed to load PLM products',
      )
    },

    async getProduct<T = Record<string, unknown>>(
      productId: string,
      params: GetPlmProductParams = {},
    ): Promise<T> {
      return requestPlmGet<T>(
        client,
        withQuery(`/api/federation/plm/products/${encodeURIComponent(productId)}`, {
          itemType: params.itemType,
          itemNumber: params.itemNumber,
        }),
        'Failed to load PLM product',
      )
    },

    async getBom<T = Record<string, unknown>>(
      productId: string,
      params: GetPlmBomParams = {},
    ): Promise<PlmListResponse<T>> {
      return requestPlmGet<PlmListResponse<T>>(
        client,
        withQuery(`/api/federation/plm/products/${encodeURIComponent(productId)}/bom`, {
          depth: params.depth,
          effective_at: params.effectiveAt,
        }),
        'Failed to load PLM BOM',
      )
    },

    async listDocuments<T = Record<string, unknown>>(
      params: ListPlmDocumentsParams,
    ): Promise<PlmListResponse<T>> {
      const filters: Record<string, unknown> = {}
      if (params.role) filters.role = params.role

      return requestPlmQuery<PlmListResponse<T>>(
        client,
        {
          operation: 'documents',
          productId: params.productId,
          pagination: withPagination(params) ?? { limit: 100, offset: 0 },
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        },
        'Failed to load PLM documents',
      )
    },

    async listApprovals<T = Record<string, unknown>>(
      params: ListPlmApprovalsParams = {},
    ): Promise<PlmListResponse<T>> {
      const filters: Record<string, unknown> = {}

      if (params.status && params.status !== 'all') filters.status = params.status
      if (params.requesterId) filters.requesterId = params.requesterId

      return requestPlmQuery<PlmListResponse<T>>(
        client,
        {
          operation: 'approvals',
          productId: params.productId,
          pagination: withPagination(params),
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        },
        'Failed to load PLM approvals',
      )
    },

    async getApprovalHistory<T = Record<string, unknown>>(
      approvalId: string,
    ): Promise<PlmApprovalHistoryResponse<T>> {
      return requestPlmQuery<PlmApprovalHistoryResponse<T>>(
        client,
        {
          operation: 'approval_history',
          approvalId,
        },
        'Failed to load PLM approval history',
      )
    },

    async approveApproval<T = Record<string, unknown>>(
      params: PlmApprovalActionParams,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'approval_approve',
          approvalId: params.approvalId,
          version: params.version,
          comment: params.comment,
        },
        'Failed to approve PLM approval',
      )
    },

    async rejectApproval<T = Record<string, unknown>>(
      params: PlmApprovalActionParams,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'approval_reject',
          approvalId: params.approvalId,
          version: params.version,
          reason: params.reason,
          comment: params.comment,
        },
        'Failed to reject PLM approval',
      )
    },

    async getWhereUsed<T = Record<string, unknown>>(
      params: GetPlmWhereUsedParams,
    ): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'where_used',
          itemId: params.itemId,
          recursive: params.recursive,
          maxLevels: params.maxLevels,
        },
        'Failed to load PLM where-used data',
      )
    },

    async compareBom<T = Record<string, unknown>>(
      params: ComparePlmBomParams,
    ): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'bom_compare',
          leftId: params.leftId,
          rightId: params.rightId,
          leftType: params.leftType ?? 'item',
          rightType: params.rightType ?? 'item',
          lineKey: params.lineKey,
          compareMode: params.compareMode,
          maxLevels: params.maxLevels,
          includeChildFields: params.includeChildFields,
          includeSubstitutes: params.includeSubstitutes,
          includeEffectivity: params.includeEffectivity,
          includeRelationshipProps: params.includeRelationshipProps,
          effectiveAt: params.effectiveAt,
        },
        'Failed to compare PLM BOMs',
      )
    },

    async getBomCompareSchema<T = Record<string, unknown>>(): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'bom_compare_schema',
        },
        'Failed to load PLM BOM compare schema',
      )
    },

    async listSubstitutes<T = Record<string, unknown>>(
      bomLineId: string,
    ): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'substitutes',
          bomLineId,
        },
        'Failed to load PLM substitutes',
      )
    },

    async addSubstitute<T = Record<string, unknown>>(
      params: AddPlmSubstituteParams,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'substitutes_add',
          bomLineId: params.bomLineId,
          substituteItemId: params.substituteItemId,
          properties: params.properties,
        },
        'Failed to add PLM substitute',
      )
    },

    async removeSubstitute<T = Record<string, unknown>>(
      params: RemovePlmSubstituteParams,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'substitutes_remove',
          bomLineId: params.bomLineId,
          substituteId: params.substituteId,
        },
        'Failed to remove PLM substitute',
      )
    },

    async getCadProperties<T = Record<string, unknown>>(fileId: string): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_properties',
          fileId,
        },
        'Failed to load PLM CAD properties',
      )
    },

    async getCadViewState<T = Record<string, unknown>>(fileId: string): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_view_state',
          fileId,
        },
        'Failed to load PLM CAD view state',
      )
    },

    async getCadReview<T = Record<string, unknown>>(fileId: string): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_review',
          fileId,
        },
        'Failed to load PLM CAD review',
      )
    },

    async getCadHistory<T = Record<string, unknown>>(fileId: string): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_history',
          fileId,
        },
        'Failed to load PLM CAD history',
      )
    },

    async getCadDiff<T = Record<string, unknown>>(
      params: GetPlmCadDiffParams,
    ): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_diff',
          fileId: params.fileId,
          otherFileId: params.otherFileId,
        },
        'Failed to load PLM CAD diff',
      )
    },

    async getCadMeshStats<T = Record<string, unknown>>(fileId: string): Promise<T> {
      return requestPlmQuery<T>(
        client,
        {
          operation: 'cad_mesh_stats',
          fileId,
        },
        'Failed to load PLM CAD mesh stats',
      )
    },

    async updateCadProperties<T = Record<string, unknown>>(
      params: UpdatePlmCadPayload,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'cad_properties_update',
          fileId: params.fileId,
          payload: params.payload,
        },
        'Failed to update PLM CAD properties',
      )
    },

    async updateCadViewState<T = Record<string, unknown>>(
      params: UpdatePlmCadPayload,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'cad_view_state_update',
          fileId: params.fileId,
          payload: params.payload,
        },
        'Failed to update PLM CAD view state',
      )
    },

    async updateCadReview<T = Record<string, unknown>>(
      params: UpdatePlmCadPayload,
    ): Promise<T> {
      return requestPlmMutate<T>(
        client,
        {
          operation: 'cad_review_update',
          fileId: params.fileId,
          payload: params.payload,
        },
        'Failed to update PLM CAD review',
      )
    },
  }
}

export function createPlmWorkbenchClient(clientOrOptions: ClientOptions | RequestClient) {
  const client = toRequestClient(clientOrOptions)

  return {
    async listTeamViews<T = Record<string, unknown>>(
      kind?: PlmWorkbenchTeamViewKind,
    ): Promise<PlmDirectListResponse<T, PlmTeamViewListMetadata>> {
      const response = await requestDirectEnvelope<T[], PlmTeamViewListMetadata>(
        client,
        'GET',
        withQuery('/api/plm-workbench/views/team', { kind }),
        'Failed to load PLM team views',
      )
      return {
        items: Array.isArray(response.data) ? response.data : [],
        metadata: response.metadata,
      }
    },

    async saveTeamView<T = Record<string, unknown>, TState = unknown>(
      params: SavePlmWorkbenchTeamViewParams<TState>,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        '/api/plm-workbench/views/team',
        'Failed to save PLM team view',
        params,
      )
    },

    async renameTeamView<T = Record<string, unknown>>(
      id: string,
      name: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'PATCH',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}`,
        'Failed to rename PLM team view',
        { name },
      )
    },

    async deleteTeamView<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'DELETE',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}`,
        'Failed to delete PLM team view',
      )
    },

    async duplicateTeamView<T = Record<string, unknown>>(
      id: string,
      name?: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/duplicate`,
        'Failed to duplicate PLM team view',
        name ? { name } : {},
      )
    },

    async transferTeamView<T = Record<string, unknown>>(
      id: string,
      ownerUserId: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/transfer`,
        'Failed to transfer PLM team view',
        { ownerUserId },
      )
    },

    async setTeamViewDefault<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/default`,
        'Failed to set PLM team view default',
      )
    },

    async clearTeamViewDefault<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'DELETE',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/default`,
        'Failed to clear PLM team view default',
      )
    },

    async archiveTeamView<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/archive`,
        'Failed to archive PLM team view',
      )
    },

    async restoreTeamView<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/views/team/${encodeURIComponent(id)}/restore`,
        'Failed to restore PLM team view',
      )
    },

    async batchTeamViews<T = Record<string, unknown>>(
      action: PlmWorkbenchBatchAction,
      ids: string[],
    ): Promise<PlmWorkbenchBatchResult<T>> {
      const response = await requestDirectEnvelope<
        Omit<PlmWorkbenchBatchResult<T>, 'metadata'>,
        PlmWorkbenchBatchResult<T>['metadata']
      >(
        client,
        'POST',
        '/api/plm-workbench/views/team/batch',
        'Failed to batch update PLM team views',
        { action, ids },
      )
      return {
        ...response.data,
        metadata: response.metadata,
      }
    },

    async listTeamFilterPresets<T = Record<string, unknown>>(
      kind?: PlmTeamFilterPresetKind,
    ): Promise<PlmDirectListResponse<T, PlmTeamFilterPresetListMetadata>> {
      const response = await requestDirectEnvelope<T[], PlmTeamFilterPresetListMetadata>(
        client,
        'GET',
        withQuery('/api/plm-workbench/filter-presets/team', { kind }),
        'Failed to load PLM team filter presets',
      )
      return {
        items: Array.isArray(response.data) ? response.data : [],
        metadata: response.metadata,
      }
    },

    async saveTeamFilterPreset<T = Record<string, unknown>, TState = unknown>(
      params: SavePlmTeamFilterPresetParams<TState>,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        '/api/plm-workbench/filter-presets/team',
        'Failed to save PLM team filter preset',
        params,
      )
    },

    async renameTeamFilterPreset<T = Record<string, unknown>>(
      id: string,
      name: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'PATCH',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}`,
        'Failed to rename PLM team filter preset',
        { name },
      )
    },

    async deleteTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'DELETE',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}`,
        'Failed to delete PLM team filter preset',
      )
    },

    async duplicateTeamFilterPreset<T = Record<string, unknown>>(
      id: string,
      name?: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/duplicate`,
        'Failed to duplicate PLM team filter preset',
        name ? { name } : {},
      )
    },

    async transferTeamFilterPreset<T = Record<string, unknown>>(
      id: string,
      ownerUserId: string,
    ): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/transfer`,
        'Failed to transfer PLM team filter preset',
        { ownerUserId },
      )
    },

    async setTeamFilterPresetDefault<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/default`,
        'Failed to set PLM team filter preset default',
      )
    },

    async clearTeamFilterPresetDefault<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'DELETE',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/default`,
        'Failed to clear PLM team filter preset default',
      )
    },

    async archiveTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/archive`,
        'Failed to archive PLM team filter preset',
      )
    },

    async restoreTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T> {
      return requestDirectApi<T>(
        client,
        'POST',
        `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/restore`,
        'Failed to restore PLM team filter preset',
      )
    },

    async batchTeamFilterPresets<T = Record<string, unknown>>(
      action: PlmWorkbenchBatchAction,
      ids: string[],
    ): Promise<PlmWorkbenchBatchResult<T>> {
      const response = await requestDirectEnvelope<
        Omit<PlmWorkbenchBatchResult<T>, 'metadata'>,
        PlmWorkbenchBatchResult<T>['metadata']
      >(
        client,
        'POST',
        '/api/plm-workbench/filter-presets/team/batch',
        'Failed to batch update PLM team filter presets',
        { action, ids },
      )
      return {
        ...response.data,
        metadata: response.metadata,
      }
    },

    async listCollaborativeAuditLogs<T = Record<string, unknown>>(
      params: ListPlmCollaborativeAuditLogsParams = {},
    ): Promise<PlmCollaborativeAuditLogsResponse<T>> {
      const response = await requestDirectEnvelope<
        {
          items?: T[]
          page?: number
          pageSize?: number
          total?: number
        },
        {
          resourceTypes?: PlmCollaborativeAuditResourceType[]
        }
      >(
        client,
        'GET',
        withQuery('/api/plm-workbench/audit-logs', {
          page: params.page,
          pageSize: params.pageSize,
          q: params.q,
          actorId: params.actorId,
          action: params.action,
          resourceType: params.resourceType,
          kind: params.kind,
          from: params.from,
          to: params.to,
        }),
        'Failed to load PLM collaborative audit logs',
      )
      return {
        items: Array.isArray(response.data?.items) ? response.data.items : [],
        page: response.data?.page,
        pageSize: response.data?.pageSize,
        total: response.data?.total,
        metadata: response.metadata,
      }
    },

    async getCollaborativeAuditSummary(
      params: GetPlmCollaborativeAuditSummaryParams = {},
    ): Promise<PlmCollaborativeAuditSummaryResponse> {
      return requestDirectApi<PlmCollaborativeAuditSummaryResponse>(
        client,
        'GET',
        withQuery('/api/plm-workbench/audit-logs/summary', {
          windowMinutes: params.windowMinutes,
          limit: params.limit,
        }),
        'Failed to load PLM collaborative audit summary',
      )
    },

    async exportCollaborativeAuditLogsCsv(
      params: ExportPlmCollaborativeAuditLogsParams = {},
    ): Promise<PlmCollaborativeAuditCsvExportResponse> {
      const response = await requestDirectText(
        client,
        'GET',
        withQuery('/api/plm-workbench/audit-logs/export.csv', {
          q: params.q,
          actorId: params.actorId,
          action: params.action,
          resourceType: params.resourceType,
          kind: params.kind,
          from: params.from,
          to: params.to,
          limit: params.limit,
        }),
        'Failed to export PLM collaborative audit logs',
        undefined,
        { accept: 'text/csv' },
      )

      const filename = response.contentDisposition?.match(/filename=\"?([^\";]+)\"?/)?.[1] || 'plm-collaborative-audit.csv'
      return {
        filename,
        csvText: response.text,
      }
    },
  }
}
