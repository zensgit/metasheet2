import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { beforeEach, describe, expect, it } from 'vitest'
import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { PlmPersonalBomWriteBindingService } from '../../src/services/PlmPersonalBomWriteBindingService'
import {
  personalBomWriteFailureBody,
  relayPersonalBomWriteFailure,
} from '../../src/services/plm-personal-bom-write-http'
import {
  clientKeySha256,
  linePatchBody,
  PlmPersonalBomWriteError,
  providerIdempotencyKey,
} from '../../src/services/plm-personal-bom-write-wire'

process.env.ENCRYPTION_KEY ||= 'unit-test-personal-bom-write-key-32'
process.env.ENCRYPTION_SALT ||= 'unit-test-personal-bom-write-salt'

const OWNER = 'meta-owner'
const SOURCE = 'source-1'
const yuw = (id: string, secret = 'b') => `yuw_${id.repeat(32)}_${secret.repeat(43)}`

interface BindingRow {
  id: string
  owner_id: string
  data_source_id: string
  connection_id: string
  subject_id: string
  meta_tenant_id: string | null
  yuantus_tenant_id: string
  yuantus_org_id: string
  target_origin: string
  workspace_id: string | null
  scope_kind: string
  grant_id: string
  expires_at: Date
  encrypted_grant: string | null
  generation: number
  purpose: string
  remote_revoke_state: string | null
  previous_grant_revoke_state: string | null
}

interface IntentRow {
  id: string
  owner_id: string
  data_source_id: string
  operation_kind: 'line' | 'eco-intent'
  client_key_sha256: string
  actor_meta_tenant_id: string | null
  source_meta_tenant_id: string | null
  workspace_id: string | null
  scope_kind: string
  target_origin: string
  connection_id: string
  yuantus_tenant_id: string
  yuantus_org_id: string
  subject_id: string
  purpose: string
  part_id: string
  bom_line_id: string | null
  if_match: string | null
  request_body: string
  payload_fingerprint: string
  provider_idempotency_key: string
  binding_id: string
  outcome: string
  saw_unknown: boolean
  confirmed_response: string | null
}

interface Call {
  op: string
  grant: string
  connectionId: string
  origin: string
  tenantId: string
  orgId: string
  data: unknown
  target?: { partId?: string; bomLineId?: string; idempotencyKey?: string; ifMatch?: string }
  at: number
}

function source(over: Record<string, unknown> = {}) {
  return {
    id: SOURCE,
    owner_id: OWNER,
    workspace_id: 'ws-1' as string | null,
    tenant_id: 'meta-a' as string | null,
    scope_kind: 'private' as string | null,
    type: 'plm',
    is_active: true,
    deleted_at: null as Date | null,
    config: {
      type: 'plm',
      connection: {
        url: 'https://synthetic.invalid',
        headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1', Authorization: 'Bearer shared-account' },
      },
      options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
      credentials: { token: 'shared-account' },
    },
    ...over,
  }
}

function verified() {
  return {
    schema: 'yuantus.plm-bom-write-binding.v1',
    grant_id: 'a'.repeat(32),
    connection_id: 'conn-1',
    tenant_id: 'yt-b',
    org_id: 'org-1',
    auth_user_id: '42',
    expires_at: '2027-01-01T00:00:00.000000Z',
    purpose: 'bom_write',
  }
}

function lineInput(over: Record<string, unknown> = {}) {
  return {
    operationKind: 'line' as const,
    partId: 'part-1',
    bomLineId: 'line-1',
    clientKey: 'client-key-1',
    patch: { quantity: 1 },
    ...over,
  }
}

function ecoInput(over: Record<string, unknown> = {}) {
  return { operationKind: 'eco-intent' as const, partId: 'part-1', clientKey: 'client-key-eco', ...over }
}

function actor(metaTenantId: string | null = 'meta-a') {
  return { userId: OWNER, metaTenantId }
}

function expectedKey(clientKey: string, operationKind: 'line' | 'eco-intent', metaTenantId: string | null = 'meta-a') {
  return providerIdempotencyKey({
    operationKind,
    ownerId: OWNER,
    dataSourceId: SOURCE,
    metaTenantId,
    targetOrigin: 'https://synthetic.invalid',
    connectionId: 'conn-1',
    yuantusTenantId: 'yt-b',
    yuantusOrgId: 'org-1',
    subjectId: '42',
    clientKey,
  })
}

