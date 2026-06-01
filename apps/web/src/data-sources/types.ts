// Generic external data-source connector — frontend types (UI-1).
//
// IMPORTANT: credentials are WRITE-ONLY across the wire. A1 encrypts them at rest and the backend
// never returns them in any GET/list response — so read types here carry NO credentials. Credentials
// only appear in the CREATE / credential-rotation payloads.

// Keep in sync with backend SUPPORTED_DATA_SOURCE_TYPES (postgresql is an accepted alias of postgres;
// the UI offers the three distinct kinds).
export const DATA_SOURCE_TYPES = ['postgres', 'sqlserver', 'http'] as const
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number]

export const DATA_SOURCE_TYPE_LABELS: Record<DataSourceType, string> = {
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
  http: 'HTTP / REST',
}

/** Shape of one source from `GET /api/data-sources` (DataSourceManager.listDataSources projection). */
export interface DataSourceListItem {
  id: string
  name: string
  type: string
  connected: boolean
}

/** Sanitized detail from `GET /api/data-sources/:id`; credentials are never returned. */
export interface DataSourceDetail extends DataSourceListItem {
  connection: DataSourceConnectionInput
  options?: { readOnly?: boolean; autoConnect?: boolean }
  hasCredentials?: boolean
}

/** Result from `GET /api/data-sources/:id/test`. Request success is separate from connection success. */
export interface DataSourceTestResult {
  id: string
  success: boolean
  latency?: string
  error?: { message?: string }
}

export interface DataSourceColumnInfo {
  name: string
  type?: string
  nullable?: boolean
}

export interface DataSourceTableInfo {
  name: string
  schema?: string
  columns?: DataSourceColumnInfo[]
}

export interface DataSourceSchemaInfo {
  tables?: DataSourceTableInfo[]
  views?: DataSourceTableInfo[]
}

export interface DataSourceSelectPayload {
  table: string
  select?: string[]
  limit?: number
  offset?: number
}

export interface DataSourceSelectResult {
  data: Array<Record<string, unknown>>
  metadata?: {
    totalCount?: number
    columns?: DataSourceColumnInfo[]
  }
}

/** Connection fields — a free-form record on the wire; these are the common typed keys the form uses. */
export interface DataSourceConnectionInput {
  host?: string
  port?: number
  database?: string
  server?: string
  baseURL?: string
  encrypt?: boolean
  trustServerCertificate?: boolean
}

/** Payload for `POST /api/data-sources`. Credentials are write-only (sent on create, never read back). */
export interface CreateDataSourcePayload {
  id: string
  name: string
  type: DataSourceType
  connection: DataSourceConnectionInput
  credentials?: { username?: string; password?: string; apiKey?: string; token?: string }
  options?: { readOnly?: boolean; autoConnect?: boolean }
}

/** Payload for `PUT /api/data-sources/:id`. Credentials use the dedicated rotation endpoint. */
export interface UpdateDataSourcePayload {
  name?: string
  connection?: DataSourceConnectionInput
  options?: { readOnly?: boolean; autoConnect?: boolean }
}

/** Payload for `PUT /api/data-sources/:id/credentials`. Blank fields are omitted by the UI. */
export interface RotateDataSourceCredentialsPayload {
  credentials: { username?: string; password?: string; apiKey?: string; token?: string }
}
