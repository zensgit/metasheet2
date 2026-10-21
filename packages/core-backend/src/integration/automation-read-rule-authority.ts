import { createHash } from 'node:crypto'
import { canonicalReadId, exactObject } from './automation-read-contracts'
import { canonicalizeConfig } from '../multitable/automation-action-idempotency'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'

export type AutomationReadRuleInput = {
  actorId: string
  ruleId: string
  sheetId: string
  baseId: string
}

type FrozenJson = null | boolean | number | string | readonly FrozenJson[]
  | { readonly [key: string]: FrozenJson }

/** Private persisted facts, never a public DTO or an execution permission. */
export type LockedAutomationReadRule = Readonly<{
  ruleId: string
  sheetId: string
  baseId: string
  createdBy: string
  authorityRevision: string
  fingerprint: string
  triggerType: string
  triggerConfig: FrozenJson
  actionType: string
  actionConfig: FrozenJson
  conditions: FrozenJson
  actions: FrozenJson
  executionMode: string | null
}>

export type AutomationRuleAuthorityErrorCode =
  | 'AUTOMATION_RULE_INPUT_INVALID'
  | 'AUTOMATION_RULE_TRANSACTION_REQUIRED'
  | 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE'
  | 'AUTOMATION_RULE_AUTHORITY_DENIED'

const messages: Record<AutomationRuleAuthorityErrorCode, string> = {
  AUTOMATION_RULE_INPUT_INVALID: 'Automation rule scope is invalid',
  AUTOMATION_RULE_TRANSACTION_REQUIRED: 'Automation rule authority requires a read-committed transaction',
  AUTOMATION_RULE_AUTHORITY_UNAVAILABLE: 'Automation rule authority is unavailable',
  AUTOMATION_RULE_AUTHORITY_DENIED: 'Automation rule authority is denied',
}

export class AutomationRuleAuthorityError extends Error {
  constructor(readonly code: AutomationRuleAuthorityErrorCode) {
    super(messages[code])
    this.name = 'AutomationRuleAuthorityError'
  }
}

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const rawColumns = ['id', 'sheet_id', 'name', 'trigger_type', 'trigger_config', 'action_type',
  'action_config', 'enabled', 'created_at', 'updated_at', 'created_by', 'conditions', 'actions',
  'execution_mode', 'integration_authority_revision'] as const

function denied(): never {
  throw new AutomationRuleAuthorityError('AUTOMATION_RULE_AUTHORITY_DENIED')
}

function unavailable(): never {
  throw new AutomationRuleAuthorityError('AUTOMATION_RULE_AUTHORITY_UNAVAILABLE')
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/** Copy the driver's JSON result before freezing; no driver-owned reference escapes. */
function freezeJson(value: unknown): FrozenJson {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  if (object(value)) return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, freezeJson(item)]),
  ))
  return unavailable()
}

/**
 * HOST-PRIVATE rule snapshot prerequisite, not standalone authorization. The caller
 * must already have locked the trusted live actor in this SAME transaction. Tenant
 * membership, Connection/source ownership and revisions, active receipt, target,
 * row/field permissions, operation, trigger allowlist and budgets remain the future
 * host port's responsibility. automation_rules has no tenant column; a sheet's base
 * or workspace must never be promoted into a tenant proof here.
 *
 * This helper accepts persisted trigger/action types without narrowing legacy rules.
 * The eventual port MUST separately require its fixed read operation and supported
 * trigger types before any grant/execution. Raw configs returned here remain private.
 *
 * Caller begins READ COMMITTED before invoking. Lock order after actor is base ->
 * sheet -> rule, with NOWAIT on each: existing base -> actor -> rule paths must not
 * form a wait cycle. A busy/missing schema fails closed; caller must roll back. Locks
 * last only until caller commit/rollback, never across later source IO. There are no
 * writes, transaction management statements, production callers or host registration.
 */
