/**
 * Shared authority flow: input and switch, transaction contract, table probe, integration FOR SHARE,
 * capability FOR SHARE, pure evaluation, and witness. No connection, transaction or session is created.
 * The two entry points fix their organization source. Consumers must never import this module.
 */
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
} from './provider-capability-registry'
import { computeIntegrationCapabilityWitness } from './integration-capability-witness'

export type CoreCapabilityDecision<
  Source extends 'authenticated_tenant' | 'background_event_row',
  Capability extends IntegrationCapability = IntegrationCapability,
> =
  | {
      effective: true
      capability: Capability
      integrationId: string
      orgId: string
      provider: string
      status: 'active'
      revision: number
      witness: string
      orgSource: Source
    }
  | {
      effective: false
      reason: CapabilityReason | 'transaction_required' | 'read_failed' | 'input_invalid' | 'integration_missing'
    }

type Refusal = Extract<CoreCapabilityDecision<'authenticated_tenant'>, { effective: false }>
type CapabilityRefusalReason = Refusal['reason']

/** Upper bound (milliseconds) of the caller's lock wait: the resolver requires 0 < lock_timeout <= this value. */
export const CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS = 5000

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

/** Only the approved thin entry points may call this shared locked-read flow. */
export async function resolveCapabilityCore<
  Source extends 'authenticated_tenant' | 'background_event_row',
  Capability extends IntegrationCapability,
>(
  executor: Queryable,
  input: { integrationId: string; capability: Capability; expectedOrgId: string },
  orgSource: Source,
): Promise<CoreCapabilityDecision<Source, Capability>> {
  // 1. Input, before any statement.
  if (input === null || typeof input !== 'object') return refuse('input_invalid')
  const { integrationId, capability, expectedOrgId } = input
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
