'use strict'

// R-71 ⑦.5 cut-over reconciliation persistence (migration zzzz20261106110700). Internal only: the caller
// (yida-reconciliation-port.mjs) owns authority. Every page is ONE transaction: the fence lookups, the
// `reconciled_existing` ledger rows with their `reconcile(legacy_readback)` audit, the observation rows, the
// page row and the cursor advance commit together or not at all. This module never UPDATEs or DELETEs a
// delivery ledger row, never writes ack_* / claim_* and never writes an `acknowledgement` audit.
const crypto = require('node:crypto')
const { types: { isProxy } } = require('node:util')

const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const RUNS = 'integration_yida_reconciliation_runs'
const PAGES = 'integration_yida_reconciliation_pages'
const OBSERVATIONS = 'integration_yida_reconciliation_observations'
const CREATE_FENCE = 'uniq_integration_yida_delivery_create_business'
const RUNNING_INDEX = 'uniq_integration_yida_reconciliation_running'
const COMMAND_UNIQUE = 'integration_yida_reconciliation_runs_command'
const TARGET_REVISION = 'evidence-1'
const OUTCOMES = Object.freeze(['registered', 'would_register', 'already_reconciled', 'duplicate_remote', 'own_acknowledged',
  'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'project_mismatch', 'key_unmatchable'])
const OBSERVED = new Set(['duplicate_remote', 'duplicate_with_own', 'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'key_unmatchable'])
const ERROR_CODES = new Set(['RETRY', 'THROTTLED', 'RESPONSE', 'TOO_LARGE', 'UNAVAILABLE', 'ABORTED', 'BUDGET', 'TOTAL_CHANGED'])
const COUNT_KEYS = Object.freeze(['scanned', ...OUTCOMES])
const TERMINAL_FAILURES = new Set(['TOTAL_CHANGED', 'BUDGET'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const STORE_CODES = new Set(['INPUT', 'CONFLICT', 'NOT_FOUND', 'UNAVAILABLE', 'RETRY', 'STALE'])
const ownErrors = new WeakMap()

class YidaReconciliationStoreError extends Error {
  constructor(code) {
    const fixed = STORE_CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_RECONCILE_STORE_${fixed}`)
    this.name = 'YidaReconciliationStoreError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaReconciliationStoreError(code) }
// Identity-only markers consumed after rollback; they carry no driver text, SQL or values.
const FENCE_RACE = new YidaReconciliationStoreError('RETRY')
const RUN_RACE = new YidaReconciliationStoreError('CONFLICT')

function first(result) {
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : [])
  return rows[0] || null
}
function opaque(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function uniqueConstraint(error) {
  if (!error || typeof error !== 'object' || isProxy(error)) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    const constraint = Object.getOwnPropertyDescriptor(error, 'constraint')
    return code?.value === '23505' && typeof constraint?.value === 'string' ? constraint.value : null
  } catch { return null }
}
const countColumn = (key) => `count_${key}`
function emptyCounts() { return Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) }
function countsOf(row) {
  const counts = {}
  for (const key of COUNT_KEYS) {
    const value = row[countColumn(key)]
    if (!Number.isSafeInteger(value) || value < 0) fail('UNAVAILABLE')
    counts[key] = value
  }
  return counts
}
function countSet(counts) { return Object.fromEntries(COUNT_KEYS.map(key => [countColumn(key), counts[key]])) }

/** Values-free projection of a run row (project_no never leaves the store). */
function projectRun(row) {
  if (!row || !UUID.test(row.id) || !['running', 'completed', 'failed'].includes(row.status)
    || !['count', 'register'].includes(row.mode)) fail('UNAVAILABLE')
  return Object.freeze({
    runId: row.id, commandId: row.command_id, targetRef: row.target_ref, mode: row.mode, status: row.status,
    pageSize: row.page_size, nextPageNumber: row.next_page_number, pagesDone: row.pages_done,
    totalCountFirst: row.total_count_first ?? null, totalCountLast: row.total_count_last ?? null,
    counts: Object.freeze(countsOf(row)), lastErrorCode: row.last_error_code ?? null,
  })
}

function createYidaReconciliationStore(options = {}) {
  const { db, context } = options
  if (!db || typeof db.transaction !== 'function') fail('UNAVAILABLE')
  if (!context || typeof context !== 'object') fail('INPUT')
  const tenantId = opaque(context.tenantId), ownerId = opaque(context.ownerId)
  if (context.workspaceId !== null) fail('INPUT')

  async function transaction(callback) {
    return db.transaction(async (trx) => {
      if (!trx || ['setTransactionIsolationLevel', 'select', 'selectOne', 'selectOneForUpdate', 'insertOne', 'updateRow']
        .some(name => typeof trx[name] !== 'function')) fail('UNAVAILABLE')
      await trx.setTransactionIsolationLevel('read committed')
      return callback(trx)
    })
  }
  function closed(error) {
    if (error === FENCE_RACE || error === RUN_RACE) throw error
    fail(ownErrors.get(error) || 'UNAVAILABLE')
  }

  /**
   * Locks (or creates) the run of (tenant, target, commandId) inside the caller's transaction. A replay of
   * the same commandId must name the same project, key layout, mode and page size; a failed run resumes as
   * running. Only one run may be running per target (partial unique index).
   */
  async function openRunInTransaction(trx, input) {
    const commandId = input.commandId, targetRef = opaque(input.targetRef)
    if (typeof commandId !== 'string' || !UUID.test(commandId)) fail('INPUT')
    if (typeof input.projectNo !== 'string' || input.projectNo.length < 1 || input.projectNo.length > 64) fail('INPUT')
    const fixed = { owner_id: ownerId, project_no: input.projectNo, project_key_target: opaque(input.projectKeyTarget),
      key_definition_digest: input.keyDefinitionDigest, mode: input.mode, page_size: input.pageSize }
    if (!HEX64.test(fixed.key_definition_digest) || !['count', 'register'].includes(fixed.mode)
      || !Number.isSafeInteger(fixed.page_size) || fixed.page_size < 1 || fixed.page_size > 100) fail('INPUT')
    let row = await trx.selectOneForUpdate(RUNS, { tenant_id: tenantId, target_ref: targetRef, command_id: commandId })
    if (row) {
      if (Object.entries(fixed).some(([key, value]) => row[key] !== value) || row.workspace_id !== null) fail('CONFLICT')
      // TOTAL_CHANGED / BUDGET end a run for good: a new commandId reads the project again from page 1.
      if (row.status === 'failed' && !TERMINAL_FAILURES.has(row.last_error_code)) {
        try {
          row = first(await trx.updateRow(RUNS, { status: 'running', last_error_code: null },
            { id: row.id, tenant_id: tenantId, status: 'failed' }))
        } catch (error) {
          if (uniqueConstraint(error) === RUNNING_INDEX) throw RUN_RACE
          throw error
        }
        if (!row || row.status !== 'running') fail('UNAVAILABLE')
      }
      return row
    }
    try {
      row = first(await trx.insertOne(RUNS, { id: crypto.randomUUID(), command_id: commandId, tenant_id: tenantId,
        workspace_id: null, target_ref: targetRef, status: 'running', ...fixed }))
    } catch (error) {
      const constraint = uniqueConstraint(error)
      if (constraint === RUNNING_INDEX || constraint === COMMAND_UNIQUE) throw RUN_RACE
      throw error
    }
    if (!row || row.tenant_id !== tenantId || row.command_id !== commandId || row.status !== 'running') fail('UNAVAILABLE')
    return row
  }

  async function inspect(input) {
    try {
      const runId = input && input.runId
      if (typeof runId !== 'string' || !UUID.test(runId)) fail('INPUT')
      const row = await transaction(trx => trx.selectOne(RUNS, { id: runId, tenant_id: tenantId, owner_id: ownerId }))
      if (!row) fail('NOT_FOUND')
      return projectRun(row)
    } catch (error) { closed(error) }
  }

  /**
   * One page, one transaction. `entries` are the page's records already split by the pure layer into
   * project_mismatch / key_unmatchable / comparable (with businessKeyDigest). Returns the new run view, or
   * throws STALE when another step already moved this run's cursor (nothing written).
   */
  async function commitPage(input) {
    const { runId, pageNumber, totalCount, responseDigest, entries, evidence, completion, classify } = input
    if (typeof runId !== 'string' || !UUID.test(runId) || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 600
      || !Number.isSafeInteger(totalCount) || totalCount < 0 || totalCount > 60000
      || typeof responseDigest !== 'string' || !HEX64.test(responseDigest) || !Array.isArray(entries) || entries.length > 100
      || typeof completion !== 'function' || typeof classify !== 'function') fail('INPUT')
    const { targetRef, planRevision, credentialRef, credentialGeneration, formUuid } = evidence
    opaque(targetRef); opaque(planRevision); opaque(credentialRef); opaque(formUuid)
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1 || credentialGeneration > 2147483647) fail('INPUT')
    const payloadDigest = evidence.payloadDigest
    if (typeof payloadDigest !== 'function') fail('INPUT')
    try {
      return await transaction(async (trx) => {
        const run = await trx.selectOneForUpdate(RUNS, { id: runId, tenant_id: tenantId, owner_id: ownerId })
        if (!run) fail('NOT_FOUND')
        if (run.status !== 'running' || run.next_page_number !== pageNumber || run.target_ref !== targetRef) fail('STALE')
        const page = emptyCounts()
        const seen = new Set()
        const observations = []
        for (const entry of entries) {
          const instanceId = entry.observedInstanceId
          if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) fail('INPUT')
          page.scanned += 1
          let outcome
          let digest = null
          if (entry.kind === 'project_mismatch') outcome = 'project_mismatch'
          else if (entry.kind === 'key_unmatchable') outcome = 'key_unmatchable'
          else if (entry.kind === 'comparable') {
            digest = entry.businessKeyDigest
            if (typeof digest !== 'string' || !HEX64.test(digest)) fail('INPUT')
            // Exactly the 091 fence tuple; FOR UPDATE so a concurrent reservation is ordered against us.
            const holder = await trx.selectOneForUpdate(LEDGER, { tenant_id: tenantId, workspace_id: null,
              target_ref: targetRef, business_key_digest: digest, intent: 'create' })
            outcome = classify(holder, instanceId)
            if (outcome === 'registered' || outcome === 'would_register') {
              // The same remote instance already registered under another digest (its keys changed), or a
              // second record with the same seven keys earlier on this page (count mode inserts nothing).
              const registered = await trx.selectOne(LEDGER, { tenant_id: tenantId, workspace_id: null, target_ref: targetRef,
                observed_instance_id: instanceId, status: 'reconciled_existing' })
              if (registered || seen.has(digest)) outcome = 'duplicate_remote'
            }
            seen.add(digest)
          } else fail('INPUT')
          if (!OUTCOMES.includes(outcome)) fail('UNAVAILABLE')
          page[outcome] += 1
          if (outcome === 'registered') {
            let inserted
            try {
              inserted = first(await trx.insertOne(LEDGER, {
                id: crypto.randomUUID(), tenant_id: tenantId, workspace_id: null, operation_id: `reconcile:${runId}`,
                row_key: instanceId, owner_id: ownerId, target_ref: targetRef, target_revision: TARGET_REVISION,
                plan_revision: planRevision, payload_digest: payloadDigest({ observedInstanceId: instanceId, businessKeyDigest: digest }),
                business_key_digest: digest, credential_ref: credentialRef, credential_generation: credentialGeneration,
                intent: 'create', instance_id: null, status: 'reconciled_existing', observed_instance_id: instanceId,
              }))
            } catch (error) {
              // A concurrent admission reserved the same tuple: roll the whole page back and retry it.
              if (uniqueConstraint(error) === CREATE_FENCE) throw FENCE_RACE
              throw error
            }
            if (!inserted || inserted.status !== 'reconciled_existing' || inserted.observed_instance_id !== instanceId
              || inserted.ack_instance_id !== null || inserted.claim_token !== null) fail('UNAVAILABLE')
            const audit = first(await trx.insertOne(AUDIT, { id: crypto.randomUUID(), ledger_id: inserted.id,
              event: 'reconcile', status: 'reconciled_existing', reason: 'legacy_readback' }))
            if (!audit || audit.ledger_id !== inserted.id || audit.event !== 'reconcile') fail('UNAVAILABLE')
          } else if (OBSERVED.has(outcome)) {
            observations.push({ instanceId, digest: outcome === 'key_unmatchable' ? null : digest, outcome })
          }
        }
        for (const observation of observations) {
          // A record seen again on a later page (the remote shifted) keeps its first observation.
          const existing = await trx.selectOne(OBSERVATIONS, { run_id: runId, observed_instance_id: observation.instanceId })
          if (existing) continue
          const row = first(await trx.insertOne(OBSERVATIONS, { id: crypto.randomUUID(), run_id: runId, page_number: pageNumber,
            target_ref: targetRef, observed_instance_id: observation.instanceId, business_key_digest: observation.digest,
            outcome: observation.outcome }))
          if (!row || row.run_id !== runId) fail('UNAVAILABLE')
        }
        const pageRow = first(await trx.insertOne(PAGES, { id: crypto.randomUUID(), run_id: runId, page_number: pageNumber,
          record_count: entries.length, total_count: totalCount, response_digest: responseDigest, ...countSet(page) }))
        if (!pageRow || pageRow.page_number !== pageNumber) fail('UNAVAILABLE')
        const totalFirst = run.total_count_first ?? totalCount
        const done = completion({ pageNumber, recordCount: entries.length, totalCount, totalCountFirst: totalFirst })
        const previous = countsOf(run)
        const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, previous[key] + page[key]]))
        const set = { next_page_number: pageNumber + 1, pages_done: run.pages_done + 1, total_count_first: totalFirst,
          total_count_last: totalCount, ...countSet(counts) }
        if (done.done && done.errorCode === null) Object.assign(set, { status: 'completed', finished_at: new Date().toISOString() })
        else if (done.done) Object.assign(set, { status: 'failed', last_error_code: done.errorCode })
        const updated = first(await trx.updateRow(RUNS, set, { id: runId, tenant_id: tenantId, status: 'running',
          next_page_number: pageNumber }))
        if (!updated || updated.next_page_number !== pageNumber + 1) fail('UNAVAILABLE')
        return Object.freeze({ run: projectRun(updated), page: Object.freeze(page) })
      })
    } catch (error) { closed(error) }
  }

  /** Stops a running run with a closed code (its own transaction); a page that failed never advanced. */
  async function failRun(input) {
    try {
      const { runId, code } = input
      if (typeof runId !== 'string' || !UUID.test(runId) || !ERROR_CODES.has(code)) fail('INPUT')
      return await transaction(async (trx) => {
        const run = await trx.selectOneForUpdate(RUNS, { id: runId, tenant_id: tenantId, owner_id: ownerId })
        if (!run) fail('NOT_FOUND')
        if (run.status !== 'running') return projectRun(run)
        const updated = first(await trx.updateRow(RUNS, { status: 'failed', last_error_code: code },
          { id: runId, tenant_id: tenantId, status: 'running' }))
        if (!updated) fail('UNAVAILABLE')
        return projectRun(updated)
      })
    } catch (error) { closed(error) }
  }

  return Object.freeze({ openRunInTransaction, commitPage, failRun, inspect, projectRun })
}

function yidaReconciliationStoreErrorKind(error) { return ownErrors.get(error) }

module.exports = { createYidaReconciliationStore, YidaReconciliationStoreError, yidaReconciliationStoreErrorKind,
  YIDA_RECONCILIATION_COUNT_KEYS: COUNT_KEYS }
