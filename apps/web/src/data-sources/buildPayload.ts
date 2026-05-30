// Pure builder for the create payload — extracted so the credential-safety rule (OMIT blank
// optional fields; never send an empty string as a value) is unit-testable without mounting the view.
import type {
  CreateDataSourcePayload,
  DataSourceType,
  RotateDataSourceCredentialsPayload,
  UpdateDataSourcePayload,
} from './types'

export interface CreateFormState {
  id: string
  name: string
  type: DataSourceType
  host: string
  server: string
  port: number | '' | undefined
  database: string
  username: string
  password: string
  baseURL: string
  apiKey: string
  readOnly: boolean
}

/**
 * Build the `POST /api/data-sources` payload from form state. Blank optional fields are OMITTED
 * (not sent as empty strings), so a blank password never reaches the backend as `password: ''`.
 */
export function buildCreatePayload(form: CreateFormState): CreateDataSourcePayload {
  const isSql = form.type !== 'http'
  const connection: CreateDataSourcePayload['connection'] = {}
  const credentials: NonNullable<CreateDataSourcePayload['credentials']> = {}

  if (isSql) {
    if (form.host) connection.host = form.host
    // ONLY SQL Server uses `server` (named instance) as a host alternative — Postgres ignores it, so
    // scope it to sqlserver. Otherwise a server-only Postgres source would bypass the host requirement.
    if (form.type === 'sqlserver' && form.server) connection.server = form.server
    if (typeof form.port === 'number' && Number.isFinite(form.port)) connection.port = form.port
    if (form.database) connection.database = form.database
    if (form.username) credentials.username = form.username
    if (form.password) credentials.password = form.password
  } else {
    if (form.baseURL) connection.baseURL = form.baseURL
    if (form.apiKey) credentials.apiKey = form.apiKey
  }

  const payload: CreateDataSourcePayload = {
    id: form.id,
    name: form.name,
    type: form.type,
    connection,
    options: { readOnly: form.readOnly },
  }
  if (Object.keys(credentials).length > 0) payload.credentials = credentials
  return payload
}

/**
 * Build the `PUT /api/data-sources/:id` payload from the same form state.
 * Credentials are deliberately excluded: the backend update schema does not
 * accept them, and blank secret inputs must never be interpreted as rotation.
 */
export function buildUpdatePayload(form: CreateFormState): UpdateDataSourcePayload {
  const isSql = form.type !== 'http'
  const connection: UpdateDataSourcePayload['connection'] = {}

  if (isSql) {
    if (form.host) connection.host = form.host
    if (form.type === 'sqlserver' && form.server) connection.server = form.server
    if (typeof form.port === 'number' && Number.isFinite(form.port)) connection.port = form.port
    if (form.database) connection.database = form.database
  } else if (form.baseURL) {
    connection.baseURL = form.baseURL
  }

  const payload: UpdateDataSourcePayload = {
    name: form.name,
    connection,
    options: { readOnly: form.readOnly },
  }
  return payload
}

/**
 * Build the credential-rotation payload. Blank fields are omitted, never sent as empty
 * strings, so "leave blank to keep current credential" is a real wire invariant.
 */
export function buildCredentialRotationPayload(form: CreateFormState): RotateDataSourceCredentialsPayload {
  const isSql = form.type !== 'http'
  const credentials: RotateDataSourceCredentialsPayload['credentials'] = {}

  if (isSql) {
    if (form.username) credentials.username = form.username
    if (form.password) credentials.password = form.password
  } else if (form.apiKey) {
    credentials.apiKey = form.apiKey
  }

  return { credentials }
}
