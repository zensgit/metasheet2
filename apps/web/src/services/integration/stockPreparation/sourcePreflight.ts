// 源就绪预检 + 拓扑自测 — the READ side of the source-readiness check.
//
// The install page already answers "is THIS deployment ready" (installPlan.ts / the deployment
// preflight). This module answers the other half, the half an implementer used to answer by hand
// over a long afternoon: is the CUSTOMER'S source reachable, does it hold real BOM data, and WHICH
// schema shape is it actually in — measured by the server, not assumed by anybody.
//
// WHAT THIS FILE IS AND IS NOT. It is a typed read of one route plus the plain-language projection of
// its verdict. It performs NO detection of its own: every judgement below (`verdict`, `blockers`,
// `detectedBridge`, `resolvedSlot`) is the SERVER's measurement, rendered. A front end that
// re-derived "ready" would be a second opinion nobody asked for and a second thing to keep in sync.
//
// VALUES-FREE, downstream of a values-free route. The response carries shapes, counts, column names
// and closed-vocabulary codes; the one exception is up to two short project numbers as liveness
// evidence, which the server shape-screens before emitting. Nothing here widens that.

import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE = '/api/integration/stock-preparation/source-preflight'

/**
 * The permission tier the route is gated on: the INTEGRATION read tier, deliberately not the
 * stock-prep namespace. The server's reasoning (stock-preparation-workbench-access.cjs) is that
 * triggering a read against the customer's own system is an owner/implementer act rather than a
 * queue-operator one, and R-11's alignment principle says what is not permitted must not be visible —
 * so the button renders on exactly the codes the route accepts, and on no others.
 */
export const STOCK_PREP_SOURCE_PREFLIGHT_PERMISSIONS: readonly string[] = Object.freeze([
  'integration:read',
  'integration:write',
  'integration:admin',
  'role:admin',
])

export function canRunStockPrepSourcePreflight(hasPermission: (permission: string) => boolean): boolean {
  return STOCK_PREP_SOURCE_PREFLIGHT_PERMISSIONS.some((permission) => hasPermission(permission))
}

// ---------------------------------------------------------------------------
// The response, as the route defines it.
// ---------------------------------------------------------------------------

export type StockPrepSourceBridge = 'order-module' | 'design-bom' | 'ambiguous' | 'none' | 'unknown'

export interface StockPrepSourceFinding {
  code: string
  detail?: Record<string, unknown>
}

export interface StockPrepSourceProbe {
  role: string
  object: string | null
  present: boolean
  rowsObserved: number
  /** false means the page filled the cap: `rowsObserved` is a FLOOR, not a total. */
  exact: boolean
  columns: string[]
  errorCode: string | null
}

export interface StockPrepSourceReachability {
  reachable: boolean
  objectsProbed: number
  objectsAnswered: number
  failureCode: string | null
}

export interface StockPrepSourceProjectData {
  entryObject: string | null
  entryObjectPresent: boolean
  matchField: string
  rowsObserved: number
  exact: boolean
  populatedMatchRows: number
  nodeTypeColumn: string | null
  projectNodeType: number | null
  projectNodeRows: number | null
  hasProjectNumbers: boolean
  livenessSamples: string[]
  errorCode: string | null
}

export interface StockPrepSourceBomData {
  bomHeadObject: string | null
  bomHeadRows: number
  bomHeadExact: boolean
  bomHeadPresent: boolean
  bomDetailObject: string | null
  bomDetailRows: number
  bomDetailExact: boolean
  bomDetailPresent: boolean
  hasBomRows: boolean
}

export interface StockPrepSourceRoleContributor {
  object: string | null
  rowsObserved: number
  exact: boolean
}

export interface StockPrepSourceBridgeCandidate {
  bridge: StockPrepSourceBridge
  headObject: string | null
  headRows: number | null
  headExact: boolean | null
  headPresent: boolean | null
  lineObject: string | null
  lineRows: number
  lineExact: boolean
  linePresent: boolean
  /** Every object that answered under this role — the audit trail behind collapsing them to one. */
  contributingObjects: StockPrepSourceRoleContributor[]
}

/** The two bridges a human may declare when the bounded sample cannot rank them. */
export type StockPrepDeclarableBridge = 'order-module' | 'design-bom'
export const STOCK_PREP_DECLARABLE_BRIDGES: readonly StockPrepDeclarableBridge[] =
  Object.freeze(['order-module', 'design-bom'])

export interface StockPrepSourceTopology {
  detectedBridge: StockPrepSourceBridge
  reason: string
  /** Whether `detectedBridge` came from the data or from a person. Never inferred here. */
  bridgeSource: 'measured' | 'declared'
  declaredBridge: StockPrepDeclarableBridge | null
  declarationContradictsMeasurement: boolean
  measuredBridge: StockPrepSourceBridge
  /** Both carriers filled the sample cap: a bounded read cannot rank them. Not the same as a tie. */
  undecidableAtCap: boolean
  rowCap: number
  configuredBridge: StockPrepSourceBridge
  matchesConfigured: boolean
  dominanceRatio: number
  minLines: number
  candidates: StockPrepSourceBridgeCandidate[]
}

export interface StockPrepSourcePresetMatch {
  matchedBy: string
  presetId: string | null
  reason: string
  tablesAnswered: number
  matchedSignatureTables: number
  requiredSignatureTables: number | null
  missingSignatureTables: string[]
}

