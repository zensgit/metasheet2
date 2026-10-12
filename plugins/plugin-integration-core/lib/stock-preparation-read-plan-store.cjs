'use strict'

// A version ledger with an explicit generation-fenced activation pointer, but
// no route, connector, or execution capability. Callers must supply a verified
// tenant/workspace scope and actor; mutations enforce current source ownership.
// Actual read authorization
// remains the future caller's responsibility.
const crypto = require('node:crypto')
const { createDb } = require('./db.cjs')
const { validateStockPreparationReadPlanConfig } = require('./stock-preparation-read-plan-config.cjs')
const { pinLockProtocolIsolation } = require('./external-system-pointer-lock.cjs')
const { VALIDATION_TABLE, VALIDATION_ACTIONS, createReadPlanValidationLedger } = require('./stock-preparation-read-plan-validation-ledger.cjs')

const VERSION_TABLE = 'integration_stock_prep_read_plan_versions'
const ACTIVATION_TABLE = 'integration_stock_prep_read_plan_activation'
const AUDIT_TABLE = 'integration_stock_prep_read_plan_audit'
const CONTENT_INDEX = 'uniq_integration_stock_prep_read_plan_content'
const VERSION_INDEX = 'uniq_integration_stock_prep_read_plan_family_version'
const ACTIVATION_SCOPE_INDEX = 'uniq_integration_stock_prep_read_plan_activation_scope'
const MAX_GENERATION = 2147483647
const MAX_MINT_ATTEMPTS = 3
const TRANSITIONS = Object.freeze({ approve: ['draft', 'approved'], retire: ['approved', 'retired'] })

class StockPreparationReadPlanStoreError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'StockPreparationReadPlanStoreError'
    this.status = status
    this.code = code
  }
}
function fail(status, code) { throw new StockPreparationReadPlanStoreError(status, code) }
function text(value) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'READ_PLAN_SCOPE_INVALID')
  return value.trim()
}
function scopeOf(input) {
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'workspaceId')) fail(400, 'READ_PLAN_SCOPE_INVALID')
  const tenantId = text(input.tenantId)
  const workspaceId = input.workspaceId === null ? null : text(input.workspaceId)
  return { tenantId, workspaceId }
}
function actorOf(value) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'READ_PLAN_ACTOR_INVALID')
  return value.trim()
}
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
function contentKey(config) { return crypto.createHash('sha256').update(stable(config)).digest('hex') }
function first(result) {
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : [])
  return rows[0] || null
}
function rows(result) { return Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : []) }
function whereScope(scope) { return { tenant_id: scope.tenantId, workspace_id: scope.workspaceId } }
function whereFamily(scope, config) {
  return { ...whereScope(scope), action_id: config.actionId, system_id: config.systemId }
}
function expectedGeneration(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_GENERATION) fail(400, 'READ_PLAN_GENERATION_INVALID')
  return value
}
function checkedActivation(row) {
  if (!row || !Number.isInteger(row.generation) || row.generation < 1 || row.generation > MAX_GENERATION
    || !['active', 'disabled'].includes(row.status) || typeof row.version_id !== 'string' || !row.version_id
    || typeof row.system_id !== 'string' || !row.system_id
    || typeof row.content_key !== 'string' || !/^[0-9a-f]{64}$/.test(row.content_key)) {
    fail(409, 'READ_PLAN_ACTIVATION_INVALID')
  }
  return {
    id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id,
    actionId: row.action_id, versionId: row.version_id, systemId: row.system_id,
    contentKey: row.content_key, generation: row.generation, status: row.status,
    validationId: row.validation_id ?? null,
    createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null,
  }
}
function activationMatchesVersion(activation, version) {
  if (activation.versionId !== version.id || activation.actionId !== version.actionId
    || activation.systemId !== version.systemId || activation.contentKey !== version.contentKey
    || activation.tenantId !== version.tenantId || activation.workspaceId !== version.workspaceId) {
    fail(409, 'READ_PLAN_ACTIVATION_INVALID')
  }
}
function checkedRow(row) {
  let config
  try { config = validateStockPreparationReadPlanConfig(row.config) } catch (_error) { fail(409, 'READ_PLAN_CONTENT_INVALID') }
  if (row.schema_version !== 1 || row.action_id !== config.actionId || row.system_id !== config.systemId
    || stable(row.config) !== stable(config) || row.content_key !== contentKey(config)
    || !Number.isInteger(row.version) || row.version < 1
    || !['draft', 'approved', 'retired'].includes(row.status)) fail(409, 'READ_PLAN_CONTENT_INVALID')
  return {
    id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id,
    actionId: row.action_id, systemId: row.system_id, schemaVersion: row.schema_version,
    config, contentKey: row.content_key, version: row.version, status: row.status,
    validationId: row.validation_id ?? null,
    createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null,
  }
}
function auditRow(row) {
  if (!row || !['save_version', 'reuse_version', 'status_change', 'activate', 'deactivate', ...VALIDATION_ACTIONS].includes(row.action)
    || !row.detail || typeof row.detail !== 'object' || Array.isArray(row.detail)) fail(409, 'READ_PLAN_AUDIT_INVALID')
  const detail = row.detail
  if (VALIDATION_ACTIONS.includes(row.action)) {
    if (Object.keys(detail).join(',') !== 'validationId'
      || typeof detail.validationId !== 'string' || !detail.validationId) fail(409, 'READ_PLAN_AUDIT_INVALID')
  } else if (row.action === 'status_change') {
    if (Object.keys(detail).sort().join(',') !== 'from,to'
      || !Object.values(TRANSITIONS).some(([from, to]) => detail.from === from && detail.to === to)) fail(409, 'READ_PLAN_AUDIT_INVALID')
  } else if (row.action === 'activate' || row.action === 'deactivate') {
    if (Object.keys(detail).sort().join(',') !== 'generation,previousGeneration'
      || !Number.isInteger(detail.previousGeneration) || detail.previousGeneration < 0
      || !Number.isInteger(detail.generation) || detail.generation !== detail.previousGeneration + 1
      || detail.generation > MAX_GENERATION) fail(409, 'READ_PLAN_AUDIT_INVALID')
  } else if (Object.keys(detail).join(',') !== 'version' || !Number.isInteger(detail.version) || detail.version < 1) {
    fail(409, 'READ_PLAN_AUDIT_INVALID')
  }
  return { id: row.id, versionId: row.version_id, action: row.action, actor: row.actor,
    detail, createdAt: row.created_at ?? null }
}

