'use strict'

// In-memory double of the plugin db adapter (db.cjs shape) for the ⑦.5 reconciliation unit suites. It models
// only what the reconciliation store needs: equality/IS NULL where clauses, whole-transaction rollback, the
// 091 create fence, the reconciled-observed index, the run/page/observation uniques and the running index.
// It records every statement (table + verb) per transaction and how many transactions are open, so a test can
// assert "no transaction is open while fetch runs" and "page transactions never touch the approved target".
const crypto = require('node:crypto')

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => (value === null || value === undefined ? row[key] === null || row[key] === undefined : row[key] === value))
}
function uniqueError(constraint) {
  const error = new Error('duplicate key value violates unique constraint')
  error.code = '23505'
  error.constraint = constraint
  return error
}
const DEFAULT_COUNTS = Object.fromEntries(['scanned', 'registered', 'would_register', 'already_reconciled', 'duplicate_remote',
  'own_acknowledged', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch',
  'key_unmatchable'].map(key => [`count_${key}`, 0]))

function uniques(table, row, rows) {
  const others = rows.filter(other => other !== row)
  const clash = (columns, predicate = () => true) => predicate(row) && others.some(other => predicate(other)
    && columns.every(column => (other[column] ?? '') === (row[column] ?? '')))
  if (table === 'integration_yida_delivery_ledger') {
    if (clash(['tenant_id', 'workspace_id', 'target_ref', 'business_key_digest'], r => r.intent === 'create')) return 'uniq_integration_yida_delivery_create_business'
    if (clash(['tenant_id', 'workspace_id', 'operation_id', 'row_key'])) return 'uniq_integration_yida_delivery_scope_row'
    if (clash(['tenant_id', 'workspace_id', 'target_ref', 'observed_instance_id'], r => r.status === 'reconciled_existing')) return 'uniq_integration_yida_delivery_reconciled_observed'
  }
  if (table === 'integration_yida_reconciliation_runs') {
    if (clash(['tenant_id', 'target_ref', 'command_id'])) return 'integration_yida_reconciliation_runs_command'
    if (clash(['tenant_id', 'target_ref'], r => r.status === 'running')) return 'uniq_integration_yida_reconciliation_running'
  }
  if (table === 'integration_yida_reconciliation_pages' && clash(['run_id', 'page_number'])) return 'integration_yida_reconciliation_pages_number'
  if (table === 'integration_yida_reconciliation_observations' && clash(['run_id', 'observed_instance_id'])) return 'integration_yida_reconciliation_observations_instance'
  return null
}

function createMemoryDb() {
  const tables = new Map()
  const transactions = []
  const state = { open: 0, failInsert: null, failUpdate: null, beforeStatement: null }
  const rows = name => { if (!tables.has(name)) tables.set(name, []); return tables.get(name) }
  function snapshot() { return new Map([...tables].map(([name, list]) => [name, list.map(row => ({ ...row }))])) }
  function crud(log) {
    const note = async (table, verb) => { log.push({ table, verb }); if (state.beforeStatement) await state.beforeStatement(table, verb) }
    return {
      async setTransactionIsolationLevel() { log.push({ table: null, verb: 'isolation' }) },
      async select(table, { where } = {}) { await note(table, 'select'); return rows(table).filter(row => matches(row, where)).map(row => ({ ...row })) },
      async selectOne(table, where) { await note(table, 'selectOne'); const row = rows(table).find(r => matches(r, where)); return row ? { ...row } : null },
      async selectOneForUpdate(table, where) { await note(table, 'selectOneForUpdate'); const row = rows(table).find(r => matches(r, where)); return row ? { ...row } : null },
      async insertOne(table, input) {
        await note(table, 'insert')
        if (state.failInsert && state.failInsert(table, input)) throw new Error('SYNTHETIC_INSERT_FAILURE')
        const row = { created_at: new Date(0).toISOString(), ...(table === 'integration_yida_reconciliation_runs' || table === 'integration_yida_reconciliation_pages' ? DEFAULT_COUNTS : {}),
          ...(table === 'integration_yida_reconciliation_runs' ? { next_page_number: 1, pages_done: 0, total_count_first: null, total_count_last: null, last_error_code: null, finished_at: null } : {}),
          ...(table === 'integration_yida_delivery_ledger' ? { claim_token: null, claim_actor_id: null, ack_status_code: null, ack_instance_id: null, observed_instance_id: null } : {}),
          ...input }
        const list = rows(table)
        list.push(row)
        const constraint = uniques(table, row, list)
        if (constraint) { list.pop(); throw uniqueError(constraint) }
        return [{ ...row }]
      },
      async updateRow(table, set, where) {
        await note(table, 'update')
        if (state.failUpdate && state.failUpdate(table, set)) throw new Error('SYNTHETIC_UPDATE_FAILURE')
        const list = rows(table)
        const row = list.find(r => matches(r, where))
        if (!row) return []
        const before = { ...row }
        Object.assign(row, set)
        const constraint = uniques(table, row, list)
        if (constraint) { Object.keys(row).forEach(key => delete row[key]); Object.assign(row, before); throw uniqueError(constraint) }
        return [{ ...row }]
      },
    }
  }
  const db = {
    async transaction(callback) {
      const saved = snapshot()
      const log = []
      transactions.push(log)
      state.open += 1
      try { return await callback(crud(log)) }
      catch (error) { tables.clear(); for (const [name, list] of saved) tables.set(name, list); log.push({ table: null, verb: 'rollback' }); throw error }
      finally { state.open -= 1 }
    },
    async selectOne(table, where) { const row = rows(table).find(r => matches(r, where)); return row ? { ...row } : null },
  }
  return { db, tables, rows, transactions, state, seed(table, row) { rows(table).push({ id: crypto.randomUUID(), ...row }) } }
}

module.exports = { createMemoryDb }
