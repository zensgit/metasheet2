/**
 * Pull-source rule: the single definition of what counts as a pull source, which organisation lock
 * guards changes to the set of pull sources, the typed errors raised when a policy is required, and the
 * switch that enables the rule.
 *
 * Invariants of this module:
 *  - It imports nothing. In particular it does not import the directory sync module or the database
 *    module, so any layer (resolver, route, write gate, adapters) can depend on it without a cycle.
 *  - It is read-only: the helpers below issue SELECT statements through an injected `query` and never
 *    write any table.
 *  - It references only tables that already exist (`directory_integrations`,
 *    `org_directory_routing_policy`).
 *  - Nothing here calls the switch: callers read it per call through `isApprovalRoutingRequirePolicyEnabled`.
 *
 * Definitions:
 *  - pull type:   `provider <> 'local'`. An unrecognised provider value counts as pull type.
 *  - active:      `status = 'active'` (exact; any other value is not active). `sync_enabled` is not read.
 *  - non-active pull type: pull type and `status <> 'active'` (the complement of active within pull type).
 *                 It is used only to count linked accounts under such integrations in a status view and
 *                 never takes part in the rule.
 *  - pull source: one active pull-type integration, de-duplicated by `(provider, corp_id)`; several rows
 *                 for the same external enterprise are one source.
 *  - multi-source: an organisation with at least `PULL_SOURCE_THRESHOLD` pull sources.
 *  - governed:    the organisation has a `purpose = 'approval_routing'` policy row.
 *  - unreadable count: `PullSourceCountUnavailableError`; a gate treats it as a refusal and a status
 *                 view omits its block; it is never read as zero.
 * The local directory is never counted and can neither trigger nor satisfy the rule.
 */

// ── switch ──────────────────────────────────────────────────────────────────────────────────────

export const APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED = 'APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED' as const

/**
 * Default OFF. Exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * Read on every call; the env is passed in so a test never has to mutate process.env at module load.
 */
export function isApprovalRoutingRequirePolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED === 'true'
}

// ── pull-source predicate ───────────────────────────────────────────────────────────────────────

export const APPROVAL_ROUTING_PURPOSE = 'approval_routing' as const

/** A pull source set of at least this size, with no policy row, requires a policy. */
export const PULL_SOURCE_THRESHOLD = 2

/** Tables the helpers in this module read. Every one of them exists before this module does. */
export const PULL_SOURCE_RULE_TABLES = Object.freeze(['directory_integrations', 'org_directory_routing_policy'] as const)

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/

function assertSqlAlias(alias: string): string {
  if (!SQL_ALIAS.test(alias)) throw new TypeError('invalid SQL alias')
  return alias
}

/** The one place the pull-type condition is written; every fragment below is assembled around it. */
function pullTypeConditionSql(checkedAlias: string): string {
  return `${checkedAlias}.provider <> 'local'`
}

/** WHERE-fragment: the row is a pull-type integration, whatever its status. */
export function pullTypePredicateSql(alias = 'i'): string {
  const a = assertSqlAlias(alias)
  return `(${pullTypeConditionSql(a)})`
}

/** WHERE-fragment: the row is an active pull-type integration. */
export function pullSourcePredicateSql(alias = 'i'): string {
  const a = assertSqlAlias(alias)
  return `(${pullTypeConditionSql(a)} AND ${a}.status = 'active')`
}

/** WHERE-fragment: the row is a pull-type integration that is not active. */
export function nonActivePullTypePredicateSql(alias = 'i'): string {
  const a = assertSqlAlias(alias)
  return `(${pullTypeConditionSql(a)} AND ${a}.status <> 'active')`
}

/** Expression identifying the external source a row belongs to. */
export function pullSourceKeySql(alias = 'i'): string {
  const a = assertSqlAlias(alias)
  return `(${a}.provider, ${a}.corp_id)`
}

export const PULL_SOURCE_PREDICATE_SQL = pullSourcePredicateSql('i')
export const PULL_SOURCE_KEY_SQL = pullSourceKeySql('i')

export const COUNT_ACTIVE_PULL_SOURCES_SQL =
  `SELECT count(DISTINCT ${PULL_SOURCE_KEY_SQL})::int AS pull_source_count ` +
  `FROM directory_integrations i WHERE i.org_id = $1 AND ${PULL_SOURCE_PREDICATE_SQL}`

export const APPROVAL_ROUTING_POLICY_EXISTS_SQL =
  `SELECT 1 AS present FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = '${APPROVAL_ROUTING_PURPOSE}'`

/** Minimal query surface: the shared pool, a transaction connection and a unit fake all satisfy it. */
export type PullSourceRuleQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>

export interface PullSourceRuleStatus {
  /** True when the organisation is multi-source and has no approval-routing policy. */
  required: boolean
  sourceCount: number
  hasPolicy: boolean
}

