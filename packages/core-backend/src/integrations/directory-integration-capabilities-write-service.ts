/**
 * Write side of the directory integration capabilities: the administrator PATCH that turns one or more
 * capabilities (directory, login, notification) of one integration on or off. This module is the only
 * writer of directory_integration_capabilities and directory_integration_capability_history.
 *
 * One request is one READ COMMITTED transaction on one connection, with this fixed statement order:
 *   - isolation level (the first statement), then a 5s lock wait bound and a 30s statement bound;
 *   0. the non-throwing existence probe of both tables;
 *   1. the integration row FOR SHARE (a request whose body is invalid reads it without a lock);
 *   2. the capability row FOR UPDATE (there may be none);
 *   3. the revision comparison (expected 0 means "no row"), then the per-capability plan;
 *   4. for each capability that would be turned on or re-anchored: the provider's enable
 *      preconditions, then the enable gates registered for that capability. Both run with the two
 *      locks held and before any write, read through this transaction's client only, and make no
 *      external call;
 *   5. the insert (no row) or the update (row), advancing the revision by one;
 *   6. the history row, in the same transaction: when it cannot be written nothing is written.
 * The audit record is written after the commit and is a convenience copy: its failure changes nothing.
 *
 * Per capability named in the request (a capability that is not named keeps its state and its anchor):
 *   - false is always allowed. It does not depend on the provider being registered, on governance, on
 *     an implementation, on the integration status or on the scope, and the decision never reads the
 *     scope. It clears the capability and its anchor; when it is already off it changes nothing. The
 *     answer does not read the scope for it either: the view compares the current scope only with an
 *     anchor that is stored, so a request that leaves no anchor on the row never asks for a scope.
 *     For a capability that keeps its anchor the answer does read the scope, for display only: a scope
 *     read that throws there is shown like a scope that is not complete (scope_changed, not effective,
 *     not matching) and does not undo the write. A scope read that throws while deciding whether a
 *     capability may be turned on still fails the request.
 *   - true is checked in this order, and the first failing check refuses the whole request: provider
 *     registered, governance, implementation, integration status, scope present, enable
 *     preconditions, enable gates. When it passes, the capability is turned on and its anchor is set
 *     to the scope of the locked integration row. Already on with an anchor equal to that scope:
 *     nothing changes and step 4 is not run for it. Already on with another anchor: the anchor is
 *     replaced, which counts as a change and is recorded as a re-anchoring.
 * Capabilities are examined in the order directory, login, notification, each one through all of its
 * checks before the next, so a refusal names the first capability in that order that fails.
 *
 * Organization: this is a platform administrator write and is not limited to one organization. The
 * organization passed to preconditions and gates is the one stored on the locked integration row.
 *
 * Results, history rows and audit records carry codes, booleans, revisions, capability names and
 * opaque ids only: never a scope value, a corp id, an application key or a configuration value.
 */
import {
  buildCapabilitiesView,
  revisionOf,
  type CapabilitiesView,
  type CapabilitiesViewDeps,
  type CapabilitiesViewOptions,
} from './directory-integration-capabilities-service'
import {
  capabilityAnchor,
  isCapabilityEnabled,
  probeCapabilityTables,
  type CapabilityRow,
  type PeekedIntegration,
} from './integration-capability-evaluate'
import {
  INTEGRATION_CAPABILITIES,
  type CapabilityTransactionClient,
  type EnablePreconditionContext,
  type EnablePreconditionResult,
  type IntegrationCapability,
  type IntegrationScope,
} from './provider-capability-registry'

/**
 * An enable gate of one capability, across providers. Same rules as a provider's enable preconditions:
 * persisted evidence only, read through `client` (the write transaction's client, also given as
 * `context.client`), no external call, no integration row lock.
 */
export type CapabilityEnableGate = (
  client: CapabilityTransactionClient,
  context: EnablePreconditionContext,
) => Promise<EnablePreconditionResult>

export type CapabilityEnableGates = Readonly<Partial<Record<IntegrationCapability, readonly CapabilityEnableGate[]>>>

/** The production gate table: frozen and empty. A gate is registered by the change that needs one. */
export const PRODUCTION_CAPABILITY_ENABLE_GATES: CapabilityEnableGates = Object.freeze({})

export const CAPABILITIES_AUDIT_RESOURCE_TYPE = 'directory-integration-capabilities'
export const CAPABILITIES_AUDIT_UPDATE_ACTION = 'directory.integration.capabilities.update'
export const CAPABILITIES_AUDIT_REFUSED_ACTION = 'directory.integration.capabilities.refused'

