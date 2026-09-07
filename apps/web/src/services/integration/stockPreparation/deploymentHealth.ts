// BOM备料 部署健康 —— 两条此前前端零调用的既有路由,给「记录与排查」面板(P1-4/P1-5,暗装)的
// 「建表/装包」格用。设计稿 §6.2 P1-5 原话:"sandbox-target/readiness + customer-packs/installs,
// 今天零调用,接上"。
//
// THREE ROUTES, NOT TWO. `sandbox-target/readiness` requires `objectId` (server-side
// `assertSandboxObjectId` throws on an empty value — there is NO default), and the only place that
// id lives is on a CONFIGURED CUSTOMER PACK (`pack.targetObjectId` — installRun.ts's own
// `ensureSandboxTarget(objectId)` reads it the same way, off the pack the install run is walking).
// So reading sandbox readiness first needs the pack CATALOG (`GET .../customer-packs`, already admin
// gated, values-free ids/counts only) to learn which objectId to ask about. `customer-packs/installs`
// is independent of that chain — it defaults its own `objectId` server-side to the CANONICAL target
// when none is given (`http-routes.cjs` `stockPreparationCustomerPackInstallList`) — so it is read in
// parallel with the catalog rather than after it.
//
// VALUES-FREE. Every field below is an id, a version string, a status enum, a count, or a schema
// field id (`installedFields` — internal logical field ids like the rest of this workbench's
// `missingFields`, never a part number or a customer value). Nothing here can carry a business value:
// the server's own projections (`summarizeCustomerPackForEvidence`, `publicStockPreparationSandboxTargetResult`)
// already strip anything else before it reaches the wire.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const STOCK_PREPARATION_CUSTOMER_PACK_CATALOG_ROUTE = '/api/integration/stock-preparation/customer-packs'
export const STOCK_PREPARATION_CUSTOMER_PACK_INSTALLS_ROUTE = '/api/integration/stock-preparation/customer-packs/installs'
export const STOCK_PREPARATION_SANDBOX_TARGET_READINESS_ROUTE = '/api/integration/stock-preparation/sandbox-target/readiness'

export interface StockPrepCustomerPackSummary {
  packId: string
  packVersion: string | null
  /** The id `sandbox-target/readiness` must be asked about to inspect THIS pack's table. */
  targetObjectId: string | null
  extensionFields: Array<{ id: string; type: string; ownership: string; preserveOnRefresh: boolean }>
}

export interface StockPrepCustomerPackCatalog {
  packCount: number
  packs: StockPrepCustomerPackSummary[]
}

export interface StockPrepCustomerPackInstallEntry {
  packId: string
  packVersion: string | null
  mode: string | null
  status: string | null
  fieldCount: number
  /** Internal logical field ids — schema shape, never a business value. */
  installedFields: string[]
  warnings: unknown[]
  lastInstallAt: string | null
}

export interface StockPrepCustomerPackInstallList {
  objectId: string
  rowCount: number
  installs: StockPrepCustomerPackInstallEntry[]
}

export interface StockPrepSandboxTargetReadiness {
  ready: boolean
  mode: string
  targetBindingAvailable: boolean
  evidence?: {
    missingFields?: string[]
    fieldCounts?: Record<string, number>
    [key: string]: unknown
  }
}

/** Carries the HTTP status only — never a server message that could quote a value. */
export class StockPrepDeploymentHealthError extends Error {
  status: number

  route: string

  constructor(status: number, route: string) {
    super(`stock-preparation deployment-health read failed (${route} -> ${status})`)
    this.name = 'StockPrepDeploymentHealthError'
    this.status = status
    this.route = route
  }
}

async function readJson(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json()
  } catch {
    return null
  }
}

function statusOf(response: Response | undefined): number {
  return typeof response?.status === 'number' ? response.status : 0
}

async function readEnvelope<T>(response: Response | undefined, route: string): Promise<T> {
  const payload = await readJson(response) as IntegrationApiEnvelope<T> | null
  if (!response?.ok || payload?.ok === false || !payload?.data) {
    throw new StockPrepDeploymentHealthError(statusOf(response), route)
  }
  return payload.data
}

/** What this deployment is ALLOWED to install — packIds and their declared targetObjectId, nothing else. */
export async function readStockPreparationCustomerPackCatalog(
  scope: IntegrationScope,
): Promise<StockPrepCustomerPackCatalog> {
  const route = STOCK_PREPARATION_CUSTOMER_PACK_CATALOG_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })}`)
  return readEnvelope<StockPrepCustomerPackCatalog>(response, route)
}

/**
 * What IS installed. `objectId` is optional — omit it to get the route's own default (the CANONICAL
 * target); pass one (typically a catalog entry's `targetObjectId`) to ask about a sandbox table
 * instead. NOTE: the route resolves its tenant from the authenticated principal only
 * (`resolveTenantId(req, {})` in http-routes.cjs — a request-supplied tenantId is not read), so no
 * scope is forwarded here; the parameter list stays `(scope, objectId)` for symmetry with the rest of
 * this service family and in case that changes.
 */
export async function readStockPreparationCustomerPackInstalls(
  scope: IntegrationScope,
  objectId?: string,
): Promise<StockPrepCustomerPackInstallList> {
  const route = STOCK_PREPARATION_CUSTOMER_PACK_INSTALLS_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ objectId })}`)
  return readEnvelope<StockPrepCustomerPackInstallList>(response, route)
}

/**
 * Is the sandbox table for THIS objectId built and complete? Read-only — `inspectStockPreparationTarget`
 * only calls `findObjectSheet` / resolves field ids, it never provisions anything, so this is safe to
 * call the moment a candidate objectId is known.
 */
export async function readStockPreparationSandboxTargetReadiness(
  scope: IntegrationScope,
  objectId: string,
): Promise<StockPrepSandboxTargetReadiness> {
  const route = STOCK_PREPARATION_SANDBOX_TARGET_READINESS_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, objectId })}`)
  return readEnvelope<StockPrepSandboxTargetReadiness>(response, route)
}