function createStockPreparationReadPlanStore({ db, idGenerator = crypto.randomUUID, now = Date.now } = {}) {
  if (!db || ['select', 'selectOne', 'selectOneForUpdate', 'insertOne', 'updateRow', 'transaction'].some((key) => typeof db[key] !== 'function')) {
    throw new Error('createStockPreparationReadPlanStore: scoped transactional db required')
  }
  if (typeof idGenerator !== 'function') throw new Error('createStockPreparationReadPlanStore: id generator required')
  function requireTrx(trx) {
    if (!trx || ['setTransactionIsolationLevel', 'selectOneForKeyShare', 'selectOneForUpdate', 'select', 'insertOne', 'updateRow'].some((key) => typeof trx[key] !== 'function')) {
      fail(500, 'READ_PLAN_TRANSACTION_UNAVAILABLE')
    }
  }
  async function appendAudit(trx, scope, versionId, action, actor, detail) {
    const row = first(await trx.insertOne(AUDIT_TABLE, {
      id: idGenerator(), ...whereScope(scope), version_id: versionId, action, actor, detail,
    }))
    if (!row) fail(409, 'READ_PLAN_AUDIT_FAILED')
  }
  const validation = createReadPlanValidationLedger({ db, versionTable: VERSION_TABLE, fail,
    scopeOf, actorOf, text, checkedRow, requireTrx, appendAudit, idGenerator, now })
  async function saveVersion({ tenantId, workspaceId, actor, config } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const by = actorOf(actor)
    const normalized = validateStockPreparationReadPlanConfig(config)
    const key = contentKey(normalized)
    const family = whereFamily(scope, normalized)
    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt += 1) {
      try {
        return await validation.boundary(() => db.transaction(async (trx) => {
          requireTrx(trx)
          await pinLockProtocolIsolation(trx)
          await validation.lockSources(trx, scope, [{ systemId: normalized.systemId, mode: 'draft' }], by)
          const existing = await trx.selectOneForUpdate(VERSION_TABLE, { ...family, content_key: key })
          if (existing) {
            const checked = checkedRow(existing)
            if (checked.status === 'retired') fail(409, 'READ_PLAN_CONTENT_RETIRED')
            await appendAudit(trx, scope, checked.id, 'reuse_version', by, { version: checked.version })
            return checked
          }
          const latest = first(await trx.select(VERSION_TABLE, { where: family, orderBy: ['version', 'DESC'], limit: 1 }))
          const nextVersion = latest ? Number(latest.version) + 1 : 1
          if (!Number.isSafeInteger(nextVersion) || nextVersion < 1 || nextVersion > 2147483647) fail(409, 'READ_PLAN_VERSION_EXHAUSTED')
          const row = first(await trx.insertOne(VERSION_TABLE, {
            id: idGenerator(), ...family, schema_version: 1, config: normalized,
            content_key: key, version: nextVersion, status: 'draft', created_by: by, updated_by: by,
          }))
          if (!row) fail(409, 'READ_PLAN_WRITE_FAILED')
          const checked = checkedRow(row)
          await appendAudit(trx, scope, checked.id, 'save_version', by, { version: checked.version })
          return checked
        }))
      } catch (error) {
        if (error && error.code === '23505' && [CONTENT_INDEX, VERSION_INDEX].includes(error.constraint)) {
          if (attempt < MAX_MINT_ATTEMPTS) continue
          fail(409, 'READ_PLAN_MINT_CONFLICT')
        }
        throw error
      }
    }
  }
  async function get({ tenantId, workspaceId, id } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const row = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: text(id) })
    return row ? checkedRow(row) : null
  }
  async function list({ scope, systemId, actionId, status, limit = 50, offset = 0 } = {}) {
    const normalizedScope = scopeOf(scope)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) fail(400, 'READ_PLAN_PAGE_INVALID')
    if (status !== undefined && !['draft', 'approved', 'retired'].includes(status)) fail(400, 'READ_PLAN_FILTER_INVALID')
    const where = { ...whereScope(normalizedScope) }
    if (systemId !== undefined) where.system_id = text(systemId)
    if (actionId !== undefined) where.action_id = text(actionId)
    if (status !== undefined) where.status = status
    return rows(await db.select(VERSION_TABLE, { where, orderBy: ['created_at', 'DESC'], limit, offset })).map(checkedRow)
  }
  async function transition(name, { tenantId, workspaceId, id, actor } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const by = actorOf(actor)
    const versionId = text(id)
    const [from, to] = TRANSITIONS[name]
    if (name === 'approve') {
      return validation.withVersion({ ...scope, id: versionId, actor: by }, async ({ trx, version, source }) => {
        await validation.requireConfirmed(trx, scope, version, source, by)
        if (version.status !== from) fail(409, 'READ_PLAN_STATUS_CONFLICT')
        const updated = first(await trx.updateRow(VERSION_TABLE,
          { status: to, updated_by: by, updated_at: new Date() },
          { ...whereScope(scope), id: versionId, status: from, validation_id: version.validationId }))
        if (!updated) fail(409, 'READ_PLAN_STATUS_CONFLICT')
        const checked = checkedRow(updated)
        await appendAudit(trx, scope, checked.id, 'status_change', by, { from, to })
        return checked
      })
    }
    const hint = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: versionId })
    if (!hint) fail(404, 'READ_PLAN_NOT_FOUND')
    const hinted = checkedRow(hint)
    return validation.boundary(() => db.transaction(async (trx) => {
      requireTrx(trx)
      await pinLockProtocolIsolation(trx)
      await validation.lockSources(trx, scope, [{ systemId: hinted.systemId, mode: 'cleanup' }], by)
      const where = { ...whereScope(scope), id: versionId }
      const existing = await trx.selectOneForUpdate(VERSION_TABLE, where)
      if (!existing) fail(404, 'READ_PLAN_NOT_FOUND')
      const version = checkedRow(existing)
      if (version.systemId !== hinted.systemId || version.actionId !== hinted.actionId
        || version.contentKey !== hinted.contentKey) fail(409, 'READ_PLAN_CONTENT_INVALID')
      if (existing.status !== from) fail(409, 'READ_PLAN_STATUS_CONFLICT')
      const updated = first(await trx.updateRow(VERSION_TABLE,
        { status: to, updated_by: by, updated_at: new Date() }, { ...where, status: from }))
      if (!updated) fail(409, 'READ_PLAN_STATUS_CONFLICT')
      const checked = checkedRow(updated)
      await appendAudit(trx, scope, checked.id, 'status_change', by, { from, to })
      return checked
    }))
  }
  async function getForRuntime({ tenantId, workspaceId, id, actionId, systemId } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const row = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: text(id), action_id: text(actionId), system_id: text(systemId) })
    if (!row) fail(404, 'READ_PLAN_NOT_FOUND')
    const checked = checkedRow(row)
    if (checked.status !== 'approved') fail(409, 'READ_PLAN_NOT_APPROVED')
    return checked
  }
  async function getActivation({ tenantId, workspaceId, actionId } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const row = await db.selectOne(ACTIVATION_TABLE, { ...whereScope(scope), action_id: text(actionId) })
    return row ? checkedActivation(row) : null
  }
  async function activate({ tenantId, workspaceId, id, actor, expectedGeneration: expected } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const versionId = text(id)
    const by = actorOf(actor)
    const generation = expectedGeneration(expected)
    // Pre-read only to discover which source row to lock FIRST. Nothing from
    // this read is trusted after the transaction starts; the version is locked
    // and checked again after the binding and source-revision UPDATE locks.
    const hint = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: versionId })
    if (!hint) fail(404, 'READ_PLAN_NOT_FOUND')
    const hinted = checkedRow(hint)
    const pointerWhere = { ...whereScope(scope), action_id: hinted.actionId }
    const pointerHintRow = await db.selectOne(ACTIVATION_TABLE, pointerWhere)
    const pointerHint = pointerHintRow ? checkedActivation(pointerHintRow) : null
    try {
      return await validation.boundary(() => db.transaction(async (trx) => {
        requireTrx(trx)
        await pinLockProtocolIsolation(trx)
        const sources = await validation.lockSources(trx, scope, [
          { systemId: hinted.systemId },
          ...(pointerHint ? [{ systemId: pointerHint.systemId, mode: 'cleanup' }] : []),
        ], by)
        const source = sources.get(hinted.systemId)
        const locked = await trx.selectOneForUpdate(VERSION_TABLE, { ...whereScope(scope), id: versionId })
        if (!locked) fail(404, 'READ_PLAN_NOT_FOUND')
        const version = checkedRow(locked)
        if (version.systemId !== hinted.systemId || version.actionId !== hinted.actionId
          || version.contentKey !== hinted.contentKey) fail(409, 'READ_PLAN_CONTENT_INVALID')
        if (version.status !== 'approved') fail(409, 'READ_PLAN_NOT_APPROVED')
        const receipt = await validation.requireConfirmed(trx, scope, version, source, by)
        const currentRow = await trx.selectOneForUpdate(ACTIVATION_TABLE, pointerWhere)
        const current = currentRow ? checkedActivation(currentRow) : null
        if ((!current && (generation !== 0 || pointerHint)) || (current && (!pointerHint
          || current.id !== pointerHint.id || current.systemId !== pointerHint.systemId
          || current.versionId !== pointerHint.versionId || current.contentKey !== pointerHint.contentKey
          || current.validationId !== pointerHint.validationId || current.status !== pointerHint.status
          || current.generation !== pointerHint.generation || current.generation !== generation))) {
          fail(409, 'READ_PLAN_GENERATION_CONFLICT')
        }
        const next = generation + 1
        if (next > MAX_GENERATION) fail(409, 'READ_PLAN_GENERATION_EXHAUSTED')
        const row = current
          ? first(await trx.updateRow(ACTIVATION_TABLE,
            { version_id: version.id, system_id: version.systemId, content_key: version.contentKey,
              validation_id: receipt.id,
              generation: next, status: 'active', updated_by: by, updated_at: new Date() },
            { ...pointerWhere, id: current.id, generation, version_id: current.versionId, status: current.status }))
          : first(await trx.insertOne(ACTIVATION_TABLE, {
            id: idGenerator(), ...pointerWhere, version_id: version.id, system_id: version.systemId,
            validation_id: receipt.id,
            content_key: version.contentKey, generation: 1, status: 'active', created_by: by, updated_by: by,
          }))
        if (!row) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
        const activation = checkedActivation(row)
        activationMatchesVersion(activation, version)
        await appendAudit(trx, scope, version.id, 'activate', by,
          { previousGeneration: generation, generation: next })
        return activation
      }))
    } catch (error) {
      if (error && error.code === '23505' && error.constraint === ACTIVATION_SCOPE_INDEX) {
        fail(409, 'READ_PLAN_GENERATION_CONFLICT')
      }
      throw error
    }
  }
  async function deactivate({ tenantId, workspaceId, actionId, actor, expectedGeneration: expected } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const action = text(actionId)
    const by = actorOf(actor)
    const generation = expectedGeneration(expected)
    const pointerWhere = { ...whereScope(scope), action_id: action }
    // Unlocked hint only; source ownership is checked before version -> pointer.
    const hintRow = await db.selectOne(ACTIVATION_TABLE, pointerWhere)
    if (!hintRow) fail(404, 'READ_PLAN_ACTIVATION_NOT_FOUND')
    const hint = checkedActivation(hintRow)
    return validation.boundary(() => db.transaction(async (trx) => {
      requireTrx(trx)
      await pinLockProtocolIsolation(trx)
      await validation.lockSources(trx, scope, [{ systemId: hint.systemId, mode: 'cleanup' }], by)
      const versionRow = await trx.selectOneForUpdate(VERSION_TABLE,
        { ...whereScope(scope), id: hint.versionId })
      if (!versionRow) fail(409, 'READ_PLAN_ACTIVATION_INVALID')
      const version = checkedRow(versionRow) // retired is permitted for disabling
      const currentRow = await trx.selectOneForUpdate(ACTIVATION_TABLE, pointerWhere)
      if (!currentRow) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
      const current = checkedActivation(currentRow)
      if (current.id !== hint.id || current.systemId !== hint.systemId || current.versionId !== hint.versionId
        || current.contentKey !== hint.contentKey || current.validationId !== hint.validationId
        || current.status !== hint.status || current.generation !== hint.generation || current.generation !== generation) {
        fail(409, 'READ_PLAN_GENERATION_CONFLICT')
      }
      activationMatchesVersion(current, version)
      const next = generation + 1
      if (next > MAX_GENERATION) fail(409, 'READ_PLAN_GENERATION_EXHAUSTED')
      const updated = first(await trx.updateRow(ACTIVATION_TABLE,
        { generation: next, status: 'disabled', updated_by: by, updated_at: new Date() },
        { ...pointerWhere, id: current.id, version_id: current.versionId,
          generation, status: current.status }))
      if (!updated) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
      const activation = checkedActivation(updated)
      await appendAudit(trx, scope, version.id, 'deactivate', by,
        { previousGeneration: generation, generation: next })
      return activation
    }))
  }
  async function getActiveForRuntime({ tenantId, workspaceId, actionId, systemId, expectedGeneration: expected } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const action = text(actionId)
    const system = text(systemId)
    const generation = expected === undefined ? undefined : expectedGeneration(expected)
    const pointerRow = await db.selectOne(ACTIVATION_TABLE, { ...whereScope(scope), action_id: action })
    if (!pointerRow) return null
    const activation = checkedActivation(pointerRow)
    if (activation.status !== 'active') fail(409, 'READ_PLAN_ACTIVATION_DISABLED')
    if (activation.systemId !== system) fail(409, 'READ_PLAN_ACTIVATION_SOURCE_MISMATCH')
    if (generation !== undefined && activation.generation !== generation) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
    const versionRow = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: activation.versionId })
    if (!versionRow) fail(409, 'READ_PLAN_ACTIVATION_INVALID')
    const version = checkedRow(versionRow)
    activationMatchesVersion(activation, version)
    if (version.status !== 'approved') fail(409, 'READ_PLAN_NOT_APPROVED')
    // The activation owns a frozen receipt. A new pending validation supersedes
    // approval/activation eligibility, but does not silently disable that pointer.
    // Metadata is checked under locks, released before the caller executes a
    // source read. This is NOT an execution lock or an atomic source snapshot.
    let sourceValidation
    await validation.boundary(async () => {
      if (!activation.validationId) fail(409, 'READ_PLAN_VALIDATION_REQUIRED')
      const receiptHint = await db.selectOne(VALIDATION_TABLE,
        { ...whereScope(scope), id: activation.validationId, version_id: version.id })
      if (!receiptHint) fail(409, 'READ_PLAN_VALIDATION_REQUIRED')
      await db.transaction(async trx => {
        requireTrx(trx)
        await pinLockProtocolIsolation(trx)
        const source = await validation.lockSource(trx, scope, version.systemId, receiptHint.actor)
        const locked = await trx.selectOneForUpdate(VERSION_TABLE, { ...whereScope(scope), id: version.id })
        if (!locked) fail(409, 'READ_PLAN_ACTIVATION_INVALID')
        const currentVersion = checkedRow(locked)
        activationMatchesVersion(activation, currentVersion)
        if (currentVersion.status !== 'approved') fail(409, 'READ_PLAN_NOT_APPROVED')
        await validation.requireConfirmed(trx, scope, currentVersion, source, receiptHint.actor,
          { validationId: activation.validationId, requireLatest: false, requireUnexpired: false })
        sourceValidation = Object.freeze({ connectionId: source.connectionId,
          connectionRevision: source.connectionRevision, bindingRevision: source.bindingRevision })
        const currentPointer = await trx.selectOneForUpdate(ACTIVATION_TABLE,
          { ...whereScope(scope), action_id: action })
        if (!currentPointer || currentPointer.generation !== activation.generation
          || currentPointer.validation_id !== activation.validationId
          || currentPointer.status !== 'active' || currentPointer.id !== activation.id
          || currentPointer.version_id !== activation.versionId) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
        activationMatchesVersion(checkedActivation(currentPointer), currentVersion)
      })
    })
    // This read is not an execution capability and cannot make a later read
    // atomic with activation. Still, do not return a pair assembled across a
    // pointer move that occurred while the version row was being loaded.
    const latestRow = await db.selectOne(ACTIVATION_TABLE, { ...whereScope(scope), action_id: action })
    if (!latestRow) fail(409, 'READ_PLAN_GENERATION_CONFLICT')
    const latest = checkedActivation(latestRow)
    if (latest.id !== activation.id || latest.generation !== activation.generation
      || latest.status !== activation.status || latest.versionId !== activation.versionId
      || latest.validationId !== activation.validationId
      || latest.systemId !== activation.systemId || latest.contentKey !== activation.contentKey) {
      fail(409, 'READ_PLAN_GENERATION_CONFLICT')
    }
    // Private runtime metadata, not part of any list/management DTO. Physical
    // facade calls must bind this revision to the actually used adapter too.
    return { activation, version, sourceValidation }
  }
  async function listAudit({ tenantId, workspaceId, id, limit = 100, offset = 0 } = {}) {
    const scope = scopeOf({ tenantId, workspaceId })
    const versionId = text(id)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) fail(400, 'READ_PLAN_PAGE_INVALID')
    const version = await db.selectOne(VERSION_TABLE, { ...whereScope(scope), id: versionId })
    if (!version) fail(404, 'READ_PLAN_NOT_FOUND')
    checkedRow(version)
    return rows(await db.select(AUDIT_TABLE, {
      where: { ...whereScope(scope), version_id: versionId }, orderBy: ['created_at', 'DESC'], limit, offset,
    })).map(auditRow)
  }
  return { saveVersion, list, get, approve: (input) => transition('approve', input),
    retire: (input) => transition('retire', input), getForRuntime, listAudit,
    getActivation, activate, deactivate, getActiveForRuntime,
    beginValidation: validation.beginValidation, finishValidation: validation.finishValidation,
    confirmValidation: validation.confirmValidation, failValidation: validation.failValidation,
    getValidation: validation.getValidation }
}

module.exports = { VERSION_TABLE, ACTIVATION_TABLE, AUDIT_TABLE, VALIDATION_TABLE, CONTENT_INDEX, VERSION_INDEX, ACTIVATION_SCOPE_INDEX,
  StockPreparationReadPlanStoreError, createStockPreparationReadPlanStore }
