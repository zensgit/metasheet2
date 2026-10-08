// BOM备料 部署健康 —— 两条此前前端零调用的既有路由,给「记录与排查」面板(P1-4/P1-5,暗装)的
// 「建表/装包」格用。设计稿 §6.2 P1-5 原话:"sandbox-target/readiness + customer-packs/installs,
// 今天零调用,接上"。
//
// FOUR ROUTES, AND THE OBJECT ID DECIDES WHICH READINESS ROUTE IS EVEN LEGAL. The catalog
// (`GET .../customer-packs`, admin-gated, values-free ids/counts only) is read FIRST because its
// `pack.targetObjectId` is the id every other read in this family has to agree on. Two facts about
// that id, both verified in the plugin source, shape everything below:
//
//   1. A pack that does not declare a `targetObjectId` gets the PRODUCTION CANONICAL one:
//      `stock-preparation-customer-pack.cjs`'s `normalizePackTargetObjectId` returns
//      `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId` ('plm_stock_preparation_main') for
//      undefined/null. Both packs shipped in `lib/customer-packs/` declare none, so canonical is the
//      NORMAL production shape, not an edge case.
//   2. `sandbox-target/readiness` REFUSES that id. Its input goes through
//      `sandboxStockPreparationTemplate` → `assertSandboxObjectId`, which throws 422
//      `TARGET_SANDBOX_OBJECT_ID_INVALID` with reason `prod_canonical` for the canonical id and
//      reason `not_sandbox_namespace` for anything outside `/^plm_stock_preparation_sandbox(?:$|[_-])/`.
//
// So asking the sandbox route about a canonical target is not "a read that might fail" — it is a
// request that CANNOT succeed, and a panel that always sent it would burn one guaranteed-422 call on
// every mount of every production deployment while reporting nothing. `readStockPreparationTargetReadiness`
// therefore routes by namespace: canonical ids go to the canonical sibling
// (`GET .../target/readiness` → `inspectStockPreparationCanonicalTarget`, same admin tier, same
// read-only inspection), sandbox-namespace ids go to the sandbox route, and an id that is neither
// (which the server can produce for no pack, since normalization only yields one of those two
// shapes) is reported as a configuration fault rather than sent anywhere.
//
// `customer-packs/installs` MUST be asked about the SAME id. Its ledger rows are written with the
// pack's own target (`stock-preparation-customer-pack-installer.cjs`: `objectId: pack.targetObjectId`),
// while the route defaults a missing `objectId` query parameter to the CANONICAL target
// (`http-routes.cjs` `stockPreparationCustomerPackInstallList`) and the store filters on it
// (`where.object_id = ...`). Reading installs with the default while reading readiness with the
// pack's sandbox id produced a single tile that said "沙箱表已就绪" and "还没有装包记录" in the same
// breath, about two different tables. One id, both reads.
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
export const STOCK_PREPARATION_CANONICAL_TARGET_READINESS_ROUTE = '/api/integration/stock-preparation/target/readiness'

/** `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId` — the production table, and what a pack that
 *  declares no `targetObjectId` normalizes to server-side. */
export const STOCK_PREPARATION_CANONICAL_OBJECT_ID = 'plm_stock_preparation_main'

/** Verbatim mirror of `SANDBOX_OBJECT_ID_NAMESPACE_PATTERN` in `stock-preparation-target-provisioning.cjs`. */
const SANDBOX_OBJECT_ID_NAMESPACE_PATTERN = /^plm_stock_preparation_sandbox(?:$|[_-])/

export function isStockPreparationSandboxObjectId(objectId: string): boolean {
  return SANDBOX_OBJECT_ID_NAMESPACE_PATTERN.test(objectId)
}

export function isStockPreparationCanonicalObjectId(objectId: string): boolean {
  return objectId === STOCK_PREPARATION_CANONICAL_OBJECT_ID
}

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

/**
 * The one shape a caller reads, whichever of the two readiness routes answered. `kind` is what the
 * page needs in order to say WHICH table it is talking about — 「备料主表(生产)」 and
 * 「备料主表(沙箱)」 are different answers to "is the table ready", and a tile that does not say
 * which one it inspected is not a useful tile.
 */
export interface StockPrepTargetReadiness {
  kind: 'canonical' | 'sandbox'
  objectId: string
  ready: boolean
  mode: string
  targetBindingAvailable: boolean
}

/**
 * Raised when the configured target id is neither the canonical one nor inside the sandbox
 * namespace — i.e. no readiness route would accept it. `status` is 422 so the caller's own
 * status-based cell mapping treats it as the permanent configuration fault it is, rather than as a
 * transient "try again shortly".
 */
export class StockPrepTargetObjectIdError extends Error {
  status = 422

