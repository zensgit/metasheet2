/**
 * R-69 1b-ii — the IntegrationRunPort (ADR adr-automation-pipeline-bridge-20261103 §2 ②③, §6.4; design
 * baseline v2.3 §10.2.3 "一次调用的顺序"). R-69 is OPEN: dry-run only, default OFF, not for merge until the owner
 * rules.
 *
 * DIRECTION: plugin → core (the same direction as `WorkdayCalendarPort`, core/workday-calendar-port.ts). The
 * `run_integration_job` automation action lives in core (type, save validation, intent ledger, job lease,
 * step result); the RUN itself — the governed authorization chain, the B2a read fence, the source read and the
 * dry-run planning — lives in plugin-integration-core and is reached ONLY through a port the plugin registers at
 * activation. Core never `require`s the plugin's libraries, never calls its HTTP routes and never uses the
 * cross-plugin communication API for this. An absent port is a FAIL-CLOSED step (`port_inactive`).
 *
 * THE CONTEXT the port receives is built by core from a live, committed authority read of the rule's BOUND
 * principal (integration/automation-run-authority.ts): exactly the six request-shaped fields the plugin's
 * governed entries read (`user`, `authUser`, `authenticatedTenantId`, `query`, `params`, `body`) — the same
 * fields its HTTP handlers read off `req`. The plugin reads it, never widens it. Core never passes `runAs`, a
 * write-lifecycle marker, or anything the HTTP path would not have.
 *
 * REGISTRY: one process-wide port, owner-tracked by plugin name inside this module (no server field), so a
 * plugin reload / deactivate unbinds it and a stale owner cannot unbind a successor's registration.
 */

/** The request-shaped principal fields the plugin's governed chain reads (and nothing else). */
export interface IntegrationRunPrincipalUser {
  id: string
  permissions: string[]
  roles: string[]
  role: string | null
  tenantId: string
}

export interface IntegrationRunPrincipalContext {
  user: IntegrationRunPrincipalUser
  authUser: IntegrationRunPrincipalUser
  authenticatedTenantId: string
  query: Record<string, never>
  params: Record<string, never>
  body: Record<string, unknown>
}

/** One job UNIT the port runs: one project of a stock-prep pull, or one pipeline dry run. */
export type IntegrationRunJob =
  | { kind: 'stock_prep_pull'; projectNo: string; actionId?: string }
  | { kind: 'pipeline'; pipelineId: string; dryRun: true }

/** ADR §4.1 status vocabulary (closed). `held` = human to-do; `skipped` = system-side skip. */
export type IntegrationRunStatus = 'succeeded' | 'partial' | 'failed' | 'held' | 'skipped' | 'not_started'
export const INTEGRATION_RUN_STATUSES: ReadonlySet<string> = new Set<IntegrationRunStatus>([
  'succeeded', 'partial', 'failed', 'held', 'skipped', 'not_started',
])

/**
 * VALUES-FREE summary of one unit: a closed status, a bounded reason / error class, integer counts, the dry-run
 * `canApply` bit (the baseline's comparison yardstick against the OS task log) and a duration. Never a row, a
 * part number, a token, a URL or an error message body. Core re-sanitizes it (sanitizeIntegrationRunSummary).
 */
export interface IntegrationRunSummary {
  status: IntegrationRunStatus
  reason?: string
  errorClass?: string
  failureStage?: string
  counts?: Record<string, number>
  canApply?: boolean
  durationMs?: number
  runId?: string
}

export interface IntegrationRunInput {
  context: IntegrationRunPrincipalContext
  job: IntegrationRunJob
  /** timeout | shutdown | lostSignal — the governed entry checks it before every project / page / remote call. */
  signal: AbortSignal
  /** I-5: `await checkpoint()` before every new call; rejects when the caller no longer holds the job lease. */
  checkpoint: () => Promise<void>
  /** Identifiers only (ADR §9), so the plugin can stamp `source: 'automation'` on its audit rows. */
  automation: { ruleId: string; executionId: string; rootExecutionId: string }
}

export interface IntegrationRunPort {
  run(input: IntegrationRunInput): Promise<IntegrationRunSummary>
}

const REASON_MAX = 120

/**
 * Re-sanitize whatever the port returned into the closed summary shape: unknown keys dropped, strings bounded,
 * counts kept only when they are finite integers. A port that returns garbage yields `failed` with
 * `errorClass: 'port_summary_invalid'` rather than a values-leaking step output.
 */
export function sanitizeIntegrationRunSummary(raw: unknown): IntegrationRunSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'failed', errorClass: 'port_summary_invalid' }
  const r = raw as Record<string, unknown>
  if (typeof r.status !== 'string' || !INTEGRATION_RUN_STATUSES.has(r.status)) {
    return { status: 'failed', errorClass: 'port_summary_invalid' }
  }
  const out: IntegrationRunSummary = { status: r.status as IntegrationRunStatus }
  const bounded = (value: unknown): string | undefined =>
    typeof value === 'string' && /[!-~]/.test(value) ? value.slice(0, REASON_MAX) : undefined
  const reason = bounded(r.reason)
  if (reason !== undefined) out.reason = reason
  const errorClass = bounded(r.errorClass)
  if (errorClass !== undefined) out.errorClass = errorClass
  const failureStage = bounded(r.failureStage)
  if (failureStage !== undefined) out.failureStage = failureStage
  const runId = bounded(r.runId)
  if (runId !== undefined) out.runId = runId
  if (typeof r.canApply === 'boolean') out.canApply = r.canApply
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) out.durationMs = Math.floor(r.durationMs)
  if (r.counts && typeof r.counts === 'object' && !Array.isArray(r.counts)) {
    const counts: Record<string, number> = {}
    for (const [key, value] of Object.entries(r.counts as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && /^[A-Za-z0-9_:-]{1,64}$/.test(key)) counts[key] = value
    }
    out.counts = counts
  }
  return out
}

// ── Registry ───────────────────────────────────────────────────────────────────────────────────────────────

let boundPort: IntegrationRunPort | undefined
let boundOwner: string | null = null

function isPort(candidate: unknown): candidate is IntegrationRunPort {
  return !!candidate && typeof candidate === 'object' && typeof (candidate as IntegrationRunPort).run === 'function'
}

/**
 * Bind the process-wide port for `owner` (the plugin name). A second registration replaces the first (the host
 * logs it). Returns the unbind for THIS registration: it unbinds only while this owner still holds the port.
 */
export function registerIntegrationRunPort(owner: string, port: IntegrationRunPort): () => void {
  if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('registerIntegrationRunPort: owner is required')
  if (!isPort(port)) throw new TypeError('registerIntegrationRunPort: port.run must be a function')
  boundPort = port
  boundOwner = owner
  return () => {
    if (boundOwner === owner && boundPort === port) {
      boundPort = undefined
      boundOwner = null
    }
  }
}

/** Unbind whatever `owner` holds (plugin deactivate / reload / activation failure). A non-owner is a no-op. */
export function unregisterIntegrationRunPortOwnedBy(owner: string): boolean {
  if (boundOwner !== owner) return false
  boundPort = undefined
  boundOwner = null
  return true
}

/** The bound port, or undefined (the executor fails closed: `port_inactive`). */
export function getIntegrationRunPort(): IntegrationRunPort | undefined {
  return boundPort
}

export function getIntegrationRunPortOwner(): string | null {
  return boundOwner
}

/** Test isolation only. */
export function clearIntegrationRunPortForTest(): void {
  boundPort = undefined
  boundOwner = null
}
