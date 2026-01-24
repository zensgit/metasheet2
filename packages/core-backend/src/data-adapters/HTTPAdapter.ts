// Axios types (optional dependency) - proper interfaces to avoid `any`
interface AxiosRequestConfig {
  url?: string;
  method?: string;
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  auth?: { username: string; password: string };
  responseType?: string;
}

interface AxiosResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AxiosRequestConfig;
}

interface AxiosInstance {
  defaults: {
    headers: {
      common: Record<string, string>;
    };
    auth?: { username: string; password: string };
  };
  interceptors: {
    request: {
      use(
        onFulfilled: (config: AxiosRequestConfig) => AxiosRequestConfig | Promise<AxiosRequestConfig>,
        onRejected: (error: unknown) => Promise<never>
      ): void;
    };
    response: {
      use(
        onFulfilled: (response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>,
        onRejected: (error: unknown) => Promise<never>
      ): void;
    };
  };
  create(config: AxiosRequestConfig): AxiosInstance;
  request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  head<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}

interface AxiosStatic {
  create(config?: AxiosRequestConfig): AxiosInstance;
  default: AxiosStatic;
}

// Dynamic axios import
let axios: AxiosStatic | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  axios = require('axios').default as AxiosStatic
} catch {
  // axios not installed
}
import type {
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo
} from './BaseAdapter';
import {
  BaseDataAdapter,
  DataSourceConfig as _DataSourceConfig
} from './BaseAdapter'

interface HTTPQueryOptions extends QueryOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  params?: Record<string, unknown>
  data?: unknown
  endpoint?: string
}

interface EndpointConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  transformRequest?: (data: unknown) => unknown;
  transformResponse?: (data: unknown) => unknown;
}

interface BatchRequestItem {
  method: string;
  endpoint: string;
  data?: unknown;
  params?: unknown;
}

interface TokenProvider {
  getToken: () => Promise<string | null>;
  onAuthError?: () => void;
}

export class HTTPAdapter extends BaseDataAdapter {
  protected client: AxiosInstance | null = null
  private endpoints: Map<string, EndpointConfig> = new Map()
  private tokenProvider: TokenProvider | null = null

  setTokenProvider(provider: TokenProvider): void {
    this.tokenProvider = provider
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }

    if (!axios) {
      throw new Error('axios package is not installed')
    }

    try {
      const baseURL = String(this.config.connection.baseURL || this.config.connection.url || '')
      const timeout = typeof this.config.options?.timeout === 'number' ? this.config.options.timeout : 30000
      const customHeaders = this.config.connection.headers as Record<string, string> | undefined

      this.client = axios.create({
        baseURL,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          ...customHeaders
        }
      })

      // Add auth if provided
      if (this.config.credentials) {
        const apiKey = this.config.credentials.apiKey
        const bearerToken = this.config.credentials.bearerToken
        const username = this.config.credentials.username
        const password = this.config.credentials.password

        if (apiKey) {
          this.client.defaults.headers.common['X-API-Key'] = String(apiKey)
        } else if (bearerToken) {
          this.client.defaults.headers.common['Authorization'] = `Bearer ${String(bearerToken)}`
        } else if (username && password) {
          this.client.defaults.auth = {
            username: String(username),
            password: String(password)
          }
        }
      }

