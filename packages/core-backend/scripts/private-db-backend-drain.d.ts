export const PRIVATE_DB_BACKEND_DRAIN_MS: number
export const PRIVATE_DB_BACKEND_POLL_MS: number
export const PRIVATE_DB_BACKEND_CENSUS_SQL: string

export interface PrivateDbAdminQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface PrivateDbBackendDrainOptions {
  drainTimeoutMs?: number
  pollIntervalMs?: number
}

export function assertPrivateDatabaseBackendsExited(
  admin: PrivateDbAdminQueryable,
  databaseName: string,
  options?: PrivateDbBackendDrainOptions,
): Promise<void>
