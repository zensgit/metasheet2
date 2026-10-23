import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bomReviewSourceFingerprint } from '../../src/multitable/plm-bom-source-navigation'
import {
  EcoCollaborationSnapshotError,
  EcoCollaborationSnapshotService,
  type EcoQuery,
} from '../../src/multitable/plm-collaboration-snapshot-service'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  EcoCollaborationSourceError,
  ecoCollaborationBusinessHash,
  parseEcoCollaborationSource,
} from '../../src/multitable/plm-collaboration-snapshot-wire'
import {
  classifyManagedSourceOnQuery,
  setManagedBindingReaderForTests,
} from '../../src/services/plm-managed-companion'

const actor = 'owner'
const dataSourceId = 'ds-eco-1'
const baseId = 'base-eco-1'
const itemId = 'item-1'
const ecoId = 'eco-1'
const tenant = 'tenant-1'
const org = 'org-1'
const sheetId = 'sheet-1'
const viewId = 'view-1'
const recordId = 'rec-1'
const capturedAt = '2026-10-24T01:02:03.000000Z'
const sourceFields = Object.fromEntries(ECO_COLLABORATION_ECO_FIELDS.map((key) => [key, `fld_${key}`]))
const localFields = {
  collaboration_owner: 'fld_collaboration_owner',
  followup_due_at: 'fld_followup_due_at',
  review_note: 'fld_review_note',
}
const rowKey = [dataSourceId, tenant, org, ecoId] as const

const sourceConfig = {
  connection: {
    url: 'https://plm.example',
    headers: { 'x-tenant-id': tenant, 'x-org-id': org },
  },
  options: { apiMode: 'yuantus', tenantId: tenant, orgId: org },
  credentials: { token: 'plain-token' },
}

const sourceRow = {
  id: dataSourceId,
  name: 'ECO source',
  type: 'plm',
  config: sourceConfig,
  owner_id: actor,
  is_active: true,
  deleted_at: null,
  workspace_id: 'ws-1',
  tenant_id: 'meta-tenant',
  scope_kind: 'personal',
}

const fingerprint = bomReviewSourceFingerprint({
  id: sourceRow.id,
  type: sourceRow.type,
  config: sourceRow.config,
  owner_id: sourceRow.owner_id,
  is_active: true,
  workspace_id: sourceRow.workspace_id,
  tenant_id: sourceRow.tenant_id,
  scope_kind: sourceRow.scope_kind,
})

function dto(name = 'Gate') {
  return {
    projection_contract: 'eco_collaboration_source.v1' as const,
    feature_key: 'collaboration_source_read' as const,
    entitled: true as const,
    source: {
      tenant_id: tenant,
      org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
    },
    snapshot_at: capturedAt,
    eco: {
      id: ecoId,
      name,
      eco_type: 'design',
      product_id: itemId,
      source_version_id: null,
      target_version_id: null,
      stage_id: null,
      state: null,
      kanban_state: null,
      priority: null,
      updated_at: null,
    },
  }
}

const parsed = parseEcoCollaborationSource(dto(), {
  tenantId: tenant,
  orgId: org,
  itemId,
  ecoId,
  currentVersionId: 'ver-1',
})
const businessHash = ecoCollaborationBusinessHash(dataSourceId, parsed)

interface ScriptState {
  bound: boolean
  armBoundAfterProvider: boolean
  providerReturned: boolean
  schemaMissing: boolean
  unavailable: boolean
  sheetGrant: boolean
  sheetPerm: string
  sourceConfigOverride: typeof sourceConfig | null
  fieldReadOnly: boolean
  recordNone: boolean
  hiddenFieldId: string | null
  concealedFieldId: string | null
  sourceOwner: string
  previews: Array<Record<string, unknown>>
  bindings: Array<Record<string, unknown>>
  stored: Array<Record<string, unknown>>
  records: Array<Record<string, unknown>>
}

function emptyState(): ScriptState {
  return {
    bound: false,
    armBoundAfterProvider: false,
    providerReturned: false,
    schemaMissing: false,
    unavailable: false,
    sheetGrant: true,
    sheetPerm: 'spreadsheet:admin',
    sourceConfigOverride: null,
    fieldReadOnly: false,
    recordNone: false,
    hiddenFieldId: null,
    concealedFieldId: null,
    sourceOwner: actor,
    previews: [],
    bindings: [],
    stored: [],
    records: [],
  }
}

