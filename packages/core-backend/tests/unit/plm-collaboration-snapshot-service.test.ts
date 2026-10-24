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
  READINESS_COLLABORATION_SOURCE_FIELDS,
  ReadinessCollaborationSourceError,
  parseReadinessCollaborationSource,
  readinessCollaborationBusinessHash,
  readinessCollaborationSourceCells,
} from '../../src/multitable/plm-collaboration-readiness-wire'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'
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
  recordNoneIds: string[]
  userActive: boolean
  hiddenFieldId: string | null
  concealedFieldId: string | null
  sourceOwner: string
  readinessInstalled: boolean
  readinessAdapter: boolean
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
    recordNoneIds: [],
    userActive: true,
    hiddenFieldId: null,
    concealedFieldId: null,
    sourceOwner: actor,
    readinessInstalled: false,
    readinessAdapter: true,
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
  if (sql.includes('meta_plm_collaboration_readiness_request_id')) {
    return rowsOf([{ ready: state.readinessInstalled === true }])
  }
  if (sql.includes('to_regclass')) return rowsOf([{ ready: true }])
  if (sql.includes("column_name = 'operation_id'")) return rowsOf([{ present: 1 }])
  if (sql.includes('INSERT INTO meta_sheets')) return { rows: [], rowCount: 1 }
  if (sql.includes('FROM meta_sheets') && sql.includes('deleted_at IS NULL')) {
    return rowsOf([{ id: params[0], base_id: baseId, name: 'collection', description: null, system_kind: null }])
  }
  if (sql.includes('INSERT INTO meta_views')) return { rows: [], rowCount: 1 }
  if (sql.includes('FROM meta_views')) {
    return rowsOf([{
      id: params[0], sheet_id: sheetId, name: '全部', type: 'grid',
      filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {},
    }])
  }
  if (sql.includes('SELECT id FROM meta_fields WHERE id = ANY')) return rowsOf([])
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
      is_active: state.userActive,
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
      const fieldIds = [...Object.values(sourceFields), ...Object.values(readinessFields)]
      return rowsOf(fieldIds.map((fieldId) => ({
        field_id: fieldId,
        visible: true,
        read_only: true,
      })))
    }
    if (state.concealedFieldId) {
      return rowsOf([{ field_id: state.concealedFieldId, visible: false, read_only: false }])
    }
  }
  if (sql.includes('FROM record_permissions') && (state.recordNone || state.recordNoneIds.length > 0)) {
    const ids = Array.isArray(params[2]) ? params[2] : []
    const denied = state.recordNone ? ids : ids.filter((id) => state.recordNoneIds.includes(String(id)))
    return rowsOf(denied.map((id) => ({ record_id: id, access_level: 'none' })))
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
  if (sql.includes('INSERT INTO meta_plm_collaboration_bindings')) {
    state.bindings.push({
      id: params[0],
      creator_id: params[1],
      data_source_id: params[2],
      source_kind: params[3],
      native_tenant_id: params[4],
      native_org_id: params[5],
      item_id: params[6],
      current_version_id: params[7],
      source_fingerprint: params[8],
      base_id: params[9],
      sheet_id: params[10],
      view_id: params[11],
      name: params[12],
      source_fields: JSON.parse(String(params[13])),
      local_fields: JSON.parse(String(params[14])),
      version: 1,
      status: 'active',
      last_failure_code: null,
      last_failure_at: null,
    })
    return rowsOf([])
  }
  if (sql.includes('FROM meta_plm_collaboration_bindings') && !sql.includes('UPDATE ')) {
    if (sql.includes('source_kind=$6')) {
      return rowsOf(state.bindings.filter((row) =>
        row.base_id === params[0]
        && row.data_source_id === params[1]
        && row.native_tenant_id === params[2]
        && row.native_org_id === params[3]
        && row.item_id === params[4]
        && row.source_kind === params[5]))
    }
    return rowsOf(state.bindings.filter((row) => row.id === params[0]))
  }
  if (sql.includes('INSERT INTO meta_plm_collaboration_rows')) {
    state.stored.push({
      binding_id: params[0],
      row_key: JSON.parse(String(params[1])),
      record_id: params[2],
      business_hash: params[3],
      captured_at: params[4],
    })
    return rowsOf([])
  }
  if (sql.includes('UPDATE meta_plm_collaboration_rows')) {
    const row = state.stored.find((entry) => entry.binding_id === params[2] && entry.record_id === params[3])
    if (row) {
      row.business_hash = params[0]
      row.captured_at = params[1]
    }
    return rowsOf([])
  }
  if (sql.includes('INSERT INTO meta_records')) {
    state.records.push({
      id: params[0],
      sheet_id: params[1],
      data: JSON.parse(String(params[2])),
      version: 1,
      locked: false,
      locked_by: null,
      created_by: params[3],
    })
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('UPDATE meta_records')) {
    const record = state.records.find((entry) => entry.id === params[2] && entry.sheet_id === params[3] && entry.version === params[4])
    if (!record) return { rows: [], rowCount: 0 }
    record.data = { ...(record.data as Record<string, unknown>), ...JSON.parse(String(params[0])) }
    record.version = Number(record.version) + 1
    return rowsOf([{ version: record.version, data: record.data }])
  }
  if (sql.includes('INSERT INTO meta_record_revisions')) return rowsOf([{ seq: '1' }])
  if (sql.includes('consumed_at=now()')) {
    const preview = state.previews.find((entry) => entry.id === params[2] && entry.actor_id === params[3] && entry.request_id == null)
    if (!preview) return { rows: [], rowCount: 0 }
    preview.request_id = params[0]
    preview.binding_id = params[1]
    preview.consumed_at = capturedAt
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('SET version = version + 1') && sql.includes("status='active'")) {
    const binding = state.bindings.find((entry) => entry.id === params[0])
    if (!binding || binding.version !== params[1] || binding.status !== 'active' || binding.creator_id !== params[2]) {
      return { rows: [], rowCount: 0 }
    }
    binding.version = Number(binding.version) + 1
    return rowsOf([{ version: binding.version }])
  }
  if (sql.includes('FROM meta_plm_collaboration_rows') && !sql.includes('UPDATE ')) {
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
    if (params.length > 13 && params[13] != null) {
      const key = typeof params[13] === 'string' ? JSON.parse(params[13]) : params[13]
      const stored = state.stored.find((row) => row.binding_id === binding.id && JSON.stringify(row.row_key) === JSON.stringify(key))
      if (!stored) return { rows: [], rowCount: 0 }
    }
    binding.version = Number(binding.version) + 1
    binding.status = 'stale'
    binding.last_failure_code = params[3]
    return { rows: [], rowCount: 1 }
  }
  return rowsOf([])
}

