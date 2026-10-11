import { canonicalReadId } from './automation-read-contracts'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'

export type AutomationReadSourcePointerInput = {
  tenantId: string
  workspaceId: null
  actionId: string
}
export type LockedAutomationReadSourcePointer = Readonly<AutomationReadSourcePointerInput & (
  | { state: 'absent'; sourcePointerRevision: string | null; sourcePointerRowId: null; externalSystemId: null }
  | { state: 'bound'; sourcePointerRevision: string; sourcePointerRowId: string; externalSystemId: string }
)>
export type AutomationReadSourcePointerErrorCode = 'AUTOMATION_SOURCE_POINTER_INPUT_INVALID'
  | 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED' | 'AUTOMATION_SOURCE_POINTER_UNAVAILABLE'
  | 'AUTOMATION_SOURCE_POINTER_DENIED'
export class AutomationReadSourcePointerError extends Error {
  constructor(readonly code: AutomationReadSourcePointerErrorCode) {
    super(code)
    this.name = 'AutomationReadSourcePointerError'
  }
}
type Row = Record<string, unknown>
const revisionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
function fail(code: AutomationReadSourcePointerErrorCode): never { throw new AutomationReadSourcePointerError(code) }
function denied(): never { return fail('AUTOMATION_SOURCE_POINTER_DENIED') }
function unavailable(): never { return fail('AUTOMATION_SOURCE_POINTER_UNAVAILABLE') }
function capturedData(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return unavailable()
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable()
    return [key, descriptor.value]
  }))
}

/**
 * HOST-PRIVATE persisted source-pointer prerequisite, not permission or a source
 * selection policy. The future composing port must establish the live actor and
 * the locked rule's authentic action/tenant independently; never infer them from
 * a returned row. No deployment default is selected for an absent pointer. Only
 * a later trusted profile can decide whether a default is permissible.
 *
 * LOCK ORDER: compose the EXT -> Connection mirror -> version/receipt/activation
 * source lock chain FIRST, then call this helper, whose table/epoch locks are
 * NOWAIT. Never hold this table lock and subsequently BLOCK waiting for EXT:
 * existing binding writers own EXT before taking their binding-table write lock.
 * A conflict requires caller rollback and a fresh authority attempt, not fallback.
 *
 * Caller owns a short READ COMMITTED transaction. SHARE on 079 covers insert,
 * update and delete phantoms including the negative lookup; the scope epoch row
 * is SHARE/NOWAIT locked against direct changes. An absent epoch plus absent 079
 * row means never bound; an epoch tombstone preserves revision across deletion.
 * No source/data IO, metadata writes, transaction creation or registration occurs.
 * These locks are not ongoing authorization after the caller commits/rolls back.
 */
export async function lockAutomationReadSourcePointer(
  trx: Queryable,
  input: AutomationReadSourcePointerInput,
): Promise<LockedAutomationReadSourcePointer> {
  let scope: Readonly<AutomationReadSourcePointerInput>
  try {
    const { tenantId, workspaceId, actionId } = capturedData(input, ['tenantId', 'workspaceId', 'actionId'])
    if (!canonicalReadId(tenantId) || workspaceId !== null || !canonicalReadId(actionId)) denied()
    scope = Object.freeze({ tenantId, workspaceId: null, actionId })
  } catch { return fail('AUTOMATION_SOURCE_POINTER_INPUT_INVALID') }

  try {
    const isolation = await trx.query("SELECT current_setting('transaction_isolation') AS isolation")
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') throw new Error('Isolation')
    await assertInTransaction(trx, 'Automation source pointer')
  } catch { return fail('AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED') }

  try {
    await trx.query('LOCK TABLE integration_stock_prep_source_binding IN SHARE MODE NOWAIT')
    const epochs = (await trx.query(`SELECT tenant_id, workspace_key, action_id, revision, binding_id, external_system_id
      FROM integration_stock_prep_source_pointer_revisions
      WHERE tenant_id = $1 AND workspace_key = '' AND action_id = $2 FOR SHARE NOWAIT`, [scope.tenantId, scope.actionId])).rows
    if (epochs.length > 1) denied()
    let epoch: Row | null = null
    if (epochs.length === 1) {
      epoch = capturedData(epochs[0], ['tenant_id', 'workspace_key', 'action_id', 'revision', 'binding_id', 'external_system_id'])
      if (epoch.tenant_id !== scope.tenantId || epoch.workspace_key !== '' || epoch.action_id !== scope.actionId) denied()
      if (typeof epoch.revision !== 'string' || !revisionPattern.test(epoch.revision)) unavailable()
      if (!((epoch.binding_id === null && epoch.external_system_id === null)
        || (canonicalReadId(epoch.binding_id) && canonicalReadId(epoch.external_system_id)))) unavailable()
    }
    // Include the index-equivalent empty-workspace bucket, then explicitly reject
    // a malformed stored '' workspace instead of interpreting it as true NULL.
    const pointers = (await trx.query(`SELECT id, tenant_id, workspace_id, action_id, external_system_id
      FROM integration_stock_prep_source_binding
      WHERE tenant_id = $1 AND COALESCE(workspace_id, '') = '' AND action_id = $2`, [scope.tenantId, scope.actionId])).rows
    if (pointers.length > 1) denied()
    if (pointers.length === 0) {
      if (epoch && (epoch.binding_id !== null || epoch.external_system_id !== null)) denied()
      return Object.freeze({ ...scope, state: 'absent', sourcePointerRevision: epoch ? epoch.revision as string : null,
        sourcePointerRowId: null, externalSystemId: null })
    }
    const pointer = capturedData(pointers[0], ['id', 'tenant_id', 'workspace_id', 'action_id', 'external_system_id'])
    if (pointer.tenant_id !== scope.tenantId || pointer.workspace_id !== null || pointer.action_id !== scope.actionId) denied()
    if (!canonicalReadId(pointer.id) || !canonicalReadId(pointer.external_system_id)) unavailable()
    if (!epoch || epoch.binding_id !== pointer.id || epoch.external_system_id !== pointer.external_system_id) denied()
    return Object.freeze({ ...scope, state: 'bound', sourcePointerRevision: epoch.revision as string,
      sourcePointerRowId: pointer.id, externalSystemId: pointer.external_system_id })
  } catch (error) {
    if (error instanceof AutomationReadSourcePointerError) throw error
    return unavailable()
  }
}