export async function lockAutomationReadRule(
  trx: Queryable,
  input: AutomationReadRuleInput,
): Promise<LockedAutomationReadRule> {
  if (!exactObject(input, ['actorId', 'ruleId', 'sheetId', 'baseId'])
    || !Object.values(input).every(canonicalReadId)) {
    throw new AutomationRuleAuthorityError('AUTOMATION_RULE_INPUT_INVALID')
  }
  // Never adopt a row-derived scope hint, or a caller mutation after an await.
  const { actorId, ruleId, sheetId, baseId } = input

  try {
    if (!trx || typeof trx.query !== 'function') throw new Error('Missing transaction')
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
      throw new Error('Wrong isolation')
    }
    await assertInTransaction(trx, 'Automation rule authority')
  } catch {
    throw new AutomationRuleAuthorityError('AUTOMATION_RULE_TRANSACTION_REQUIRED')
  }

  try {
    const bases = (await trx.query(
      'SELECT id, deleted_at FROM meta_bases WHERE id = $1 FOR SHARE NOWAIT', [baseId],
    )).rows
    if (bases.length !== 1 || bases[0]?.id !== baseId || bases[0]?.deleted_at !== null) denied()

    const sheets = (await trx.query(
      'SELECT id, base_id, deleted_at FROM meta_sheets WHERE id = $1 FOR SHARE NOWAIT', [sheetId],
    )).rows
    if (sheets.length !== 1 || sheets[0]?.id !== sheetId || sheets[0]?.base_id !== baseId
      || sheets[0]?.deleted_at !== null) denied()

    const rules = (await trx.query(
      `SELECT (pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
         'integration_authority_revision', r.integration_authority_revision,
         'created_at', pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'updated_at', pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       )) AS raw_rule
       FROM automation_rules r WHERE r.id = $1 FOR SHARE NOWAIT`, [ruleId],
    )).rows
    if (rules.length !== 1) denied()
    const raw = rules[0]?.raw_rule
    // An old/partial schema is not a usable authority source. Referencing the nonce
    // column explicitly above also rejects a missing migration at the SQL boundary.
    if (!object(raw) || !rawColumns.every(key => Object.hasOwn(raw, key))) unavailable()
    if (raw.id !== ruleId || raw.sheet_id !== sheetId || raw.created_by !== actorId
      || raw.enabled !== true || typeof raw.integration_authority_revision !== 'string'
      || !uuidPattern.test(raw.integration_authority_revision)) denied()
    if (typeof raw.trigger_type !== 'string' || typeof raw.action_type !== 'string'
      || (raw.execution_mode !== null && typeof raw.execution_mode !== 'string')
      || typeof raw.created_at !== 'string' || !timestampPattern.test(raw.created_at)
      || typeof raw.updated_at !== 'string' || !timestampPattern.test(raw.updated_at)) unavailable()

    const snapshot = freezeJson(raw) as Readonly<Record<string, FrozenJson>>
    // Include every raw column, not an executor-normalized action set. Timestamps
    // stay UTC microsecond strings (never JS Date); the DB nonce prevents ABA reuse.
    const fingerprint = createHash('sha256').update(canonicalizeConfig(snapshot)).digest('hex')
    return Object.freeze({
      ruleId, sheetId, baseId, createdBy: actorId,
      authorityRevision: raw.integration_authority_revision,
      fingerprint,
      triggerType: raw.trigger_type,
      triggerConfig: snapshot.trigger_config,
      actionType: raw.action_type,
      actionConfig: snapshot.action_config,
      conditions: snapshot.conditions,
      actions: snapshot.actions,
      executionMode: typeof raw.execution_mode === 'string' ? raw.execution_mode : null,
    })
  } catch (error) {
    if (error instanceof AutomationRuleAuthorityError) throw error
    // SQL errors (including NOWAIT conflicts), raw config and causes never escape.
    return unavailable()
  }
}
