/**
 * The one authoritative consumer entry point for directory integration capabilities.
 *
 * `resolveEffectiveIntegrationCapability` decides, inside the caller's READ COMMITTED transaction,
 * whether one capability-gated path of one integration may be used. It takes no switch, descriptor,
 * implementation flag or lock option: it reads the capability switch, the production provider
 * registry and the production implementation table itself, and it sets no session or transaction
 * parameter. It never throws; every failure is a refusal.
 *
 * Fixed statement sequence (nothing else is issued):
 *   1. input checks, before any statement (`input_invalid`; a blank organization is `org_mismatch`);
 *   2. switch OFF: no statement, `switch_off`;
 *   3. one statement reading the isolation level and the lock wait bound, then the two transaction
 *      probes of `assertInTransaction` (`transaction_required` when a requirement does not hold;
 *      `read_failed` when one of these statements itself fails);
 *   4. the non-throwing table probe (`schema_unavailable`);
 *   5. the integration row `FOR SHARE`, filtered by id AND organization (absent and foreign are the same
 *      `integration_missing`), then the capability row `FOR SHARE`;
 *   6. the pure evaluator with the expected organization;
 *   7. the decision, with a server-side witness.
 *
 * Lock order: integration row, then capability row. This module never reads the connection lifecycle
 * table, never takes `FOR UPDATE`, and never locks anything after the capability row.
 *
 * Organization source: this version serves authenticated consumers only. `expectedOrgId` is the
 * token-derived authenticated tenant; a consumer without one passes the empty string and is refused
 * before any statement. A pre-authentication consumer must not call this function, and must not pass
 * the integration row's own organization or any request input as `expectedOrgId`.
 *
 * Caller transaction contract: finish every external call before calling; `SET LOCAL lock_timeout` to a
 * value in (0, CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS] before calling; after the call issue local
 * statements only and commit or roll back promptly; after `read_failed` roll back (the transaction is
 * aborted). When the integration can only be found by scope, resolve every candidate in id order in one
 * transaction and continue only when exactly one is effective.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { isDirectoryIntegrationCapabilitiesEnabled } from './directory-integration-capabilities-flag'
import {
  capabilityAnchor,
  evaluateIntegrationCapability,
  probeCapabilityTables,
  type CapabilityReason,
  type CapabilityRow,
  type EvaluatedIntegration,
} from './integration-capability-evaluate'
import { isCapabilityImplementationAvailable } from './integration-capability-implementations'
import {
  INTEGRATION_CAPABILITIES,
  resolveProviderCapabilityDescriptor,
  type IntegrationCapability,
  type IntegrationScope,
} from './provider-capability-registry'

export type CapabilityDecision =
  | {
      effective: true
      capability: IntegrationCapability
      integrationId: string
      orgId: string
      provider: string
      status: 'active'
      revision: number
      witness: string
      orgSource: 'authenticated_tenant'
    }
  | {
      effective: false
      reason: CapabilityReason | 'transaction_required' | 'read_failed' | 'input_invalid' | 'integration_missing'
    }

type CapabilityRefusalReason = Extract<CapabilityDecision, { effective: false }>['reason']

/** Upper bound (milliseconds) of the caller's lock wait: the resolver requires 0 < lock_timeout <= this value. */
export const CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS = 5000

/** PostgreSQL and application shape of the SHA-256 hexadecimal witness. */
export const CAPABILITY_WITNESS_SHAPE = '^[0-9a-f]{64}$'

/** The version string that opens every witness encoding. */
const CAPABILITY_WITNESS_VERSION = 'metasheet.directory-integration-capability-witness.v1'

/** The organization source marker of this version: the token-derived authenticated tenant. */
const ORG_SOURCE_AUTHENTICATED_TENANT = 'authenticated_tenant' as const

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const SETTINGS_SQL = `SELECT current_setting('transaction_isolation') AS isolation,
    (SELECT setting FROM pg_settings WHERE name = 'lock_timeout') AS lock_timeout_ms`

const INTEGRATION_FOR_SHARE_SQL = `SELECT id::text AS id, org_id, provider, status, corp_id, config
  FROM directory_integrations WHERE id = $1::uuid AND org_id = $2 FOR SHARE`