export interface CapabilityAuditEvent {
  actorId: string
  actorType: 'user'
  action: string
  resourceType: string
  resourceId: string
  meta: Record<string, unknown>
}

export interface CapabilitiesWriteServiceDeps extends CapabilitiesViewDeps {
  isEnabled(): boolean
  /**
   * Runs `work` in one transaction on one connection: commits when it resolves and rolls back when it
   * rejects, rejecting with the same error.
   */
  transaction<T>(work: (client: CapabilityTransactionClient) => Promise<T>): Promise<T>
  readonly capabilityGates: CapabilityEnableGates
  audit(event: CapabilityAuditEvent): Promise<void>
}

/** Why a request to turn a capability on was refused. */
export const CAPABILITY_REFUSAL_CODES = [
  'CAPABILITY_PROVIDER_NOT_REGISTERED',
  'CAPABILITY_GOVERNED_BY_LEGACY_PATH',
  'CAPABILITY_UNSUPPORTED',
  'CAPABILITY_IMPLEMENTATION_MISSING',
  'CAPABILITY_INTEGRATION_INACTIVE',
  'CAPABILITY_SCOPE_INCOMPLETE',
  'CAPABILITY_PRECONDITION_FAILED',
  'CAPABILITY_LOGIN_SCOPE_TAKEN',
] as const
export type CapabilityRefusalCode = (typeof CAPABILITY_REFUSAL_CODES)[number]

/** The one token reported for any field the request may not carry; the field's own name is never repeated. */
export const PATCH_UNKNOWN_FIELD = 'unknown_field'
/** Reported when the body is not a plain object. */
export const PATCH_BODY_FIELD = 'body'
/** Reported when a provider declares a gated capability without preconditions. */
export const PRECONDITIONS_MISSING_CODE = 'PRECONDITIONS_MISSING'
/** Reported in place of a precondition or gate code that is not a fixed token. */
export const PRECONDITION_CODE_MALFORMED = 'PRECONDITION_CODE_MALFORMED'

export interface CapabilitiesPatchInput {
  expectedRevision: number
  capabilities: Partial<Record<IntegrationCapability, boolean>>
}

export type ParsedCapabilitiesPatch =
  | { ok: true; input: CapabilitiesPatchInput }
  | { ok: false; fields: readonly string[] }

export type CapabilitiesPatchResult =
  | { kind: 'disabled' }
  | { kind: 'schema_unavailable' }
  | { kind: 'not_found' }
  | { kind: 'invalid_input'; fields: readonly string[] }
  | { kind: 'stale' }
  | { kind: 'refused'; code: CapabilityRefusalCode; capability: IntegrationCapability; reason?: string }
  | { kind: 'busy' }
  | { kind: 'ok'; changed: boolean; view: CapabilitiesView }

export interface DirectoryIntegrationCapabilitiesWriteService {
  isEnabled(): boolean
  /** `body` is the request body as received; `actorId` is the administrator the gate identified. */
  patch(integrationId: string, body: unknown, actorId: string): Promise<CapabilitiesPatchResult>
}