function harness(state = emptyState(), body = dto(), readinessBody: unknown = undefined) {
  const calls: string[] = []
  const transactions: string[][] = []
  const provider = vi.fn(async () => {
    state.providerReturned = true
    return body
  })
  const readinessProvider = vi.fn(async () => {
    state.providerReturned = true
    return readinessBody
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
    dataSourceManager: {
      getDataSource: () => state.readinessAdapter
        ? { getEcoCollaborationSource: provider, getReadinessCollaborationSource: readinessProvider }
        : { getEcoCollaborationSource: provider },
    } as never,
  })
  return { service, calls, transactions, provider, readinessProvider, state }
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
  __resetOperationLedgerColumnProbe()
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
    expect(calls[insertAt]).not.toContain("'eco'")
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

  it('stales the frozen ECO collection when a not-yet-stored eco tuple is token-refused', async () => {
    const refused = harness()
    refused.provider.mockRejectedValue(new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED'))
    const target = seedBinding(refused.state, 3)
    const unrelated = seedBinding(refused.state, 5)
    refused.state.bindings[1].item_id = 'item-B'
    refused.state.bindings[1].name = 'B collection'
    const storedBefore = refused.state.stored.map((row) => JSON.stringify(row.row_key))
    const previewId = seedPreview(refused.state, null, null, {
      row_key: [dataSourceId, tenant, org, 'eco-b'],
    })
    await expect(refused.service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: target,
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })
    expect(refused.provider).toHaveBeenCalledTimes(1)
    expect(refused.state.bindings.find((row) => row.id === target)).toMatchObject({
      status: 'stale',
      version: 4,
      last_failure_code: 'ECO_SOURCE_TOKEN_REJECTED',
    })
    expect(refused.state.bindings.find((row) => row.id === unrelated)).toMatchObject({ status: 'active', version: 5 })
    expect(refused.state.stored.map((row) => JSON.stringify(row.row_key))).toEqual(storedBefore)
    expect(refused.state.previews[0]).toMatchObject({ request_id: null, consumed_at: null })

    const rotated = harness()
    const rotatedId = seedBinding(rotated.state, 3)
    const rotatedPreview = seedPreview(rotated.state, null, null, {
      row_key: [dataSourceId, tenant, org, 'eco-b'],
    })
    rotated.provider.mockImplementation(async () => {
      rotated.state.sourceConfigOverride = { ...sourceConfig, credentials: { token: 'rotated-token' } }
      throw new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED')
    })
    await expect(rotated.service.confirm(actor, {
      previewId: rotatedPreview,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: rotatedId,
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })
    expect(rotated.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })

    const advanced = harness()
    const advancedId = seedBinding(advanced.state, 3)
    const advancedPreview = seedPreview(advanced.state, null, null, {
      row_key: [dataSourceId, tenant, org, 'eco-b'],
    })
    advanced.provider.mockImplementation(async () => {
      advanced.state.bindings[0].version = 4
      throw new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED')
    })
    await expect(advanced.service.confirm(actor, {
      previewId: advancedPreview,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: advancedId,
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })
    expect(advanced.state.bindings[0]).toMatchObject({ status: 'active', version: 4 })

    const revoked = harness()
    const revokedId = seedBinding(revoked.state, 3)
    const revokedPreview = seedPreview(revoked.state, null)
    revoked.provider.mockImplementation(async () => {
      revoked.state.recordNoneIds = [recordId]
      throw new EcoCollaborationSourceError(401, 'ECO_SOURCE_TOKEN_REJECTED')
    })
    await expect(revoked.service.confirm(actor, {
      previewId: revokedPreview,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: revokedId,
    })).rejects.toMatchObject({ status: 401, code: 'ECO_SOURCE_TOKEN_REJECTED' })
    expect(revoked.provider).toHaveBeenCalledTimes(1)
    expect(revoked.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
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

const rulesetA = 'ruleset-a'
const rulesetB = 'ruleset-b'
const readinessFields = Object.fromEntries(READINESS_COLLABORATION_SOURCE_FIELDS.map((key) => [key, `fld_${key}`]))

function issueFree(kind: 'mbom_release' | 'routing_release', resourceType: 'mbom' | 'routing', id: string) {
  return {
    kind,
    name: id,
    state: 'open',
    resource_type: resourceType,
    resource_id: id,
    errors: [] as Array<{ code: string; rule_id: string }>,
    warnings: [] as Array<{ code: string; rule_id: string }>,
  }
}

function readinessDto(
  ruleset = rulesetA,
  resources: ReturnType<typeof issueFree>[] = [],
  generatedAt = capturedAt,
  snapshotAt = capturedAt,
  version: string | null = 'ver-1',
) {
  return {
    projection_contract: 'release_readiness_collaboration_source.v1' as const,
    feature_key: 'collaboration_source_read' as const,
    entitled: true as const,
    source: { tenant_id: tenant, org_id: org, item_id: itemId, current_version_id: version },
    snapshot_at: snapshotAt,
    readiness: {
      item_id: itemId,
      ruleset_id: ruleset,
      generated_at: generatedAt,
      coverage_status: 'bounded_not_proven_complete' as const,
      summary: {
        resources: resources.length,
        ok_resources: resources.filter((resource) => resource.errors.length === 0).length,
        error_count: resources.reduce((sum, resource) => sum + resource.errors.length, 0),
        warning_count: resources.reduce((sum, resource) => sum + resource.warnings.length, 0),
      },
      resources,
    },
  }
}

function readinessPreviewBody(ruleset = rulesetA) {
  return {
    sourceKind: 'readiness' as const,
    dataSourceId,
    baseId,
    itemId,
    currentVersionId: 'ver-1' as string | null,
    rulesetId: ruleset,
    name: 'Readiness collection',
  }
}

function readinessKey(ruleset = rulesetA) {
  return [dataSourceId, tenant, org, itemId, ruleset] as const
}

function seedReadiness(state: ScriptState, ruleset = rulesetA, version = 4, hash = readinessCollaborationBusinessHash(
  dataSourceId,
  parseReadinessCollaborationSource(readinessDto(ruleset), {
    tenantId: tenant, orgId: org, itemId, rulesetId: ruleset, currentVersionId: 'ver-1',
  }),
)) {
  const bindingId = state.bindings.find((row) => row.source_kind === 'readiness')?.id as string | undefined ?? randomUUID()
  if (!state.bindings.some((row) => row.id === bindingId)) {
    state.bindings.push({
      id: bindingId,
      creator_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      source_fingerprint: fingerprint,
      base_id: baseId,
      sheet_id: sheetId,
      view_id: viewId,
      name: 'Readiness collection',
      source_fields: readinessFields,
      local_fields: localFields,
      version,
      status: 'active',
      last_failure_code: null,
      last_failure_at: null,
    })
  }
  const record = `rec-${ruleset}`
  state.stored.push({
    binding_id: bindingId,
    record_id: record,
    row_key: [...readinessKey(ruleset)],
    business_hash: hash,
    captured_at: capturedAt,
  })
  state.records.push({
    id: record,
    sheet_id: sheetId,
    data: {
      [readinessFields.ruleset_id]: ruleset,
      [readinessFields.resources]: '[]',
      [localFields.review_note]: 'kept',
    },
    version: 1,
    locked: false,
    locked_by: null,
    created_by: actor,
  })
  return bindingId
}

describe('Readiness collaboration snapshot service', () => {
  it('stores a readiness preview after the capability check and keeps ECO free of that probe', async () => {
    const ready = harness(emptyState(), dto(), readinessDto())
    ready.state.readinessInstalled = true
    const result = await ready.service.preview(actor, readinessPreviewBody())
    expect(result.rowKey).toEqual([...readinessKey()])
    expect(result).not.toHaveProperty('eco')
    expect(result.readiness.resources).toBe('[]')
    expect(result.readiness.coverage_status).toBe('bounded_not_proven_complete')
    expect(JSON.stringify(result)).not.toContain('plain-token')
    const probeAt = ready.calls.findIndex((sql) => sql.includes('meta_plm_collaboration_readiness_request_id'))
    const providerAt = ready.calls.length
    expect(probeAt).toBeGreaterThanOrEqual(0)
    expect(probeAt).toBeLessThan(providerAt)
    expect(ready.readinessProvider).toHaveBeenCalledTimes(1)
    expect(ready.provider).not.toHaveBeenCalled()
    expect(ready.calls.some((sql) => sql.includes('to_regclass'))).toBe(true)
    expect(ready.calls.find((sql) => sql.includes('meta_plm_collaboration_readiness_request_id'))).not.toContain('to_regclass')

    const eco = harness()
    await eco.service.preview(actor, previewBody())
    expect(eco.calls.some((sql) => sql.includes('meta_plm_collaboration_readiness_request_id'))).toBe(false)
    expect(eco.provider).toHaveBeenCalledTimes(1)
  })

  it('refuses a readiness preview on a foundation-only schema before the provider', async () => {
    const missing = harness(emptyState(), dto(), readinessDto())
    await expect(missing.service.preview(actor, readinessPreviewBody())).rejects.toMatchObject({
      status: 503,
      code: 'READINESS_RUNTIME_UNAVAILABLE',
    })
    expect(missing.readinessProvider).not.toHaveBeenCalled()
    expect(missing.provider).not.toHaveBeenCalled()
    expect(missing.calls.some((sql) => sql.includes('meta_plm_collaboration_readiness_request_id'))).toBe(true)

    const eco = harness()
    await eco.service.preview(actor, previewBody())
    expect(eco.provider).toHaveBeenCalledTimes(1)
  })

  it('rejects a readiness preview that still carries an ECO id before any query', async () => {
    const { service, calls, provider, readinessProvider } = harness()
    await expect(service.preview(actor, { ...readinessPreviewBody(), ecoId: 'eco-1' })).rejects.toMatchObject({
      status: 422,
      code: 'ECO_REQUEST_INVALID',
    })
    expect(calls).toEqual([])
    expect(provider).not.toHaveBeenCalled()
    expect(readinessProvider).not.toHaveBeenCalled()
  })

  it('confirms the first readiness row and appends a second ruleset on the same binding', async () => {
    const first = harness(emptyState(), dto(), readinessDto(rulesetA))
    first.state.readinessInstalled = true
    const preview = await first.service.preview(actor, readinessPreviewBody(rulesetA))
    first.state.previews.push({
      id: preview.previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetA)],
      source_fingerprint: fingerprint,
      business_hash: preview.businessHash,
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    const created = await first.service.confirm(actor, {
      previewId: preview.previewId,
      requestId: randomUUID(),
      expectedVersion: 0,
    })
    expect(created.replayed).toBe(false)
    expect(first.state.bindings).toHaveLength(1)
    expect(first.state.bindings[0]).toMatchObject({ source_kind: 'readiness', item_id: itemId, version: 1 })
    expect(first.state.stored.map((row) => row.row_key)).toEqual([[...readinessKey(rulesetA)]])
    expect(first.readinessProvider).toHaveBeenCalledTimes(2)

    const second = harness(emptyState(), dto(), readinessDto(rulesetB))
    second.state.readinessInstalled = true
    const bindingId = seedReadiness(second.state, rulesetA, 1)
    const again = await second.service.preview(actor, readinessPreviewBody(rulesetB))
    second.state.previews.push({
      id: again.previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetB)],
      source_fingerprint: fingerprint,
      business_hash: again.businessHash,
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    const appended = await second.service.confirm(actor, {
      previewId: again.previewId,
      requestId: randomUUID(),
      expectedVersion: 1,
      targetBindingId: bindingId,
    })
    expect(appended.bindingId).toBe(bindingId)
    expect(second.state.bindings).toHaveLength(1)
    expect(second.state.stored.map((row) => row.row_key[4])).toEqual([rulesetA, rulesetB])
  })

  it('selects two readiness rows independently and returns a shell when the selector is absent', async () => {
    const harnessed = harness()
    harnessed.state.readinessInstalled = true
    const id = seedReadiness(harnessed.state, rulesetA, 2)
    seedReadiness(harnessed.state, rulesetB, 2)
    const absent = await harnessed.service.get(actor, id, {})
    expect(absent).toMatchObject({ id, sourceKind: 'readiness', row: null, canRefresh: false })
    expect(harnessed.calls.some((sql) => sql.includes('ORDER BY record_id LIMIT 1'))).toBe(false)
    const selectedA = await harnessed.service.get(actor, id, { rowKey: JSON.stringify(readinessKey(rulesetA)) })
    const selectedB = await harnessed.service.get(actor, id, { rowKey: JSON.stringify(readinessKey(rulesetB)) })
    expect(selectedA.row?.rowKey).toEqual([...readinessKey(rulesetA)])
    expect(selectedB.row?.rowKey).toEqual([...readinessKey(rulesetB)])
    expect(selectedA.row?.cells.ruleset_id).toBe(rulesetA)
    expect(selectedB.row?.cells.ruleset_id).toBe(rulesetB)
    expect(harnessed.readinessProvider).not.toHaveBeenCalled()
  })

  it('rejects a malformed, repeated, four-part, or foreign readiness selector', async () => {
    const { service, state, readinessProvider } = harness()
    state.readinessInstalled = true
    const id = seedReadiness(state, rulesetA, 2)
    await expect(service.get(actor, id, { rowKey: [rulesetA], extra: '1' })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.get(actor, id, { rowKey: ['a', 'b'] })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.get(actor, id, { rowKey: JSON.stringify(['a', 'b', 'c', 'd']) })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.get(actor, id, { rowKey: '{not-json' })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.get(actor, id, {
      rowKey: JSON.stringify(readinessKey(rulesetA)),
      sourceKind: 'readiness',
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    await expect(service.get(actor, id, {
      rowKey: JSON.stringify(['other-source', tenant, org, itemId, rulesetA]),
    })).rejects.toMatchObject({ status: 409, code: 'ROW_KEY_MISMATCH' })
    expect(state.calls).toBeUndefined()
    expect(readinessProvider).not.toHaveBeenCalled()
    expect(state.stored).toHaveLength(1)
  })

  it('returns 403 for a denied sheet before a matching or foreign readiness selector, and keeps the anchor for a sheet-authorized reader', async () => {
    const visible = harness()
    visible.state.readinessInstalled = true
    const id = seedReadiness(visible.state, rulesetA, 3)
    const selected = { rowKey: JSON.stringify(readinessKey(rulesetA)) }
    const positive = await visible.service.get(actor, id, selected)
    expect(positive.row).toMatchObject({ recordId: `rec-${rulesetA}`, rowKey: [...readinessKey(rulesetA)] })
    expect(positive.anchor).toMatchObject({ dataSourceId, tenantId: tenant, orgId: org, itemId })
    expect(visible.readinessProvider).not.toHaveBeenCalled()
    expect(visible.provider).not.toHaveBeenCalled()

    visible.state.recordNoneIds = [`rec-${rulesetA}`]
    const concealed = await visible.service.get(actor, id, selected)
    expect(concealed.row).toBeNull()
    expect(concealed.anchor).toMatchObject({ dataSourceId, tenantId: tenant, orgId: org, itemId })
    expect(concealed).toMatchObject({ id, status: 'active', sourceKind: 'readiness' })
    expect(visible.readinessProvider).not.toHaveBeenCalled()
    visible.state.recordNoneIds = []

    visible.state.sheetGrant = false
    const atDenial = visible.calls.length
    await expect(visible.service.get(actor, id, selected)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(visible.calls.slice(atDenial).some((sql) => sql.includes('FROM spreadsheet_permissions'))).toBe(true)
    const beforeForeign = visible.calls.length
    await expect(visible.service.get(actor, id, {
      rowKey: JSON.stringify(['foreign-source', tenant, org, itemId, rulesetA]),
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(visible.calls.slice(beforeForeign).some((sql) => sql.includes('FROM spreadsheet_permissions'))).toBe(true)
    expect(visible.readinessProvider).not.toHaveBeenCalled()
    expect(visible.provider).not.toHaveBeenCalled()
  })

  it('keeps a clock-only generated_at change as a noop and writes an ordered resource change', async () => {
    const clock = harness(emptyState(), dto(), readinessDto(rulesetA, [], '2026-10-24T02:03:04.000000Z', '2026-10-24T02:03:04.000000Z'))
    clock.state.readinessInstalled = true
    const id = seedReadiness(clock.state, rulesetA, 3)
    const before = clock.state.stored[0].captured_at
    const noop = await clock.service.refresh(actor, id, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })
    expect(noop).toMatchObject({ noop: true, recordId: 'rec-ruleset-a' })
    expect(clock.state.stored[0].captured_at).toBe(before)
    expect(mutations(clock.calls).some((sql) => sql.includes('meta_records'))).toBe(false)
    expect(clock.calls.some((sql) => /^\s*insert\s+into\s+meta_record_revisions\b/i.test(sql))).toBe(false)
    expect(clock.calls.some((sql) => /^\s*insert\s+into\s+meta_record_history_operations\b/i.test(sql))).toBe(false)

    const ordered = [issueFree('routing_release', 'routing', 'route-1'), issueFree('mbom_release', 'mbom', 'mbom-1')]
    const changed = harness(emptyState(), dto(), readinessDto(rulesetA, ordered))
    changed.state.readinessInstalled = true
    const changedId = seedReadiness(changed.state, rulesetA, 3)
    const written = await changed.service.refresh(actor, changedId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })
    expect(written.noop).toBe(false)
    expect(changed.state.stored[0].business_hash).not.toBe(readinessCollaborationBusinessHash(
      dataSourceId,
      parseReadinessCollaborationSource(readinessDto(rulesetA), {
        tenantId: tenant, orgId: org, itemId, rulesetId: rulesetA, currentVersionId: 'ver-1',
      }),
    ))
    expect(mutations(changed.calls).some((sql) => sql.includes('UPDATE meta_records'))).toBe(true)
    const cells = readinessCollaborationSourceCells(parseReadinessCollaborationSource(readinessDto(rulesetA, ordered), {
      tenantId: tenant, orgId: org, itemId, rulesetId: rulesetA, currentVersionId: 'ver-1',
    }))
    expect(String((changed.state.records[0].data as Record<string, unknown>)[readinessFields.resources])).toBe(cells.resources)
    expect(cells.resources.indexOf('route-1')).toBeLessThan(cells.resources.indexOf('mbom-1'))
  })

  it('does not treat a native version change as a clock noop and does not resurrect on 503', async () => {
    const shifted = harness(emptyState(), dto(), readinessDto(rulesetA, [], capturedAt, capturedAt, 'ver-2'))
    shifted.state.readinessInstalled = true
    const id = seedReadiness(shifted.state, rulesetA, 3)
    await expect(shifted.service.refresh(actor, id, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 409, code: 'READINESS_SOURCE_ANCHOR_MISMATCH' })
    expect(shifted.state.bindings[0]).toMatchObject({ status: 'stale', version: 4 })
    expect(mutations(shifted.calls).some((sql) => sql.includes('meta_records'))).toBe(false)

    const down = harness(emptyState(), dto(), readinessDto())
    down.state.readinessInstalled = true
    down.readinessProvider.mockRejectedValue(new ReadinessCollaborationSourceError(503, 'READINESS_SOURCE_UNAVAILABLE'))
    const downId = seedReadiness(down.state, rulesetA, 3)
    await expect(down.service.refresh(actor, downId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 503, code: 'READINESS_SOURCE_UNAVAILABLE' })
    expect(down.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
    expect(down.state.stored).toHaveLength(1)
    expect(mutations(down.calls).some((sql) => sql.includes('meta_records'))).toBe(false)
  })

  it('stales only a stored readiness tuple and leaves the same binding active when another ruleset is absent', async () => {
    const { service, state, readinessProvider } = harness(emptyState(), dto(), readinessDto(rulesetB))
    state.readinessInstalled = true
    readinessProvider.mockRejectedValue(new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_TOKEN_REJECTED'))
    const bindingId = seedReadiness(state, rulesetA, 3)
    const previewId = randomUUID()
    state.previews.push({
      id: previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetB)],
      source_fingerprint: fingerprint,
      business_hash: 'different-hash-is-not-reached',
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    await expect(service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: bindingId,
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(state.bindings[0]).toMatchObject({ id: bindingId, status: 'active', version: 3 })
    expect(state.bindings).toHaveLength(1)
    expect(state.stored).toHaveLength(1)
    expect(state.stored[0].row_key).toEqual([...readinessKey(rulesetA)])
  })

  it('replays a consumed readiness preview without a provider call', async () => {
    const { service, state, readinessProvider } = harness()
    state.readinessInstalled = true
    const bindingId = seedReadiness(state, rulesetA, 4)
    const requestId = randomUUID()
    const previewId = randomUUID()
    state.previews.push({
      id: previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetA)],
      source_fingerprint: fingerprint,
      business_hash: state.stored[0].business_hash,
      captured_at: capturedAt,
      request_id: requestId,
      binding_id: bindingId,
      consumed_at: capturedAt,
      expired: false,
    })
    const replayed = await service.confirm(actor, { previewId, requestId, expectedVersion: 0 })
    expect(replayed).toMatchObject({ bindingId, replayed: true })
    expect(readinessProvider).not.toHaveBeenCalled()
  })

  it('refuses a foreign family and a cross-kind refresh before the provider', async () => {
    const foreign = harness(emptyState(), dto(), readinessDto(rulesetA))
    foreign.state.readinessInstalled = true
    const ecoBinding = seedBinding(foreign.state, 3)
    const previewId = randomUUID()
    foreign.state.previews.push({
      id: previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetA)],
      source_fingerprint: fingerprint,
      business_hash: 'unused',
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    await expect(foreign.service.confirm(actor, {
      previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: ecoBinding,
    })).rejects.toMatchObject({ status: 409, code: 'TARGET_MISMATCH' })
    expect(foreign.readinessProvider).not.toHaveBeenCalled()

    const crossed = harness()
    const id = seedBinding(crossed.state, 3)
    await expect(crossed.service.refresh(actor, id, {
      expectedVersion: 3,
      rowKey: [...readinessKey()],
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    expect(crossed.provider).not.toHaveBeenCalled()

    const readiness = harness()
    readiness.state.readinessInstalled = true
    const readinessId = seedReadiness(readiness.state, rulesetA, 3)
    await expect(readiness.service.refresh(actor, readinessId, {
      expectedVersion: 3,
      rowKey: [dataSourceId, tenant, org, itemId],
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    const callsBeforeKind = readiness.calls.length
    await expect(readiness.service.refresh(actor, readinessId, {
      sourceKind: 'readiness',
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 422, code: 'ECO_REQUEST_INVALID' })
    expect(readiness.calls).toHaveLength(callsBeforeKind)
    expect(readiness.readinessProvider).not.toHaveBeenCalled()
  })

  it('refuses a late readiness failure when selected-row, source, actor, or collection authority changed', async () => {
    const denied = harness(emptyState(), dto(), readinessDto(rulesetA))
    denied.state.readinessInstalled = true
    const deniedId = seedReadiness(denied.state, rulesetA, 3)
    seedReadiness(denied.state, rulesetB, 3)
    denied.readinessProvider.mockImplementation(async () => {
      denied.state.recordNoneIds = ['rec-ruleset-a']
      throw new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_TOKEN_REJECTED')
    })
    await expect(denied.service.refresh(actor, deniedId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(denied.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
    const hiddenA = await denied.service.get(actor, deniedId, { rowKey: JSON.stringify(readinessKey(rulesetA)) })
    const visibleB = await denied.service.get(actor, deniedId, { rowKey: JSON.stringify(readinessKey(rulesetB)) })
    expect(hiddenA.row).toBeNull()
    expect(hiddenA).toMatchObject({ version: 3, status: 'active' })
    expect(visibleB.row?.rowKey).toEqual([...readinessKey(rulesetB)])

    const rotated = harness(emptyState(), dto(), readinessDto(rulesetA))
    rotated.state.readinessInstalled = true
    const rotatedId = seedReadiness(rotated.state, rulesetA, 3)
    seedReadiness(rotated.state, rulesetB, 3)
    rotated.readinessProvider.mockImplementation(async () => {
      rotated.state.sourceConfigOverride = { ...sourceConfig, credentials: { token: 'rotated-token' } }
      throw new ReadinessCollaborationSourceError(403, 'READINESS_SOURCE_UNLICENSED')
    })
    await expect(rotated.service.refresh(actor, rotatedId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 403, code: 'READINESS_SOURCE_UNLICENSED' })
    expect(rotated.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
    const stillB = await rotated.service.get(actor, rotatedId, { rowKey: JSON.stringify(readinessKey(rulesetB)) })
    expect(stillB.row?.rowKey).toEqual([...readinessKey(rulesetB)])

    const quiet = harness(emptyState(), dto(), readinessDto(rulesetA))
    quiet.state.readinessInstalled = true
    const quietId = seedReadiness(quiet.state, rulesetA, 3)
    quiet.readinessProvider.mockRejectedValue(new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_TOKEN_REJECTED'))
    await expect(quiet.service.refresh(actor, quietId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(quiet.state.bindings[0]).toMatchObject({
      status: 'stale',
      version: 4,
      last_failure_code: 'READINESS_SOURCE_TOKEN_REJECTED',
    })

    const advanced = harness(emptyState(), dto(), readinessDto(rulesetA))
    advanced.state.readinessInstalled = true
    const advancedId = seedReadiness(advanced.state, rulesetA, 3)
    seedReadiness(advanced.state, rulesetB, 3)
    advanced.readinessProvider.mockImplementation(async () => {
      advanced.state.bindings[0].version = 4
      throw new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_TOKEN_REJECTED')
    })
    await expect(advanced.service.refresh(actor, advancedId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(advanced.state.bindings[0]).toMatchObject({ status: 'active', version: 4 })

    const stopped = harness(emptyState(), dto(), readinessDto(rulesetA))
    stopped.state.readinessInstalled = true
    const stoppedId = seedReadiness(stopped.state, rulesetA, 3)
    stopped.readinessProvider.mockImplementation(async () => {
      stopped.state.bindings[0].status = 'disabled'
      stopped.state.bindings[0].version = 4
      throw new ReadinessCollaborationSourceError(403, 'READINESS_SOURCE_UNLICENSED')
    })
    await expect(stopped.service.refresh(actor, stoppedId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 403, code: 'READINESS_SOURCE_UNLICENSED' })
    expect(stopped.state.bindings[0]).toMatchObject({ status: 'disabled', version: 4 })
    expect(stopped.state.records).toHaveLength(1)

    const asleep = harness(emptyState(), dto(), readinessDto(rulesetA))
    asleep.state.readinessInstalled = true
    const asleepId = seedReadiness(asleep.state, rulesetA, 3)
    asleep.readinessProvider.mockImplementation(async () => {
      asleep.state.userActive = false
      throw new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_LOGIN_REJECTED')
    })
    await expect(asleep.service.refresh(actor, asleepId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_LOGIN_REJECTED' })
    expect(asleep.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
  })

  it('checks selected-row and source-field authority before confirm provider egress', async () => {
    const changed = readinessDto(rulesetA, [issueFree('mbom_release', 'mbom', 'delta-mbom')])
    const granted = harness(emptyState(), dto(), changed)
    granted.state.readinessInstalled = true
    const grantedId = seedReadiness(granted.state, rulesetA, 3)
    const grantedPreview = await granted.service.preview(actor, readinessPreviewBody(rulesetA))
    granted.state.previews.push({
      id: grantedPreview.previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetA)],
      source_fingerprint: fingerprint,
      business_hash: grantedPreview.businessHash,
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    expect(granted.readinessProvider).toHaveBeenCalledTimes(1)
    granted.readinessProvider.mockClear()
    const beforeGranted = granted.calls.length
    const published = await granted.service.confirm(actor, {
      previewId: grantedPreview.previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: grantedId,
    })
    expect(published).toMatchObject({
      bindingId: grantedId,
      recordId: `rec-${rulesetA}`,
      version: 4,
      noop: false,
      replayed: false,
    })
    expect(granted.readinessProvider).toHaveBeenCalledTimes(1)
    expect(mutations(granted.calls.slice(beforeGranted)).some((sql) => sql.includes('UPDATE meta_records'))).toBe(true)
    expect(granted.state.previews[0].consumed_at).toBeTruthy()
    expect(granted.provider).not.toHaveBeenCalled()

    const refusals: Array<(state: ScriptState) => void> = [
      (state) => { state.recordNoneIds = [`rec-${rulesetA}`] },
      (state) => { state.fieldReadOnly = true },
      (state) => { state.hiddenFieldId = readinessFields.resources },
      (state) => { state.concealedFieldId = readinessFields.resources },
    ]
    for (const mutate of refusals) {
      const denied = harness(emptyState(), dto(), changed)
      denied.state.readinessInstalled = true
      const bindingId = seedReadiness(denied.state, rulesetA, 3)
      const preview = await denied.service.preview(actor, readinessPreviewBody(rulesetA))
      denied.state.previews.push({
        id: preview.previewId,
        actor_id: actor,
        data_source_id: dataSourceId,
        source_kind: 'readiness',
        native_tenant_id: tenant,
        native_org_id: org,
        item_id: itemId,
        current_version_id: 'ver-1',
        base_id: baseId,
        name: 'Readiness collection',
        row_key: [...readinessKey(rulesetA)],
        source_fingerprint: fingerprint,
        business_hash: preview.businessHash,
        captured_at: capturedAt,
        request_id: null,
        binding_id: null,
        consumed_at: null,
        expired: false,
      })
      denied.readinessProvider.mockClear()
      mutate(denied.state)
      const beforeDenied = mutations(denied.calls).length
      await expect(denied.service.confirm(actor, {
        previewId: preview.previewId,
        requestId: randomUUID(),
        expectedVersion: 3,
        targetBindingId: bindingId,
      })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
      expect(denied.readinessProvider).not.toHaveBeenCalled()
      expect(mutations(denied.calls).slice(beforeDenied)).toEqual([])
      expect(denied.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
      expect(denied.state.previews[0]).toMatchObject({ request_id: null, consumed_at: null })
      expect(denied.provider).not.toHaveBeenCalled()
    }

    const appended = harness(emptyState(), dto(), readinessDto(rulesetB))
    appended.state.readinessInstalled = true
    const appendedId = seedReadiness(appended.state, rulesetA, 3)
    const appendPreview = await appended.service.preview(actor, readinessPreviewBody(rulesetB))
    appended.state.previews.push({
      id: appendPreview.previewId,
      actor_id: actor,
      data_source_id: dataSourceId,
      source_kind: 'readiness',
      native_tenant_id: tenant,
      native_org_id: org,
      item_id: itemId,
      current_version_id: 'ver-1',
      base_id: baseId,
      name: 'Readiness collection',
      row_key: [...readinessKey(rulesetB)],
      source_fingerprint: fingerprint,
      business_hash: appendPreview.businessHash,
      captured_at: capturedAt,
      request_id: null,
      binding_id: null,
      consumed_at: null,
      expired: false,
    })
    appended.readinessProvider.mockClear()
    appended.state.fieldReadOnly = true
    await expect(appended.service.confirm(actor, {
      previewId: appendPreview.previewId,
      requestId: randomUUID(),
      expectedVersion: 3,
      targetBindingId: appendedId,
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(appended.readinessProvider).not.toHaveBeenCalled()
    expect(appended.state.bindings[0]).toMatchObject({ status: 'active', version: 3 })
    expect(appended.state.stored).toHaveLength(1)
  })

  it('orders the row-auth advisory before the selected-row scope read in the same stale transaction', async () => {
    const quiet = harness(emptyState(), dto(), readinessDto(rulesetA))
    quiet.state.readinessInstalled = true
    const quietId = seedReadiness(quiet.state, rulesetA, 3)
    quiet.readinessProvider.mockRejectedValue(new ReadinessCollaborationSourceError(401, 'READINESS_SOURCE_TOKEN_REJECTED'))
    await expect(quiet.service.refresh(actor, quietId, {
      expectedVersion: 3,
      rowKey: [...readinessKey(rulesetA)],
    })).rejects.toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(quiet.state.bindings[0]).toMatchObject({ status: 'stale', version: 4 })
    const tx = quiet.transactions.find((sqls) => sqls.some((sql) => sql.includes("status='stale'")))
    expect(tx).toBeTruthy()
    const sourceLock = tx!.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended'))
    const bindingLock = tx!.findIndex((sql) => sql.includes('FROM meta_plm_collaboration_bindings') && sql.includes('FOR UPDATE'))
    const rowAuth = tx!.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtext($1))'))
    const scope = tx!.findIndex((sql) => sql.includes('FROM record_permissions rp'))
    const stale = tx!.findIndex((sql) => sql.includes("status='stale'"))
    expect(sourceLock).toBeGreaterThanOrEqual(0)
    expect(bindingLock).toBeGreaterThan(sourceLock)
    expect(rowAuth).toBeGreaterThan(bindingLock)
    expect(scope).toBeGreaterThan(rowAuth)
    expect(stale).toBeGreaterThan(scope)
  })

  it('masks a hidden readiness source cell and keeps source metadata for a local-only hide', async () => {
    const hidden = harness()
    hidden.state.readinessInstalled = true
    hidden.state.hiddenFieldId = readinessFields.resources
    const hiddenId = seedReadiness(hidden.state, rulesetA, 2)
    const hiddenBody = await hidden.service.get(actor, hiddenId, { rowKey: JSON.stringify(readinessKey(rulesetA)) })
    expect(hiddenBody.row?.rowKey).toBeNull()
    expect(hiddenBody.row?.businessHash).toBeNull()
    expect(hiddenBody.row?.capturedAt).toBeNull()
    expect(hiddenBody.row?.cells.resources).toBeUndefined()

    const local = harness()
    local.state.readinessInstalled = true
    local.state.hiddenFieldId = localFields.review_note
    const localId = seedReadiness(local.state, rulesetA, 2)
    const body = await local.service.get(actor, localId, { rowKey: JSON.stringify(readinessKey(rulesetA)) })
    expect(body.row?.rowKey).toEqual([...readinessKey(rulesetA)])
    expect(body.row?.businessHash).toBeTruthy()
    expect(body.row?.capturedAt).toBe(capturedAt)
    expect(JSON.stringify(body.row)).not.toContain('kept')
    expect(local.readinessProvider).not.toHaveBeenCalled()
  })

  it('reports a missing readiness adapter as unavailable and does not call ECO transport', async () => {
    const { service, state, provider, readinessProvider } = harness(emptyState(), dto(), readinessDto())
    state.readinessInstalled = true
    state.readinessAdapter = false
    await expect(service.preview(actor, readinessPreviewBody())).rejects.toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_UNAVAILABLE',
    })
    expect(provider).not.toHaveBeenCalled()
    expect(readinessProvider).not.toHaveBeenCalled()
  })
})
