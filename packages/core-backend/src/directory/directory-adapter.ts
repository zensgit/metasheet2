/**
 * Directory provider adapter contract.
 *
 * An adapter turns an integration's decrypted config into the two maps the reconcile code reads
 * (departments by external id, members by external user id) and, optionally, a root-department
 * diagnostic sample and a connection probe. Completeness is the throw contract: a fetch method
 * returns only a complete snapshot and throws (with the provider's own error class, unwrapped)
 * for a missing page, an invalid shape, a cursor fault, a parent conflict or a parent cycle.
 */
import type { DirectorySyncApiCallCounters } from './directory-sync-api-telemetry'
import type { DirectoryIntegrationConfig, NormalizedDirectoryIntegrationInput } from './directory-sync'

/** Default member page size; shared by the config normalizer and the adapters. */
export const DIRECTORY_DEFAULT_PAGE_SIZE = 50

export interface DirectoryDepartmentRecord {
  id: string
  parentId: string | null
  name: string
  order: number
  source: Record<string, unknown>
  /**
   * Manager enrichment: `undefined` = not fetched or the fetch failed (the apply carries the prior
   * value forward); `[]` = fetched and empty. Written to the stored raw as
   * `dept_manager_userid_list`, which the approval directory, assignee resolution and alert
   * delivery read.
   */
  managerUserIds?: string[]
}

export interface DirectoryMemberRecord {
  /** Stable member id; stored as `directory_accounts.external_user_id`. */
  userId: string
  name: string
  nick?: string
  unionId?: string
  openId?: string
  mobile?: string
  email?: string
  jobNumber?: string
  title?: string
  avatarUrl?: string
  departmentIds: string[]
  source: Record<string, unknown>
  /** Carried, not read: absence from the pull stays the only source of `is_active`. */
  providerStatus?: 'active' | 'provider_marked_inactive'
}

export interface DirectoryAdapterCapabilities {
  contactFields: {
    email: 'available' | 'needs_field_permission' | 'unavailable'
    mobile: 'available' | 'needs_field_permission' | 'unavailable'
  }
  memberOpenId: 'available' | 'login_backfill_only' | 'unavailable'
  memberUnionId: 'available' | 'unavailable'
  managerIds: boolean
  primaryDepartmentSignal: boolean
  diagnostics: boolean
}

export interface DirectoryPullTelemetry {
  apiCalls?: DirectorySyncApiCallCounters
}

export type DirectoryPullRetryObserver = (event: { reason: string }) => void

export type DirectoryIntegrationDiagnosticSummary = {
  code: string
  title: string
  nextAction: string
}

export type DirectoryRootDepartmentDiagnosticSample = {
  rootDepartmentChildCount: number
  rootDepartmentDirectUserCount: number
  rootDepartmentDirectUserHasMore: boolean
  rootDepartmentDirectUserCountWithAccessLimit: number
  rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
  sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
  sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  summary: DirectoryIntegrationDiagnosticSummary
  warnings: string[]
}

/** Everything a connection test returns except `corpId`, `rootDepartmentId` and `appKey`; key order is part of the contract. */
export interface DirectoryIntegrationProbeResult {
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
  diagnostics: {
    rootDepartmentChildCount: number
    rootDepartmentDirectUserCount: number
    rootDepartmentDirectUserHasMore: boolean
    rootDepartmentDirectUserCountWithAccessLimit: number
    rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
    sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
    sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  }
  summary: DirectoryIntegrationDiagnosticSummary
  warnings: string[]
}

export interface DirectoryAdapter<TConfig = DirectoryIntegrationConfig> {
  readonly provider: string
  readonly capabilities: DirectoryAdapterCapabilities
  fetchDepartments(
    config: TConfig,
    integrationName: string,
    telemetry?: DirectoryPullTelemetry,
  ): Promise<Map<string, DirectoryDepartmentRecord>>
  fetchMembers(
    config: TConfig,
    departments: Map<string, DirectoryDepartmentRecord>,
    telemetry?: DirectoryPullTelemetry,
  ): Promise<Map<string, DirectoryMemberRecord>>
  /** Runs `fn` with `observer` receiving every transport retry made inside it. */
  observeRetries<T>(observer: DirectoryPullRetryObserver, fn: () => Promise<T>): Promise<T>
  sampleDiagnostics?(config: TConfig): Promise<DirectoryRootDepartmentDiagnosticSample>
  probeConnection?(normalized: NormalizedDirectoryIntegrationInput): Promise<DirectoryIntegrationProbeResult>
}