const CAPABILITY_FOR_SHARE_SQL = `SELECT integration_id::text AS integration_id, bound_provider, bound_org_id,
    directory_enabled, directory_bound_tenant, directory_bound_app_scope,
    login_enabled, login_bound_tenant, login_bound_app_scope,
    notification_enabled, notification_bound_tenant, notification_bound_app_scope,
    revision::text AS revision, created_by, updated_by, created_at, updated_at
  FROM directory_integration_capabilities WHERE integration_id = $1::uuid FOR SHARE`

/** The fields a witness covers, in encoding order after the version string. */
export interface CapabilityWitnessFields {
  /** Organization source marker; this version only produces 'authenticated_tenant'. */
  orgSource: string
  integrationId: string
  orgId: string
  provider: string
  status: string
  capability: IntegrationCapability
  revision: number
  anchor: IntegrationScope
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([length, bytes])
}

/**
 * Domain-separated SHA-256 (lowercase hex) over the length-prefixed UTF-8 encoding of the version
 * string and each field. Server side only: it is never sent to a browser.
 */
export function computeIntegrationCapabilityWitness(fields: CapabilityWitnessFields): string {
  const parts = [
    CAPABILITY_WITNESS_VERSION,
    fields.orgSource,
    fields.integrationId,
    fields.orgId,
    fields.provider,
    fields.status,
    fields.capability,
    String(fields.revision),
    fields.anchor.tenant,
    fields.anchor.appScope,
  ]
  const hash = createHash('sha256')
  for (const part of parts) hash.update(lengthPrefixed(part))
  return hash.digest('hex')
}

type Refusal = Extract<CapabilityDecision, { effective: false }>

const refuse = (reason: CapabilityRefusalReason): Refusal => ({ effective: false, reason })

function isCapability(value: unknown): value is IntegrationCapability {
  return typeof value === 'string' && (INTEGRATION_CAPABILITIES as readonly string[]).includes(value)
}

/** A lock wait bound read from pg_settings (milliseconds), or null when it is not a plain integer. */
function lockTimeoutMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

/** The stored revision as an integer in 0..2^53-1, or null when it is anything else. */
function revisionOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

function isIntegrationRow(row: Record<string, unknown>): boolean {
  return (
    typeof row.id === 'string' &&
    typeof row.org_id === 'string' &&
    typeof row.provider === 'string' &&
    typeof row.status === 'string' &&
    typeof row.corp_id === 'string'
  )
}

function isCapabilityRowShape(row: Record<string, unknown>): boolean {
  return (
    typeof row.integration_id === 'string' &&
    typeof row.bound_provider === 'string' &&
    typeof row.bound_org_id === 'string'
  )
}

type TransactionContract = 'holds' | 'transaction_required' | 'read_failed'

/**
 * Step 3: the caller's handle is one ongoing READ COMMITTED transaction with a bounded lock wait.
 *
 * Two different refusals: a requirement that does not hold (no usable handle, a settings result of the
 * wrong shape, another isolation, an unbounded / over-long / unreadable lock wait, a probe that returns
 * no transaction id, or two probes in different transactions) is `transaction_required`; a statement
 * the database itself fails (any thrown query, including 55P03 / 40001 / 40P01 / 57014 and 25P02 in an
 * already aborted transaction) is `read_failed`, and the caller rolls back.
 */
async function transactionContract(executor: Queryable): Promise<TransactionContract> {
  if (!executor || typeof executor.query !== 'function') return 'transaction_required'

  let rows: unknown
  try {
    const settings = await executor.query(SETTINGS_SQL)
    rows = settings?.rows
  } catch {
    return 'read_failed'
  }
  if (!Array.isArray(rows) || rows.length !== 1) return 'transaction_required'
  const row = rows[0] as Record<string, unknown> | null | undefined
  if (row?.isolation !== 'read committed') return 'transaction_required'
  const bound = lockTimeoutMs(row?.lock_timeout_ms)
  if (bound === null || bound <= 0 || bound > CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS) return 'transaction_required'

  // The production probe, through a handle that only records whether one of its statements failed.
  let statementFailed = false
  const observed: Queryable = {
    query: async (sql, params) => {
      try {
        return await executor.query(sql, params)
      } catch (error) {
        statementFailed = true
        throw error
      }
    },
  }
  try {
    await assertInTransaction(observed, 'Integration capability resolve')
  } catch {
    return statementFailed ? 'read_failed' : 'transaction_required'
  }
  return 'holds'
}