function memory() {
  const users = new Map<string, { id: string; is_active: boolean }>([[OWNER, { id: OWNER, is_active: true }]])
  const memberships = [{ user_id: OWNER, org_id: 'meta-a', is_active: true }]
  const sources = new Map<string, ReturnType<typeof source>>([[SOURCE, source()]])
  const bindings: BindingRow[] = []
  const intents: IntentRow[] = []
  const queries: string[] = []
  const calls: Call[] = []
  const state = {
    users,
    memberships,
    sources,
    bindings,
    intents,
    queries,
    calls,
    failNextCommit: false,
    failOutcome: false,
    onNextCommit: undefined as (() => void) | undefined,
    nextWire: undefined as unknown,
    injectRace: false,
    injectMismatch: false,
    pool: undefined as unknown as { connect: () => Promise<PoolClient> },
    transport: undefined as unknown as {
      personalBomWriteManagementUrl: () => string
      personalBomWriteRequest: (
        op: string,
        grant: string,
        connectionId: string,
        authority: { origin: string; tenantId: string; orgId: string },
        data?: unknown,
        target?: Call['target'],
      ) => Promise<unknown>
    },
  }
  const copyBinding = (row: BindingRow): BindingRow => ({ ...row })
  const copyIntent = (row: IntentRow): IntentRow => ({ ...row })
  const nullable = (value: unknown): string | null => (value == null ? null : String(value))
  const intentFrom = (params: unknown[]): IntentRow => ({
    id: String(params[0]),
    owner_id: String(params[1]),
    data_source_id: String(params[2]),
    operation_kind: params[3] as IntentRow['operation_kind'],
    client_key_sha256: String(params[4]),
    actor_meta_tenant_id: nullable(params[5]),
    source_meta_tenant_id: nullable(params[6]),
    workspace_id: nullable(params[7]),
    scope_kind: String(params[8]),
    target_origin: String(params[9]),
    connection_id: String(params[10]),
    yuantus_tenant_id: String(params[11]),
    yuantus_org_id: String(params[12]),
    subject_id: String(params[13]),
    purpose: 'bom_write',
    part_id: String(params[14]),
    bom_line_id: nullable(params[15]),
    if_match: nullable(params[16]),
    request_body: String(params[17]),
    payload_fingerprint: String(params[18]),
    provider_idempotency_key: String(params[19]),
    binding_id: String(params[20]),
    outcome: 'frozen',
    saw_unknown: false,
    confirmed_response: null,
  })
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim()
      queries.push(text)
      if (text.includes('plm_personal_bom_write_intents')) {
        for (const param of params) {
          if (typeof param === 'string' && (/yuw_[0-9a-f]{32}_[A-Za-z0-9_-]{43}/.test(param) || param.includes('client-key-')))
            throw new Error('intent sql kept a raw client key or grant')
        }
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (text === 'COMMIT') {
        if (state.failNextCommit) {
          state.failNextCommit = false
          throw new Error('commit uncertain')
        }
        const hook = state.onNextCommit
        state.onNextCommit = undefined
        hook?.()
        return { rows: [], rowCount: 0 }
      }
      if (text.includes('FROM user_orgs')) {
        const row = memberships.find((item) => item.user_id === params[0] && item.org_id === params[1] && item.is_active)
        return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 }
      }
      if (text.includes('FROM users')) {
        const user = users.get(String(params[0]))
        return user?.is_active ? { rows: [{ id: user.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
      if (text.includes('FROM data_sources')) {
        const row = sources.get(String(params[0]))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (text.startsWith('SELECT') && text.includes('plm_personal_bom_write_intents')) {
        const rows = intents.filter(
          (row) =>
            row.owner_id === params[0] &&
            row.data_source_id === params[1] &&
            row.operation_kind === params[2] &&
            row.client_key_sha256 === params[3],
        )
        return { rows: rows.map(copyIntent), rowCount: rows.length }
      }
      if (text.startsWith('SELECT') && text.includes('plm_personal_bom_write_bindings')) {
        const rows = text.includes('WHERE id=$1')
          ? bindings.filter((row) => row.id === params[0] && row.owner_id === params[1])
          : bindings.filter((row) => row.owner_id === params[0] && row.data_source_id === params[1])
        return { rows: rows.map(copyBinding), rowCount: rows.length }
      }
      if (text.startsWith('INSERT') && text.includes('plm_personal_bom_write_intents')) {
        if (state.injectRace || state.injectMismatch) {
          const planted = intentFrom(params)
          if (state.injectRace) planted.provider_idempotency_key = 'ab'.repeat(32)
          if (state.injectMismatch) {
            planted.part_id = 'planted-part'
            planted.request_body = planted.operation_kind === 'line' ? '{"quantity":9}' : 'null'
          }
          state.injectRace = false
          state.injectMismatch = false
          intents.push(planted)
          return { rows: [], rowCount: 0 }
        }
        const existing = intents.find(
          (row) =>
            row.owner_id === params[1] &&
            row.data_source_id === params[2] &&
            row.operation_kind === params[3] &&
            row.client_key_sha256 === params[4],
        )
        if (existing) return { rows: [], rowCount: 0 }
        const row = intentFrom(params)
        intents.push(row)
        return { rows: [copyIntent(row)], rowCount: 1 }
      }
      if (text.startsWith('INSERT') && text.includes('plm_personal_bom_write_bindings')) {
        const row: BindingRow = {
          id: String(params[0]),
          owner_id: String(params[1]),
          data_source_id: String(params[2]),
          connection_id: String(params[3]),
          subject_id: String(params[4]),
          meta_tenant_id: nullable(params[5]),
          yuantus_tenant_id: String(params[6]),
          yuantus_org_id: String(params[7]),
          target_origin: String(params[8]),
          workspace_id: nullable(params[9]),
          scope_kind: String(params[10]),
          grant_id: String(params[11]),
          expires_at: params[12] as Date,
          encrypted_grant: String(params[13]),
          generation: 1,
          purpose: 'bom_write',
          remote_revoke_state: null,
          previous_grant_revoke_state: null,
        }
        bindings.push(row)
        return { rows: [copyBinding(row)], rowCount: 1 }
      }
      if (text.startsWith('UPDATE') && text.includes('plm_personal_bom_write_intents')) {
        if (state.failOutcome) {
          state.failOutcome = false
          throw new Error('outcome commit lost')
        }
        const row = intents.find(
          (item) =>
            item.id === params[0] &&
            item.owner_id === params[4] &&
            item.provider_idempotency_key === params[5] &&
            item.client_key_sha256 === params[6] &&
            item.request_body === params[7] &&
            item.part_id === params[8] &&
            (item.bom_line_id ?? null) === (params[9] ?? null) &&
            (item.if_match ?? null) === (params[10] ?? null),
        )
        if (!row) return { rows: [], rowCount: 0 }
        row.outcome = String(params[1])
        row.saw_unknown = row.saw_unknown || params[2] === true
        if (row.confirmed_response == null && params[3] != null) row.confirmed_response = String(params[3])
        return { rows: [copyIntent(row)], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${text}`)
    },
    release() {},
  }
  state.pool = { async connect() { return client as PoolClient } }
  state.transport = {
    personalBomWriteManagementUrl: () => 'https://synthetic.invalid/personal-approval-grants#bom-write',
    async personalBomWriteRequest(op, grant, connectionId, authority, data, target) {
      calls.push({
        op,
        grant,
        connectionId,
        origin: authority.origin,
        tenantId: authority.tenantId,
        orgId: authority.orgId,
        data,
        target,
        at: queries.length,
      })
      if (op === 'verify') return verified()
      if (op === 'revoke') return null
      if (state.nextWire !== undefined) {
        const planned = state.nextWire
        state.nextWire = undefined
        if (planned instanceof Error) throw planned
        return planned
      }
      if (op === 'line') return { ok: true, bom_line_id: 'line-1' }
      return {
        eco_id: 'eco-1',
        state: 'open',
        attached: false,
        source_version_id: null,
        target_version_id: null,
      }
    },
  }
  return state
}

type State = ReturnType<typeof memory>

function service(state: State) {
  return new PlmPersonalBomWriteBindingService(state.pool, () => state.transport)
}

function writes(state: State) {
  return state.calls.filter((call) => call.op === 'line' || call.op === 'eco-intent')
}

function phasesOf(queries: string[]): string[][] {
  const phases: string[][] = []
  let current: string[] = []
  for (const query of queries) {
    if (query === 'COMMIT') {
      phases.push(current)
      current = []
      continue
    }
    if (query !== 'BEGIN' && query !== 'ROLLBACK') current.push(query)
  }
  return phases
}

function assertLockOrder(part: string[], membership: boolean) {
  const at = (pred: (sql: string) => boolean) => part.findIndex(pred)
  const users = at((sql) => sql.includes('FROM users') && sql.includes('FOR SHARE'))
  const source = at((sql) => sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'))
  const binding = at((sql) => sql.includes('plm_personal_bom_write_bindings') && sql.includes('FOR UPDATE'))
  const intent = at((sql) => sql.includes('plm_personal_bom_write_intents') && sql.includes('FOR UPDATE'))
  expect(users).toBeGreaterThanOrEqual(0)
  let cursor = users
  if (membership) {
    const member = at((sql) => sql.includes('FROM user_orgs') && sql.includes('FOR SHARE'))
    expect(member).toBeGreaterThan(cursor)
    cursor = member
  } else {
    expect(part.some((sql) => sql.includes('user_orgs'))).toBe(false)
  }
  expect(source).toBeGreaterThan(cursor)
  expect(binding).toBeGreaterThan(source)
  expect(intent).toBeGreaterThan(binding)
}

describe('personal BOM write intent dispatch', () => {
  beforeEach(() => {
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
  })

  it('commits a line intent before one wire using the frozen body and If-Match', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const mark = state.queries.length
    const svc = service(state)
    const sent = await svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: 'etag-1' }))
    const segment = state.queries.slice(mark)
    const phases = phasesOf(segment)
    const line = writes(state)
    expect(phases).toHaveLength(2)
    assertLockOrder(phases[0], true)
    assertLockOrder(phases[1], true)
    expect(segment.some((sql) => sql.includes('pg_advisory'))).toBe(false)
    expect(phases[0].some((sql) => sql.includes('ON CONFLICT (owner_id, data_source_id, operation_kind, client_key_sha256)'))).toBe(true)
    expect(phases[0].some((sql) => sql.startsWith('UPDATE') && sql.includes('plm_personal_bom_write_intents'))).toBe(false)
    expect(phases[1].some((sql) => sql.startsWith('UPDATE') && sql.includes('plm_personal_bom_write_intents'))).toBe(true)
    const firstCommit = segment.indexOf('COMMIT')
    const secondCommit = segment.indexOf('COMMIT', firstCommit + 1)
    expect(line).toHaveLength(1)
    expect(line[0].at - mark).toBeGreaterThan(firstCommit)
    expect(line[0].at - mark).toBeLessThan(secondCommit)
    expect(state.queries[line[0].at - 1]).toContain('plm_personal_bom_write_intents')
    expect(line[0].origin).toBe('https://synthetic.invalid')
    expect(line[0].tenantId).toBe('yt-b')
    expect(line[0].orgId).toBe('org-1')
    expect(line[0].connectionId).toBe('conn-1')
    expect(line[0].grant).toBe(yuw('a'))
    expect(line[0].data).toEqual({ quantity: 1 })
    expect(line[0].target).toEqual({
      partId: 'part-1',
      bomLineId: 'line-1',
      idempotencyKey: expectedKey('client-key-1', 'line'),
      ifMatch: 'etag-1',
    })
    expect(sent).toMatchObject({
      operationKind: 'line',
      dataSourceId: SOURCE,
      partId: 'part-1',
      bomLineId: 'line-1',
      providerIdempotencyKey: expectedKey('client-key-1', 'line'),
      clientKeySha256: clientKeySha256('client-key-1'),
      actorMetaTenantId: 'meta-a',
      sourceMetaTenantId: 'meta-a',
      outcome: 'accepted',
      native: { ok: true, bom_line_id: 'line-1' },
    })
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0]).toMatchObject({
      id: sent.intentId,
      workspace_id: 'ws-1',
      scope_kind: 'private',
      actor_meta_tenant_id: 'meta-a',
      source_meta_tenant_id: 'meta-a',
      target_origin: 'https://synthetic.invalid',
      subject_id: '42',
      purpose: 'bom_write',
      request_body: '{"quantity":1}',
      if_match: 'etag-1',
      outcome: 'accepted',
      saw_unknown: false,
    })
    expect(state.intents[0].payload_fingerprint).toBe(
      createHash('sha256').update(state.intents[0].request_body, 'utf8').digest('hex'),
    )
    expect(JSON.stringify(state.intents) + JSON.stringify(sent)).not.toContain('client-key-')
    expect(JSON.stringify(state.intents) + JSON.stringify(sent)).not.toContain('yuw_')
    expect(state.calls.filter((call) => call.op === 'verify')).toHaveLength(1)
  })

  it('commits an eco intent whose effective body is absent', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const sent = await service(state).dispatchOperation(actor(), SOURCE, ecoInput())
    const eco = writes(state)
    expect(eco).toHaveLength(1)
    expect(eco[0].op).toBe('eco-intent')
    expect(eco[0].data).toBeUndefined()
    expect(eco[0].target).toEqual({
      partId: 'part-1',
      idempotencyKey: expectedKey('client-key-eco', 'eco-intent'),
    })
    expect(sent.bomLineId).toBeNull()
    expect(sent.native).toEqual({
      eco_id: 'eco-1',
      state: 'open',
      attached: false,
      source_version_id: null,
      target_version_id: null,
    })
    expect(state.intents[0]).toMatchObject({
      operation_kind: 'eco-intent',
      request_body: 'null',
      bom_line_id: null,
      if_match: null,
      part_id: 'part-1',
      provider_idempotency_key: sent.providerIdempotencyKey,
    })
  })

  it('keeps one row for one key and rejects a changed line request with no second write', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const input = lineInput({ ifMatch: 'etag-1' })
    const first = await svc.dispatchOperation(actor(), SOURCE, input)
    const again = await svc.dispatchOperation(actor(), SOURCE, input)
    expect(again.intentId).toBe(first.intentId)
    expect(again.providerIdempotencyKey).toBe(first.providerIdempotencyKey)
    expect(state.intents).toHaveLength(1)
    expect(writes(state)).toHaveLength(2)
    expect(state.queries.filter((sql) => sql.startsWith('INSERT') && sql.includes('plm_personal_bom_write_intents'))).toHaveLength(1)
    const frozen = {
      id: state.intents[0].id,
      part_id: state.intents[0].part_id,
      bom_line_id: state.intents[0].bom_line_id,
      if_match: state.intents[0].if_match,
      request_body: state.intents[0].request_body,
      provider_idempotency_key: state.intents[0].provider_idempotency_key,
      client_key_sha256: state.intents[0].client_key_sha256,
    }
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: 'etag-1', patch: { quantity: 2 } }))).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: 'etag-1', partId: 'part-2' }))).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: 'etag-1', bomLineId: 'line-2' }))).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(writes(state)).toHaveLength(2)
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0]).toMatchObject(frozen)
    state.intents[0].payload_fingerprint = 'ab'.repeat(32)
    await expect(svc.dispatchOperation(actor(), SOURCE, input)).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(state.intents[0].payload_fingerprint).toBe('ab'.repeat(32))
    expect(state.intents[0].provider_idempotency_key).toBe(frozen.provider_idempotency_key)
    expect(writes(state)).toHaveLength(2)
  })

  it('rejects a changed eco part without a second post', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    await svc.dispatchOperation(actor(), SOURCE, ecoInput())
    await expect(svc.dispatchOperation(actor(), SOURCE, ecoInput({ partId: 'part-9' }))).rejects.toMatchObject({ status: 409, code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(writes(state)).toHaveLength(1)
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0]).toMatchObject({ part_id: 'part-1', request_body: 'null', bom_line_id: null, if_match: null })
  })

  it('scopes a second key and a second kind without reusing the first provider key', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const line = await svc.dispatchOperation(actor(), SOURCE, lineInput({ clientKey: 'client-key-a' }))
    const other = await svc.dispatchOperation(actor(), SOURCE, lineInput({ clientKey: 'client-key-b' }))
    const eco = await svc.dispatchOperation(actor(), SOURCE, ecoInput({ clientKey: 'client-key-a' }))
    expect(new Set([line.intentId, other.intentId, eco.intentId]).size).toBe(3)
    expect(line.providerIdempotencyKey).not.toBe(other.providerIdempotencyKey)
    expect(line.providerIdempotencyKey).not.toBe(eco.providerIdempotencyKey)
    expect(state.intents).toHaveLength(3)
    expect(state.intents.every((row) => row.binding_id === state.bindings[0].id)).toBe(true)
    expect(state.intents.filter((row) => row.client_key_sha256 === clientKeySha256('client-key-a'))).toHaveLength(2)
    expect(state.intents.map((row) => row.operation_kind).sort()).toEqual(['eco-intent', 'line', 'line'])
  })

  it('treats object key order as the same line body', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const first = await svc.dispatchOperation(actor(), SOURCE, lineInput({
      clientKey: 'client-key-order',
      patch: { quantity: 1, uom: 'ea' },
    }))
    const second = await svc.dispatchOperation(actor(), SOURCE, lineInput({
      clientKey: 'client-key-order',
      patch: { uom: 'ea', quantity: 1 },
    }))
    expect(second.intentId).toBe(first.intentId)
    expect(second.providerIdempotencyKey).toBe(first.providerIdempotencyKey)
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].request_body).toBe('{"quantity":1,"uom":"ea"}')
    expect(writes(state)).toHaveLength(2)
    expect(writes(state).every((call) => call.target?.idempotencyKey === first.providerIdempotencyKey)).toBe(true)
  })

  it.each([
    ['source owner', (state: State) => { state.sources.get(SOURCE)!.owner_id = 'other-owner' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['scope', (state: State) => { state.sources.get(SOURCE)!.scope_kind = 'workspace' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['workspace', (state: State) => { state.sources.get(SOURCE)!.workspace_id = 'ws-2' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['source tenant', (state: State) => { state.sources.get(SOURCE)!.tenant_id = 'meta-b' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['inactive source', (state: State) => { state.sources.get(SOURCE)!.is_active = false }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['deleted source', (state: State) => { state.sources.get(SOURCE)!.deleted_at = new Date() }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['rebind person', (state: State) => { state.bindings[0].subject_id = '99' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['origin', (state: State) => { state.sources.get(SOURCE)!.config.connection.url = 'https://other.invalid' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['source pathname', (state: State) => { state.sources.get(SOURCE)!.config.connection.url = 'https://synthetic.invalid/prefix' }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['membership revocation', (state: State) => { state.memberships[0].is_active = false }, 403, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['inactive user', (state: State) => { state.users.get(OWNER)!.is_active = false }, 401, 'PLM_BOM_WRITE_UNAUTHORIZED'],
  ] as const)('sends nothing when %s changes after the intent commits', async (_name, mutate, status, code) => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.onNextCommit = () => mutate(state)
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({ status, code })
    expect(writes(state)).toEqual([])
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].outcome).toBe('frozen')
    expect(state.intents[0].confirmed_response).toBeNull()
    expect(state.queries.some((sql) => sql.startsWith('DELETE'))).toBe(false)
  })

  it('sends the replacement grant for the same person with the stored provider key', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const first = await svc.dispatchOperation(actor(), SOURCE, lineInput())
    state.bindings[0].encrypted_grant = encryptStoredSecretValue(yuw('b'))
    state.bindings[0].grant_id = 'b'.repeat(32)
    const second = await svc.dispatchOperation(actor(), SOURCE, lineInput())
    expect(second.intentId).toBe(first.intentId)
    expect(second.providerIdempotencyKey).toBe(first.providerIdempotencyKey)
    expect(writes(state).map((call) => call.grant)).toEqual([yuw('a'), yuw('b')])
    expect(writes(state).every((call) => call.target?.idempotencyKey === first.providerIdempotencyKey)).toBe(true)
    expect(state.intents[0].subject_id).toBe('42')
    expect(state.intents[0].provider_idempotency_key).toBe(first.providerIdempotencyKey)
  })

  it('reuses a stored provider key instead of hashing a new one', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const first = await svc.dispatchOperation(actor(), SOURCE, lineInput())
    const stored = 'cd'.repeat(32)
    state.intents[0].provider_idempotency_key = stored
    const second = await svc.dispatchOperation(actor(), SOURCE, lineInput())
    expect(second.providerIdempotencyKey).toBe(stored)
    expect(second.providerIdempotencyKey).not.toBe(first.providerIdempotencyKey)
    expect(writes(state)[1].target?.idempotencyKey).toBe(stored)
    expect(state.intents[0].provider_idempotency_key).toBe(stored)
  })

  it('does not return a cached success when a later native call is forbidden', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const sent = await svc.dispatchOperation(actor(), SOURCE, lineInput())
    const confirmed = state.intents[0].confirmed_response
    state.nextWire = new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN', undefined, true)
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 403,
      code: 'PLM_BOM_WRITE_FORBIDDEN',
      received: true,
    })
    expect(JSON.parse(confirmed!)).toEqual(sent.native)
    expect(state.intents[0].confirmed_response).toBe(confirmed)
    expect(state.intents[0].outcome).toBe('denied')
    expect(state.intents[0].saw_unknown).toBe(false)
    expect(state.intents).toHaveLength(1)
    expect(writes(state)).toHaveLength(2)
  })

  it('keeps an earlier unknown when a later call is forbidden', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    state.nextWire = { ok: true }
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 503,
      code: 'PLM_BOM_WRITE_UNAVAILABLE',
      received: true,
    })
    expect(state.intents[0]).toMatchObject({ outcome: 'unknown', saw_unknown: true, confirmed_response: null })
    state.nextWire = new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN', undefined, true)
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(state.intents[0]).toMatchObject({ outcome: 'denied', saw_unknown: true, confirmed_response: null })
    expect(state.intents).toHaveLength(1)
    expect(writes(state)).toHaveLength(2)
    expect(state.queries.some((sql) => sql.startsWith('DELETE'))).toBe(false)
  })

  it('records one unknown when the provider times out and does not retry', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.nextWire = new Error('timeout')
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 503,
      code: 'PLM_BOM_WRITE_UNAVAILABLE',
      received: false,
    })
    expect(writes(state)).toHaveLength(1)
    expect(state.intents[0]).toMatchObject({ outcome: 'unknown', saw_unknown: true, confirmed_response: null })
  })

  it('does not wire when the intent commit is uncertain, then a new instance sends once', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.failNextCommit = true
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toThrow('commit uncertain')
    expect(writes(state)).toEqual([])
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].outcome).toBe('frozen')
    const restarted = service(state)
    const sent = await restarted.dispatchOperation(actor(), SOURCE, lineInput())
    expect(sent.intentId).toBe(state.intents[0].id)
    expect(sent.providerIdempotencyKey).toBe(state.intents[0].provider_idempotency_key)
    expect(writes(state)).toHaveLength(1)
    expect(writes(state)[0].target?.idempotencyKey).toBe(sent.providerIdempotencyKey)
    expect(state.intents).toHaveLength(1)
  })

  it('recovers the same intent when the outcome update is lost after the native call', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.failOutcome = true
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toThrow('outcome commit lost')
    expect(writes(state)).toHaveLength(1)
    expect(state.intents[0].outcome).toBe('frozen')
    const id = state.intents[0].id
    const key = state.intents[0].provider_idempotency_key
    const restarted = service(state)
    const sent = await restarted.dispatchOperation(actor(), SOURCE, lineInput())
    expect(sent.intentId).toBe(id)
    expect(sent.providerIdempotencyKey).toBe(key)
    expect(writes(state).map((call) => call.target?.idempotencyKey)).toEqual([key, key])
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].outcome).toBe('accepted')
  })

  it('stays disabled for every flag value other than the exact literal', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
      else process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = value
      await expect(svc.dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
        status: 404,
        code: 'PLM_BOM_WRITE_DISABLED',
      })
    }
    expect(state.intents).toEqual([])
    expect(writes(state)).toEqual([])
  })

  it('rejects a blank actor tenant and a null or extra eco field before locking', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const mark = state.queries.length
    const svc = service(state)
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: null }))).rejects.toMatchObject({ status: 422, code: 'PLM_BOM_WRITE_INVALID' })
    await expect(svc.dispatchOperation(actor(), SOURCE, lineInput({ ifMatch: '' }))).rejects.toMatchObject({ status: 422, code: 'PLM_BOM_WRITE_INVALID' })
    await expect(svc.dispatchOperation(actor(), SOURCE, ecoInput({ ifMatch: 'etag-1' }))).rejects.toMatchObject({ status: 422, code: 'PLM_BOM_WRITE_INVALID' })
    await expect(svc.dispatchOperation(actor(), SOURCE, ecoInput({ bomLineId: 'line-1' }))).rejects.toMatchObject({ status: 422, code: 'PLM_BOM_WRITE_INVALID' })
    await expect(svc.dispatchOperation(actor(), SOURCE, ecoInput({ patch: { quantity: 1 } }))).rejects.toMatchObject({ status: 422, code: 'PLM_BOM_WRITE_INVALID' })
    await expect(svc.dispatchOperation({ userId: OWNER, metaTenantId: '   ' }, SOURCE, lineInput())).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.dispatchOperation({ userId: OWNER } as never, SOURCE, lineInput())).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(state.queries.length).toBe(mark)
    expect(state.intents).toEqual([])
    expect(writes(state)).toEqual([])
  })

  it('admits an explicit null legacy tenant without a membership lock', async () => {
    const state = memory()
    const row = state.sources.get(SOURCE)!
    row.tenant_id = null
    row.scope_kind = 'legacy_private'
    await service(state).bind(actor(null), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const mark = state.queries.length
    const sent = await service(state).dispatchOperation(actor(null), SOURCE, lineInput())
    const phases = phasesOf(state.queries.slice(mark))
    expect(phases).toHaveLength(2)
    assertLockOrder(phases[0], false)
    assertLockOrder(phases[1], false)
    expect(sent.actorMetaTenantId).toBeNull()
    expect(sent.sourceMetaTenantId).toBeNull()
    expect(sent.providerIdempotencyKey).toBe(expectedKey('client-key-1', 'line', null))
    expect(state.intents[0]).toMatchObject({
      actor_meta_tenant_id: null,
      source_meta_tenant_id: null,
      scope_kind: 'legacy_private',
      yuantus_tenant_id: 'yt-b',
    })
  })

  it('keeps the planted provider key when the first insert conflicts', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.injectRace = true
    const sent = await service(state).dispatchOperation(actor(), SOURCE, lineInput())
    expect(sent.providerIdempotencyKey).toBe('ab'.repeat(32))
    expect(sent.providerIdempotencyKey).not.toBe(expectedKey('client-key-1', 'line'))
    expect(writes(state)[0].target?.idempotencyKey).toBe('ab'.repeat(32))
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].provider_idempotency_key).toBe('ab'.repeat(32))
  })

  it('does not replace a conflicting planted row', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.injectMismatch = true
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 409,
      code: 'PLM_BOM_WRITE_CONFLICT',
    })
    expect(writes(state)).toEqual([])
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0]).toMatchObject({ part_id: 'planted-part', request_body: '{"quantity":9}' })
  })

  it('stores long, empty, and ordinary yuw_ body text and a line id that contains that text', async () => {
    const longRef = 'X'.repeat(200)
    const quantity = `${'0'.repeat(200)}1`
    const component = 'assembly_yuw_component'
    const lineId = 'line-assembly_yuw_component'
    const grant = yuw('a')
    const kept = { find_num: component, quantity, refdes: longRef, uom: '' }
    const requestBody = `{"find_num":"${component}","quantity":"${quantity}","refdes":"${longRef}","uom":""}`
    expect(linePatchBody({
      ...kept,
      token: 'yuw_should-not-leave',
      grant,
      nested: { password: 'secret-no' },
    })).toEqual(kept)
    expect(linePatchBody({ refdes: '部件-甲' })).toEqual({ refdes: '部件-甲' })
    expect(linePatchBody({ refdes: 'a\nb' })).toEqual({ refdes: 'a\nb' })
    expect(linePatchBody({ refdes: '😀' })).toEqual({ refdes: '😀' })
    expect(linePatchBody({ quantity: '' })).toEqual({ quantity: '' })
    expect(linePatchBody({ quantity: null, refdes: null })).toEqual({ quantity: null, refdes: null })
    for (const patch of [
      {},
      { token: grant },
      { quantity: true },
      { quantity: { x: 1 } },
      { quantity: ['1'] },
      { quantity: Number.NaN },
      { quantity: Number.POSITIVE_INFINITY },
      { refdes: 1 },
      { refdes: 'a\u0000b' },
      { quantity: 'a\u0000b' },
      { refdes: '\uD800' },
    ]) {
      expect(() => linePatchBody(patch)).toThrow(PlmPersonalBomWriteError)
    }

    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    state.nextWire = { ok: true, bom_line_id: lineId }
    const sent = await service(state).dispatchOperation(actor(), SOURCE, lineInput({
      clientKey: 'client-key-json-text',
      bomLineId: lineId,
      patch: {
        refdes: longRef,
        uom: '',
        find_num: component,
        quantity,
        token: 'yuw_should-not-leave',
        grant,
        nested: { password: 'secret-no' },
      },
    }))
    const call = writes(state).at(-1)
    expect(call?.data).toEqual(kept)
    expect(call?.target?.bomLineId).toBe(lineId)
    expect(call?.grant).toBe(grant)
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0].request_body).toBe(requestBody)
    expect(state.intents[0].bom_line_id).toBe(lineId)
    expect(state.intents[0].confirmed_response).toBe(`{"bom_line_id":"${lineId}","ok":true}`)
    expect(sent.native).toEqual({ ok: true, bom_line_id: lineId })
    const stored = JSON.stringify(state.intents) + JSON.stringify(sent)
    expect(stored).toContain(component)
    expect(stored).toContain(lineId)
    expect(stored).not.toContain(grant)
    expect(stored).not.toContain('client-key-')
    expect(stored).not.toContain('yuw_should-not-leave')
    expect(stored).not.toContain('secret-no')
  })

  it('records unknown when the first line acknowledgement names another line', async () => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    state.nextWire = { ok: true, bom_line_id: 'other-line' }
    await expect(service(state).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 503,
      code: 'PLM_BOM_WRITE_UNAVAILABLE',
      received: true,
    })
    expect(writes(state)).toHaveLength(1)
    expect(state.intents).toHaveLength(1)
    expect(state.intents[0]).toMatchObject({
      outcome: 'unknown',
      saw_unknown: true,
      confirmed_response: null,
      bom_line_id: 'line-1',
    })
    expect(state.queries.some((sql) => sql.startsWith('DELETE'))).toBe(false)
    const sent = await service(state).dispatchOperation(actor(), SOURCE, lineInput())
    expect(sent.native).toEqual({ ok: true, bom_line_id: 'line-1' })
    expect(state.intents[0].confirmed_response).toBe('{"bom_line_id":"line-1","ok":true}')
    expect(state.intents[0].outcome).toBe('accepted')
    expect(writes(state)).toHaveLength(2)
  })

  it('keeps the stored confirmation when a later line or eco acknowledgement differs', async () => {
    const line = memory()
    await service(line).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const sent = await service(line).dispatchOperation(actor(), SOURCE, lineInput())
    const confirmed = line.intents[0].confirmed_response
    line.nextWire = { ok: true, bom_line_id: 'other-line' }
    await expect(service(line).dispatchOperation(actor(), SOURCE, lineInput())).rejects.toMatchObject({
      status: 503,
      code: 'PLM_BOM_WRITE_UNAVAILABLE',
      received: true,
    })
    expect(line.intents[0].confirmed_response).toBe(confirmed)
    expect(confirmed).not.toContain('other-line')
    expect(line.intents[0]).toMatchObject({ outcome: 'unknown', saw_unknown: true, bom_line_id: 'line-1' })
    expect(writes(line)).toHaveLength(2)
    expect(JSON.parse(confirmed!)).toEqual(sent.native)

    const eco = memory()
    await service(eco).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const first = await service(eco).dispatchOperation(actor(), SOURCE, ecoInput())
    const ecoConfirmed = eco.intents[0].confirmed_response
    eco.nextWire = {
      eco_id: 'eco-9',
      state: 'closed',
      attached: true,
      source_version_id: 'source-v',
      target_version_id: 'target-v',
    }
    await expect(service(eco).dispatchOperation(actor(), SOURCE, ecoInput())).rejects.toMatchObject({
      status: 503,
      code: 'PLM_BOM_WRITE_UNAVAILABLE',
      received: true,
    })
    expect(eco.intents[0].confirmed_response).toBe(ecoConfirmed)
    expect(ecoConfirmed).toBe('{"attached":false,"eco_id":"eco-1","source_version_id":null,"state":"open","target_version_id":null}')
    expect(ecoConfirmed).not.toContain('eco-9')
    expect(eco.intents[0]).toMatchObject({ outcome: 'unknown', saw_unknown: true })
    expect(writes(eco)).toHaveLength(2)
    expect(JSON.parse(ecoConfirmed!)).toEqual(first.native)
    expect(eco.queries.some((sql) => sql.startsWith('DELETE'))).toBe(false)
  })

  function publicFailure(kind: 'line' | 'eco-intent', error: unknown) {
    const relayed = relayPersonalBomWriteFailure(error, kind)
    return { relayed, body: personalBomWriteFailureBody('fixed', SOURCE, relayed) }
  }

  const sameOperation = [
    {
      kind: 'line' as const,
      input: () => lineInput({ ifMatch: 'etag-1' }),
      lost: { ok: true },
      code: 'PLM_BOM_WRITEBACK_FAILED',
    },
    {
      kind: 'eco-intent' as const,
      input: () => ecoInput(),
      lost: { eco_id: 'eco-1' },
      code: 'PLM_ECO_INTENT_FAILED',
    },
  ]

  const nativeRefusals = sameOperation.flatMap((spec) => [401, 403].map((status) => ({
    ...spec, status, nativeCode: status === 401 ? 'PLM_BOM_WRITE_UNAUTHORIZED' : 'PLM_BOM_WRITE_FORBIDDEN',
  })))

  it.each(nativeRefusals)('lost response then native $status for $kind stays a refused attempt', async (spec) => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const input = spec.input()
    state.nextWire = spec.lost
    await expect(svc.dispatchOperation(actor(), SOURCE, input)).rejects.toMatchObject({
      status: 503,
      received: true,
    })
    expect(state.intents[0]).toMatchObject({ outcome: 'unknown', saw_unknown: true, confirmed_response: null })
    state.nextWire = new PlmPersonalBomWriteError(spec.status, spec.nativeCode, { message: 'hidden native text' }, true)
    let receipt: unknown
    let caught: unknown
    try {
      receipt = await svc.dispatchOperation(actor(), SOURCE, input)
    } catch (error) {
      caught = error
    }
    expect(receipt).toBeUndefined()
    expect(caught).toMatchObject({ status: spec.status, code: spec.nativeCode, received: true })
    expect(caught).not.toHaveProperty('native')
    const { relayed, body } = publicFailure(spec.kind, caught)
    expect(relayed.status).toBe(spec.status)
    expect(body).toEqual({
      error: 'fixed',
      code: spec.code,
      data_source_id: SOURCE,
      reason: 'provider-rejected',
      attempt_outcome: 'refused',
      operation_may_have_applied: true,
      retry_policy: 'same-operation',
    })
    expect(JSON.stringify(body)).not.toContain('hidden native text')
    expect(state.intents[0]).toMatchObject({ outcome: 'denied', saw_unknown: true, confirmed_response: null })
    expect(state.intents).toHaveLength(1)
    const sent = writes(state)
    expect(sent).toHaveLength(2)
    expect(sent[1].target).toEqual(sent[0].target)
    expect(sent[1].data).toEqual(sent[0].data)
    expect(state.queries.some((sql) => sql.startsWith('DELETE'))).toBe(false)
  })

  it.each(nativeRefusals)('confirmed then native $status for $kind does not return the cached receipt', async (spec) => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const input = spec.input()
    const sent = await svc.dispatchOperation(actor(), SOURCE, input)
    const confirmed = state.intents[0].confirmed_response
    expect(JSON.parse(confirmed!)).toEqual(sent.native)
    state.nextWire = new PlmPersonalBomWriteError(spec.status, spec.nativeCode, undefined, true)
    let receipt: unknown
    let caught: unknown
    try {
      receipt = await svc.dispatchOperation(actor(), SOURCE, input)
    } catch (error) {
      caught = error
    }
    expect(receipt).toBeUndefined()
    expect(caught).toMatchObject({ status: spec.status, code: spec.nativeCode, received: true })
    expect(caught).not.toHaveProperty('native')
    expect(state.intents[0].confirmed_response).toBe(confirmed)
    expect(state.intents[0].outcome).toBe('denied')
    expect(state.intents[0].saw_unknown).toBe(false)
    const { body } = publicFailure(spec.kind, caught)
    expect(body.operation_may_have_applied).toBe(true)
    expect(body.attempt_outcome).toBe('refused')
    expect(body.retry_policy).toBe('same-operation')
    expect(body.reason).toBe('provider-rejected')
    expect(JSON.stringify(body)).not.toContain(JSON.stringify(sent.native))
    expect(writes(state)).toHaveLength(2)
    expect(state.intents).toHaveLength(1)
  })

  it.each(sameOperation)('same-person replacement retry for $kind preserves the native key and request', async (spec) => {
    const state = memory()
    await service(state).bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const svc = service(state)
    const first = await svc.dispatchOperation(actor(), SOURCE, spec.input())
    const frozen = {
      request_body: state.intents[0].request_body,
      if_match: state.intents[0].if_match,
      part_id: state.intents[0].part_id,
      bom_line_id: state.intents[0].bom_line_id,
      provider_idempotency_key: state.intents[0].provider_idempotency_key,
    }
    state.bindings[0].encrypted_grant = encryptStoredSecretValue(yuw('b'))
    state.bindings[0].grant_id = 'b'.repeat(32)
    const second = await svc.dispatchOperation(actor(), SOURCE, spec.input())
    expect(second.intentId).toBe(first.intentId)
    expect(second.providerIdempotencyKey).toBe(first.providerIdempotencyKey)
    expect(second.providerIdempotencyKey).toBe(frozen.provider_idempotency_key)
    expect(state.intents[0]).toMatchObject(frozen)
    const sent = writes(state)
    expect(sent.map((call) => call.grant)).toEqual([yuw('a'), yuw('b')])
    expect(sent[1].target).toEqual(sent[0].target)
    expect(sent[1].data).toEqual(sent[0].data)
    expect(sent[1].op).toBe(spec.kind)
    expect(sent.every((call) => call.target?.idempotencyKey === first.providerIdempotencyKey)).toBe(true)
    expect(state.intents).toHaveLength(1)
  })
})