/** A state the write cannot continue from; the route answers with its fixed internal-error sentence. */
export class CapabilitiesWriteError extends Error {
  constructor() {
    super('capability write cannot continue')
    this.name = 'CapabilitiesWriteError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const TOP_LEVEL_FIELDS: readonly string[] = ['expectedRevision', 'capabilities']

/**
 * The closed allowlist of the request body. Only own properties are read. Any other own property, at
 * the top level or under `capabilities`, is reported as `unknown_field` without its name; a wrong value
 * of a known field is reported under that field's fixed name.
 */
export function parseCapabilitiesPatchBody(body: unknown): ParsedCapabilitiesPatch {
  if (!isPlainObject(body)) return { ok: false, fields: [PATCH_BODY_FIELD] }
  const fields: string[] = []
  const report = (field: string): void => {
    if (!fields.includes(field)) fields.push(field)
  }

  for (const key of Reflect.ownKeys(body)) {
    if (typeof key !== 'string' || !TOP_LEVEL_FIELDS.includes(key)) report(PATCH_UNKNOWN_FIELD)
  }

  const rawRevision: unknown = Object.hasOwn(body, 'expectedRevision') ? body.expectedRevision : undefined
  const revisionValid = typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision) && rawRevision >= 0
  if (!revisionValid) report('expectedRevision')

  const capabilities: Partial<Record<IntegrationCapability, boolean>> = {}
  const rawCapabilities: unknown = Object.hasOwn(body, 'capabilities') ? body.capabilities : undefined
  if (!isPlainObject(rawCapabilities)) {
    report('capabilities')
  } else {
    for (const key of Reflect.ownKeys(rawCapabilities)) {
      if (typeof key !== 'string' || !(INTEGRATION_CAPABILITIES as readonly string[]).includes(key)) {
        report(PATCH_UNKNOWN_FIELD)
      }
    }
    let named = 0
    for (const capability of INTEGRATION_CAPABILITIES) {
      if (!Object.hasOwn(rawCapabilities, capability)) continue
      named += 1
      const value: unknown = rawCapabilities[capability]
      if (typeof value === 'boolean') capabilities[capability] = value
      else report(`capabilities.${capability}`)
    }
    if (named === 0) report('capabilities')
  }

  if (fields.length > 0 || !revisionValid) return { ok: false, fields }
  // `+ 0` folds a negative zero into zero.
  return { ok: true, input: { expectedRevision: (rawRevision as number) + 0, capabilities } }
}

const SET_ISOLATION_SQL = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '30s'`

const INTEGRATION_EXISTS_SQL = `SELECT 1 AS present FROM directory_integrations WHERE id = $1::uuid`

const INTEGRATION_FOR_SHARE_SQL = `SELECT id::text AS id, org_id, provider, status, corp_id, config, sync_enabled, schedule_cron
  FROM directory_integrations WHERE id = $1::uuid FOR SHARE`

const STATE_COLUMNS = `integration_id::text AS integration_id, bound_provider, bound_org_id,
    directory_enabled, directory_bound_tenant, directory_bound_app_scope,
    login_enabled, login_bound_tenant, login_bound_app_scope,
    notification_enabled, notification_bound_tenant, notification_bound_app_scope,
    revision::text AS revision, created_by, updated_by, created_at, updated_at`

const STATE_FOR_UPDATE_SQL = `SELECT ${STATE_COLUMNS}
  FROM directory_integration_capabilities WHERE integration_id = $1::uuid FOR UPDATE`

// The conflict target is the primary key and nothing else: a conflict on the login scope index must
// raise, not be absorbed.
const INSERT_STATE_SQL = `INSERT INTO directory_integration_capabilities
    (integration_id, bound_provider, bound_org_id,
     directory_enabled, directory_bound_tenant, directory_bound_app_scope,
     login_enabled, login_bound_tenant, login_bound_app_scope,
     notification_enabled, notification_bound_tenant, notification_bound_app_scope,
     revision, created_by, updated_by)
  VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13)
  ON CONFLICT (integration_id) DO NOTHING
  RETURNING ${STATE_COLUMNS}`

const INSERT_HISTORY_SQL = `INSERT INTO directory_integration_capability_history
    (integration_id, bound_provider, revision, actor_id, changed, anchor_rebound,
     directory_enabled, login_enabled, notification_enabled)
  VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9)`

/** SQLSTATEs of a lost lock race or an exhausted time bound: nothing was written and a retry may succeed. */
const BUSY_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '40001', '57014'])
const LOGIN_SCOPE_CONSTRAINT = 'dic_login_scope_uniq'
const ANCHOR_CONSTRAINT = /^dic_(directory|login|notification)_anchor_chk$/
const FIXED_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type PlannedChange =
  | { capability: IntegrationCapability; kind: 'disable' }
  | { capability: IntegrationCapability; kind: 'enable' | 'rebind'; scope: IntegrationScope }

interface UpdateAudit {
  provider: string
  fromRevision: number
  toRevision: number
  changed: IntegrationCapability[]
  anchorRebound: IntegrationCapability[]
  directoryEnabled: boolean
  loginEnabled: boolean
  notificationEnabled: boolean
}

type Refusal = Extract<CapabilitiesPatchResult, { kind: 'refused' }>
type Outcome =
  | Exclude<CapabilitiesPatchResult, { kind: 'ok' | 'disabled' }>
  | { kind: 'ok'; changed: false; view: CapabilitiesView }
  | { kind: 'ok'; changed: true; view: CapabilitiesView; audit: UpdateAudit }

/** What the transaction has established so far; read after it ends, also when it was rolled back. */
interface Observed {
  integrationId: string | null
  provider: string | null
  stage: 'read' | 'write' | 'history'
}

/** The answer is a display of rows already decided over: a scope read that throws is shown as no current scope. */
const ANSWER_VIEW: CapabilitiesViewOptions = Object.freeze({ scopeReadFailureAsNoScope: true })

const refusal = (code: CapabilityRefusalCode, capability: IntegrationCapability, reason?: string): Refusal =>
  reason === undefined ? { kind: 'refused', code, capability } : { kind: 'refused', code, capability, reason }

function isIntegrationRow(row: Record<string, unknown> | undefined): boolean {
  return (
    row !== undefined &&
    typeof row.id === 'string' &&
    typeof row.org_id === 'string' &&
    typeof row.provider === 'string' &&
    typeof row.status === 'string' &&
    typeof row.corp_id === 'string'
  )
}

function isStateRow(row: Record<string, unknown> | undefined, integrationId: string): boolean {
  return row !== undefined && row.integration_id === integrationId && typeof row.bound_provider === 'string'
}

function sameScope(left: IntegrationScope | null, right: IntegrationScope): boolean {
  return left !== null && left.tenant === right.tenant && left.appScope === right.appScope
}

/** The fixed code of a precondition or gate answer that is not an exact pass; null when it passed. */
function failureCodeOf(answer: unknown): string | null {
  if (answer !== null && typeof answer === 'object' && (answer as { ok?: unknown }).ok === true) return null
  const code = (answer as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && FIXED_CODE.test(code) ? code : PRECONDITION_CODE_MALFORMED
}

/** Step 4 for one capability: the provider's preconditions, then that capability's gates, in order. */
async function firstEnableFailure(
  deps: CapabilitiesWriteServiceDeps,
  enablePreconditions: ((capability: IntegrationCapability, context: EnablePreconditionContext) => Promise<EnablePreconditionResult>) | undefined,
  capability: IntegrationCapability,
  client: CapabilityTransactionClient,
  context: EnablePreconditionContext,
): Promise<string | null> {
  if (typeof enablePreconditions !== 'function') return PRECONDITIONS_MISSING_CODE
  const precondition = failureCodeOf(await enablePreconditions(capability, context))
  if (precondition !== null) return precondition
  const gates = Object.hasOwn(deps.capabilityGates, capability) ? deps.capabilityGates[capability] ?? [] : []
  for (const gate of gates) {
    const failed = failureCodeOf(await gate(client, context))
    if (failed !== null) return failed
  }
  return null
}

async function runPatch(
  deps: CapabilitiesWriteServiceDeps,
  client: CapabilityTransactionClient,
  integrationId: string,
  parsed: ParsedCapabilitiesPatch,
  actorId: string,
  observed: Observed,
): Promise<Outcome> {
  await client.query(SET_ISOLATION_SQL)
  await client.query(SET_LOCK_TIMEOUT_SQL)
  await client.query(SET_STATEMENT_TIMEOUT_SQL)

  // 0. Tables.
  if (!(await probeCapabilityTables(client))) return { kind: 'schema_unavailable' }

  // An invalid body is answered after the integration is known to exist, and takes no row lock.
  // The comparison is with the literal: this package compiles without strict null checks, where a
  // truthiness test does not select the member of the union.
  if (parsed.ok === false) {
    const exists = await client.query(INTEGRATION_EXISTS_SQL, [integrationId])
    return exists.rows.length === 0 ? { kind: 'not_found' } : { kind: 'invalid_input', fields: parsed.fields }
  }
  const { input } = parsed

  // 1. Integration row.
  const integrationResult = await client.query(INTEGRATION_FOR_SHARE_SQL, [integrationId])
  if (integrationResult.rows.length === 0) return { kind: 'not_found' }
  if (integrationResult.rows.length !== 1 || !isIntegrationRow(integrationResult.rows[0])) throw new CapabilitiesWriteError()
  const integration = integrationResult.rows[0] as unknown as PeekedIntegration
  observed.integrationId = integration.id
  observed.provider = integration.provider

  // 2. Capability row.
  const stateResult = await client.query(STATE_FOR_UPDATE_SQL, [integration.id])
  if (stateResult.rows.length > 1) throw new CapabilitiesWriteError()
  if (stateResult.rows.length === 1 && !isStateRow(stateResult.rows[0], integration.id)) throw new CapabilitiesWriteError()
  const state = (stateResult.rows[0] as unknown as CapabilityRow | undefined) ?? null

  // 3. Revision first: a request with another revision is stale whatever it asks for.
  const fromRevision = revisionOf(state)
  if (fromRevision !== input.expectedRevision) return { kind: 'stale' }

  const descriptor = deps.resolveDescriptor(integration.provider)
  let scope: IntegrationScope | null | undefined
  const plan: PlannedChange[] = []
  for (const capability of INTEGRATION_CAPABILITIES) {
    if (!Object.hasOwn(input.capabilities, capability)) continue
    const enabledNow = state !== null && isCapabilityEnabled(state, capability)

    if (input.capabilities[capability] !== true) {
      if (enabledNow) plan.push({ capability, kind: 'disable' })
      continue
    }

    if (descriptor === null) return refusal('CAPABILITY_PROVIDER_NOT_REGISTERED', capability)
    const governance = descriptor.governance[capability]
    if (governance === 'legacy') return refusal('CAPABILITY_GOVERNED_BY_LEGACY_PATH', capability)
    if (governance !== 'gated') return refusal('CAPABILITY_UNSUPPORTED', capability)
    if (deps.isImplementationAvailable(integration.provider, capability) !== true) {
      return refusal('CAPABILITY_IMPLEMENTATION_MISSING', capability)
    }
    if (integration.status !== 'active') return refusal('CAPABILITY_INTEGRATION_INACTIVE', capability)
    if (scope === undefined) scope = descriptor.scopeOf(integration)
    if (scope === null) return refusal('CAPABILITY_SCOPE_INCOMPLETE', capability)
    if (enabledNow && state !== null && sameScope(capabilityAnchor(state, capability), scope)) continue

    // 4. Both locks are held and nothing has been written.
    const context: EnablePreconditionContext = Object.freeze({
      integrationId: integration.id,
      provider: integration.provider,
      orgId: integration.org_id,
      scope,
      client,
    })
    const failed = await firstEnableFailure(deps, descriptor.enablePreconditions?.bind(descriptor), capability, client, context)
    if (failed !== null) return refusal('CAPABILITY_PRECONDITION_FAILED', capability, failed)
    plan.push({ capability, kind: enabledNow ? 'rebind' : 'enable', scope })
  }

  if (plan.length === 0) {
    return { kind: 'ok', changed: false, view: buildCapabilitiesView(deps, integration, state, ANSWER_VIEW) }
  }

  // 5. The capability row.
  observed.stage = 'write'
  let written: CapabilityRow
  if (state === null) {
    const columns: unknown[] = []
    for (const capability of INTEGRATION_CAPABILITIES) {
      const change = plan.find((candidate) => candidate.capability === capability)
      if (change !== undefined && change.kind !== 'disable') columns.push(true, change.scope.tenant, change.scope.appScope)
      else columns.push(false, null, null)
    }
    const inserted = await client.query(INSERT_STATE_SQL, [integration.id, integration.provider, integration.org_id, ...columns, actorId])
    // Another request created the row after step 2 found none.
    if (inserted.rows.length === 0) return { kind: 'stale' }
    written = inserted.rows[0] as unknown as CapabilityRow
  } else {
    // Only the columns of the capabilities in the plan are assigned; the names come from the closed list.
    const assignments: string[] = []
    const params: unknown[] = [integration.id]
    for (const change of plan) {
      const name = change.capability
      if (change.kind === 'disable') {
        assignments.push(`${name}_enabled = false`, `${name}_bound_tenant = NULL`, `${name}_bound_app_scope = NULL`)
      } else {
        params.push(change.scope.tenant, change.scope.appScope)
        assignments.push(
          `${name}_enabled = true`,
          `${name}_bound_tenant = $${params.length - 1}`,
          `${name}_bound_app_scope = $${params.length}`,
        )
      }
    }
    params.push(actorId)
    const updated = await client.query(
      `UPDATE directory_integration_capabilities
          SET ${assignments.join(', ')}, revision = revision + 1, updated_by = $${params.length}, updated_at = now()
        WHERE integration_id = $1::uuid
        RETURNING ${STATE_COLUMNS}`,
      params,
    )
    if (updated.rows.length !== 1) throw new CapabilitiesWriteError()
    written = updated.rows[0] as unknown as CapabilityRow
  }
  if (!isStateRow(written as unknown as Record<string, unknown>, integration.id)) throw new CapabilitiesWriteError()
  const toRevision = revisionOf(written)
  if (toRevision !== fromRevision + 1) throw new CapabilitiesWriteError()

  // 6. History, in this transaction.
  observed.stage = 'history'
  const changed = plan.map((change) => change.capability)
  const anchorRebound = plan.filter((change) => change.kind === 'rebind').map((change) => change.capability)
  const audit: UpdateAudit = {
    provider: integration.provider,
    fromRevision,
    toRevision,
    changed,
    anchorRebound,
    directoryEnabled: isCapabilityEnabled(written, 'directory'),
    loginEnabled: isCapabilityEnabled(written, 'login'),
    notificationEnabled: isCapabilityEnabled(written, 'notification'),
  }
  await client.query(INSERT_HISTORY_SQL, [
    integration.id,
    integration.provider,
    toRevision,
    actorId,
    changed,
    anchorRebound,
    audit.directoryEnabled,
    audit.loginEnabled,
    audit.notificationEnabled,
  ])

  return { kind: 'ok', changed: true, view: buildCapabilitiesView(deps, integration, written, ANSWER_VIEW), audit }
}

/**
 * The typed answer for an error that ended the transaction, or null when it is not one of the mapped
 * ones (the caller rethrows it). The two constraint mappings apply to the capability row write only.
 */
function outcomeOfFailure(error: unknown, observed: Observed): Outcome | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string') return null
  if (BUSY_SQLSTATES.has(code)) return { kind: 'busy' }
  if (observed.stage !== 'write') return null
  const constraint = (error as { constraint?: unknown }).constraint
  if (typeof constraint !== 'string') return null
  if (code === '23505' && constraint === LOGIN_SCOPE_CONSTRAINT) return refusal('CAPABILITY_LOGIN_SCOPE_TAKEN', 'login')
  if (code === '23514') {
    const anchor = ANCHOR_CONSTRAINT.exec(constraint)
    if (anchor !== null) return refusal('CAPABILITY_SCOPE_INCOMPLETE', anchor[1] as IntegrationCapability)
  }
  return null
}

/** The audit record of an outcome, or null when the outcome writes none (also: every unchanged 200). */
function auditEventOf(outcome: Outcome, observed: Observed, actorId: string): CapabilityAuditEvent | null {
  const base = { actorId, actorType: 'user' as const, resourceType: CAPABILITIES_AUDIT_RESOURCE_TYPE }
  if (outcome.kind === 'ok' && outcome.changed) {
    if (observed.integrationId === null) return null
    const { provider, fromRevision, toRevision, changed, anchorRebound, directoryEnabled, loginEnabled, notificationEnabled } = outcome.audit
    return {
      ...base,
      action: CAPABILITIES_AUDIT_UPDATE_ACTION,
      resourceId: observed.integrationId,
      // The audit writer keeps only a numeric operator id in its own column, so the id is repeated here.
      meta: { provider, actorId, fromRevision, toRevision, changed, anchorRebound, directoryEnabled, loginEnabled, notificationEnabled },
    }
  }
  if (outcome.kind === 'refused') {
    if (observed.integrationId === null || observed.provider === null) return null
    return {
      ...base,
      action: CAPABILITIES_AUDIT_REFUSED_ACTION,
      resourceId: observed.integrationId,
      meta: { provider: observed.provider, actorId, code: outcome.code, capability: outcome.capability },
    }
  }
  return null
}

function resultOf(outcome: Outcome): CapabilitiesPatchResult {
  if (outcome.kind === 'ok') return { kind: 'ok', changed: outcome.changed, view: outcome.view }
  return outcome
}

export function createDirectoryIntegrationCapabilitiesWriteService(
  deps: CapabilitiesWriteServiceDeps,
): DirectoryIntegrationCapabilitiesWriteService {
  return {
    isEnabled: () => deps.isEnabled(),
    async patch(integrationId: string, body: unknown, actorId: string): Promise<CapabilitiesPatchResult> {
      if (!deps.isEnabled()) return { kind: 'disabled' }
      if (typeof actorId !== 'string' || actorId.trim() === '') throw new CapabilitiesWriteError()
      const parsed = parseCapabilitiesPatchBody(body)
      const observed: Observed = { integrationId: null, provider: null, stage: 'read' }

      let outcome: Outcome
      try {
        outcome = await deps.transaction((client) => runPatch(deps, client, integrationId, parsed, actorId, observed))
      } catch (error) {
        const mapped = outcomeOfFailure(error, observed)
        if (mapped === null) throw error
        outcome = mapped
      }

      // After the transaction has ended. Best effort: the record is a copy, the history row is the source.
      const event = auditEventOf(outcome, observed, actorId)
      if (event !== null) {
        try {
          await deps.audit(event)
        } catch {
          // The answer does not depend on the audit record.
        }
      }
      return resultOf(outcome)
    },
  }
}