      // Add request interceptor for logging
      this.client.interceptors.request.use(
        async (config: AxiosRequestConfig) => {
          if (this.tokenProvider?.getToken) {
            const token = await this.tokenProvider.getToken()
            if (token) {
              config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` }
            }
          }
          this.emit('request', { method: config.method, url: config.url })
          return config
        },
        (error: unknown) => {
          this.emit('error', { error })
          return Promise.reject(error)
        }
      )

      // Add response interceptor for error handling
      this.client.interceptors.response.use(
        (response: AxiosResponse) => {
          this.emit('response', { status: response.status, url: response.config.url })
          return response
        },
        (error: unknown) => {
          const status = (error as { response?: { status?: number } })?.response?.status
          if (status === 401 && this.tokenProvider?.onAuthError) {
            this.tokenProvider.onAuthError()
          }
          this.emit('error', { error })
          return Promise.reject(error)
        }
      )

      // Register predefined endpoints if provided
      if (this.config.options?.endpoints) {
        for (const [name, endpoint] of Object.entries(this.config.options.endpoints)) {
          this.registerEndpoint(name, endpoint as EndpointConfig)
        }
      }

      this.connected = true
      await this.onConnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to initialize HTTP adapter: ${error}`)
    }
  }

  async disconnect(): Promise<void> {
    this.client = null
    this.endpoints.clear()
    this.connected = false
    await this.onDisconnect()
  }

  isConnected(): boolean {
    return this.connected && this.client !== null
  }

  async testConnection(): Promise<boolean> {
    if (!this.client) {
      return false
    }

    try {
      const healthEndpoint = String(this.config.options?.healthCheckEndpoint || '/health')
      const response = await this.client.get(healthEndpoint)
      return response.status >= 200 && response.status < 300
    } catch {
      // Try a HEAD request to base URL as fallback
      try {
        const response = await this.client.head('/')
        return response.status >= 200 && response.status < 300
      } catch {
        return false
      }
    }
  }

  registerEndpoint(name: string, config: EndpointConfig): void {
    this.endpoints.set(name, config)
  }

  async query<T = unknown>(endpoint: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const endpointConfig = this.endpoints.get(endpoint)
    const executeRequest = async (): Promise<QueryResult<T>> => {
      if (endpointConfig) {
        const requestConfig: AxiosRequestConfig = {
          url: endpointConfig.url,
          method: endpointConfig.method,
          headers: endpointConfig.headers
        }

        // Apply request transformation if provided
        if (params && endpointConfig.transformRequest) {
          requestConfig.data = endpointConfig.transformRequest(params)
        } else if (params) {
          if (['GET', 'DELETE'].includes(endpointConfig.method.toUpperCase())) {
            requestConfig.params = params[0] as Record<string, unknown>
          } else {
            requestConfig.data = params[0]
          }
        }

        const response = await client.request<T>(requestConfig)

        // Apply response transformation if provided
        const data = endpointConfig.transformResponse
          ? endpointConfig.transformResponse(response.data)
          : response.data

        return {
          data: Array.isArray(data) ? data : [data],
          metadata: {
            totalCount: Array.isArray(data) ? data.length : 1,
            columns: this.extractColumns(data)
          }
        }
      }

      const response = await client.get<T>(endpoint, { params: params?.[0] as Record<string, unknown> })
      const data = response.data

      return {
        data: Array.isArray(data) ? data : [data],
        metadata: {
          totalCount: Array.isArray(data) ? data.length : 1,
          columns: this.extractColumns(data)
        }
      }
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await executeRequest()
      } catch (error) {
        lastError = error as Error
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 && attempt === 0 && this.tokenProvider) {
          this.tokenProvider.onAuthError?.()
          continue
        }
        break
      }
    }

