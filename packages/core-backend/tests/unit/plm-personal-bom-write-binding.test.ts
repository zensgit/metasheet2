import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { decryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { PlmPersonalBomWriteBindingService } from '../../src/services/PlmPersonalBomWriteBindingService'
import {
  bindingAuthorizesFrozen,
  freezeDispatchAttempt,
  nativeEcoHashMaterial,
  nativeLineHashMaterial,
  nativeScopeKey,
  parsePersonalBomWriteSuccess,
  personalBomWriteGrantSchema,
  PlmPersonalBomWriteError,
  preparePersonalBomWriteCall,
  providerIdempotencyKey,
} from '../../src/services/plm-personal-bom-write-wire'

process.env.ENCRYPTION_KEY ||= 'unit-test-personal-bom-write-key-32'
process.env.ENCRYPTION_SALT ||= 'unit-test-personal-bom-write-salt'

const OWNER = 'meta-owner'
const SOURCE = 'source-1'
const yuw = (id: string, secret = 'b') => `yuw_${id.repeat(32)}_${secret.repeat(43)}`

interface Row {
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

function encodedSource(url: string, encoding: 'object' | 'json') {
  const row = source()
  const persistedConfig = {
    connection: {
      url,
      headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1', Authorization: 'Bearer shared-account' },
    },
    options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    credentials: { token: 'shared-account' },
  }
  row.config = (encoding === 'json' ? JSON.stringify(persistedConfig) : persistedConfig) as never
  return row
}

function source(over: Record<string, unknown> = {}) {
  return {
    id: SOURCE,
    owner_id: OWNER,
    workspace_id: 'ws-1',
    tenant_id: 'meta-a',
    scope_kind: 'private',
    type: 'plm',
    is_active: true,
    deleted_at: null,
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

function verified(over: Record<string, unknown> = {}) {
  return {
    schema: 'yuantus.plm-bom-write-binding.v1',
    grant_id: 'a'.repeat(32),
    connection_id: 'conn-1',
    tenant_id: 'yt-b',
    org_id: 'org-1',
    auth_user_id: '42',
    expires_at: '2027-01-01T00:00:00.000000Z',
    purpose: 'bom_write',
    ...over,
  }
}

function memory() {
  const users = new Map<string, { id: string; is_active: boolean }>([[OWNER, { id: OWNER, is_active: true }]])
  const memberships: Array<{ user_id: string; org_id: string; is_active: boolean }> = [
    { user_id: OWNER, org_id: 'meta-a', is_active: true },
  ]
  const sources = new Map<string, ReturnType<typeof source>>([[SOURCE, source()]])
  const bindings: Row[] = []
  const retired: Array<{
    id: string
    binding_id: string
    owner_id: string
    connection_id: string
    yuantus_tenant_id: string
    yuantus_org_id: string
    target_origin: string
    grant_id: string
    encrypted_grant: string | null
    state: string
    binding_generation: number
    successor_grant_id: string
    slot: string
  }> = []
  const queries: string[] = []
  const calls: Array<{ op: string; grant: string; atCleared: boolean; origin?: string; tenantId?: string }> = []
  let failNextCas = false
  let verifyBody: Record<string, unknown> | (() => Record<string, unknown>) = verified()
  let revoke: () => void = () => undefined
  const copy = (row: Row): Row => ({ ...row })
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim()
      queries.push(text)
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (text.includes('FROM users')) {
        const user = users.get(String(params[0]))
        return user?.is_active ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (text.includes('FROM user_orgs')) {
        const row = memberships.find(
          (item) => item.user_id === params[0] && item.org_id === params[1] && item.is_active,
        )
        return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 }
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
      if (text.includes('FROM data_sources')) {
        const row = sources.get(String(params[0]))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (text.startsWith('SELECT') && text.includes('plm_personal_bom_write_retired_grants')) {
        const open = (row: (typeof retired)[number]) =>
          row.encrypted_grant != null && (row.state === 'pending' || row.state === 'unknown')
        const rows = text.includes('WHERE id=$1')
          ? retired.filter((row) => row.id === params[0] && row.owner_id === params[1])
          : text.includes('binding_id=$1')
            ? retired.filter(
                (row) =>
                  row.binding_id === params[0] &&
                  row.owner_id === params[1] &&
                  row.grant_id === params[2] &&
                  row.connection_id === params[3] &&
                  row.yuantus_tenant_id === params[4] &&
                  row.yuantus_org_id === params[5] &&
                  row.target_origin === params[6] &&
                  open(row),
              )
            : retired.filter((row) => row.owner_id === params[0] && open(row))
        return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length }
      }
      if (text.startsWith('SELECT') && text.includes('plm_personal_bom_write_bindings')) {
        const rows = text.includes('WHERE id=$1')
          ? bindings.filter((row) => row.id === params[0] && row.owner_id === params[1])
          : text.includes('data_source_id=$2')
            ? bindings.filter((row) => row.owner_id === params[0] && row.data_source_id === params[1])
            : bindings.filter((row) => row.owner_id === params[0])
        return { rows: rows.map(copy), rowCount: rows.length }
      }
      if (text.startsWith('INSERT') && text.includes('plm_personal_bom_write_retired_grants')) {
        const row = {
          id: String(params[0]),
          binding_id: String(params[1]),
          owner_id: String(params[2]),
          connection_id: String(params[3]),
          yuantus_tenant_id: String(params[4]),
          yuantus_org_id: String(params[5]),
          target_origin: String(params[6]),
          grant_id: String(params[7]),
          encrypted_grant: String(params[8]),
          state: 'pending',
          binding_generation: Number(params[9]),
          successor_grant_id: String(params[10]),
          slot: String(params[11]),
        }
        retired.push(row)
        return { rows: [{ ...row }], rowCount: 1 }
      }
      if (text.startsWith('INSERT')) {
        const existing = bindings.find((row) => row.owner_id === params[1] && row.data_source_id === params[2])
        if (!existing) {
          const row: Row = {
            id: String(params[0]),
            owner_id: String(params[1]),
            data_source_id: String(params[2]),
            connection_id: String(params[3]),
            subject_id: String(params[4]),
            meta_tenant_id: (params[5] as string | null) ?? null,
            yuantus_tenant_id: String(params[6]),
            yuantus_org_id: String(params[7]),
            target_origin: String(params[8]),
            workspace_id: (params[9] as string | null) ?? null,
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
          return { rows: [copy(row)], rowCount: 1 }
        }
        if (failNextCas || existing.generation !== params[14]) {
          failNextCas = false
          return { rows: [], rowCount: 0 }
        }
        existing.connection_id = String(params[3])
        existing.subject_id = String(params[4])
        existing.meta_tenant_id = (params[5] as string | null) ?? null
        existing.yuantus_tenant_id = String(params[6])
        existing.yuantus_org_id = String(params[7])
        existing.target_origin = String(params[8])
        existing.workspace_id = (params[9] as string | null) ?? null
        const previousGrant = existing.grant_id
        const hadSecret = existing.encrypted_grant != null
        existing.scope_kind = String(params[10])
        existing.grant_id = String(params[11])
        existing.expires_at = params[12] as Date
        existing.previous_grant_revoke_state = hadSecret && previousGrant !== params[11] ? 'pending' : null
        existing.encrypted_grant = String(params[13])
        existing.generation += 1
        existing.remote_revoke_state = null
        existing.purpose = 'bom_write'
        return { rows: [copy(existing)], rowCount: 1 }
      }
      if (text.startsWith('UPDATE') && text.includes('plm_personal_bom_write_retired_grants')) {
        const row = retired.find(
          (item) =>
            item.id === params[0] &&
            item.owner_id === params[2] &&
            item.encrypted_grant === params[3] &&
            (item.state === 'pending' || item.state === 'unknown'),
        )
        if (!row) return { rows: [], rowCount: 0 }
        row.state = String(params[1])
        if (row.state === 'revoked' || row.state === 'rejected') row.encrypted_grant = null
        return { rows: [{ ...row }], rowCount: 1 }
      }
      if (text.includes('SET encrypted_grant=NULL')) {
        const row = bindings.find((item) => item.id === params[0] && item.owner_id === params[1])
        if (!row || failNextCas || row.generation !== params[2]) {
          failNextCas = false
          return { rows: [], rowCount: 0 }
        }
        row.encrypted_grant = null
        row.generation += 1
        row.remote_revoke_state = 'pending'
        return { rows: [copy(row)], rowCount: 1 }
      }
      if (text.includes('SET remote_revoke_state=$3')) {
        const row = bindings.find(
          (item) =>
            item.id === params[0] &&
            item.generation === params[1] &&
            !item.encrypted_grant &&
            (item.remote_revoke_state === 'pending' || item.remote_revoke_state === 'unknown'),
        )
        if (!row || row.encrypted_grant) return { rows: [], rowCount: 0 }
        row.remote_revoke_state = String(params[2])
        return { rows: [copy(row)], rowCount: 1 }
      }
      if (text.includes('previous_grant_revoke_state=$4')) {
        const row = bindings.find(
          (item) =>
            item.id === params[0] &&
            item.generation === params[1] &&
            item.grant_id === params[2] &&
            (item.previous_grant_revoke_state === 'pending' || item.previous_grant_revoke_state === 'unknown'),
        )
        if (!row) return { rows: [], rowCount: 0 }
        row.previous_grant_revoke_state = String(params[3])
        return { rows: [copy(row)], rowCount: 1 }
      }
      throw new Error(`unexpected sql: ${text}`)
    },
    release() {},
  }
  const transport = {
    personalBomWriteManagementUrl: () => 'https://synthetic.invalid/personal-approval-grants#bom-write',
    getEffectiveTenantId: () => 'yt-b' as string | undefined,
    getEffectiveOrgId: () => 'org-1' as string | undefined,
    async personalBomWriteRequest(
      op: string,
      grant: string,
      _connectionId: string,
      authority?: { origin?: string; tenantId?: string },
    ) {
      const row = bindings[0]
      calls.push({
        op,
        grant,
        origin: authority?.origin,
        tenantId: authority?.tenantId,
        atCleared: !row?.encrypted_grant || !decryptStoredSecretValue(row.encrypted_grant).includes(grant),
      })
      if (op === 'verify') return typeof verifyBody === 'function' ? verifyBody() : verifyBody
      if (op === 'revoke') {
        revoke()
        return null
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
  return {
    users,
    memberships,
    sources,
    bindings,
    retired,
    queries,
    calls,
    transport,
    pool: { connect: async () => client },
    setVerify(body: Record<string, unknown> | (() => Record<string, unknown>)) {
      verifyBody = body
    },
    setRevoke(fn: () => void) {
      revoke = fn
    },
    failCas() {
      failNextCas = true
    },
  }
}

function service(mem = memory()) {
  return { mem, svc: new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never) }
}

function actor(metaTenantId: string | null = 'meta-a') {
  return { userId: OWNER, metaTenantId }
}

function interruptRevoke(mem: ReturnType<typeof memory>): void {
  mem.setRevoke(() => {
    throw new Error('synthetic interruption before revoke')
  })
}

async function bindId(
  mem: ReturnType<typeof memory>,
  svc: PlmPersonalBomWriteBindingService,
  id: string,
) {
  mem.setVerify(verified({ grant_id: id.repeat(32) }))
  return svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw(id) })
}

/** The reuse probe sits after the source and binding locks and before any upsert. */
function reuseCheckedBeforeWrite(queries: string[]): void {
  const memberAt = queries.findIndex((sql) => sql.includes('FROM user_orgs') && sql.includes('FOR SHARE'))
  const sourceAt = queries.findIndex((sql) => sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'))
  const bindingAt = queries.findIndex(
    (sql) => sql.includes('plm_personal_bom_write_bindings') && sql.includes('data_source_id=$2') && sql.includes('FOR UPDATE'),
  )
  const reuseAt = queries.findIndex(
    (sql) => sql.includes('plm_personal_bom_write_retired_grants') && sql.includes('binding_id=$1'),
  )
  const insertAt = queries.findIndex((sql) => sql.includes('INSERT INTO plm_personal_bom_write_bindings'))
  expect(memberAt).toBeGreaterThanOrEqual(0)
  expect(sourceAt).toBeGreaterThan(memberAt)
  expect(bindingAt).toBeGreaterThan(sourceAt)
  expect(reuseAt).toBeGreaterThan(bindingAt)
  expect(insertAt).toBe(-1)
}

function lockPoint(queries: string[], marker: string, locked = true): number {
  const index = queries.findIndex((sql) => sql.includes(marker) && (!locked || sql.includes('FOR UPDATE')))
  if (index < 0) throw new Error(`missing lock query: ${marker}`)
  return index
}

function sourceBeforeBinding(queries: string[]): boolean {
  const peek = lockPoint(queries, 'SELECT data_source_id FROM plm_personal_bom_write_bindings', false)
  const source = lockPoint(queries, 'FROM data_sources')
  const binding = queries.findIndex((sql) => (
    sql.includes('plm_personal_bom_write_bindings') && sql.includes('WHERE id=$1') && sql.includes('FOR UPDATE')
  ))
  return peek < source && source < binding
}

function admissionBeforeSource(queries: string[]): boolean {
  const user = queries.findIndex((sql) => sql.includes('FROM users') && sql.includes('FOR SHARE'))
  const member = queries.findIndex((sql) => sql.includes('FROM user_orgs') && sql.includes('FOR SHARE'))
  const source = queries.findIndex((sql) => sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'))
  return user >= 0 && user < member && member < source
}

beforeEach(() => {
  process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'true'
  delete process.env.PLM_APPROVAL_CARD_ENABLED
})

describe('personal BOM write binding', () => {
  it.each(['object', 'json'] as const)('binds canonical persisted %s config using the source type column', async (encoding) => {
    const { mem, svc } = service()
    const row = mem.sources.get(SOURCE)!
    // DataSourceManager.configToRecord stores type in its column, not inside config.
    const { type: _redundantType, ...persistedConfig } = row.config
    row.config = (encoding === 'json' ? JSON.stringify(persistedConfig) : persistedConfig) as never
    const bound = await bindId(mem, svc, 'a')
    expect(bound).toMatchObject({ dataSourceId: SOURCE, subjectId: '42', bound: true })
    expect(mem.calls.filter((call) => call.op === 'verify')).toHaveLength(1)
  })

  it.each([
    ['object', 'https://native.invalid'],
    ['object', 'https://native.invalid/'],
    ['json', 'https://native.invalid'],
    ['json', 'https://native.invalid/'],
  ] as const)('admits persisted %s root %s for management and bind', async (encoding, url) => {
    const { mem, svc } = service()
    mem.sources.set(SOURCE, encodedSource(url, encoding))
    await expect(svc.managementUrl(actor(), SOURCE)).resolves.toBe(
      'https://native.invalid/personal-approval-grants#bom-write',
    )
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    expect(saved.targetOrigin).toBe('https://native.invalid')
    expect(mem.calls).toEqual([
      expect.objectContaining({ op: 'verify', origin: 'https://native.invalid', tenantId: 'yt-b' }),
    ])
    expect(mem.bindings).toHaveLength(1)
  })

  it.each([
    ['object', 'https://native.invalid/prefix'],
    ['object', 'https://native.invalid/prefix/'],
    ['object', 'https://native.invalid/%2F'],
    ['json', 'https://native.invalid/prefix'],
    ['json', 'https://native.invalid/prefix/'],
    ['json', 'https://native.invalid/%2F'],
  ] as const)('rejects persisted %s pathname %s before verify', async (encoding, url) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      const { mem, svc } = service()
      mem.sources.set(SOURCE, encodedSource(url, encoding))
      await expect(svc.managementUrl(actor(), SOURCE)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_BOM_WRITE_FORBIDDEN',
      })
      await expect(
        svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
      ).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
      expect(mem.calls).toHaveLength(0)
      expect(mem.bindings).toHaveLength(0)
      expect(mem.queries.some((sql) => sql.includes('INSERT INTO plm_personal_bom_write_bindings'))).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses a non-PLM source column even if its JSON claims PLM', async () => {
    const { mem, svc } = service()
    mem.sources.get(SOURCE)!.type = 'http'
    await expect(bindId(mem, svc, 'a')).rejects.toMatchObject({ status: 403 })
    expect(mem.calls).toHaveLength(0)
  })

  it('stores a verified yuw binding encrypted and keeps Meta and Yuantus identities apart', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    const row = mem.bindings[0]
    expect(saved.subjectId).toBe('42')
    expect(saved.ownerId).toBe(OWNER)
    expect(saved.metaTenantId).toBe('meta-a')
    expect(saved.yuantusTenantId).toBe('yt-b')
    expect(saved.yuantusOrgId).toBe('org-1')
    expect(row.encrypted_grant?.startsWith('enc:')).toBe(true)
    expect(row.encrypted_grant).not.toContain(grant)
    expect(decryptStoredSecretValue(row.encrypted_grant!)).toBe(grant)
    expect(JSON.stringify(saved)).not.toContain(grant)
    expect(mem.queries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(mem.queries.some((sql) => sql.includes('FROM data_sources') && sql.includes('FOR UPDATE'))).toBe(true)
    expect(saved.targetOrigin).toBe('https://synthetic.invalid')
    expect(mem.queries.some((sql) => sql.includes('generation=$15'))).toBe(true)
    expect(mem.calls[0]).toMatchObject({ op: 'verify', grant })
  })

  // Fake-pool statement order only. The PostgreSQL wait is plm-personal-bom-write-lock-pg.realdb.ts.
  it('records source-before-binding SQL for bind, use, freeze, and unbind', async () => {
    const serviceSource = readFileSync(
      new URL('../../src/services/PlmPersonalBomWriteBindingService.ts', import.meta.url),
      'utf8',
    )
    expect(serviceSource).not.toContain('40P01')
    const { mem, svc } = service()
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    expect(admissionBeforeSource(mem.queries)).toBe(true)
    expect(lockPoint(mem.queries, 'FROM data_sources')).toBeLessThan(
      lockPoint(mem.queries, 'data_source_id=$2 FOR UPDATE'),
    )
    mem.queries.length = 0
    await svc.requireUsable(actor(), saved.id)
    expect(admissionBeforeSource(mem.queries)).toBe(true)
    expect(sourceBeforeBinding(mem.queries)).toBe(true)
    mem.queries.length = 0
    await svc.freezeForOperation(actor(), saved.id, {
      operationKind: 'line',
      partId: 'part-1',
      bomLineId: 'line-1',
      clientKey: 'browser-key-1',
      patch: { quantity: 1 },
    })
    expect(admissionBeforeSource(mem.queries)).toBe(true)
    expect(sourceBeforeBinding(mem.queries)).toBe(true)
    mem.queries.length = 0
    await svc.unbind(OWNER, saved.id)
    expect(mem.queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(false)
    expect(sourceBeforeBinding(mem.queries)).toBe(true)
  })

  it('preserves a null legacy_private Meta tenant and does not copy the Yuantus tenant', async () => {
    const { mem, svc } = service()
    mem.sources.set(SOURCE, source({ tenant_id: null, scope_kind: 'legacy_private', workspace_id: null }))
    const saved = await svc.bind(actor(null), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    expect(saved.metaTenantId).toBeNull()
    expect(saved.yuantusTenantId).toBe('yt-b')
    expect(saved.scopeKind).toBe('legacy_private')
    expect(mem.queries.some((sql) => sql.includes('FROM user_orgs'))).toBe(false)
    expect(mem.calls[0]).toMatchObject({ op: 'verify', tenantId: 'yt-b' })

    mem.calls.length = 0
    mem.memberships.push({ user_id: OWNER, org_id: 'yt-b', is_active: true })
    await expect(
      svc.bind(actor('yt-b'), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('b') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    mem.sources.set(SOURCE, source({ tenant_id: null, scope_kind: 'private', workspace_id: null }))
    await expect(
      svc.bind(actor(null), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('b') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(mem.calls).toHaveLength(0)
    expect(mem.bindings).toHaveLength(1)
    expect(mem.bindings[0].meta_tenant_id).toBeNull()
    expect(mem.bindings[0].yuantus_tenant_id).toBe('yt-b')
  })

  it.each([
    ['missing', { userId: OWNER }],
    ['undefined', { userId: OWNER, metaTenantId: undefined }],
    ['numeric', { userId: OWNER, metaTenantId: 12 }],
    ['blank', { userId: OWNER, metaTenantId: '' }],
    ['whitespace', { userId: OWNER, metaTenantId: ' \t' }],
  ])('rejects %s metaTenantId instead of admitting legacy_private', async (_name, bad) => {
    const { mem, svc } = service()
    mem.sources.set(SOURCE, source({ tenant_id: null, scope_kind: 'legacy_private', workspace_id: null }))
    const caller = bad as never
    const line = {
      operationKind: 'line' as const,
      partId: 'part-1',
      bomLineId: 'line-1',
      clientKey: 'browser-key-1',
      patch: { quantity: 1 },
    }
    await expect(svc.bind(caller, { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })).rejects.toMatchObject({
      status: 403,
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    await expect(svc.list(caller)).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.managementUrl(caller, SOURCE)).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.requireUsable(caller, 'missing')).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.freezeForOperation(caller, 'missing', line)).rejects.toMatchObject({
      status: 403,
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    expect(mem.calls).toHaveLength(0)
    expect(mem.bindings).toHaveLength(0)
    expect(mem.queries.some((sql) => sql.includes('FROM data_sources') || sql.includes('FROM user_orgs'))).toBe(false)
  })

  it('keeps the native Yuantus tenant distinct from the Meta actor tenant', async () => {
    const { mem, svc } = service()
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    expect(saved.metaTenantId).toBe('meta-a')
    expect(saved.yuantusTenantId).toBe('yt-b')
    expect(saved.metaTenantId).not.toBe(saved.yuantusTenantId)
    expect(mem.calls[0]).toMatchObject({ op: 'verify', tenantId: 'yt-b' })
    mem.calls.length = 0
    mem.memberships.push({ user_id: OWNER, org_id: 'yt-b', is_active: true })
    await expect(
      svc.bind(actor('yt-b'), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('b') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(mem.calls).toHaveLength(0)
    expect(mem.bindings[0].meta_tenant_id).toBe('meta-a')
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('a'))
  })

  it('refuses a different Meta tenant and a missing or revoked membership before verify', async () => {
    const wrong = service()
    wrong.mem.memberships.push({ user_id: OWNER, org_id: 'meta-b', is_active: true })
    await expect(
      wrong.svc.bind(actor('meta-b'), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(wrong.mem.calls).toHaveLength(0)
    expect(wrong.mem.bindings).toHaveLength(0)
    wrong.mem.users.set('other', { id: 'other', is_active: true })
    wrong.mem.memberships.push({ user_id: 'other', org_id: 'meta-a', is_active: true })
    await expect(
      wrong.svc.bind({ userId: 'other', metaTenantId: 'meta-a' }, { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(wrong.mem.calls).toHaveLength(0)

    const missing = service()
    missing.mem.memberships.length = 0
    await expect(
      missing.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(missing.svc.requireUsable(actor(), 'missing')).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(missing.mem.calls).toHaveLength(0)

    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    mem.memberships[0].is_active = false
    mem.calls.length = 0
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.managementUrl(actor(), SOURCE)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.list(actor())).resolves.toEqual([])
    expect(mem.calls).toHaveLength(0)
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const cleared = await svc.unbind(OWNER, saved.id)
    expect(cleared.bound).toBe(false)
    expect(cleared.remoteRevokeState).toBe('revoked')
    expect(mem.calls).toEqual([expect.objectContaining({ op: 'revoke', grant })])
  })

  it('denies use when the persisted source tenant or scope changes', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    mem.sources.set(SOURCE, source({ tenant_id: 'meta-b' }))
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(
      svc.freezeForOperation(actor(), saved.id, {
        operationKind: 'line',
        partId: 'part-1',
        bomLineId: 'line-1',
        clientKey: 'browser-key-1',
        patch: { quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.managementUrl(actor(), SOURCE)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.list(actor())).resolves.toEqual([])
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)

    mem.sources.set(SOURCE, source({ scope_kind: 'workspace' }))
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(svc.list(actor())).resolves.toEqual([])
    await expect(svc.unbind(OWNER, saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
  })

  it.each([
    ['yua grant', { grant: `yua_${'a'.repeat(32)}_${'b'.repeat(43)}` }, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['schema', { verify: verified({ schema: 'yuantus.plm-approval-personal-binding.v1' }) }, 'PLM_BOM_WRITE_INVALID'],
    ['purpose', { verify: verified({ purpose: 'approval' }) }, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['tenant', { verify: verified({ tenant_id: 'meta-a' }) }, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['org', { verify: verified({ org_id: 'org-2' }) }, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['connection', { verify: verified({ connection_id: 'conn-2' }) }, 'PLM_BOM_WRITE_FORBIDDEN'],
    ['subject', { verify: verified({ auth_user_id: OWNER }) }, 'PLM_BOM_WRITE_INVALID'],
    ['grant id', { verify: verified({ grant_id: 'c'.repeat(32) }) }, 'PLM_BOM_WRITE_FORBIDDEN'],
  ])('refuses %s mismatch and stores nothing', async (_name, change, code) => {
    const { mem, svc } = service()
    if ('verify' in change) mem.setVerify(change.verify as Record<string, unknown>)
    const grant = 'grant' in change ? change.grant : yuw('a')
    await expect(svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })).rejects.toMatchObject({ code })
    expect(mem.bindings).toHaveLength(0)
    if (String(grant).startsWith('yua_')) expect(mem.calls).toHaveLength(0)
  })

  it('verifies the locked source when the cached tenant getter disagrees', async () => {
    const { mem, svc } = service()
    mem.transport.getEffectiveTenantId = () => 'meta-a'
    mem.transport.getEffectiveOrgId = () => 'other-org'
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    expect(saved.targetOrigin).toBe('https://synthetic.invalid')
    expect(mem.calls).toEqual([
      expect.objectContaining({ op: 'verify', origin: 'https://synthetic.invalid', tenantId: 'yt-b' }),
    ])
  })

  it('refuses inactive users, other owners, and inactive or ambiguous sources', async () => {
    const inactive = service()
    inactive.mem.users.set(OWNER, { id: OWNER, is_active: false })
    await expect(inactive.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })).rejects.toMatchObject({
      status: 401,
    })
    expect(inactive.mem.calls).toHaveLength(0)

    const transferred = service()
    transferred.mem.sources.set(SOURCE, source({ owner_id: 'other-owner' }))
    await expect(
      transferred.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(transferred.mem.calls).toHaveLength(0)

    const disabled = service()
    disabled.mem.sources.set(SOURCE, source({ is_active: false }))
    await expect(disabled.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })

    const ambiguous = service()
    const config = source().config as { connection: { headers: Record<string, string> } }
    config.connection.headers['X-Tenant-Id'] = 'meta-a'
    ambiguous.mem.sources.set(SOURCE, source({ config }))
    await expect(
      ambiguous.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(ambiguous.mem.calls).toHaveLength(0)
  })

  it('blocks a transferred source and an inactive user from using the stored binding', async () => {
    const { mem, svc } = service()
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    mem.sources.set(SOURCE, source({ owner_id: 'other-owner' }))
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(mem.bindings[0].encrypted_grant).toContain('enc:')
    mem.sources.set(SOURCE, source())
    mem.users.set(OWNER, { id: OWNER, is_active: false })
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ status: 401 })
  })

  it('invalidates locally before revoke and records an unknown network outcome', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    mem.setRevoke(() => {
      throw new Error('socket hang up')
    })
    const result = await svc.unbind(OWNER, saved.id)
    expect(mem.calls.at(-1)).toMatchObject({ op: 'revoke', grant, atCleared: true })
    expect(result.bound).toBe(false)
    expect(result.remoteRevokeState).toBe('unknown')
    expect(result.remoteRevokeState).not.toBe('revoked')
    expect(mem.bindings[0].encrypted_grant).toBeNull()
  })

  it('records native 204 as revoked and a definite 401 as rejected', async () => {
    const ok = service()
    const saved = await ok.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const revoked = await ok.svc.unbind(OWNER, saved.id)
    expect(revoked.remoteRevokeState).toBe('revoked')

    const denied = service()
    const row = await denied.svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    denied.mem.setRevoke(() => {
      throw new PlmPersonalBomWriteError(401, 'PLM_BOM_WRITE_UNAUTHORIZED', undefined, true)
    })
    const result = await denied.svc.unbind(OWNER, row.id)
    expect(result.remoteRevokeState).toBe('rejected')
  })

  it('keeps the old row when a generation compare fails', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    mem.failCas()
    await expect(svc.unbind(OWNER, saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
    expect(mem.bindings[0].generation).toBe(1)

    mem.failCas()
    mem.setVerify(verified({ grant_id: 'd'.repeat(32), auth_user_id: '900' }))
    await expect(
      svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('d') }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_CONFLICT' })
    expect(mem.bindings[0].subject_id).toBe('42')
    expect(mem.calls.filter((call) => call.op === 'revoke')).toHaveLength(0)
  })

  it('replaces the native person for future operations and does not call an unknown old revoke success', async () => {
    const { mem, svc } = service()
    const first = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })
    const frozen = await svc.freezeForOperation(actor(), first.id, {
      operationKind: 'line',
      partId: 'part-1',
      bomLineId: 'line-1',
      clientKey: 'browser-key-1',
      patch: { quantity: 2, token: 'yuw_should-not-leave' },
    })
    expect(frozen.authorizes).toBe(true)
    expect(frozen.operation.subjectId).toBe('42')
    expect(JSON.stringify(frozen.operation)).not.toContain('browser-key-1')
    expect(frozen.operation.providerIdempotencyKey).toHaveLength(64)
    const retry = freezeDispatchAttempt(frozen.operation, frozen.binding.generation + 1, 2)
    expect(retry.providerIdempotencyKey).toBe(frozen.attempt.providerIdempotencyKey)
    expect(retry.nativeScopeKey).toBe(frozen.attempt.nativeScopeKey)
    expect(retry.attempt).toBe(2)

    mem.setVerify(verified({ grant_id: 'e'.repeat(32), auth_user_id: '900' }))
    mem.setRevoke(() => {
      throw new Error('timeout')
    })
    const replaced = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('e', 'f') })
    expect(replaced.subjectId).toBe('900')
    expect(replaced.bound).toBe(true)
    expect(replaced.remoteRevokeState).toBeNull()
    expect(replaced.previousGrantRevokeState).toBe('unknown')
    expect(bindingAuthorizesFrozen(replaced, frozen.operation)).toBe(false)
    expect(bindingAuthorizesFrozen({ ...replaced, subjectId: '42', grantId: 'different' }, frozen.operation)).toBe(true)
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('e', 'f'))
    expect(mem.calls.at(-1)?.grant).toBe(yuw('a'))
  })

  it('lists owned metadata and revokes the exact secret while the flag is off', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    mem.bindings[0].expires_at = new Date('2020-01-01T00:00:00.000Z')
    mem.sources.set(SOURCE, source({ is_active: false }))
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const listed = await svc.list(actor())
    expect(listed.map((row) => row.id)).toEqual([saved.id])
    expect(listed[0].bound).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(grant)
    await expect(svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_DISABLED' })
    await expect(
      svc.freezeForOperation(actor(), saved.id, {
        operationKind: 'line',
        partId: 'part-1',
        bomLineId: 'line-1',
        clientKey: 'browser-key-1',
        patch: { quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_DISABLED' })
    expect(mem.calls.filter((call) => call.op !== 'verify')).toHaveLength(0)
    const revoked = await svc.unbind(OWNER, saved.id)
    expect(revoked.bound).toBe(false)
    expect(revoked.remoteRevokeState).toBe('revoked')
    expect(mem.calls.at(-1)).toMatchObject({ op: 'revoke', grant, atCleared: true })
  })

  it('keeps source owner and the current Meta tenant in force while the flag is off', async () => {
    const { mem, svc } = service()
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    mem.sources.set(SOURCE, source({ owner_id: 'other-owner' }))
    await expect(svc.list(actor())).resolves.toEqual([])
    await expect(svc.unbind(OWNER, saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(mem.calls.filter((call) => call.op === 'revoke')).toHaveLength(0)
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
    mem.sources.set(SOURCE, source({ tenant_id: 'meta-b' }))
    await expect(svc.unbind(OWNER, saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
  })

  it('stays disabled unless its own flag is the exact literal true', async () => {
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    process.env.PLM_APPROVAL_CARD_ENABLED = 'true'
    const { mem, svc } = service()
    await expect(svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('a') })).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    expect(mem.calls).toHaveLength(0)
    process.env.PLM_PERSONAL_BOM_WRITE_ENABLED = 'TRUE'
    await expect(svc.managementUrl(actor(), SOURCE)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_DISABLED' })
  })

  it('freezes the native line and eco materials without the grant id', () => {
    const scope = {
      purpose: 'bom_write' as const,
      connectionId: 'conn-1',
      yuantusTenantId: 'yt-b',
      yuantusOrgId: 'org-1',
      subjectId: '42',
    }
    const key = providerIdempotencyKey({
      operationKind: 'line',
      ownerId: OWNER,
      dataSourceId: SOURCE,
      metaTenantId: 'meta-a',
      targetOrigin: 'https://synthetic.invalid',
      ...scope,
      clientKey: 'browser-key-1',
    })
    const line = nativeLineHashMaterial(scope, key)
    const eco = nativeEcoHashMaterial(scope, 'part-1', key)
    expect(line).toBe(JSON.stringify(['bom_write', 'line', 'conn-1', 'yt-b', 'org-1', '42', key]))
    expect(eco).toBe(JSON.stringify(['bom_write', 'eco-intent', 'conn-1', 'yt-b', 'org-1', '42', 'part-1', key]))
    expect(nativeScopeKey(line)).toHaveLength(64)
    const providerKey = 'a'.repeat(64)
    const utf8 = nativeLineHashMaterial(
      { purpose: 'bom_write', connectionId: '连接-甲', yuantusTenantId: 'default', yuantusOrgId: 'fixture-org', subjectId: '42' },
      providerKey,
    )
    expect(utf8).toBe(
      `["bom_write","line","\\u8fde\\u63a5-\\u7532","default","fixture-org","42","${providerKey}"]`,
    )
    expect(nativeScopeKey(utf8)).toBe('7da3be7ac0e7d962ba4fc1c01f1ec610f2b5c4a5fa7ee6b0ac2abd780cdacaf6')
    const nonBmp = nativeEcoHashMaterial(
      {
        purpose: 'bom_write',
        connectionId: '连接-\u{1F600}',
        yuantusTenantId: 'default',
        yuantusOrgId: 'fixture-org',
        subjectId: '42',
      },
      'part-1',
      providerKey,
    )
    expect(nonBmp).toBe(
      `["bom_write","eco-intent","\\u8fde\\u63a5-\\ud83d\\ude00","default","fixture-org","42","part-1","${providerKey}"]`,
    )
    expect(nativeScopeKey(nonBmp)).toBe('eff1085c1fef41507f74828d5a00bfad01f78a14d1c9826b6bb19b38d0a53843')
    expect(freezeDispatchAttempt(
      {
        purpose: 'bom_write',
        operationKind: 'line',
        ownerId: OWNER,
        dataSourceId: SOURCE,
        metaTenantId: 'meta-a',
        targetOrigin: 'https://synthetic.invalid',
        connectionId: '连接-甲',
        yuantusTenantId: 'default',
        yuantusOrgId: 'fixture-org',
        subjectId: '42',
        partId: 'part-1',
        bomLineId: 'line-1',
        clientKeySha256: key,
        payloadFingerprint: key,
        providerIdempotencyKey: key,
      },
      1,
      1001,
    ).attempt).toBe(1001)
    expect(line).not.toContain(OWNER)
    const otherPerson = providerIdempotencyKey({
      operationKind: 'line',
      ownerId: OWNER,
      dataSourceId: SOURCE,
      metaTenantId: 'meta-a',
      targetOrigin: 'https://synthetic.invalid',
      ...scope,
      subjectId: '900',
      clientKey: 'browser-key-1',
    })
    const otherHost = providerIdempotencyKey({
      operationKind: 'line',
      ownerId: OWNER,
      dataSourceId: SOURCE,
      metaTenantId: 'meta-a',
      targetOrigin: 'https://other.example',
      ...scope,
      clientKey: 'browser-key-1',
    })
    expect(otherHost).not.toBe(key)
    expect(otherPerson).not.toBe(key)
  })

  it('accepts the native UTF-8 verify 200 that an ASCII whitelist rejected', async () => {
    const captured = {
      schema: 'yuantus.plm-bom-write-binding.v1',
      grant_id: '62e5f888a04e4cf2872ebe5cd6729712',
      connection_id: '连接-甲',
      tenant_id: 'default',
      org_id: 'fixture-org',
      auth_user_id: '42',
      expires_at: '2026-11-16T03:43:05.914747Z',
      purpose: 'bom_write',
    }
    expect(/^[\x20-\x7e]+$/.test(captured.connection_id)).toBe(false)
    expect(personalBomWriteGrantSchema.safeParse(captured).success).toBe(true)
    expect(personalBomWriteGrantSchema.safeParse({ ...captured, connection_id: '连接\u0000甲' }).success).toBe(false)
    expect(personalBomWriteGrantSchema.safeParse({ ...captured, connection_id: '甲'.repeat(129) }).success).toBe(false)
    expect(personalBomWriteGrantSchema.safeParse({ ...captured, connection_id: '甲'.repeat(128) }).success).toBe(true)
    expect(personalBomWriteGrantSchema.safeParse({ ...captured, connection_id: '\uD800' }).success).toBe(false)

    const { mem, svc } = service()
    mem.setVerify(verified({ connection_id: '连接-甲' }))
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: '连接-甲', grant: yuw('a') })
    expect(saved.connectionId).toBe('连接-甲')
    expect(saved.yuantusTenantId).toBe('yt-b')
    expect(mem.bindings[0].connection_id).toBe('连接-甲')
  })

  it('accepts the native UTF-8 line patch and encodes each opaque segment', () => {
    const partId = '部件-甲'
    const bomLineId = '行-甲'
    const connectionId = '连接-甲'
    const historicalAscii = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
    expect(historicalAscii.test(partId)).toBe(false)
    expect(historicalAscii.test(bomLineId)).toBe(false)
    expect(historicalAscii.test(connectionId)).toBe(false)
    const key = 'a'.repeat(64)
    const prepared = preparePersonalBomWriteCall('line', connectionId, { quantity: 2 }, {
      partId,
      bomLineId,
      idempotencyKey: key,
    })
    expect(prepared.method).toBe('PATCH')
    expect(prepared.path).toBe(
      `/api/v1/bom/multitable/${encodeURIComponent(partId)}/lines/${encodeURIComponent(bomLineId)}`,
    )
    expect(prepared.path).toBe(
      '/api/v1/bom/multitable/%E9%83%A8%E4%BB%B6-%E7%94%B2/lines/%E8%A1%8C-%E7%94%B2',
    )
    expect(prepared.body).toEqual({ quantity: 2 })
    expect(parsePersonalBomWriteSuccess('line', 200, JSON.stringify({ ok: true, bom_line_id: bomLineId }))).toEqual({
      ok: true,
      bom_line_id: bomLineId,
    })
    expect(() => preparePersonalBomWriteCall('line', connectionId, { quantity: 2 }, {
      partId: '部件/甲',
      bomLineId,
      idempotencyKey: key,
    })).toThrow(PlmPersonalBomWriteError)
    expect(() => parsePersonalBomWriteSuccess('line', 200, JSON.stringify({ ok: true, bom_line_id: '行/甲' }))).toThrow(
      PlmPersonalBomWriteError,
    )
  })

  it('accepts native 140-character item ids and still rejects reserved path characters', () => {
    const partId = 'p'.repeat(140)
    const bomLineId = 'l'.repeat(140)
    const key = 'a'.repeat(64)
    const prepared = preparePersonalBomWriteCall('line', 'conn-1', { quantity: 2 }, {
      partId,
      bomLineId,
      idempotencyKey: key,
    })
    expect([...partId].length).toBe(140)
    expect([...bomLineId].length).toBe(140)
    expect(prepared.method).toBe('PATCH')
    expect(prepared.path).toBe(`/api/v1/bom/multitable/${partId}/lines/${bomLineId}`)
    expect(prepared.body).toEqual({ quantity: 2 })
    expect(parsePersonalBomWriteSuccess('line', 200, JSON.stringify({ ok: true, bom_line_id: bomLineId }))).toEqual({
      ok: true,
      bom_line_id: bomLineId,
    })
    const longer = 'p'.repeat(141)
    expect(preparePersonalBomWriteCall('line', 'conn-1', { quantity: 2 }, {
      partId: longer,
      bomLineId,
      idempotencyKey: key,
    }).path).toBe(`/api/v1/bom/multitable/${longer}/lines/${bomLineId}`)
    expect(preparePersonalBomWriteCall('eco-intent', 'conn-1', undefined, {
      partId,
      idempotencyKey: key,
    }).path).toBe(`/api/v1/bom/multitable/${partId}/eco-intent`)
    for (const reserved of ['p/p', 'p?p', 'p#p', 'p\\p', 'p\u0000p', '\uD800']) {
      expect(() => preparePersonalBomWriteCall('line', 'conn-1', { quantity: 2 }, {
        partId: reserved,
        bomLineId,
        idempotencyKey: key,
      })).toThrow(PlmPersonalBomWriteError)
      expect(() => parsePersonalBomWriteSuccess(
        'line',
        200,
        JSON.stringify({ ok: true, bom_line_id: reserved }),
      )).toThrow(PlmPersonalBomWriteError)
    }
  })

  it('sends the secret only to the bound origin when another host shares the scope', async () => {
    const hosts: string[] = []
    const fetch = vi.fn(async (url: URL, init: { headers: Record<string, string> }) => {
      hosts.push(new URL(String(url)).host)
      expect(init.headers.Authorization.startsWith('Bearer yuw_')).toBe(true)
      expect(JSON.stringify(init.headers)).not.toContain('shared-account')
      if (String(url).endsWith('/grant')) return new Response(null, { status: 204 })
      const id = init.headers.Authorization.includes(yuw('e')) ? 'e' : 'a'
      return new Response(JSON.stringify(verified({ grant_id: id.repeat(32) })), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    try {
    const stale = new PLMAdapter(
      { get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      {
        id: 'stale',
        name: 'stale',
        type: 'plm',
        connection: {
          url: 'https://stale.example/cached',
          headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1', Authorization: 'Bearer shared-account' },
        },
        options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
        credentials: { token: 'shared-account' },
      } as never,
    )
    const at = (url: string) =>
      source({
        config: {
          type: 'plm',
          connection: {
            url,
            headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1', Authorization: 'Bearer shared-account' },
          },
          options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
          credentials: { token: 'shared-account' },
        },
      })
    const mem = memory()
    mem.sources.set(SOURCE, at('https://bound.example'))
    const svc = new PlmPersonalBomWriteBindingService(mem.pool as never, () => stale as never)
    const grant = yuw('a')
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    expect(saved.targetOrigin).toBe('https://bound.example')
    expect(hosts).toEqual(['bound.example'])

    mem.sources.set(SOURCE, at('https://moved.example'))
    await expect(svc.managementUrl(actor(), SOURCE)).resolves.toBe(
      'https://moved.example/personal-approval-grants#bom-write',
    )
    await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    await expect(
      svc.freezeForOperation(actor(), saved.id, {
        operationKind: 'line',
        partId: 'part-1',
        bomLineId: 'line-1',
        clientKey: 'browser-key-1',
        patch: { quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
    expect(hosts).toEqual(['bound.example'])
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)

    const rebound = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: yuw('e') })
    expect(rebound.targetOrigin).toBe('https://moved.example')
    expect(hosts).toEqual(['bound.example', 'moved.example', 'bound.example'])
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${yuw('e')}`)
    expect(String(fetch.mock.calls[2][0])).toBe('https://bound.example/api/v1/plm-bom-write-grant/grant')
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${grant}`)

    // Unlink keeps the frozen origin. This non-root path is not an admission input.
    mem.sources.set(SOURCE, at('https://elsewhere.example/plm'))
    await svc.unbind(OWNER, rebound.id)
    expect(hosts).toEqual(['bound.example', 'moved.example', 'bound.example', 'moved.example'])
    expect(String(fetch.mock.calls[3][0])).toBe('https://moved.example/api/v1/plm-bom-write-grant/grant')
    expect(fetch.mock.calls[3][1].headers.Authorization).toBe(`Bearer ${yuw('e')}`)
    expect(hosts).not.toContain('stale.example')
    expect(hosts).not.toContain('elsewhere.example')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a same-origin prefix after a root bind and still revokes that frozen root', async () => {
    const root = 'https://native.invalid'
    const prefix = `${root}/prefix`
    const cachedUrl = 'https://stale.example/cached'
    const grant = yuw('a')
    const connectionId = 'conn-1'
    const tenantId = 'yt-b'
    const orgId = 'org-1'
    const mem = memory()
    const boundSource = source()
    ;(boundSource.config as { connection: { url: string } }).connection.url = root
    mem.sources.set(SOURCE, boundSource)
    const atGrant: Array<{ bindingCleared: boolean; retiredSecret: string | null; retiredState: string }> = []
    let grantCalls = 0
    const fetch = vi.fn(async (url: URL, _init: { method: string; headers: Record<string, string> }) => {
      const href = String(url)
      if (href.endsWith('/grant')) {
        grantCalls += 1
        const retiredCipher = mem.retired[0]?.encrypted_grant ?? null
        atGrant.push({
          bindingCleared: mem.bindings[0]?.encrypted_grant == null,
          retiredSecret: retiredCipher ? decryptStoredSecretValue(retiredCipher) : null,
          retiredState: mem.retired[0]?.state ?? '',
        })
        if (grantCalls === 1) return new Response('unavailable', { status: 429 })
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify(verified()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const cached = new PLMAdapter(
        { get: async () => undefined } as never,
        { info() {}, warn() {}, error() {}, debug() {} } as never,
        {
          id: 'stale',
          name: 'stale',
          type: 'plm',
          connection: {
            url: cachedUrl,
            headers: { 'x-tenant-id': tenantId, 'x-org-id': orgId, Authorization: 'Bearer shared-account' },
          },
          options: { apiMode: 'yuantus', tenantId, orgId },
          credentials: { token: 'shared-account' },
        } as never,
      )
      const requests = vi.spyOn(cached, 'personalBomWriteRequest')
      const requested = () => requests.mock.calls.map(([operation, token, boundConnection, authority]) => [
        operation,
        token,
        boundConnection,
        authority.origin,
        authority.tenantId,
        authority.orgId,
      ])
      const svc = new PlmPersonalBomWriteBindingService(mem.pool as never, () => cached as never)
      const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId, grant })
      expect(saved.targetOrigin).toBe(root)
      expect(requested()).toEqual([['verify', grant, connectionId, root, tenantId, orgId]])

      ;(mem.sources.get(SOURCE)!.config as { connection: { url: string } }).connection.url = prefix
      await expect(svc.requireUsable(actor(), saved.id)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_BOM_WRITE_FORBIDDEN',
      })
      await expect(svc.freezeForOperation(actor(), saved.id, {
        operationKind: 'line',
        partId: 'part-1',
        bomLineId: 'line-1',
        clientKey: 'browser-key-1',
        patch: { quantity: 1 },
      })).rejects.toMatchObject({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' })
      await expect(svc.managementUrl(actor(), SOURCE)).rejects.toMatchObject({
        status: 403,
        code: 'PLM_BOM_WRITE_FORBIDDEN',
      })
      await expect(svc.bind(actor(), { dataSourceId: SOURCE, connectionId, grant: yuw('e') })).rejects.toMatchObject({
        status: 403,
        code: 'PLM_BOM_WRITE_FORBIDDEN',
      })
      expect(requests.mock.calls).toHaveLength(1)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
      expect(mem.bindings[0].target_origin).toBe(root)
      await expect(svc.list(actor())).resolves.toEqual([
        expect.objectContaining({
          id: saved.id,
          targetOrigin: root,
          bound: true,
          yuantusTenantId: tenantId,
          yuantusOrgId: orgId,
        }),
      ])

      delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
      mem.memberships[0].is_active = false
      await expect(svc.list(actor())).resolves.toEqual([])
      mem.sources.get(SOURCE)!.owner_id = 'other-owner'
      await expect(svc.unbind(OWNER, saved.id)).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_FORBIDDEN' })
      expect(requests.mock.calls.filter(([operation]) => operation === 'revoke')).toHaveLength(0)
      expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(grant)
      mem.sources.get(SOURCE)!.owner_id = OWNER

      const unbound = await svc.unbind(OWNER, saved.id)
      expect(unbound.bound).toBe(false)
      expect(unbound.remoteRevokeState).toBe('unknown')
      expect(mem.bindings[0].encrypted_grant).toBeNull()
      expect(mem.bindings[0].target_origin).toBe(root)
      expect(mem.retired[0]).toMatchObject({
        state: 'unknown',
        slot: 'current',
        target_origin: root,
        yuantus_tenant_id: tenantId,
        yuantus_org_id: orgId,
        connection_id: connectionId,
      })
      expect(decryptStoredSecretValue(mem.retired[0].encrypted_grant!)).toBe(grant)
      expect(requested()[1]).toEqual(['revoke', grant, connectionId, root, tenantId, orgId])
      expect(atGrant[0]).toEqual({ bindingCleared: true, retiredSecret: grant, retiredState: 'pending' })

      const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => cached as never)
      await restarted.retryRetiredRevocations(OWNER)
      expect((mem.sources.get(SOURCE)!.config as { connection: { url: string } }).connection.url).toBe(prefix)
      expect(requested()).toEqual([
        ['verify', grant, connectionId, root, tenantId, orgId],
        ['revoke', grant, connectionId, root, tenantId, orgId],
        ['revoke', grant, connectionId, root, tenantId, orgId],
      ])
      expect(atGrant).toEqual([
        { bindingCleared: true, retiredSecret: grant, retiredState: 'pending' },
        { bindingCleared: true, retiredSecret: grant, retiredState: 'unknown' },
      ])
      expect(fetch.mock.calls.map(([url, init]) => [String(url), init.method])).toEqual([
        [`${root}/api/v1/plm-bom-write-grant/verify`, 'POST'],
        [`${root}/api/v1/plm-bom-write-grant/grant`, 'DELETE'],
        [`${root}/api/v1/plm-bom-write-grant/grant`, 'DELETE'],
      ])
      for (const [, init] of fetch.mock.calls) {
        expect(init.headers.Authorization).toBe(`Bearer ${grant}`)
        expect(init.headers['x-tenant-id']).toBe(tenantId)
        expect(init.headers['x-org-id']).toBe(orgId)
      }
      expect(JSON.stringify(fetch.mock.calls)).not.toContain('shared-account')
      expect(JSON.stringify(fetch.mock.calls)).not.toContain('stale.example')
      expect(JSON.stringify(fetch.mock.calls)).not.toContain('/prefix')
      expect(JSON.stringify(requests.mock.calls)).not.toContain('shared-account')
      expect(JSON.stringify(requests.mock.calls)).not.toContain('stale.example')
      expect(JSON.stringify(requests.mock.calls)).not.toContain('/prefix')
      expect(mem.retired[0].state).toBe('revoked')
      expect(mem.retired[0].encrypted_grant).toBeNull()
      expect(mem.bindings[0].encrypted_grant).toBeNull()
      expect(mem.bindings[0].remote_revoke_state).toBe('revoked')
      expect(mem.bindings[0].target_origin).toBe(root)
      expect(JSON.stringify(mem.retired)).not.toContain(grant)
      await expect(restarted.list(actor())).resolves.toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the personal bearer on the locked source when the cached adapter host differs', async () => {
    const expectedOrigin = 'https://current-native.invalid'
    const staleOrigin = 'https://stale-native.invalid'
    const tenant = 'yt-b'
    const org = 'org-1'
    const connection = 'conn-1'
    const grant = yuw('a')
    const config = (url: string) => ({
      id: SOURCE,
      name: 'Source',
      type: 'plm',
      connection: { url, headers: { 'x-tenant-id': tenant, 'x-org-id': org } },
      options: { apiMode: 'yuantus', tenantId: tenant, orgId: org },
    })
    const sourceRow = {
      id: SOURCE,
      owner_id: OWNER,
      workspace_id: null,
      tenant_id: 'meta-a',
      scope_kind: 'private',
      type: 'plm',
      is_active: true,
      deleted_at: null,
      config: config(expectedOrigin),
    }
    let stored: Row | undefined
    const client = {
      release() {},
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('FROM users')) return { rows: [{ id: OWNER }], rowCount: 1 }
        if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: OWNER }], rowCount: 1 }
        if (sql.includes('FROM data_sources')) return { rows: [sourceRow], rowCount: 1 }
        if (sql.includes('INSERT INTO plm_personal_bom_write_bindings')) {
          stored = {
            id: String(params[0]),
            owner_id: String(params[1]),
            data_source_id: String(params[2]),
            connection_id: String(params[3]),
            subject_id: String(params[4]),
            meta_tenant_id: (params[5] as string | null) ?? null,
            yuantus_tenant_id: String(params[6]),
            yuantus_org_id: String(params[7]),
            target_origin: String(params[8]),
            workspace_id: (params[9] as string | null) ?? null,
            scope_kind: String(params[10]),
            grant_id: String(params[11]),
            expires_at: params[12] as Date,
            encrypted_grant: String(params[13]),
            generation: 1,
            purpose: 'bom_write',
            remote_revoke_state: null,
            previous_grant_revoke_state: null,
          }
          return { rows: [{ ...stored }], rowCount: 1 }
        }
        if (sql.includes('FROM plm_personal_bom_write_bindings')) {
          return { rows: stored ? [{ ...stored }] : [], rowCount: stored ? 1 : 0 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const targets: string[] = []
    const fetch = vi.fn(async (url: URL, init: { headers: Record<string, string> }) => {
      targets.push(new URL(String(url)).origin)
      expect(init.headers.Authorization).toBe(`Bearer ${grant}`)
      expect(JSON.stringify(init.headers)).not.toContain('shared-account')
      return new Response(JSON.stringify(verified()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const cached = new PLMAdapter(
        { get: async () => undefined } as never,
        { info() {}, warn() {}, error() {}, debug() {} } as never,
        config(staleOrigin) as never,
      )
      const svc = new PlmPersonalBomWriteBindingService({ connect: async () => client } as never, () => cached as never)
      const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: connection, grant })
      expect(saved.targetOrigin).toBe(expectedOrigin)
      expect(stored?.target_origin).toBe(expectedOrigin)
      expect(targets).toEqual([expectedOrigin])
      expect(String(fetch.mock.calls[0][0])).toBe(`${expectedOrigin}/api/v1/plm-bom-write-grant/verify`)
      expect(targets).not.toContain(staleOrigin)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries the exact unbound secret after the outcome write is lost', async () => {
    const mem = memory()
    let killSettle = false
    const pool = {
      connect: async () => {
        const client = await mem.pool.connect()
        return {
          release: () => client.release(),
          query: async (sql: string, params?: unknown[]) => {
            if (killSettle && sql.includes('UPDATE plm_personal_bom_write_retired_grants')) {
              killSettle = false
              throw new Error('process lost')
            }
            return client.query(sql, params)
          },
        }
      },
    }
    const grant = yuw('a')
    const svc = new PlmPersonalBomWriteBindingService(pool as never, () => mem.transport as never)
    const saved = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant })
    killSettle = true
    await expect(svc.unbind(OWNER, saved.id)).rejects.toThrow('process lost')
    expect(mem.bindings[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].generation).toBe(2)
    expect(mem.bindings[0].remote_revoke_state).toBe('pending')
    expect(mem.retired[0]).toMatchObject({
      state: 'pending',
      slot: 'current',
      target_origin: 'https://synthetic.invalid',
      yuantus_tenant_id: 'yt-b',
      yuantus_org_id: 'org-1',
      connection_id: 'conn-1',
    })
    expect(mem.retired[0].encrypted_grant?.startsWith('enc:')).toBe(true)
    expect(mem.retired[0].encrypted_grant).not.toContain(grant)
    expect(decryptStoredSecretValue(mem.retired[0].encrypted_grant!)).toBe(grant)
    expect(JSON.stringify(mem.queries)).not.toContain(grant)
    expect(mem.calls.at(-1)).toMatchObject({ op: 'revoke', grant, origin: 'https://synthetic.invalid' })

    mem.calls.length = 0
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
    await restarted.retryRetiredRevocations(OWNER)
    expect(mem.calls).toEqual([
      expect.objectContaining({ op: 'revoke', grant, origin: 'https://synthetic.invalid', tenantId: 'yt-b' }),
    ])
    expect(mem.retired[0].state).toBe('revoked')
    expect(mem.retired[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].remote_revoke_state).toBe('revoked')
    expect(JSON.stringify(mem.retired)).not.toContain(grant)
  })

  it('retries a replaced grant at its original origin and leaves the replacement bound', async () => {
    const mem = memory()
    const { svc } = service(mem)
    const oldGrant = yuw('a')
    const nextGrant = yuw('e', 'f')
    await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: oldGrant })
    const moved = source()
    ;(moved.config as { connection: { url: string } }).connection.url = 'https://moved.example'
    mem.sources.set(SOURCE, moved)
    mem.setVerify(verified({ grant_id: 'e'.repeat(32), auth_user_id: '900' }))
    mem.setRevoke(() => {
      expect(mem.retired[0].state).toBe('pending')
      expect(mem.retired[0].target_origin).toBe('https://synthetic.invalid')
      expect(mem.retired[0].encrypted_grant).not.toContain(oldGrant)
      expect(decryptStoredSecretValue(mem.retired[0].encrypted_grant!)).toBe(oldGrant)
      expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(nextGrant)
      throw new Error('timeout')
    })
    const replaced = await svc.bind(actor(), { dataSourceId: SOURCE, connectionId: 'conn-1', grant: nextGrant })
    expect(replaced.bound).toBe(true)
    expect(replaced.targetOrigin).toBe('https://moved.example')
    expect(replaced.subjectId).toBe('900')
    expect(replaced.remoteRevokeState).toBeNull()
    expect(replaced.previousGrantRevokeState).toBe('unknown')
    expect(mem.retired[0].state).toBe('unknown')
    expect(mem.retired[0].slot).toBe('previous')
    expect(decryptStoredSecretValue(mem.retired[0].encrypted_grant!)).toBe(oldGrant)
    expect(mem.bindings[0].target_origin).toBe('https://moved.example')
    expect(JSON.stringify(replaced)).not.toContain(oldGrant)

    mem.calls.length = 0
    mem.setRevoke(() => undefined)
    const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
    await restarted.retryRetiredRevocations(OWNER)
    expect(mem.calls).toEqual([
      expect.objectContaining({
        op: 'revoke',
        grant: oldGrant,
        origin: 'https://synthetic.invalid',
        tenantId: 'yt-b',
      }),
    ])
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(nextGrant)
    expect(mem.bindings[0].target_origin).toBe('https://moved.example')
    expect(mem.bindings[0].grant_id).toBe('e'.repeat(32))
    expect(mem.retired[0].state).toBe('revoked')
    expect(mem.retired[0].encrypted_grant).toBeNull()
    expect(JSON.stringify(mem.retired)).not.toContain(oldGrant)
    expect(JSON.stringify(mem.retired)).not.toContain(nextGrant)
  })

  it('accepts a new grant while a retired credential stays unknown and retry does not revoke it', async () => {
    const mem = memory()
    const { svc } = service(mem)
    await bindId(mem, svc, 'a')
    interruptRevoke(mem)
    await bindId(mem, svc, 'b')
    const retiredA = mem.retired.find((row) => row.grant_id === 'a'.repeat(32))
    expect(retiredA).toMatchObject({ state: 'unknown', slot: 'previous', target_origin: 'https://synthetic.invalid' })
    expect(decryptStoredSecretValue(retiredA!.encrypted_grant!)).toBe(yuw('a'))
    const saved = await bindId(mem, svc, 'c')
    expect(saved.bound).toBe(true)
    expect(saved.grantId).toBe('c'.repeat(32))
    expect(saved.targetOrigin).toBe('https://synthetic.invalid')
    expect(saved.remoteRevokeState).toBeNull()
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('c'))
    expect(mem.bindings[0].grant_id).toBe('c'.repeat(32))
    expect(retiredA!.state).toBe('unknown')
    expect(decryptStoredSecretValue(retiredA!.encrypted_grant!)).toBe(yuw('a'))
    const retiredB = mem.retired.find((row) => row.grant_id === 'b'.repeat(32))
    expect(retiredB).toMatchObject({ state: 'unknown', slot: 'previous' })
    expect(decryptStoredSecretValue(retiredB!.encrypted_grant!)).toBe(yuw('b'))
    expect(JSON.stringify(saved)).not.toContain(yuw('a'))
    expect(JSON.stringify(saved)).not.toContain(yuw('c'))

    mem.calls.length = 0
    mem.setRevoke(() => undefined)
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
    await restarted.retryRetiredRevocations(OWNER)
    expect(mem.calls.map((call) => call.grant)).toEqual([yuw('a'), yuw('b')])
    expect(mem.calls.every((call) => call.op === 'revoke' && call.origin === 'https://synthetic.invalid')).toBe(true)
    expect(mem.calls.some((call) => call.grant === yuw('c'))).toBe(false)
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('c'))
    expect(mem.bindings[0].grant_id).toBe('c'.repeat(32))
    expect(mem.bindings[0].remote_revoke_state).toBeNull()
    expect(mem.bindings[0].previous_grant_revoke_state).toBe('revoked')
    expect(retiredA!.state).toBe('revoked')
    expect(retiredA!.encrypted_grant).toBeNull()
    expect(retiredB!.state).toBe('revoked')
    expect(retiredB!.encrypted_grant).toBeNull()
    expect(JSON.stringify(mem.retired)).not.toContain(yuw('a'))
    expect(JSON.stringify(mem.retired)).not.toContain(yuw('c'))
  })

  it('rejects reactivation of a grant retired by replacement and retry revokes only that grant', async () => {
    const mem = memory()
    const { svc } = service(mem)
    await bindId(mem, svc, 'a')
    interruptRevoke(mem)
    const replaced = await bindId(mem, svc, 'b')
    const liveCipher = mem.bindings[0].encrypted_grant
    const retiredCipher = mem.retired[0].encrypted_grant
    expect(replaced.grantId).toBe('b'.repeat(32))
    expect(replaced.bound).toBe(true)
    expect(decryptStoredSecretValue(liveCipher!)).toBe(yuw('b'))
    expect(mem.retired[0]).toMatchObject({
      state: 'unknown',
      slot: 'previous',
      grant_id: 'a'.repeat(32),
      target_origin: 'https://synthetic.invalid',
    })
    expect(decryptStoredSecretValue(retiredCipher!)).toBe(yuw('a'))
    const generation = mem.bindings[0].generation

    mem.calls.length = 0
    mem.queries.length = 0
    await expect(bindId(mem, svc, 'a')).rejects.toMatchObject({
      status: 409,
      code: 'PLM_BOM_WRITE_CONFLICT',
    })
    reuseCheckedBeforeWrite(mem.queries)
    expect(mem.calls).toEqual([expect.objectContaining({ op: 'verify', grant: yuw('a') })])
    expect(mem.bindings[0].encrypted_grant).toBe(liveCipher)
    expect(mem.bindings[0].grant_id).toBe('b'.repeat(32))
    expect(mem.bindings[0].target_origin).toBe('https://synthetic.invalid')
    expect(mem.bindings[0].generation).toBe(generation)
    expect(mem.retired).toHaveLength(1)
    expect(mem.retired[0].state).toBe('unknown')
    expect(mem.retired[0].encrypted_grant).toBe(retiredCipher)

    mem.calls.length = 0
    mem.setRevoke(() => undefined)
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
    await restarted.retryRetiredRevocations(OWNER)
    expect(mem.calls).toEqual([
      expect.objectContaining({ op: 'revoke', grant: yuw('a'), origin: 'https://synthetic.invalid' }),
    ])
    expect(mem.calls.some((call) => call.grant === yuw('b'))).toBe(false)
    expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('b'))
    expect(mem.bindings[0].grant_id).toBe('b'.repeat(32))
    expect(mem.bindings[0].target_origin).toBe('https://synthetic.invalid')
    expect(mem.bindings[0].remote_revoke_state).toBeNull()
    expect(mem.bindings[0].generation).toBe(generation)
    expect(mem.retired[0].state).toBe('revoked')
    expect(mem.retired[0].encrypted_grant).toBeNull()
    expect(JSON.stringify(mem.retired)).not.toContain(yuw('a'))
    expect(JSON.stringify(mem.retired)).not.toContain(yuw('b'))
  })

  it.each([429, 408])(
    'keeps a %s retired grant encrypted and revokes it on restart after 204',
    async (status) => {
      const mem = memory()
      const { svc } = service(mem)
      await bindId(mem, svc, 'a')
      mem.setRevoke(() => {
        throw new PlmPersonalBomWriteError(status, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
      })
      const replaced = await bindId(mem, svc, 'b')
      expect(replaced.bound).toBe(true)
      expect(replaced.grantId).toBe('b'.repeat(32))
      expect(replaced.remoteRevokeState).toBeNull()
      expect(replaced.previousGrantRevokeState).toBe('unknown')
      expect(mem.calls.filter((call) => call.op === 'revoke')).toHaveLength(1)
      const retiredCipher = mem.retired[0].encrypted_grant
      expect(mem.retired[0]).toMatchObject({
        state: 'unknown',
        slot: 'previous',
        grant_id: 'a'.repeat(32),
        target_origin: 'https://synthetic.invalid',
      })
      expect(mem.retired[0].state).not.toBe('rejected')
      expect(mem.retired[0].state).not.toBe('revoked')
      expect(decryptStoredSecretValue(retiredCipher!)).toBe(yuw('a'))
      expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('b'))

      mem.calls.length = 0
      delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
      const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
      await restarted.retryRetiredRevocations(OWNER)
      expect(mem.calls).toEqual([
        expect.objectContaining({ op: 'revoke', grant: yuw('a'), origin: 'https://synthetic.invalid' }),
      ])
      expect(mem.retired[0].state).toBe('unknown')
      expect(mem.retired[0].encrypted_grant).toBe(retiredCipher)

      mem.calls.length = 0
      mem.setRevoke(() => undefined)
      await restarted.retryRetiredRevocations(OWNER)
      expect(mem.calls).toEqual([
        expect.objectContaining({ op: 'revoke', grant: yuw('a'), origin: 'https://synthetic.invalid' }),
      ])
      expect(mem.calls.some((call) => call.grant === yuw('b'))).toBe(false)
      expect(mem.retired[0].state).toBe('revoked')
      expect(mem.retired[0].encrypted_grant).toBeNull()
      expect(decryptStoredSecretValue(mem.bindings[0].encrypted_grant!)).toBe(yuw('b'))
      expect(mem.bindings[0].grant_id).toBe('b'.repeat(32))
      expect(mem.bindings[0].remote_revoke_state).toBeNull()
      expect(mem.bindings[0].previous_grant_revoke_state).toBe('revoked')
      expect(JSON.stringify(mem.retired)).not.toContain(yuw('a'))
      expect(JSON.stringify(mem.retired)).not.toContain(yuw('b'))
    },
  )

  it('rejects rebinding a grant retired by unbind and retry leaves the binding unbound', async () => {
    const mem = memory()
    const { svc } = service(mem)
    const saved = await bindId(mem, svc, 'a')
    interruptRevoke(mem)
    const unbound = await svc.unbind(OWNER, saved.id)
    expect(unbound.bound).toBe(false)
    expect(unbound.remoteRevokeState).toBe('unknown')
    expect(mem.bindings[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].generation).toBe(2)
    const retiredCipher = mem.retired[0].encrypted_grant
    expect(mem.retired[0]).toMatchObject({
      state: 'unknown',
      slot: 'current',
      grant_id: 'a'.repeat(32),
      target_origin: 'https://synthetic.invalid',
    })
    expect(decryptStoredSecretValue(retiredCipher!)).toBe(yuw('a'))

    mem.calls.length = 0
    mem.queries.length = 0
    await expect(bindId(mem, svc, 'a')).rejects.toMatchObject({
      status: 409,
      code: 'PLM_BOM_WRITE_CONFLICT',
    })
    reuseCheckedBeforeWrite(mem.queries)
    expect(mem.calls).toEqual([expect.objectContaining({ op: 'verify', grant: yuw('a') })])
    expect(mem.bindings[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].generation).toBe(2)
    expect(mem.bindings[0].remote_revoke_state).toBe('unknown')
    expect(mem.retired).toHaveLength(1)
    expect(mem.retired[0].state).toBe('unknown')
    expect(mem.retired[0].encrypted_grant).toBe(retiredCipher)

    mem.calls.length = 0
    mem.setRevoke(() => undefined)
    delete process.env.PLM_PERSONAL_BOM_WRITE_ENABLED
    const restarted = new PlmPersonalBomWriteBindingService(mem.pool as never, () => mem.transport as never)
    await restarted.retryRetiredRevocations(OWNER)
    expect(mem.calls).toEqual([
      expect.objectContaining({ op: 'revoke', grant: yuw('a'), origin: 'https://synthetic.invalid' }),
    ])
    expect(mem.bindings[0].encrypted_grant).toBeNull()
    expect(mem.bindings[0].generation).toBe(2)
    expect(mem.bindings[0].remote_revoke_state).toBe('revoked')
    expect(mem.retired[0].state).toBe('revoked')
    expect(mem.retired[0].encrypted_grant).toBeNull()
    expect(JSON.stringify(mem.retired)).not.toContain(yuw('a'))
    const listed = await restarted.list(actor())
    expect(listed).toEqual([expect.objectContaining({ bound: false, remoteRevokeState: 'revoked', grantId: 'a'.repeat(32) })])
  })

  it('stores a retired revoke ciphertext and refuses to drop stored rows', () => {
    const sql = readFileSync(
      new URL('../../src/db/migrations/zzzz20261017010000_create_plm_personal_bom_write_bindings.ts', import.meta.url),
      'utf8',
    )
    expect(sql).toContain('UNIQUE (owner_id, data_source_id)')
    expect(sql).toContain("purpose = 'bom_write'")
    expect(sql).toContain("left(encrypted_grant, 4) = 'enc:'")
    expect(sql).toContain('target_origin')
    expect(sql).toContain("target_origin ~ '^https://'")
    expect(sql).toContain('plm_personal_bom_write_retired_grants')
    expect(sql).toContain("slot IN ('current', 'previous')")
    expect(sql).toContain("(state IN ('pending', 'unknown') AND encrypted_grant IS NOT NULL)")
    expect(sql).toContain("(state IN ('revoked', 'rejected') AND encrypted_grant IS NULL)")
    expect(sql).toContain('DROP TABLE plm_personal_bom_write_retired_grants')
    expect(sql).toContain('plm_personal_bom_write_evidence_present')
    expect(sql).not.toContain('personal-approval-grants')
  })
})