function rowsOf(rows: unknown[]) {
  return { rows, rowCount: rows.length }
}

function answer(state: ScriptState, sql: string, params: unknown[] = []) {
  if (sql.includes('to_regclass')) return rowsOf([{ ready: true }])
  if (sql.includes('plm_managed_source_bindings')) {
    if (state.schemaMissing) {
      throw Object.assign(new Error('relation "plm_managed_source_bindings" does not exist'), { code: '42P01' })
    }
    if (state.unavailable) throw new Error('connection reset')
    if (state.bound || (state.armBoundAfterProvider && state.providerReturned)) {
      return rowsOf([{ data_source_id: dataSourceId, binding_status: 'active' }])
    }
    return rowsOf([])
  }
  if (sql.includes('FROM data_sources')) {
    return rowsOf([{
      ...sourceRow,
      owner_id: state.sourceOwner,
      config: state.sourceConfigOverride ?? sourceRow.config,
    }])
  }
  if (sql.includes('FROM users')) {
    return rowsOf([{
      id: actor,
      is_active: true,
      role: 'member',
      activation_status: 'activated',
      local_password_set: true,
      permissions: [],
    }])
  }
  if (sql.includes('JOIN meta_bases')) return rowsOf([{ id: sheetId }])
  if (sql.includes('FROM meta_bases')) return rowsOf([{ id: baseId, owner_id: actor, deleted_at: null }])
  if (sql.includes('FROM spreadsheet_permissions') && state.sheetGrant) {
    const sheet = Array.isArray(params[1]) ? String(params[1][0]) : sheetId
    return rowsOf([{ sheet_id: sheet, perm_code: state.sheetPerm, subject_type: 'user' }])
  }
  if (sql.includes('FROM field_permissions')) {
    if (state.fieldReadOnly) {
      return rowsOf(Object.values(sourceFields).map((fieldId) => ({
        field_id: fieldId,
        visible: true,
        read_only: true,
      })))
    }
    if (state.concealedFieldId) {
      return rowsOf([{ field_id: state.concealedFieldId, visible: false, read_only: false }])
    }
  }
  if (sql.includes('FROM record_permissions') && state.recordNone) {
    const ids = Array.isArray(params[2]) ? params[2] : []
    return rowsOf(ids.map((id) => ({ record_id: id, access_level: 'none' })))
  }
  if (sql.includes('FROM meta_fields')) {
    const ids = Array.isArray(params[1]) ? params[1] : Array.isArray(params[0]) ? params[0] : []
    return rowsOf(ids.map((id) => ({
      id,
      sheet_id: sheetId,
      type: 'string',
      property: id === state.hiddenFieldId ? { hidden: true } : { readOnly: true },
    })))
  }
  if (sql.includes('INSERT INTO meta_plm_collaboration_previews')) {
    return rowsOf([{ id: params[0], expires_at: '2026-10-24T02:17:03.000Z' }])
  }
  if (sql.includes('FROM meta_plm_collaboration_previews')) {
    if (sql.includes('id<>')) {
      const [requestId, id] = params
      return rowsOf(state.previews.filter((row) => row.request_id === requestId && row.id !== id))
    }
    const [id, owner] = params
    return rowsOf(state.previews
      .filter((row) => row.id === id && row.actor_id === owner)
      .map((row) => ({ ...row, expired: row.expired === true })))
  }
  if (sql.includes('FROM meta_plm_collaboration_bindings')) {
    return rowsOf(state.bindings.filter((row) => row.id === params[0]))
  }
  if (sql.includes('FROM meta_plm_collaboration_rows')) {
    const matched = state.stored.filter((row) => {
      if (row.binding_id !== params[0]) return false
      if (!sql.includes('row_key=$2')) return true
      const key = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
      return JSON.stringify(row.row_key) === JSON.stringify(key)
    })
    return rowsOf(sql.includes('LIMIT 1') ? matched.slice(0, 1) : matched)
  }
  if (sql.includes('FROM meta_records')) {
    return rowsOf(state.records.filter((row) => row.id === params[0] && row.sheet_id === params[1]))
  }
  if (sql.includes("status = 'disabled'")) {
    const binding = state.bindings.find((row) => row.id === params[0])
    if (!binding || binding.version !== params[1] || binding.status !== params[2] || binding.creator_id !== params[3]) {
      return { rows: [], rowCount: 0 }
    }
    binding.version = Number(binding.version) + 1
    binding.status = 'disabled'
    return rowsOf([{ version: binding.version, status: 'disabled' }])
  }
  if (sql.includes("status='stale'")) {
    const binding = state.bindings.find((row) => row.id === params[0])
    if (!binding || binding.version !== params[1] || binding.status !== 'active' || binding.creator_id !== params[2]) {
      return { rows: [], rowCount: 0 }
    }
    binding.version = Number(binding.version) + 1
    binding.status = 'stale'
    binding.last_failure_code = params[3]
    return { rows: [], rowCount: 1 }
  }
  return rowsOf([])
}