/**
 * Steps 4–5. As in step 3, any failing statement aborts the caller's transaction (the caller must roll back) and is
 * `read_failed`; so is a result of an unexpected shape.
 */
async function readLocked(
  executor: Queryable,
  integrationId: string,
  expectedOrgId: string,
): Promise<Refusal | { integration: EvaluatedIntegration; state: CapabilityRow | null }> {
  try {
    // 4. Tables.
    if (!(await probeCapabilityTables(executor))) return refuse('schema_unavailable')

    // 5. Integration row (id AND organization), then capability row, both FOR SHARE, in this order.
    const integrationResult = await executor.query(INTEGRATION_FOR_SHARE_SQL, [integrationId, expectedOrgId])
    if (integrationResult.rows.length === 0) return refuse('integration_missing')
    if (integrationResult.rows.length !== 1 || !isIntegrationRow(integrationResult.rows[0])) return refuse('read_failed')
    const integration = integrationResult.rows[0] as unknown as EvaluatedIntegration

    const stateResult = await executor.query(CAPABILITY_FOR_SHARE_SQL, [integrationId])
    if (stateResult.rows.length > 1) return refuse('read_failed')
    const stateRow = stateResult.rows[0]
    if (stateRow !== undefined && !isCapabilityRowShape(stateRow)) return refuse('read_failed')
    const state = (stateRow as unknown as CapabilityRow | undefined) ?? null
    return { integration, state }
  } catch {
    return refuse('read_failed')
  }
}

async function resolve(executor: Queryable, input: unknown): Promise<CapabilityDecision> {
  // 1. Input, before any statement.
  if (input === null || typeof input !== 'object') return refuse('input_invalid')
  const { integrationId, capability, expectedOrgId } = input as Record<string, unknown>
  if (typeof integrationId !== 'string' || !CANONICAL_UUID.test(integrationId)) return refuse('input_invalid')
  if (!isCapability(capability)) return refuse('input_invalid')
  if (typeof expectedOrgId !== 'string' || expectedOrgId.trim() === '') return refuse('org_mismatch')

  // 2. Switch.
  const switchOn = isDirectoryIntegrationCapabilitiesEnabled()
  if (!switchOn) return refuse('switch_off')

  // 3. Transaction, isolation and lock wait bound.
  const contract = await transactionContract(executor)
  if (contract !== 'holds') return refuse(contract)

  // 4–5. Tables, then the two locked reads.
  const read = await readLocked(executor, integrationId, expectedOrgId)
  if ('effective' in read) return read
  const { integration, state } = read

  // 6. The pure evaluator; the switch, descriptor and implementation come from production sources only.
  const evaluation = evaluateIntegrationCapability({
    capability,
    switchOn,
    schemaAvailable: true,
    descriptor: resolveProviderCapabilityDescriptor(integration.provider),
    implementationAvailable: isCapabilityImplementationAvailable(integration.provider, capability),
    expectedOrgId,
    integration,
    state,
  })
  if (!evaluation.effective) return refuse(evaluation.reason ?? 'read_failed')

  // 7. Decision and witness. Effective implies an enabled row with an anchor matching the current scope.
  if (state === null || integration.status !== 'active' || integration.id !== integrationId) return refuse('read_failed')
  const anchor = capabilityAnchor(state, capability)
  const revision = revisionOf(state.revision)
  if (anchor === null || revision === null) return refuse('read_failed')
  const orgSource = ORG_SOURCE_AUTHENTICATED_TENANT
  const witness = computeIntegrationCapabilityWitness({
    orgSource,
    integrationId: integration.id,
    orgId: integration.org_id,
    provider: integration.provider,
    status: integration.status,
    capability,
    revision,
    anchor,
  })
  return {
    effective: true,
    capability,
    integrationId: integration.id,
    orgId: integration.org_id,
    provider: integration.provider,
    status: 'active',
    revision,
    witness,
    orgSource,
  }
}

/**
 * Whether `capability` of `integrationId` may be used now, decided inside the caller's transaction.
 * `expectedOrgId` is the token-derived authenticated tenant only (empty string when there is none).
 * Never throws.
 */
export async function resolveEffectiveIntegrationCapability(
  executor: Queryable,
  input: { integrationId: string; capability: IntegrationCapability; expectedOrgId: string },
): Promise<CapabilityDecision> {
  try {
    return await resolve(executor, input)
  } catch {
    return refuse('read_failed')
  }
}