    return {
      data: [],
      error: lastError
    }
  }

  async select<T = unknown>(endpoint: string, options?: HTTPQueryOptions): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const executeRequest = async (): Promise<QueryResult<T>> => {
      const method = options?.method || 'GET'
      const url = options?.endpoint || endpoint

      const requestConfig: AxiosRequestConfig = {
        url,
        method,
        headers: options?.headers,
        params: options?.params || options?.where,
        data: options?.data
      }

      // Handle pagination
      if (options?.limit) {
        requestConfig.params = {
          ...requestConfig.params,
          limit: options.limit,
          offset: options.offset || 0
        }
      }

      // Handle ordering
      if (options?.orderBy?.length) {
        const sortParams = options.orderBy.map(o => `${o.column}:${o.direction}`).join(',')
        requestConfig.params = {
          ...requestConfig.params,
          sort: sortParams
        }
      }

      const response = await client.request<T | { data?: T[]; items?: T[]; results?: T[]; total?: number; count?: number; totalCount?: number }>(requestConfig)
      const data = response.data

      // Handle paginated responses
      let resultData: unknown = data
      let totalCount: number | undefined = undefined

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // Check for common pagination patterns
        if ('data' in data) {
          resultData = data.data
        } else if ('items' in data) {
          resultData = data.items
        } else if ('results' in data) {
          resultData = data.results
        }

        // Extract total count if available
        if ('total' in data) {
          totalCount = data.total as number
        } else if ('count' in data) {
          totalCount = data.count as number
        } else if ('totalCount' in data) {
          totalCount = data.totalCount as number
        }
      }

      return {
        data: Array.isArray(resultData) ? resultData : [resultData],
        metadata: {
          totalCount: totalCount || (Array.isArray(resultData) ? resultData.length : 1),
          columns: this.extractColumns(resultData)
        }
      }
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await executeRequest()
      } catch (error) {
        lastError = error as Error
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 && attempt === 0 && this.tokenProvider) {
          this.tokenProvider.onAuthError?.()
          continue
        }
        break
      }
    }

    return {
      data: [],
      error: lastError
    }
  }

  async insert<T = unknown>(endpoint: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const executeRequest = async (): Promise<QueryResult<T>> => {
      const response = await client.post<T>(endpoint, data)
      const responseData = response.data

      return {
        data: Array.isArray(responseData) ? responseData : [responseData],
        metadata: {
          totalCount: Array.isArray(responseData) ? responseData.length : 1
        }
      }
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await executeRequest()
      } catch (error) {
        lastError = error as Error
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 && attempt === 0 && this.tokenProvider) {
          this.tokenProvider.onAuthError?.()
          continue
        }
        break
      }
    }

    return {
      data: [],
      error: lastError
    }
  }

  async update<T = unknown>(
    endpoint: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>
  ): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const executeRequest = async (): Promise<QueryResult<T>> => {
      // For REST APIs, typically update by ID
      const id = where.id || where._id
      const url = id ? `${endpoint}/${id}` : endpoint

      const response = await client.put<T>(url, data, {
        params: id ? undefined : where
      })

      const responseData = response.data

      return {
        data: Array.isArray(responseData) ? responseData : [responseData],
        metadata: {
          totalCount: Array.isArray(responseData) ? responseData.length : 1
        }
      }
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await executeRequest()
      } catch (error) {
        lastError = error as Error
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 && attempt === 0 && this.tokenProvider) {
          this.tokenProvider.onAuthError?.()
          continue
        }
        break
      }
    }

    return {
      data: [],
      error: lastError
    }
  }

  async delete<T = unknown>(endpoint: string, where: Record<string, unknown>): Promise<QueryResult<T>> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const executeRequest = async (): Promise<QueryResult<T>> => {
      // For REST APIs, typically delete by ID
      const id = where.id || where._id
      const url = id ? `${endpoint}/${id}` : endpoint

      const response = await client.delete<T>(url, {
        params: id ? undefined : where
      })

      const responseData = response.data

      return {
        data: Array.isArray(responseData) ? responseData : [responseData],
        metadata: {
          totalCount: Array.isArray(responseData) ? responseData.length : 1
        }
      }
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await executeRequest()
      } catch (error) {
        lastError = error as Error
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 401 && attempt === 0 && this.tokenProvider) {
          this.tokenProvider.onAuthError?.()
          continue
        }
        break
      }
    }

    return {
      data: [],
      error: lastError
    }
  }

  // Schema operations (limited for HTTP)
  async getSchema(_schema?: string): Promise<SchemaInfo> {
    // HTTP APIs typically don't expose schema information
    // This could be implemented for specific APIs that provide metadata endpoints
    return {
      tables: []
    }
  }

  async getTableInfo(table: string, _schema?: string): Promise<TableInfo> {
    // Would need API-specific implementation
    return {
      name: table,
      schema: _schema,
      columns: []
    }
  }

  async getColumns(_table: string, _schema?: string): Promise<ColumnInfo[]> {
    // Would need API-specific implementation
    return []
  }

  async tableExists(table: string, _schema?: string): Promise<boolean> {
    // Try to access the endpoint
    try {
      const response = await this.client!.head(table)
      return response.status < 400
    } catch {
      return false
    }
  }

  // Transaction support (not applicable for HTTP)
  async beginTransaction(): Promise<void> {
    throw new Error('Transactions not supported in HTTP adapter')
  }

  async commit(_transaction: unknown): Promise<void> {
    throw new Error('Transactions not supported in HTTP adapter')
  }

  async rollback(_transaction: unknown): Promise<void> {
    throw new Error('Transactions not supported in HTTP adapter')
  }

  async inTransaction<T>(_transaction: unknown, callback: () => Promise<T>): Promise<T> {
    // Just execute the callback without transaction support
    return callback()
  }

  async *stream<T = unknown>(
    endpoint: string,
    params?: unknown[],
    options?: { highWaterMark?: number }
  ): AsyncIterableIterator<T> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    // Implement pagination-based streaming
    let page = 0
    const pageSize = options?.highWaterMark || 100

    while (true) {
      const response = await client.get<unknown>(endpoint, {
        params: {
          ...(params?.[0] as Record<string, unknown>),
          page,
          limit: pageSize
        }
      })

      const data = response.data
      const items = Array.isArray(data)
        ? data
        : (
            typeof data === 'object' && data !== null
              ? (data as { data?: unknown[]; items?: unknown[]; results?: unknown[] }).data ||
                (data as { data?: unknown[]; items?: unknown[]; results?: unknown[] }).items ||
                (data as { data?: unknown[]; items?: unknown[]; results?: unknown[] }).results ||
                []
              : []
          )

      if (items.length === 0) {
        break
      }

      for (const item of items) {
        yield item as T
      }

      // Check if there are more pages
      if (items.length < pageSize) {
        break
      }

      page++
    }
  }

  protected async download(endpoint: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const response = await client.request<ArrayBuffer>({
      url: endpoint,
      method: 'GET',
      responseType: 'arraybuffer'
    })

    return Buffer.from(response.data as ArrayBuffer)
  }

  // Helper methods
  private extractColumns(data: unknown): Array<{ name: string; type: string; nullable?: boolean }> {
    if (!data) return []

    const sample = Array.isArray(data) ? data[0] : data
    if (!sample || typeof sample !== 'object') return []

    return Object.keys(sample).map(key => ({
      name: key,
      type: typeof (sample as Record<string, unknown>)[key],
      nullable: (sample as Record<string, unknown>)[key] === null || (sample as Record<string, unknown>)[key] === undefined
    }))
  }

  // Batch operations using HTTP
  async batchRequest<T = unknown>(
    requests: BatchRequestItem[]
  ): Promise<QueryResult<T>[]> {
    if (!this.client) {
      throw new Error('HTTP client not initialized')
    }

    const client = this.client
    const results: QueryResult<T>[] = []

    // Execute requests in parallel with concurrency control
    const concurrencyOption = this.config.options?.batchConcurrency
    const concurrency = typeof concurrencyOption === 'number' ? concurrencyOption : 5
    const chunks: BatchRequestItem[][] = []

    for (let i = 0; i < requests.length; i += concurrency) {
      chunks.push(requests.slice(i, i + concurrency))
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (req) => {
        try {
          const response = await client.request<T>({
            method: req.method,
            url: req.endpoint,
            data: req.data,
            params: req.params as Record<string, unknown>
          })

          return {
            data: Array.isArray(response.data) ? response.data : [response.data]
          }
        } catch (error) {
          return {
            data: [],
            error: error as Error
          }
        }
      })

      const chunkResults = await Promise.all(promises)
      results.push(...chunkResults as QueryResult<T>[])
    }

    return results
  }
}