export interface StockPrepSourceQuantityField {
  carrierObject: string | null
  configuredField: string
  dictionaryObject: string | null
  dictionaryReadable: boolean
  dictionaryKeyColumn: string | null
  dictionaryEnabledRows: number
  dictionarySlot: string | null
  measuredSlot: string | null
  measuredNumericRatio: number | null
  measuredCandidates: { column: string; populated: number; numericRatio: number }[]
  /** Slots that cleared the density floor — the field the reading refused to choose from, when it did. */
  qualifyingSlots: string[]
  measuredAmbiguous: boolean
  configuredAmongCandidates: boolean
  resolvedSlot: string | null
  readingsAgree: boolean
  matchesConfigured: boolean
  numericDensityFloor: number
}

export interface StockPrepSourcePreflight {
  ok: boolean
  verdict: 'go' | 'no-go'
  externalSystemId: string | null
  readPlanId: string
  rowCap: number
  checks: {
    reachability: StockPrepSourceReachability
    projectData: StockPrepSourceProjectData
    bomData: StockPrepSourceBomData
    topology: StockPrepSourceTopology
    presetMatch: StockPrepSourcePresetMatch
    quantityField: StockPrepSourceQuantityField
  }
  blockers: StockPrepSourceFinding[]
  warnings: StockPrepSourceFinding[]
  probes: StockPrepSourceProbe[]
}

/** Only a status reaches state — a server message could carry a value. */
export class StockPrepSourcePreflightError extends Error {
  readonly status: number
  readonly route: string
  readonly code: string | null

  constructor(status: number, route: string, code: string | null = null) {
    super(`stock-preparation source preflight read failed: ${status}`)
    this.name = 'StockPrepSourcePreflightError'
    this.status = status
    this.route = route
    this.code = code
  }
}

function statusOf(response: Response | null | undefined): number {
  return typeof response?.status === 'number' ? response.status : 0
}

async function readJson(response: Response | null | undefined): Promise<unknown> {
  if (!response || typeof response.json !== 'function') return null
  try {
    return await response.json()
  } catch {
    // A gateway answering 200 with HTML must read as a failure, never as an empty verdict.
    return null
  }
}

/**
 * Run the check. Read tier; the server provisions nothing and writes nothing.
 *
 * `externalSystemId` is optional and, when omitted, the server checks the source the stock-prep table
 * action is CONFIGURED against — which is the only source whose topology can be compared with the
 * configured read plan, and therefore the one the page asks about by default.
 */
export async function readStockPreparationSourcePreflight(
  scope: IntegrationScope,
  externalSystemId?: string,
  declaredBridge?: StockPrepDeclarableBridge,
): Promise<StockPrepSourcePreflight> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    externalSystemId,
    declaredBridge,
  })
  const route = STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE
  const response = await apiFetch(`${route}${query ? `?${query}` : ''}`)
  const payload = await readJson(response) as IntegrationApiEnvelope<StockPrepSourcePreflight> | null
  if (!response?.ok || payload?.ok === false || !payload?.data) {
    const code = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : null
    throw new StockPrepSourcePreflightError(statusOf(response), route, code)
  }
  return payload.data
}

// ---------------------------------------------------------------------------
// The four lines the panel leads with.
//
// Deliberately a PROJECTION, not a re-derivation: each row's `ok` comes from a field the server
// already decided, so the page cannot disagree with the verdict it is rendering.
// ---------------------------------------------------------------------------

export type StockPrepSourceCheckId = 'reachable' | 'has-data' | 'topology' | 'preset'

export interface StockPrepSourceCheckRow {
  id: StockPrepSourceCheckId
  ok: boolean
  /** The measured reading, as a short token an implementer can quote. Never a business value. */
  token: string
}

export function stockPrepSourceCheckRows(preflight: StockPrepSourcePreflight): StockPrepSourceCheckRow[] {
  const { reachability, projectData, bomData, topology, presetMatch } = preflight.checks
  const bridge = topology.detectedBridge
  return [
    {
      id: 'reachable',
      ok: reachability.reachable,
      token: reachability.reachable
        ? `${reachability.objectsAnswered}/${reachability.objectsProbed}`
        : String(reachability.failureCode || 'unknown_error'),
    },
    {
      id: 'has-data',
      ok: projectData.hasProjectNumbers && (bomData.hasBomRows || bridge === 'design-bom'),
      token: `${projectData.populatedMatchRows}${projectData.exact ? '' : '+'} · ${bomData.bomDetailRows}${bomData.bomDetailExact ? '' : '+'}`,
    },
    {
      id: 'topology',
      // `matchesConfigured` is false for BOTH an undecidable standoff and a real mismatch — correctly,
      // since neither is a source you can run against. The token is what tells them apart at a glance.
      ok: topology.matchesConfigured,
      token: topology.undecidableAtCap && topology.bridgeSource === 'measured'
        ? `undecidable@cap(${topology.rowCap})`
        : `${bridge}${topology.bridgeSource === 'declared' ? '(declared)' : ''} vs ${topology.configuredBridge}`,
    },
    {
      id: 'preset',
      ok: Boolean(presetMatch.presetId),
      token: presetMatch.presetId
        ? `${presetMatch.presetId} (${presetMatch.matchedSignatureTables}/${presetMatch.requiredSignatureTables ?? '?'})`
        : presetMatch.reason,
    },
  ]
}
