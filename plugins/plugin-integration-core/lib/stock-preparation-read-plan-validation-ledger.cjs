'use strict'

const { pinLockProtocolIsolation } = require('./external-system-pointer-lock.cjs')
const { DEFAULT_SQL_CONNECTION_TYPES } = require('./connection-resolver.cjs')

const VALIDATION_TABLE = 'integration_stock_prep_read_plan_validations'
const SOURCE_REVISION_TABLE = 'integration_data_source_validation_revisions'
const EXTERNAL_SYSTEM_TABLE = 'integration_external_systems'
const VALIDATION_TTL_MS = 15 * 60 * 1000
const VALIDATION_CONTRACT_VERSION = 'plm-read-plan-validation.v1'
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COUNT_LIMITS = Object.freeze({ sampleCount: 100000, readCount: 1000, objectCount: 7 })
const VALIDATION_ACTIONS = Object.freeze(['validation_begin', 'validation_finish', 'validation_confirm', 'validation_fail'])

function createReadPlanValidationLedger({ db, versionTable, fail, scopeOf, actorOf, text,
  checkedRow, requireTrx, appendAudit, idGenerator, now = Date.now }) {
  const whereScope = scope => ({ tenant_id: scope.tenantId, workspace_id: scope.workspaceId })
  const first = result => (Array.isArray(result) ? result : result?.rows ?? [])[0] ?? null
  function timestamp(value) {
    const time = value instanceof Date ? value.getTime() : Date.parse(value)
    if (!Number.isFinite(time)) fail(409, 'READ_PLAN_VALIDATION_INVALID')
    return time
  }
  function clock() {
    const time = Number(now())
    if (!Number.isFinite(time)) fail(500, 'READ_PLAN_VALIDATION_UNAVAILABLE')
    return time
  }
  function countsOf(counts) {
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.keys(counts).sort().join(',') !== Object.keys(COUNT_LIMITS).sort().join(',')) {
      fail(400, 'READ_PLAN_VALIDATION_COUNTS_INVALID')
    }
    const result = {}
    for (const [key, maximum] of Object.entries(COUNT_LIMITS)) {
      if (!Number.isSafeInteger(counts[key]) || counts[key] < 1 || counts[key] > maximum) {
        fail(400, 'READ_PLAN_VALIDATION_COUNTS_INVALID')
      }
      result[key] = counts[key]
    }
    return result
  }
  function sourceOf(source) {
    if (!source || typeof source.connectionId !== 'string' || !source.connectionId
      || !REVISION.test(source.connectionRevision)) fail(409, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
    return { connectionId: source.connectionId, connectionRevision: source.connectionRevision }
  }
  function checkReceipt(row, version) {
    if (!row || typeof row.id !== 'string' || !row.id
      || row.contract_version !== VALIDATION_CONTRACT_VERSION
      || row.tenant_id !== version.tenantId || row.workspace_id !== version.workspaceId
      || row.version_id !== version.id || row.system_id !== version.systemId
      || row.action_id !== version.actionId || row.content_key !== version.contentKey
      || typeof row.actor !== 'string' || !row.actor.trim()
      || typeof row.connection_id !== 'string' || !row.connection_id
      || !REVISION.test(row.connection_revision) || !REVISION.test(row.binding_revision)
      || !['pending', 'passed', 'confirmed', 'failed'].includes(row.status)
      || timestamp(row.expires_at) !== timestamp(row.begun_at) + VALIDATION_TTL_MS) {
      fail(409, 'READ_PLAN_VALIDATION_INVALID')
    }
    if (['passed', 'confirmed'].includes(row.status)) {
      countsOf(row.counts)
      if (timestamp(row.finished_at) < timestamp(row.begun_at)
        || timestamp(row.finished_at) >= timestamp(row.expires_at)) fail(409, 'READ_PLAN_VALIDATION_INVALID')
    } else if (row.counts !== null) fail(409, 'READ_PLAN_VALIDATION_INVALID')
    if (row.status === 'confirmed') {
      if (timestamp(row.confirmed_at) < timestamp(row.finished_at)
        || timestamp(row.confirmed_at) >= timestamp(row.expires_at)) fail(409, 'READ_PLAN_VALIDATION_INVALID')
    } else if (row.confirmed_at !== null) fail(409, 'READ_PLAN_VALIDATION_INVALID')
    return row
  }
  function summary(row) {
    return { validationId: row.id, status: row.status, counts: row.counts,
      expiresAt: new Date(timestamp(row.expires_at)).toISOString(),
      confirmedAt: row.confirmed_at === null ? null : new Date(timestamp(row.confirmed_at)).toISOString() }
  }
  async function boundary(work) {
    try { return await work() } catch (error) {
      if (['42P01', '42703'].includes(error?.code)) fail(503, 'READ_PLAN_VALIDATION_UNAVAILABLE')
      throw error
    }
  }
  // Lock the actual mutable metadata, never connector config or credentials.
  // All EXT (sorted) -> all mirror (sorted) -> version/evidence/pointer. Do not
  // take the DS row here:
  // a DS update owns DS -> mirror, while canonical binding writes own EXT -> DS.
  async function lockSources(trx, scope, requests, actor) {
    const requirements = new Map()
    for (const { systemId, mode = 'validation' } of requests) {
      const prior = requirements.get(systemId)
      requirements.set(systemId, {
        validate: mode === 'validation' || prior?.validate === true,
        requireActive: mode !== 'cleanup' || prior?.requireActive === true,
      })
    }
    const bindings = new Map()
    for (const systemId of [...requirements.keys()].sort()) {
      const { validate, requireActive } = requirements.get(systemId)
      const code = validate ? 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE' : 'READ_PLAN_SOURCE_INELIGIBLE'
      const binding = await trx.selectOneForUpdate(EXTERNAL_SYSTEM_TABLE,
        { tenant_id: scope.tenantId, id: systemId })
      if (!binding || binding.id !== systemId || binding.tenant_id !== scope.tenantId
        || (validate && scope.workspaceId !== null)
        || (binding.workspace_id !== null && binding.workspace_id !== scope.workspaceId)
        || binding.kind !== 'data-source:sql-readonly' || !['active', 'inactive'].includes(binding.status)
        || (requireActive && binding.status !== 'active')
        || !['source', 'bidirectional'].includes(binding.role)
        || typeof binding.connection_id !== 'string' || !binding.connection_id
        || !REVISION.test(binding.validation_revision)) fail(409, code)
      const legacy = binding.config?.dataSourceId
      if (legacy !== undefined && legacy !== null && legacy !== binding.connection_id) fail(409, code)
      bindings.set(systemId, binding)
    }
    const revisions = new Map()
    for (const connectionId of [...new Set([...bindings.values()].map(binding => binding.connection_id))].sort()) {
      revisions.set(connectionId, await trx.selectOneForUpdate(SOURCE_REVISION_TABLE, { data_source_id: connectionId }))
    }
    const sources = new Map()
    for (const [systemId, binding] of bindings) {
      const { validate } = requirements.get(systemId)
      const code = validate ? 'READ_PLAN_VALIDATION_SOURCE_INELIGIBLE' : 'READ_PLAN_SOURCE_INELIGIBLE'
      const revision = revisions.get(binding.connection_id)
      if (!revision || revision.data_source_id !== binding.connection_id
        || revision.tenant_id !== scope.tenantId || (validate && revision.workspace_id !== null)
        || revision.owner_id !== actor || revision.scope_kind !== 'private'
        || typeof revision.type !== 'string'
        || !(validate ? ['postgres', 'postgresql', 'sqlserver'].includes(revision.type)
          : DEFAULT_SQL_CONNECTION_TYPES.has(revision.type.toLowerCase()))
        || revision.is_active !== true || revision.deleted_at !== null
        || !REVISION.test(revision.validation_revision)) fail(409, code)
      sources.set(systemId, { connectionId: binding.connection_id, connectionRevision: revision.validation_revision,
        bindingRevision: binding.validation_revision })
    }
    return sources
  }
  async function lockSource(trx, scope, systemId, actor, suppliedSource) {
    const source = (await lockSources(trx, scope, [{ systemId }], actor)).get(systemId)
    if (suppliedSource) {
      const supplied = sourceOf(suppliedSource)
      if (supplied.connectionId !== source.connectionId || supplied.connectionRevision !== source.connectionRevision) {
        fail(409, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
      }
    }
    return source
  }
  function matchSource(receipt, source) {
    if (receipt.connection_id !== source.connectionId || receipt.connection_revision !== source.connectionRevision
      || receipt.binding_revision !== source.bindingRevision) fail(409, 'READ_PLAN_VALIDATION_SOURCE_CHANGED')
  }
  async function receiptFor(trx, scope, version, validationId) {
    if (typeof validationId !== 'string' || !validationId) fail(409, 'READ_PLAN_VALIDATION_REQUIRED')
    return checkReceipt(await trx.selectOneForUpdate(VALIDATION_TABLE,
      { ...whereScope(scope), id: validationId, version_id: version.id }), version)
  }
  async function requireConfirmed(trx, scope, version, source, actor,
    { validationId = version.validationId, requireLatest = true, requireUnexpired = true } = {}) {
    if (requireLatest && validationId !== version.validationId) fail(409, 'READ_PLAN_VALIDATION_SUPERSEDED')
    const receipt = await receiptFor(trx, scope, version, validationId)
    if (receipt.actor !== actor) fail(403, 'READ_PLAN_VALIDATION_ACTOR_MISMATCH')
    matchSource(receipt, source)
    if (receipt.status !== 'confirmed') fail(409, 'READ_PLAN_VALIDATION_REQUIRED')
    if (requireUnexpired && clock() >= timestamp(receipt.expires_at)) fail(409, 'READ_PLAN_VALIDATION_EXPIRED')
    return receipt
  }
  async function withVersion(input, work) {
    const scope = scopeOf(input)
    const actor = actorOf(input.actor)
    const id = text(input.id)
    return boundary(async () => {
      // This unlocked hint ONLY establishes lock order. Immutable family/content
      // and owner are checked again after all mutable source metadata is locked.
      const hint = await db.selectOne(versionTable, { ...whereScope(scope), id })
      if (!hint) fail(404, 'READ_PLAN_NOT_FOUND')
      const hinted = checkedRow(hint)
      return db.transaction(async trx => {
        requireTrx(trx)
        await pinLockProtocolIsolation(trx)
        const source = await lockSource(trx, scope, hinted.systemId, actor, input.source)
        const row = await trx.selectOneForUpdate(versionTable, { ...whereScope(scope), id })
        if (!row) fail(404, 'READ_PLAN_NOT_FOUND')
        const version = checkedRow(row)
        if (version.systemId !== hinted.systemId || version.actionId !== hinted.actionId
          || version.contentKey !== hinted.contentKey) fail(409, 'READ_PLAN_CONTENT_INVALID')
        if (version.status === 'retired') fail(409, 'READ_PLAN_CONTENT_RETIRED')
        return work({ trx, scope, actor, version, source })
      })
    })
  }
  async function beginValidation(input = {}) {
    sourceOf(input.source)
    return withVersion(input, async ({ trx, scope, actor, version, source }) => {
      const begunAt = clock()
      // The mirror lock serializes admission across all versions/bindings using
      // this current Connection revision. A crashed attempt expires; no client
      // force flag can create overlapping reads or synthesize a successful one.
      const pending = first(await trx.select(VALIDATION_TABLE, { where: {
        ...whereScope(scope), actor, connection_id: source.connectionId,
        connection_revision: source.connectionRevision, status: 'pending',
      }, orderBy: ['expires_at', 'DESC'], limit: 1 }))
      if (pending && timestamp(pending.expires_at) > begunAt) fail(409, 'READ_PLAN_VALIDATION_IN_PROGRESS')
      const row = first(await trx.insertOne(VALIDATION_TABLE, {
        id: idGenerator(), ...whereScope(scope), version_id: version.id,
        contract_version: VALIDATION_CONTRACT_VERSION,
        action_id: version.actionId, system_id: version.systemId, content_key: version.contentKey,
        actor, connection_id: source.connectionId, connection_revision: source.connectionRevision,
        binding_revision: source.bindingRevision, status: 'pending', counts: null,
        begun_at: new Date(begunAt), expires_at: new Date(begunAt + VALIDATION_TTL_MS),
        finished_at: null, confirmed_at: null,
      }))
      if (!row) fail(409, 'READ_PLAN_VALIDATION_WRITE_FAILED')
      const updated = first(await trx.updateRow(versionTable,
        { validation_id: row.id, updated_by: actor, updated_at: new Date(begunAt) },
        { ...whereScope(scope), id: version.id, status: version.status }))
      if (!updated) fail(409, 'READ_PLAN_VALIDATION_WRITE_FAILED')
      await appendAudit(trx, scope, version.id, 'validation_begin', actor, { validationId: row.id })
      return summary(checkReceipt(row, version))
    })
  }
  async function changeValidation(action, input = {}) {
    const counts = action === 'finish' ? countsOf(input.counts) : null
    if (action === 'finish') sourceOf(input.source)
    const validationId = text(input.validationId)
    return withVersion(input, async ({ trx, scope, actor, version, source }) => {
      if (version.validationId !== validationId) fail(409, 'READ_PLAN_VALIDATION_SUPERSEDED')
      const receipt = await receiptFor(trx, scope, version, validationId)
      if (receipt.actor !== actor) fail(403, 'READ_PLAN_VALIDATION_ACTOR_MISMATCH')
      matchSource(receipt, source)
      const time = clock()
      if (time >= timestamp(receipt.expires_at)) fail(409, 'READ_PLAN_VALIDATION_EXPIRED')
      const from = action === 'confirm' ? 'passed' : 'pending'
      if (receipt.status !== from) fail(409, 'READ_PLAN_VALIDATION_STATUS_CONFLICT')
      const changes = action === 'confirm'
        ? { status: 'confirmed', confirmed_at: new Date(time) }
        : { status: action === 'finish' ? 'passed' : 'failed', finished_at: new Date(time), counts }
      const updated = first(await trx.updateRow(VALIDATION_TABLE, changes,
        { ...whereScope(scope), id: validationId, version_id: version.id, status: from }))
      if (!updated) fail(409, 'READ_PLAN_VALIDATION_STATUS_CONFLICT')
      await appendAudit(trx, scope, version.id, `validation_${action}`, actor, { validationId })
      return summary(checkReceipt(updated, version))
    })
  }
  async function getValidation(input = {}) {
    const scope = scopeOf(input)
    return boundary(async () => {
      const row = await db.selectOne(versionTable, { ...whereScope(scope), id: text(input.id) })
      if (!row) fail(404, 'READ_PLAN_NOT_FOUND')
      const version = checkedRow(row)
      if (!version.validationId) return null
      const receipt = await db.selectOne(VALIDATION_TABLE,
        { ...whereScope(scope), id: version.validationId, version_id: version.id })
      return summary(checkReceipt(receipt, version))
    })
  }
  return { beginValidation, finishValidation: input => changeValidation('finish', input),
    confirmValidation: input => changeValidation('confirm', input), failValidation: input => changeValidation('fail', input),
    getValidation, withVersion, requireConfirmed, lockSource, lockSources, boundary }
}

module.exports = { VALIDATION_TABLE, SOURCE_REVISION_TABLE, VALIDATION_TTL_MS, VALIDATION_CONTRACT_VERSION, VALIDATION_ACTIONS,
  createReadPlanValidationLedger }
