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

export function createClient(opts: ClientOptions): RequestClient {
  const f = opts.fetch || fetch

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: string,
  ): Promise<ClientResponse<T>> {
    const token = await opts.getToken()
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    }

    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    if (ifMatch) {
      headers['if-match'] = ifMatch
    }

    const res = await f(joinUrl(opts.baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const etag = res.headers.get('etag') || undefined
    const json = await res.json().catch(() => ({} as T))

    return { status: res.status, etag, json }
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

  return { request, requestWithRetry }
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
    ): Promise<{ items?: T[] }> {
      return requestPlmQuery<{ items?: T[] }>(
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