function harness(state = emptyState(), body = dto()) {
  const calls: string[] = []
  const transactions: string[][] = []
  const provider = vi.fn(async () => {
    state.providerReturned = true
    return body
  })
  const pool = {
    async transaction<T>(fn: (tx: { query: EcoQuery }) => Promise<T>): Promise<T> {
      const local: string[] = []
      const query: EcoQuery = async (sql, params) => {
        calls.push(sql)
        local.push(sql)
        return answer(state, sql, params)
      }
      try {
        return await fn({ query })
      } finally {
        transactions.push(local)
      }
    },
  }
  const service = new EcoCollaborationSnapshotService({
    pool,
    dataSourceManager: { getDataSource: () => ({ getEcoCollaborationSource: provider }) } as never,
  })
  return { service, calls, transactions, provider, state }
}

function previewBody() {
  return {
    sourceKind: 'eco' as const,
    dataSourceId,
    baseId,
    itemId,
    currentVersionId: 'ver-1',
    ecoId,
    name: 'ECO collection',
  }
}

function seedBinding(state: ScriptState, version = 4, status: 'active' | 'stale' | 'disabled' = 'active') {
  const bindingId = randomUUID()
  state.bindings.push({
    id: bindingId,
    creator_id: actor,
    data_source_id: dataSourceId,
    source_kind: 'eco',
    native_tenant_id: tenant,
    native_org_id: org,
    item_id: itemId,
    current_version_id: 'ver-1',
    source_fingerprint: fingerprint,
    base_id: baseId,
    sheet_id: sheetId,
    view_id: viewId,
    name: 'ECO collection',
    source_fields: sourceFields,
    local_fields: localFields,
    version,
    status,
    last_failure_code: null,
    last_failure_at: null,
  })
  state.stored.push({
    binding_id: bindingId,
    record_id: recordId,
    row_key: [...rowKey],
    business_hash: businessHash,
    captured_at: capturedAt,
  })
  state.records.push({
    id: recordId,
    sheet_id: sheetId,
    data: { [sourceFields.id]: ecoId, [localFields.review_note]: 'kept' },
    version: 1,
    locked: false,
    locked_by: null,
    created_by: actor,
  })
  return bindingId
}

function seedPreview(
  state: ScriptState,
  bindingId: string | null,
  requestId: string | null = null,
  patch: Record<string, unknown> = {},
) {
  const previewId = randomUUID()
  state.previews.push({
    id: previewId,
    actor_id: actor,
    data_source_id: dataSourceId,
    source_kind: 'eco',
    native_tenant_id: tenant,
    native_org_id: org,
    item_id: itemId,
    current_version_id: 'ver-1',
    base_id: baseId,
    name: 'ECO collection',
    row_key: [...rowKey],
    source_fingerprint: fingerprint,
    business_hash: businessHash,
    captured_at: capturedAt,
    request_id: requestId,
    binding_id: bindingId,
    consumed_at: bindingId ? capturedAt : null,
    expired: false,
    ...patch,
    id: previewId,
  })
  return previewId
}

function mutations(calls: string[]) {
  return calls.filter((sql) => /^\s*(insert|update|delete)\b/i.test(sql))
}

beforeEach(() => {
  vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
})

afterEach(() => {
  setManagedBindingReaderForTests(null)
  vi.unstubAllEnvs()
})