/** Number of distinct active pull sources in the organisation. */
export async function countActivePullSources(query: PullSourceRuleQuery, orgId: string): Promise<number> {
  const result = await query(COUNT_ACTIVE_PULL_SOURCES_SQL, [orgId])
  const raw = result.rows[0]?.pull_source_count
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  // An unreadable count fails closed: a gate treats it as a refusal and a status view omits its block;
  // it is never zero.
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new PullSourceCountUnavailableError(orgId)
  }
  return count
}

/**
 * Read-only, lock-free status of the rule for one organisation. It does not read the switch: the answer
 * is a pure data judgement. Suitable for status views and pre-flight checks; it takes no lock and is not
 * a substitute for a check made under the organisation lock.
 */
export async function isApprovalRoutingPolicyRequired(
  query: PullSourceRuleQuery,
  orgId: string,
): Promise<PullSourceRuleStatus> {
  const sourceCount = await countActivePullSources(query, orgId)
  const policy = await query(APPROVAL_ROUTING_POLICY_EXISTS_SQL, [orgId])
  const hasPolicy = policy.rows.length > 0
  return { required: sourceCount >= PULL_SOURCE_THRESHOLD && !hasPolicy, sourceCount, hasPolicy }
}

// ── organisation lock ───────────────────────────────────────────────────────────────────────────

/** Prefix of the transaction-scoped advisory lock key that guards changes to an organisation's sources. */
export const DIRECTORY_ORG_LOCK_KEY_PREFIX = 'directory:pull-sources:' as const

/** The lock key text for an organisation. */
export function directoryOrgLockKey(orgId: string): string {
  return `${DIRECTORY_ORG_LOCK_KEY_PREFIX}${orgId}`
}

/** Statement that takes the organisation lock for the current transaction; `orgIdParam` is a `$n` placeholder. */
export function directoryOrgLockSql(orgIdParam = '$1'): string {
  if (!/^\$[1-9]\d*$/.test(orgIdParam)) throw new TypeError('invalid parameter placeholder')
  return `SELECT pg_advisory_xact_lock(hashtext('${DIRECTORY_ORG_LOCK_KEY_PREFIX}' || ${orgIdParam}::text))`
}

// ── typed errors ────────────────────────────────────────────────────────────────────────────────

export type ApprovalRoutingPolicyErrorReason =
  | 'canonical_unavailable'
  | 'multi_org_ambiguous'
  | 'policy_required'

/** Fixed sentence: carries no organisation id, count, integration name, corp id or user id. */
export const POLICY_REQUIRED_MESSAGE = 'Approval routing requires a canonical directory source policy for this organization'

export const APPROVAL_ROUTING_POLICY_REQUIRED_CODE = 'APPROVAL_ROUTING_POLICY_REQUIRED' as const

/** Fixed sentence for a source count that could not be read. */
export const PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE = 'The directory source count for this organization is unavailable'

/** The source count could not be read. Not an ApprovalRoutingPolicyError: a gate refuses, a status view omits its block. */
export class PullSourceCountUnavailableError extends Error {
  readonly orgId: string | null
  constructor(orgId: string | null = null) {
    super(PULL_SOURCE_COUNT_UNAVAILABLE_MESSAGE)
    this.name = 'PullSourceCountUnavailableError'
    this.orgId = orgId
  }
}

/**
 * Fail-closed routing configuration error. `reason` discriminates the cause; `orgId` and `sourceCount`
 * live only in typed properties (for a values-free server log) and never in `message`.
 */
export class ApprovalRoutingPolicyError extends Error {
  readonly reason: ApprovalRoutingPolicyErrorReason
  readonly orgId: string | null
  readonly sourceCount: number | null

  constructor(
    message: string,
    reason: ApprovalRoutingPolicyErrorReason = 'canonical_unavailable',
    orgId: string | null = null,
    sourceCount: number | null = null,
  ) {
    super(message)
    this.name = 'ApprovalRoutingPolicyError'
    this.reason = reason
    this.orgId = orgId
    this.sourceCount = sourceCount
  }
}

export const DIRECTORY_ROUTING_POLICY_REQUIRED_CODE = 'DIRECTORY_ROUTING_POLICY_REQUIRED' as const
export const DIRECTORY_ROUTING_POLICY_REQUIRED_MESSAGE = 'A routing policy is required before another directory source can be added'

/**
 * A pull source may not join an organisation that is already multi-source (or would become so) without
 * an approval-routing policy. Extends Error only (not any directory sync error type), fixed sentence.
 */
export class DirectoryRoutingPolicyRequiredError extends Error {
  readonly code = DIRECTORY_ROUTING_POLICY_REQUIRED_CODE

  constructor() {
    super(DIRECTORY_ROUTING_POLICY_REQUIRED_MESSAGE)
    this.name = 'DirectoryRoutingPolicyRequiredError'
  }
}
