import { describe, it, expect, vi } from 'vitest'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'
import {
  personalBindingInput,
  personalCommandSchema,
  requirePlmApprovalCard,
} from '../../src/services/plm-personal-approval-wire'
describe('personal PLM purpose contract', () => {
  it('has a persistent explicit binding service', () =>
    expect(PlmPersonalApprovalBindingService).toBeTypeOf('function'))
  it('does not admit an actor, URL or scope supplied in a binding', () => {
    const base = { connectionId: 'fixed', grant: `yua_${'a'.repeat(32)}_${'b'.repeat(43)}` }
    expect(personalBindingInput.safeParse(base).success).toBe(true)
    for (const extra of ['actor', 'subjectId', 'url', 'tenantId', 'orgId'])
      expect(personalBindingInput.safeParse({ ...base, [extra]: 'forged' }).success).toBe(false)
  })
  it('default off and exact true', () => {
    for (const flag of [undefined, 'TRUE', '1', ' true ']) {
      vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', flag)
      expect(() => requirePlmApprovalCard()).toThrow()
    }
    vi.unstubAllEnvs()
  })
  it('requires comment for rejection and all command keys', () => {
    const c = {
      schema: 'yuantus.plm-approval-card-command.v1',
      command_id: '00000000-0000-4000-8000-000000000001',
      connection_id: 'fixed',
      delivery_id: '00000000-0000-4000-8000-000000000002',
      task_id: '00000000-0000-4000-8000-000000000003',
      round_id: '00000000-0000-4000-8000-000000000004',
      decision: 'reject',
      comment: null,
    }
    expect(personalCommandSchema.safeParse(c).success).toBe(false)
    expect(personalCommandSchema.safeParse({ ...c, comment: 'reason' }).success).toBe(true)
  })
})
describe('personal binding local unlink', () => {
  const grant = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
  const owner = 'owner-1'
  const clearSql =
    'UPDATE plm_personal_approval_bindings SET encrypted_grant=NULL,generation=generation+1,updated_at=now() WHERE id=$1'
  const taskSql =
    'UPDATE plm_personal_approval_tasks SET active=false,updated_at=now() WHERE binding_id=$1'
  const cardSql = `UPDATE dingtalk_approval_card_deliveries SET card_state='revoked',updated_at=now() WHERE plm_task_id IN(SELECT id FROM plm_personal_approval_tasks WHERE binding_id=$1) AND card_state='sent'`
  const listSql =
    `SELECT b.*,(SELECT count(*) FROM plm_personal_approval_commands x WHERE x.binding_id=b.id AND x.state='pending') AS unresolved FROM plm_personal_approval_bindings b WHERE b.owner_id=$1 ORDER BY id`
  const lockSql =
    'SELECT * FROM plm_personal_approval_bindings WHERE id=$1 AND owner_id=$2 FOR UPDATE'
  const userSql = 'SELECT id FROM users WHERE id=$1 AND is_active=true FOR SHARE'
  function enable(connectionId: string) {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', connectionId)
  }
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'binding-1',
      owner_id: owner,
      connection_id: 'fixed',
      subject_id: 'subject-1',
      tenant_id: 'tenant-saved',
      org_id: 'org-saved',
      grant_id: 'grant-1',
      expires_at: new Date('2099-01-01T00:00:00.000Z'),
      encrypted_grant: 'enc:original-secret',
      generation: 4,
      ...overrides,
    }
  }
  function pg(options: {
    activeUser: boolean
    binding: ReturnType<typeof row> | null
    listed?: Array<ReturnType<typeof row> & { unresolved?: string }>
  }) {
    const calls: { sql: string; params: unknown[] }[] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const bound = params ?? []
        calls.push({ sql, params: bound })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql.includes('FROM users') && sql.includes('FOR SHARE')) {
          if (!sql.includes('is_active=true') || options.activeUser)
            return { rows: [{ id: bound[0] }], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('FROM plm_personal_approval_bindings') && sql.includes('FOR UPDATE')) {
          const saved = options.binding
          if (!saved) return { rows: [], rowCount: 0 }
          if (!sql.includes('owner_id=$2')) return { rows: [saved], rowCount: 1 }
          if (sql.includes('id=$1') && bound[0] === saved.id && bound[1] === saved.owner_id)
            return { rows: [saved], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }
        // Observed list fixtures only. owner_id=$1 selects rows; unresolved stays a count string.
        if (sql.includes('AS unresolved') && sql.includes('FROM plm_personal_approval_bindings b')) {
          const source = options.listed ?? []
          const visible = sql.includes('b.owner_id=$1')
            ? source.filter((item) => item.owner_id === bound[0])
            : source
          const rows = visible.map((item) => ({
            ...item,
            unresolved: typeof item.unresolved === 'string' ? item.unresolved : '0',
          }))
          return { rows, rowCount: rows.length }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    return {
      calls,
      client,
      pool: { connect: vi.fn(async () => client), query: vi.fn() },
    }
  }
  async function withFetch<T>(run: (fetchSpy: ReturnType<typeof vi.fn>) => Promise<T>) {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      return await run(fetchSpy)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  }
  async function unlink(saved: ReturnType<typeof row>, provider: () => unknown) {
    return withFetch(async (fetchSpy) => {
      enable('fixed')
      expect(requirePlmApprovalCard()).toBe('fixed')
      const fx = pg({ activeUser: true, binding: saved })
      const svc = new PlmPersonalApprovalBindingService(fx.pool as never, provider as never)
      await svc.unbind(saved.owner_id, saved.id)
      expect(provider).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(fx.calls.map((c) => c.sql)).toEqual([
        'BEGIN',
        userSql,
        lockSql,
        clearSql,
        taskSql,
        cardSql,
        'COMMIT',
      ])
      expect(fx.calls[1].params).toEqual([saved.owner_id])
      expect(fx.calls[2].params).toEqual([saved.id, saved.owner_id])
      for (const call of fx.calls.slice(3, 6)) expect(call.params).toEqual([saved.id])
      expect(fx.calls.some((c) => c.sql.includes('plm_personal_approval_commands'))).toBe(false)
      expect(JSON.stringify(fx.calls)).not.toContain(String(saved.encrypted_grant))
      expect(fx.client.release).toHaveBeenCalledTimes(1)
      return fx
    })
  }
  it('clears an owned binding when the provider getter throws', async () => {
    const saved = row()
    const provider = vi.fn(() => {
      throw new Error('provider unavailable')
    })
    await unlink(saved, provider)
  })
  it('clears an owned binding when current provider tenant and org drifted', async () => {
    const saved = row()
    const provider = vi.fn(() => ({
      personalApprovalManagementUrl: () => 'https://example.invalid/manage',
      getEffectiveTenantId: () => 'tenant-drift',
      getEffectiveOrgId: () => 'org-drift',
      personalApprovalRequest: () => {
        throw new Error('remote fetch')
      },
    }))
    await unlink(saved, provider)
  })
  it('clears an owned binding when the saved connection differs from the configured connection', async () => {
    const saved = row({ connection_id: 'saved' })
    const provider = vi.fn(() => ({
      personalApprovalManagementUrl: () => 'https://example.invalid/manage',
      getEffectiveTenantId: () => saved.tenant_id,
      getEffectiveOrgId: () => saved.org_id,
      personalApprovalRequest: () => {
        throw new Error('remote fetch')
      },
    }))
    await unlink(saved, provider)
  })
  it('clears an owned expired credential without calling the current provider', async () => {
    const saved = row({ expires_at: new Date('2000-01-01T00:00:00.000Z') })
    const provider = vi.fn(() => ({
      personalApprovalManagementUrl: () => 'https://example.invalid/manage',
      getEffectiveTenantId: () => saved.tenant_id,
      getEffectiveOrgId: () => saved.org_id,
      personalApprovalRequest: () => {
        throw new Error('remote fetch')
      },
    }))
    await unlink(saved, provider)
  })
  it('does not clean up an inactive owner, another owner, a missing binding, or a disabled module', async () => {
    const saved = row()
    const provider = vi.fn(() => {
      throw new Error('provider unavailable')
    })
    await withFetch(async (fetchSpy) => {
      enable('fixed')
      const inactive = pg({ activeUser: false, binding: saved })
      const inactiveSvc = new PlmPersonalApprovalBindingService(inactive.pool as never, provider as never)
      await expect(inactiveSvc.unbind(owner, saved.id)).rejects.toMatchObject({
        status: 401,
        message: 'PLM_CARD_UNAUTHORIZED',
      })
      expect(inactive.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
      const wrong = pg({ activeUser: true, binding: saved })
      const wrongSvc = new PlmPersonalApprovalBindingService(wrong.pool as never, provider as never)
      await expect(wrongSvc.unbind('owner-2', saved.id)).rejects.toMatchObject({
        status: 404,
        message: 'PLM_BINDING_REQUIRED',
      })
      expect(wrong.calls.some((c) => c.sql === lockSql && c.params[1] === 'owner-2')).toBe(true)
      expect(wrong.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
      const missing = pg({ activeUser: true, binding: saved })
      const missingSvc = new PlmPersonalApprovalBindingService(missing.pool as never, provider as never)
      await expect(missingSvc.unbind(owner, 'missing')).rejects.toMatchObject({
        status: 404,
        message: 'PLM_BINDING_REQUIRED',
      })
      expect(missing.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false)
      expect(provider).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
    await withFetch(async (fetchSpy) => {
      vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', '1')
      const off = pg({ activeUser: true, binding: saved })
      const offSvc = new PlmPersonalApprovalBindingService(off.pool as never, provider as never)
      await expect(offSvc.unbind(owner, saved.id)).rejects.toThrow()
      expect(off.calls.some((c) => c.sql.startsWith('UPDATE') || c.sql === lockSql)).toBe(false)
      expect(provider).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
  it('rejects bind when current provider authority is unavailable or mismatched', async () => {
    const input = { connectionId: 'fixed', grant }
    await withFetch(async () => {
      enable('fixed')
      expect(requirePlmApprovalCard()).toBe('fixed')
      const unavailable = pg({ activeUser: true, binding: null })
      const down = vi.fn(() => {
        throw new Error('provider unavailable')
      })
      const downSvc = new PlmPersonalApprovalBindingService(unavailable.pool as never, down as never)
      await expect(downSvc.bind(owner, input)).rejects.toThrow('provider unavailable')
      expect(unavailable.calls.map((c) => c.sql)).toEqual([
        'BEGIN',
        userSql,
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        'ROLLBACK',
      ])
      const mismatchedConnection = pg({ activeUser: true, binding: null })
      const idle = vi.fn(() => {
        throw new Error('provider should stay idle')
      })
      const idleSvc = new PlmPersonalApprovalBindingService(
        mismatchedConnection.pool as never,
        idle as never,
      )
      await expect(idleSvc.bind(owner, { connectionId: 'other', grant })).rejects.toMatchObject({
        status: 403,
        message: 'PLM_PROVIDER_FORBIDDEN',
      })
      expect(mismatchedConnection.pool.connect).not.toHaveBeenCalled()
      expect(idle).not.toHaveBeenCalled()
      expect(mismatchedConnection.calls.some((c) => c.sql.includes('INSERT INTO'))).toBe(false)
      const verified = {
        schema: 'yuantus.plm-approval-personal-binding.v1',
        connection_id: 'fixed',
        tenant_id: 'native-tenant-a',
        org_id: 'native-org-a',
        auth_user_id: '42',
        grant_id: 'a'.repeat(32),
        expires_at: '2099-01-01T00:00:00.000Z',
      }
      const scope = pg({ activeUser: true, binding: null })
      const request = vi.fn(async () => verified)
      const scopeProvider = vi.fn(() => ({
        personalApprovalManagementUrl: () => 'https://example.invalid/manage',
        getEffectiveTenantId: () => 'native-tenant-b',
        getEffectiveOrgId: () => 'native-org-b',
        personalApprovalRequest: request,
      }))
      const scopeSvc = new PlmPersonalApprovalBindingService(scope.pool as never, scopeProvider as never)
      await expect(scopeSvc.bind(owner, input)).rejects.toMatchObject({
        status: 403,
        message: 'PLM_PROVIDER_FORBIDDEN',
      })
      expect(request).toHaveBeenCalledWith('verify', grant, 'fixed')
      expect(scope.calls.map((c) => c.sql)).toEqual([
        'BEGIN',
        userSql,
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        'ROLLBACK',
      ])
      const driftedConnection = pg({ activeUser: true, binding: null })
      const connectionRequest = vi.fn(async () => ({
        ...verified,
        connection_id: 'native-connection-b',
      }))
      const connectionProvider = vi.fn(() => ({
        personalApprovalManagementUrl: () => 'https://example.invalid/manage',
        getEffectiveTenantId: () => verified.tenant_id,
        getEffectiveOrgId: () => verified.org_id,
        personalApprovalRequest: connectionRequest,
      }))
      const connectionSvc = new PlmPersonalApprovalBindingService(
        driftedConnection.pool as never,
        connectionProvider as never,
      )
      await expect(connectionSvc.bind(owner, input)).rejects.toMatchObject({
        status: 403,
        message: 'PLM_PROVIDER_FORBIDDEN',
      })
      expect(connectionRequest).toHaveBeenCalledWith('verify', grant, 'fixed')
      expect(driftedConnection.calls.some((c) => c.sql.includes('INSERT INTO'))).toBe(false)
      expect(driftedConnection.calls.some((c) => c.sql.includes('owner_id=$1 AND connection_id=$2'))).toBe(
        false,
      )
    })
  })
  function projected(saved: ReturnType<typeof row>, unresolvedCount: number, canUse: boolean) {
    return {
      id: String(saved.id),
      connectionId: String(saved.connection_id),
      subjectId: String(saved.subject_id),
      tenantId: String(saved.tenant_id),
      orgId: String(saved.org_id),
      grantId: String(saved.grant_id),
      expiresAt: new Date(saved.expires_at as Date).toISOString(),
      bound: !!saved.encrypted_grant,
      unresolvedCount,
      canUse,
    }
  }
  function connection(grantManagementUrl: string | null) {
    return { id: 'fixed', label: 'Yuantus', grantManagementUrl }
  }
  function expectOwnerList(calls: { sql: string; params: unknown[] }[]) {
    expect(calls.map((call) => call.sql)).toEqual(['BEGIN', userSql, listSql, 'COMMIT'])
    expect(calls[1].params).toEqual([owner])
    expect(calls[2].params).toEqual([owner])
    expect(calls[2].sql.includes('connection_id=$2')).toBe(false)
  }
  function transport(overrides: { url?: () => unknown; tenant?: () => unknown; org?: () => unknown } = {}) {
    const request = vi.fn(() => {
      throw new Error('remote fetch')
    })
    const provider = vi.fn(() => ({
      personalApprovalManagementUrl: overrides.url ?? (() => 'https://example.invalid/personal-approval-grants'),
      getEffectiveTenantId: overrides.tenant ?? (() => 'tenant-saved'),
      getEffectiveOrgId: overrides.org ?? (() => 'org-saved'),
      personalApprovalRequest: request,
    }))
    return { provider, request }
  }
  async function readList(
    rows: Array<ReturnType<typeof row> & { unresolved?: string }>,
    provider: () => unknown,
  ) {
    return withFetch(async (fetchSpy) => {
      enable('fixed')
      const fx = pg({ activeUser: true, binding: null, listed: rows })
      const svc = new PlmPersonalApprovalBindingService(fx.pool as never, provider as never)
      const result = await svc.list(owner)
      expectOwnerList(fx.calls)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('enc:original-secret')
      expect(JSON.stringify(fx.calls)).not.toContain('enc:original-secret')
      expect(fx.client.release).toHaveBeenCalledTimes(1)
      return result
    })
  }
  it('lists every saved binding for the active owner and marks only the current scope usable', async () => {
    const current = { ...row({ id: 'binding-current' }), unresolved: '2' }
    const legacy = { ...row({ id: 'binding-legacy', connection_id: 'legacy' }), unresolved: '1' }
    const foreign = { ...row({ id: 'binding-foreign', owner_id: 'owner-2' }), unresolved: '9' }
    const { provider, request } = transport()
    const result = await readList([current, legacy, foreign], provider)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(result).toEqual({
      connection: connection('https://example.invalid/personal-approval-grants'),
      bindings: [projected(current, 2, true), projected(legacy, 1, false)],
    })
    expect(JSON.stringify(result)).not.toContain('binding-foreign')
    expect(JSON.stringify(result)).not.toContain('remote fetch')
  })
  it('keeps an old connection listed when its saved id no longer matches', async () => {
    const legacy = { ...row({ id: 'binding-legacy', connection_id: 'legacy' }), unresolved: '1' }
    const { provider, request } = transport()
    const result = await readList([legacy], provider)
    expect(request).not.toHaveBeenCalled()
    expect(result).toEqual({
      connection: connection('https://example.invalid/personal-approval-grants'),
      bindings: [projected(legacy, 1, false)],
    })
  })
  it.each([
    ['tenant', () => 'tenant-drift', () => 'org-saved'],
    ['org', () => 'tenant-saved', () => 'org-drift'],
  ] as const)('keeps the management URL but marks drifted %s unusable while the other saved scope matches', async (_scope, tenant, org) => {
    const saved = { ...row(), unresolved: '0' }
    const { provider, request } = transport({ tenant, org })
    const result = await readList([saved], provider)
    expect(request).not.toHaveBeenCalled()
    expect(result).toEqual({
      connection: connection('https://example.invalid/personal-approval-grants'),
      bindings: [projected(saved, 0, false)],
    })
  })
  it('marks an expired saved binding unusable without a personal provider call', async () => {
    const saved = { ...row({ expires_at: new Date('2000-01-01T00:00:00.000Z') }), unresolved: '4' }
    const { provider, request } = transport()
    const result = await readList([saved], provider)
    expect(request).not.toHaveBeenCalled()
    expect(result).toEqual({
      connection: connection('https://example.invalid/personal-approval-grants'),
      bindings: [projected(saved, 4, false)],
    })
  })
  it('marks an unbound saved binding unusable without a personal provider call', async () => {
    const saved = { ...row({ encrypted_grant: null }), unresolved: '3' }
    const { provider, request } = transport()
    const result = await readList([saved], provider)
    expect(request).not.toHaveBeenCalled()
    expect(result).toEqual({
      connection: connection('https://example.invalid/personal-approval-grants'),
      bindings: [projected(saved, 3, false)],
    })
  })
  it('returns cleanup rows when the provider getter, management URL, or effective scope fails', async () => {
    const current = { ...row({ id: 'binding-current' }), unresolved: '2' }
    const legacy = { ...row({ id: 'binding-legacy', connection_id: 'legacy' }), unresolved: '0' }
    const thrown = vi.fn(() => {
      throw new Error('fixture-secret')
    })
    const failed = await readList([current, legacy], thrown)
    expect(thrown).toHaveBeenCalledTimes(1)
    expect(failed).toEqual({
      connection: connection(null),
      bindings: [projected(current, 2, false), projected(legacy, 0, false)],
    })
    expect(JSON.stringify(failed)).not.toContain('fixture-secret')
    const management = transport({
      url: () => {
        throw new Error('fixture-secret')
      },
    })
    const missingUrl = await readList([current], management.provider)
    expect(management.request).not.toHaveBeenCalled()
    expect(missingUrl).toEqual({
      connection: connection(null),
      bindings: [projected(current, 2, false)],
    })
    expect(JSON.stringify(missingUrl)).not.toContain('fixture-secret')
    const missingScope = transport({ tenant: () => undefined })
    const noScope = await readList([current], missingScope.provider)
    expect(missingScope.request).not.toHaveBeenCalled()
    expect(noScope).toEqual({
      connection: connection(null),
      bindings: [projected(current, 2, false)],
    })
    const orgDown = transport({
      org: () => {
        throw new Error('fixture-secret')
      },
    })
    const noOrg = await readList([legacy], orgDown.provider)
    expect(orgDown.request).not.toHaveBeenCalled()
    expect(noOrg).toEqual({
      connection: connection(null),
      bindings: [projected(legacy, 0, false)],
    })
    expect(JSON.stringify(noOrg)).not.toContain('https://example.invalid/personal-approval-grants')
  })
  it('propagates owner, module, list SQL, metadata, and post-await gate failures', async () => {
    const saved = row()
    await withFetch(async (fetchSpy) => {
      enable('fixed')
      const idle = vi.fn(() => {
        throw new Error('provider should stay idle')
      })
      const inactive = pg({ activeUser: false, binding: saved, listed: [{ ...saved, unresolved: '1' }] })
      const svc = new PlmPersonalApprovalBindingService(inactive.pool as never, idle as never)
      await expect(svc.list(owner)).rejects.toMatchObject({ status: 401, message: 'PLM_CARD_UNAUTHORIZED' })
      expect(inactive.calls.map((call) => call.sql)).toEqual(['BEGIN', userSql, 'ROLLBACK'])
      expect(inactive.calls.some((call) => call.sql.includes('AS unresolved'))).toBe(false)
      expect(idle).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
    await withFetch(async (fetchSpy) => {
      vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', '1')
      const idle = vi.fn(() => {
        throw new Error('provider should stay idle')
      })
      const off = pg({ activeUser: true, binding: saved })
      const svc = new PlmPersonalApprovalBindingService(off.pool as never, idle as never)
      await expect(svc.list(owner)).rejects.toThrow()
      expect(off.pool.connect).not.toHaveBeenCalled()
      expect(idle).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
    await withFetch(async (fetchSpy) => {
      enable('fixed')
      const calls: { sql: string; params: unknown[] }[] = []
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          const boundParams = params ?? []
          calls.push({ sql, params: boundParams })
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
          if (sql.includes('FROM users')) return { rows: [{ id: owner }], rowCount: 1 }
          if (sql.includes('AS unresolved')) throw new Error('sql-failure')
          return { rows: [], rowCount: 0 }
        }),
        release: vi.fn(),
      }
      const pool = { connect: vi.fn(async () => client), query: vi.fn() }
      const idle = vi.fn(() => {
        throw new Error('provider should stay idle')
      })
      const svc = new PlmPersonalApprovalBindingService(pool as never, idle as never)
      await expect(svc.list(owner)).rejects.toThrow('sql-failure')
      expect(calls.map((call) => call.sql)).toEqual(['BEGIN', userSql, listSql, 'ROLLBACK'])
      expect(calls[2].params).toEqual([owner])
      expect(calls.some((call) => call.sql === 'COMMIT')).toBe(false)
      expect(idle).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.stringify(calls)).not.toContain('enc:original-secret')
    })
    await withFetch(async (fetchSpy) => {
      enable('fixed')
      const bad = { ...row({ expires_at: new Date(Number.NaN) }), unresolved: '0' }
      const fx = pg({ activeUser: true, binding: null, listed: [bad] })
      const { provider, request } = transport()
      const svc = new PlmPersonalApprovalBindingService(fx.pool as never, provider as never)
      await expect(svc.list(owner)).rejects.toThrow('Invalid time value')
      expect(request).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(fx.calls.some((call) => call.sql === 'ROLLBACK')).toBe(true)
      expect(fx.calls.some((call) => call.sql === 'COMMIT')).toBe(false)
      expect(JSON.stringify(fx.calls)).not.toContain('enc:original-secret')
    })
    await withFetch(async (fetchSpy) => {
      enable('fixed')
      const calls: { sql: string; params: unknown[] }[] = []
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          const boundParams = params ?? []
          calls.push({ sql, params: boundParams })
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
          if (sql.includes('FROM users')) return { rows: [{ id: owner }], rowCount: 1 }
          if (sql.includes('AS unresolved')) {
            vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'false')
            return { rows: [{ ...saved, unresolved: '0' }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
        release: vi.fn(),
      }
      const pool = { connect: vi.fn(async () => client), query: vi.fn() }
      const idle = vi.fn(() => {
        throw new Error('provider should stay idle')
      })
      const svc = new PlmPersonalApprovalBindingService(pool as never, idle as never)
      await expect(svc.list(owner)).rejects.toThrow()
      expect(idle).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(calls.map((call) => call.sql)).toEqual(['BEGIN', userSql, listSql, 'ROLLBACK'])
      expect(calls.some((call) => call.sql === 'COMMIT')).toBe(false)
    })
  })
})
