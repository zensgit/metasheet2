export type SqlServerScalar = string | number | boolean | null | Date

export interface SqlServerReadonlyHelperDetails {
  [key: string]: unknown
}

export class SqlServerReadonlyHelperError extends Error {
  code: string
  details: SqlServerReadonlyHelperDetails
  constructor(code: string, message: string, details?: SqlServerReadonlyHelperDetails)
}

export const VALID_TLS_MIN_VERSIONS: readonly ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']

export function optionalString(value: unknown): string | undefined
export function requiredString(value: unknown, field: string, code?: string): string
export function coerceBoolean(value: unknown, fallback: boolean): boolean
export function normalizeIdentifier(value: unknown, field?: string): string
export function quoteSqlServerIdentifier(value: unknown, field?: string): string

export interface SqlServerEndpointInput {
  host?: unknown
  server?: unknown
  port?: unknown
}

export interface SqlServerEndpoint {
  server: string
  port?: number
}

export function parseSqlServerEndpoint(input?: SqlServerEndpointInput): SqlServerEndpoint

export interface TimeoutPolicy {
  field?: string
  defaultValue?: number
  allowZero?: boolean
}

export function normalizeTimeout(value: unknown, options?: TimeoutPolicy): number | undefined

export interface LimitPolicy {
  defaultLimit?: number
  maxLimit?: number
  overMax?: 'throw' | 'clamp'
}

export function normalizeLimit(value: unknown, options?: LimitPolicy): number

export interface LegacyTlsInput {
  legacyTls?: unknown
  tlsMinVersion?: unknown
  tlsCiphers?: unknown
  encrypt?: unknown
}

export interface LegacyTlsOptions {
  minVersion?: string
  ciphers?: string
}

export function buildLegacyTlsOptions(connection?: LegacyTlsInput): LegacyTlsOptions | undefined

export type WhereValue =
  | SqlServerScalar
  | SqlServerScalar[]
  | { [operator: string]: unknown }
  | { [key: string]: unknown }
  | undefined

export interface WhereClause {
  [key: string]: WhereValue | WhereClause[] | undefined
  $or?: WhereClause[]
  $and?: WhereClause[]
}

export interface GenericWhereOptions {
  quoteIdentifier?: (field: string) => string
  parameter?: (index: number) => string
}

export interface GenericWhereResult {
  sql: string
  params: unknown[]
}

export function buildGenericWhereClause(where: WhereClause, options?: GenericWhereOptions): GenericWhereResult

export function normalizeScalar(value: unknown, field: string): { skip: true } | { value: SqlServerScalar }

export interface SimpleRequest {
  input(name: string, value: unknown): unknown
}

export interface SimpleSelectInput {
  request: SimpleRequest
  table: string
  columns?: string[]
  limit?: unknown
  filters?: Record<string, unknown>
  watermark?: Record<string, unknown>
  orderBy?: string
  limitPolicy?: LimitPolicy
}

export function buildSimpleSelectQuery(input: SimpleSelectInput): string