  route = STOCK_PREPARATION_CANONICAL_TARGET_READINESS_ROUTE

  constructor() {
    super('stock-preparation target objectId is neither the canonical target nor in the sandbox namespace')
    this.name = 'StockPrepTargetObjectIdError'
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
 * What IS installed on ONE table. `objectId` is optional only in the sense that the route has a
 * default (the CANONICAL target); every caller in this panel passes the id it also asked readiness
 * about, because the ledger is filtered on it (`where.object_id = ...`).
 *
 * `tenantId` IS forwarded, and the comment that used to sit here saying it must not be was wrong:
 * `stockPreparationCustomerPackInstallList` calls `resolveTenantId(req, {})`, and `resolveTenantId`
 * reads `input.tenantId → req.query.tenantId → req.params.tenantId → user.tenantId` in that order —
 * the query string is very much consulted. Omitting it did not "keep the read principal-bound"; it
 * only broke the one principal that has no tenant of its own (a tenantless platform admin, the
 * subject this route deliberately keeps cross-tenant read capability for), who fell through all four
 * sources to a 400 TENANT_REQUIRED and turned the whole 建表/装包 tile into "暂时看不了" while its
 * two sibling reads succeeded. Forwarding the scope widens nothing: for a tenant-bound principal
 * `resolveTenantId` still 403s on any tenant but their own.
 */
export async function readStockPreparationCustomerPackInstalls(
  scope: IntegrationScope,
  objectId?: string,
): Promise<StockPrepCustomerPackInstallList> {
  const route = STOCK_PREPARATION_CUSTOMER_PACK_INSTALLS_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ tenantId: scope.tenantId, objectId })}`)
  return readEnvelope<StockPrepCustomerPackInstallList>(response, route)
}

/**
 * Is the SANDBOX table for THIS objectId built and complete? Read-only — `inspectStockPreparationTarget`
 * only calls `findObjectSheet` / resolves field ids, it never provisions anything. Refuses anything
 * outside the sandbox namespace server-side with a 422; use `readStockPreparationTargetReadiness`
 * unless the id is already known to be a sandbox one.
 */
export async function readStockPreparationSandboxTargetReadiness(
  scope: IntegrationScope,
  objectId: string,
): Promise<StockPrepSandboxTargetReadiness> {
  const route = STOCK_PREPARATION_SANDBOX_TARGET_READINESS_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, objectId })}`)
  return readEnvelope<StockPrepSandboxTargetReadiness>(response, route)
}

interface RawCanonicalTargetReadiness {
  ready?: unknown
  mode?: unknown
  targetBinding?: unknown
}

/**
 * Is the PRODUCTION CANONICAL table built and complete? The sibling route of the sandbox one, same
 * admin tier, same read-only inspection (`inspectStockPreparationCanonicalTarget`). Its envelope
 * names the binding `targetBinding` (an object or null) where the sandbox one exposes the boolean
 * `targetBindingAvailable`; only the boolean is kept here — this panel never needs the binding, and
 * not carrying it is one less thing a future template edit could put on screen.
 */
export async function readStockPreparationCanonicalTargetReadiness(
  scope: IntegrationScope,
): Promise<StockPrepTargetReadiness> {
  const route = STOCK_PREPARATION_CANONICAL_TARGET_READINESS_ROUTE
  const response = await apiFetch(`${route}${buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })}`)
  const data = await readEnvelope<RawCanonicalTargetReadiness>(response, route)
  return {
    kind: 'canonical',
    objectId: STOCK_PREPARATION_CANONICAL_OBJECT_ID,
    ready: data.ready === true,
    mode: typeof data.mode === 'string' ? data.mode : '',
    targetBindingAvailable: data.targetBinding != null,
  }
}

/**
 * Readiness for whichever table this deployment actually installs onto. See the file header: the
 * objectId decides which route can legally answer, and sending a canonical id to the sandbox route
 * is a guaranteed 422 rather than a read worth attempting.
 */
export async function readStockPreparationTargetReadiness(
  scope: IntegrationScope,
  objectId: string,
): Promise<StockPrepTargetReadiness> {
  if (isStockPreparationCanonicalObjectId(objectId)) {
    return readStockPreparationCanonicalTargetReadiness(scope)
  }
  if (!isStockPreparationSandboxObjectId(objectId)) {
    throw new StockPrepTargetObjectIdError()
  }
  const sandbox = await readStockPreparationSandboxTargetReadiness(scope, objectId)
  return {
    kind: 'sandbox',
    objectId,
    ready: sandbox.ready === true,
    mode: typeof sandbox.mode === 'string' ? sandbox.mode : '',
    targetBindingAvailable: sandbox.targetBindingAvailable === true,
  }
}
