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
  function pg(options: { activeUser: boolean; binding: ReturnType<typeof row> | null }) {
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
})