describe('ECO collaboration snapshot service', () => {
  it('classifies on the caller query and keeps the global wrapper unchanged', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
    const companion = readFileSync(new URL('../../src/services/plm-managed-companion.ts', import.meta.url), 'utf8')
    const globalFn = companion.slice(
      companion.indexOf('export async function classifyManagedSource('),
      companion.indexOf('export async function classifyManagedSourceOnQuery'),
    )
    expect(globalFn).toContain('readerOverride')
    expect(globalFn).toContain('explicitDatabaseUrl()')
    setManagedBindingReaderForTests(async () => {
      throw new Error('global reader')
    })
    await expect(classifyManagedSourceOnQuery(async () => ({ rows: [] }), dataSourceId)).resolves.toEqual({ kind: 'unbound' })
    const source = readFileSync(new URL('../../src/multitable/plm-collaboration-snapshot-service.ts', import.meta.url), 'utf8')
    expect(source).toContain('classifyManagedSourceOnQuery')
    expect(source).not.toMatch(/\bclassifyManagedSource\(/)
    expect(source).toContain('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))')
    expect(source).not.toContain('provisionManagedLink')
    const admit = source.slice(source.indexOf('private async admit'), source.indexOf('private async fetch'))
    expect(admit.indexOf('ADVISORY_SQL')).toBeGreaterThanOrEqual(0)
    expect(admit.indexOf('ADVISORY_SQL')).toBeLessThan(admit.indexOf('classifyManagedSourceOnQuery'))
    expect(admit.indexOf('classifyManagedSourceOnQuery')).toBeLessThan(admit.indexOf('FOR SHARE'))
    expect(source).toContain(', 1, false)')
    expect(source).toContain(', expectedVersion, true)')
  })

  it('rejects a strict-invalid preview before any query or provider call', async () => {
    const { service, calls, provider } = harness()
    await expect(service.preview(actor, { ...previewBody(), sourceKind: 'readiness' })).rejects.toMatchObject({
      status: 422,
      code: 'ECO_REQUEST_INVALID',
    })
    expect(calls).toEqual([])
    expect(provider).not.toHaveBeenCalled()
  })

  it('stores an unbound preview only after the source lock and omits credentials', async () => {
    const { service, calls, provider } = harness()
    const result = await service.preview(actor, previewBody())
    expect(result.businessHash).toBe(businessHash)
    expect(result.rowKey).toEqual([...rowKey])
    expect(JSON.stringify(result)).not.toContain('plain-token')
    const insertAt = calls.findIndex((sql) => sql.includes('INSERT INTO meta_plm_collaboration_previews'))
    const advisoryAt = calls.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended'))
    const bindingAt = calls.findIndex((sql) => sql.includes('plm_managed_source_bindings'))
    const shareAt = calls.findIndex((sql) => sql.includes('FROM data_sources') && sql.includes('FOR SHARE'))
    expect(advisoryAt).toBeGreaterThanOrEqual(0)
    expect(advisoryAt).toBeLessThan(bindingAt)
    expect(bindingAt).toBeLessThan(shareAt)
    expect(shareAt).toBeLessThan(insertAt)
    expect(calls[insertAt]).toContain("now() + interval '15 minutes'")
    expect(calls[insertAt]).not.toContain('request_id')
    expect(provider).toHaveBeenCalledTimes(1)
    expect(mutations(calls)).toHaveLength(1)
  })

  it('refuses a bound, missing, or unavailable source before the provider', async () => {
    const bound = harness()
    bound.state.bound = true
    await expect(bound.service.preview(actor, previewBody())).rejects.toMatchObject({ status: 403, code: 'ECO_SOURCE_MANAGED' })
    expect(bound.provider).not.toHaveBeenCalled()

    const missing = harness()
    missing.state.schemaMissing = true
    await expect(missing.service.preview(actor, previewBody())).rejects.toMatchObject({ status: 403, code: 'ECO_SOURCE_SCHEMA_MISSING' })
    expect(missing.provider).not.toHaveBeenCalled()

    const down = harness()
    down.state.unavailable = true
    await expect(down.service.preview(actor, previewBody())).rejects.toMatchObject({ status: 503, code: 'ECO_SOURCE_UNAVAILABLE' })
    expect(down.provider).not.toHaveBeenCalled()
  })

  it('refuses contradictory confirm selectors before a query', async () => {
    const { service, calls, provider } = harness()
    await expect(service.confirm(actor, {
      previewId: randomUUID(),
      requestId: randomUUID(),
      expectedVersion: 0,
      targetBindingId: randomUUID(),
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.confirm(actor, {
      previewId: randomUUID(),
      requestId: randomUUID(),
      expectedVersion: 1,
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    expect(calls).toEqual([])
    expect(provider).not.toHaveBeenCalled()
  })

  it('replays a consumed version-0 preview onto binding A without a provider call or a version-0 requirement', async () => {
    const { service, calls, provider, state } = harness()
    const bindingId = seedBinding(state, 4)
    const requestId = randomUUID()
    const previewId = seedPreview(state, bindingId, requestId)
    const result = await service.confirm(actor, { previewId, requestId, expectedVersion: 0 })
    expect(result).toMatchObject({ bindingId, version: 4, replayed: true, recordId })
    expect(provider).not.toHaveBeenCalled()
    expect(mutations(calls)).toEqual([])
  })

  it('rejects replay target B and a second preview using the same request with no provider call', async () => {
    const replay = harness()
    const bindingId = seedBinding(replay.state, 4)
    const requestId = randomUUID()
    const previewId = seedPreview(replay.state, bindingId, requestId)
    await expect(replay.service.confirm(actor, {
      previewId,
      requestId,
      expectedVersion: 2,
      targetBindingId: randomUUID(),
    })).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
    expect(replay.provider).not.toHaveBeenCalled()
    expect(mutations(replay.calls)).toEqual([])

    const conflict = harness()
    const first = seedPreview(conflict.state, null, requestId)
    seedPreview(conflict.state, null, null)
    const open = conflict.state.previews.find((row) => row.id !== first)
    await expect(conflict.service.confirm(actor, {
      previewId: String(open?.id),
      requestId,
      expectedVersion: 0,
    })).rejects.toMatchObject({ status: 409, code: 'REQUEST_CONFLICT' })
    expect(conflict.provider).not.toHaveBeenCalled()
  })

  it('refuses replay when the source owner or sheet grant is gone', async () => {
    const owned = harness()
    const bindingId = seedBinding(owned.state, 1)
    const requestId = randomUUID()
    const previewId = seedPreview(owned.state, bindingId, requestId)
    owned.state.sourceOwner = 'other-owner'
    await expect(owned.service.confirm(actor, { previewId, requestId, expectedVersion: 0 })).rejects.toMatchObject({
      status: 403,
      code: 'SOURCE_FORBIDDEN',
    })
    expect(owned.provider).not.toHaveBeenCalled()

    const sheet = harness()
    const sheetBinding = seedBinding(sheet.state, 1)
    const sheetRequest = randomUUID()
    const sheetPreview = seedPreview(sheet.state, sheetBinding, sheetRequest)
    sheet.state.sheetGrant = false
    await expect(sheet.service.confirm(actor, {
      previewId: sheetPreview,
      requestId: sheetRequest,
      expectedVersion: 0,
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(sheet.provider).not.toHaveBeenCalled()
  })

  it('stops confirm after the provider when the source becomes managed with the same config', async () => {
    const { service, calls, transactions, provider, state } = harness()
    state.armBoundAfterProvider = true
    const previewId = seedPreview(state, null)
    const requestId = randomUUID()
    await expect(service.confirm(actor, { previewId, requestId, expectedVersion: 0 })).rejects.toMatchObject({
      status: 403,
      code: 'ECO_SOURCE_MANAGED',
    })
    expect(provider).toHaveBeenCalledTimes(1)
    const last = transactions[transactions.length - 1]
    const advisoryAt = last.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended'))
    const bindingAt = last.findIndex((sql) => sql.includes('plm_managed_source_bindings'))
    expect(advisoryAt).toBeGreaterThanOrEqual(0)
    expect(bindingAt).toBeGreaterThan(advisoryAt)
    expect(last.some((sql) => sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'))).toBe(false)
    expect(mutations(calls)).toEqual([])
    expect(JSON.stringify(calls)).not.toContain('plain-token')
  })

  it('treats an unchanged business hash as a refresh no-op even when the source property is readOnly', async () => {
    const { service, calls, provider, state } = harness()
    const bindingId = seedBinding(state, 3)
    const result = await service.refresh(actor, bindingId, { expectedVersion: 3, rowKey: [...rowKey] })
    expect(result).toMatchObject({ bindingId, version: 3, noop: true, recordId })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(mutations(calls)).toEqual([])
    expect(calls.some((sql) => sql.includes('metasheet.plm_collaboration_sync'))).toBe(false)
    expect(state.bindings[0].version).toBe(3)
  })

  it('refuses a field-permission readOnly refresh before the provider and does not stale a hash change', async () => {
    const denied = harness()
    const bindingId = seedBinding(denied.state, 3)
    denied.state.fieldReadOnly = true
    await expect(denied.service.refresh(actor, bindingId, { expectedVersion: 3, rowKey: [...rowKey] })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(denied.provider).not.toHaveBeenCalled()
    expect(denied.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })

    const changed = harness(emptyState(), dto('Changed'))
    const previewId = seedPreview(changed.state, null)
    await expect(changed.service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 0,
    })).rejects.toMatchObject({ status: 409, code: 'SOURCE_CHANGED' })
    expect(changed.state.previews[0].consumed_at).toBeNull()
    expect(changed.state.bindings).toEqual([])
    expect(mutations(changed.calls)).toEqual([])
  })

  it('marks an active binding stale only for a retained provider entitlement refusal', async () => {
    const refused = harness()
    const bindingId = seedBinding(refused.state, 3)
    refused.provider.mockRejectedValue(new EcoCollaborationSourceError(403, 'ECO_SOURCE_UNLICENSED'))
    await expect(refused.service.refresh(actor, bindingId, { expectedVersion: 3, rowKey: [...rowKey] })).rejects.toMatchObject({
      status: 403,
      code: 'ECO_SOURCE_UNLICENSED',
    })
    expect(refused.state.bindings[0]).toMatchObject({ status: 'stale', version: 4, last_failure_code: 'ECO_SOURCE_UNLICENSED' })

    const unavailable = harness()
    const unavailableId = seedBinding(unavailable.state, 3)
    unavailable.provider.mockRejectedValue(new EcoCollaborationSourceError(503, 'ECO_SOURCE_UNAVAILABLE'))
    await expect(unavailable.service.refresh(actor, unavailableId, {
      expectedVersion: 3,
      rowKey: [...rowKey],
    })).rejects.toMatchObject({ status: 503, code: 'ECO_SOURCE_UNAVAILABLE' })
    expect(unavailable.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
  })

  it('disables without a provider and never resurrects a disabled binding', async () => {
    const active = harness()
    const bindingId = seedBinding(active.state, 2)
    const disabled = await active.service.disable(actor, bindingId, { expectedVersion: 2 })
    expect(disabled).toMatchObject({ bindingId, status: 'disabled', version: 3 })
    expect(active.provider).not.toHaveBeenCalled()
    expect(active.calls.some((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended'))).toBe(false)
    const again = await active.service.disable(actor, bindingId, { expectedVersion: 3 })
    expect(again).toMatchObject({ status: 'disabled', version: 3 })
    expect(active.state.bindings[0].version).toBe(3)
    await expect(active.service.disable(actor, bindingId, { expectedVersion: 2 })).rejects.toBeInstanceOf(EcoCollaborationSnapshotError)
  })

  it('reads a retained binding with no provider call and hides a denied record', async () => {
    const visible = harness()
    visible.state.bound = true
    visible.state.hiddenFieldId = localFields.review_note
    const bindingId = seedBinding(visible.state, 4, 'stale')
    const body = await visible.service.get(actor, bindingId)
    expect(visible.provider).not.toHaveBeenCalled()
    expect(body).toMatchObject({ id: bindingId, status: 'stale', canRefresh: false, sourceKind: 'eco' })
    expect(body.row?.cells.id).toBe(ecoId)
    expect(body.row?.rowKey).toEqual([...rowKey])
    expect(body.row?.businessHash).toBe(businessHash)
    expect(body.row?.capturedAt).toBe(capturedAt)
    expect(JSON.stringify(body.row)).not.toContain('kept')
    expect(JSON.stringify(body)).not.toContain('plain-token')

    const hidden = harness()
    const hiddenId = seedBinding(hidden.state, 1)
    hidden.state.recordNone = true
    const denied = await hidden.service.get(actor, hiddenId)
    expect(denied.row).toBeNull()
    expect(denied.canRefresh).toBe(false)
    expect(denied).toMatchObject({ id: hiddenId, sheetId, viewId, sourceKind: 'eco' })
    const serialized = JSON.stringify(denied)
    for (const secret of [recordId, businessHash, capturedAt, `"${ecoId}"`]) {
      expect(serialized).not.toContain(secret)
    }
    expect(hidden.provider).not.toHaveBeenCalled()
  })

  it('refuses an explicit confirm target that is not the frozen preview before any provider call', async () => {
    const { service, provider, state, calls } = harness()
    const unrelated = seedBinding(state, 2)
    const previewId = seedPreview(state, null, null, {
      data_source_id: 'ds-eco-A',
      item_id: 'item-A',
      name: 'A collection',
      row_key: ['ds-eco-A', tenant, org, 'eco-A'],
    })
    await expect(service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 2,
      targetBindingId: unrelated,
    })).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
    expect(provider).not.toHaveBeenCalled()
    expect(mutations(calls)).toEqual([])
    expect(state.bindings[0]).toMatchObject({ id: unrelated, status: 'active', version: 2 })
  })

  it('stales only the explicit frozen target after a provider token refusal', async () => {
    const { service, provider, state } = harness()
    provider.mockRejectedValue(new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED'))
    const target = seedBinding(state, 3)
    const unrelated = seedBinding(state, 5)
    state.bindings[1].item_id = 'item-B'
    state.bindings[1].name = 'B collection'
    const previewId = seedPreview(state, null)
    await expect(service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: target,
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })
    expect(state.bindings.find((row) => row.id === target)).toMatchObject({
      status: 'stale',
      version: 4,
      last_failure_code: 'ECO_SOURCE_TOKEN_REJECTED',
    })
    expect(state.bindings.find((row) => row.id === unrelated)).toMatchObject({ status: 'active', version: 5 })
  })

  it('rejects an exact replay after the source fingerprint changes and keeps the binding', async () => {
    const { service, provider, state, calls } = harness()
    const bindingId = seedBinding(state, 4)
    const requestId = randomUUID()
    const previewId = seedPreview(state, bindingId, requestId)
    state.sourceConfigOverride = {
      ...sourceConfig,
      credentials: { token: 'changed-own-token' },
    }
    await expect(service.confirm(actor, { previewId, requestId, expectedVersion: 0 })).rejects.toMatchObject({
      status: 409,
      code: 'SOURCE_CHANGED',
    })
    expect(provider).not.toHaveBeenCalled()
    expect(mutations(calls)).toEqual([])
    expect(state.bindings[0]).toMatchObject({ status: 'active', version: 4 })
  })

  it('rejects an exact replay when management is gone and read remains', async () => {
    const { service, provider, state, calls } = harness()
    const bindingId = seedBinding(state, 4)
    const requestId = randomUUID()
    const previewId = seedPreview(state, bindingId, requestId)
    state.sheetPerm = 'spreadsheet:read'
    await expect(service.confirm(actor, { previewId, requestId, expectedVersion: 0 })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
    expect(provider).not.toHaveBeenCalled()
    expect(mutations(calls)).toEqual([])
    expect(state.bindings[0]).toMatchObject({ status: 'active', version: 4 })
  })

  it('refuses preview and unconsumed confirm when the writer fence is off', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'false')
    const preview = harness()
    await expect(preview.service.preview(actor, previewBody())).rejects.toMatchObject({
      status: 503,
      code: 'ECO_RUNTIME_UNAVAILABLE',
    })
    expect(preview.provider).not.toHaveBeenCalled()
    expect(mutations(preview.calls)).toEqual([])

    const confirm = harness()
    const previewId = seedPreview(confirm.state, null)
    await expect(confirm.service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 0,
    })).rejects.toMatchObject({ status: 503, code: 'ECO_RUNTIME_UNAVAILABLE' })
    expect(confirm.provider).not.toHaveBeenCalled()
    expect(confirm.state.previews[0].consumed_at).toBeNull()
    expect(mutations(confirm.calls)).toEqual([])
  })

  it('redacts ECO identity when a source field is concealed and keeps it for a local-only hide', async () => {
    const concealed = harness()
    const concealedId = seedBinding(concealed.state, 1)
    concealed.state.concealedFieldId = sourceFields.id
    const hidden = await concealed.service.get(actor, concealedId)
    expect(hidden.row?.recordId).toBe(recordId)
    expect(hidden.row?.cells.id).toBeUndefined()
    expect(hidden.row?.rowKey).toBeNull()
    expect(hidden.row?.businessHash).toBeNull()
    expect(hidden.row?.capturedAt).toBeNull()
    expect(hidden).toMatchObject({ id: concealedId, sheetId, viewId, sourceKind: 'eco' })
    const serialized = JSON.stringify(hidden)
    expect(serialized).not.toContain(JSON.stringify(ecoId))
    expect(serialized).not.toContain(JSON.stringify(businessHash))
    expect(concealed.provider).not.toHaveBeenCalled()

    const propertyHidden = harness()
    propertyHidden.state.hiddenFieldId = sourceFields.id
    const propertyId = seedBinding(propertyHidden.state, 1)
    const propertyBody = await propertyHidden.service.get(actor, propertyId)
    expect(propertyBody.row?.recordId).toBe(recordId)
    expect(propertyBody.row?.rowKey).toBeNull()
    expect(propertyBody.row?.businessHash).toBeNull()
    expect(JSON.stringify(propertyBody)).not.toContain(JSON.stringify(ecoId))
    expect(JSON.stringify(propertyBody)).not.toContain(JSON.stringify(businessHash))

    const local = harness()
    local.state.hiddenFieldId = localFields.review_note
    const localId = seedBinding(local.state, 1)
    const body = await local.service.get(actor, localId)
    expect(body.row?.recordId).toBe(recordId)
    expect(body.row?.cells.id).toBe(ecoId)
    expect(body.row?.rowKey).toEqual([...rowKey])
    expect(body.row?.businessHash).toBe(businessHash)
    expect(body.row?.capturedAt).toBe(capturedAt)
    expect(JSON.stringify(body.row)).not.toContain('kept')
    expect(local.provider).not.toHaveBeenCalled()
  })

  it('takes the source advisory before a preview or binding row lock', async () => {
    const explicit = harness()
    const unrelated = seedBinding(explicit.state, 2)
    const explicitPreview = seedPreview(explicit.state, null, null, {
      data_source_id: 'ds-eco-A',
      item_id: 'item-A',
      name: 'A collection',
      row_key: ['ds-eco-A', tenant, org, 'eco-A'],
    })
    await expect(explicit.service.confirm(actor, {
      previewId: explicitPreview,
      requestId: randomUUID(),
      expectedVersion: 2,
      targetBindingId: unrelated,
    })).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
    expect(explicit.provider).not.toHaveBeenCalled()

    const replayed = harness()
    const replayBinding = seedBinding(replayed.state, 4)
    const requestId = randomUUID()
    const replayPreview = seedPreview(replayed.state, replayBinding, requestId)
    await replayed.service.confirm(actor, { previewId: replayPreview, requestId, expectedVersion: 0 })
    expect(replayed.provider).not.toHaveBeenCalled()

    const refreshed = harness()
    const refreshBinding = seedBinding(refreshed.state, 3)
    await refreshed.service.refresh(actor, refreshBinding, { expectedVersion: 3, rowKey: [...rowKey] })

    const retained = harness()
    retained.provider.mockRejectedValue(new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED'))
    const retainedBinding = seedBinding(retained.state, 3)
    await expect(retained.service.refresh(actor, retainedBinding, {
      expectedVersion: 3,
      rowKey: [...rowKey],
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })

    for (const { transactions } of [explicit, replayed, refreshed, retained]) {
      for (const sqls of transactions) {
        const advisory = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended'))
        const binding = sqls.findIndex((sql) => sql.includes('FROM meta_plm_collaboration_bindings') && sql.includes('FOR UPDATE'))
        const preview = sqls.findIndex((sql) => sql.includes('FROM meta_plm_collaboration_previews') && sql.includes('FOR UPDATE'))
        if (binding >= 0 || preview >= 0) expect(advisory).toBeGreaterThanOrEqual(0)
        if (binding >= 0) expect(binding).toBeGreaterThan(advisory)
        if (preview >= 0) expect(preview).toBeGreaterThan(advisory)
      }
    }
  })
})
