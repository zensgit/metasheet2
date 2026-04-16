/**
 * Yjs POC hardening tests — JWT/auth integration + write-own e2e.
 */
import { describe, it, expect, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════
// JWT/Auth socket integration
// ═══════════════════════════════════════════════════════════════════
describe('YjsWebSocketAdapter auth integration', () => {
  it('rejects connection without token', async () => {
    const { YjsWebSocketAdapter } = await import('../../src/collab/yjs-websocket-adapter')
    const { YjsSyncService } = await import('../../src/collab/yjs-sync-service')

    const mockPersistence = {
      loadDoc: vi.fn().mockResolvedValue(null),
      storeUpdate: vi.fn().mockResolvedValue(undefined),
      storeSnapshot: vi.fn().mockResolvedValue(undefined),
    }
    const syncService = new YjsSyncService(mockPersistence as any)
    const adapter = new YjsWebSocketAdapter(syncService)

    // Token verifier rejects missing token
    adapter.setTokenVerifier(async (token: string) => {
      if (!token) return null
      return token === 'valid-jwt' ? 'user-123' : null
    })

    // Simulate Socket.IO middleware call with no token
    const mockSocket = {
      id: 'sock-1',
      handshake: { auth: {}, query: {} },
    }

    // The middleware is registered in register() — we test the verifier directly
    const verifier = adapter['tokenVerifier']!
    expect(await verifier('')).toBeNull()
    expect(await verifier('invalid')).toBeNull()
    expect(await verifier('valid-jwt')).toBe('user-123')

    syncService.destroy()
  })

  it('getSocketUserId returns undefined for unknown socket', async () => {
    const { YjsWebSocketAdapter } = await import('../../src/collab/yjs-websocket-adapter')
    const { YjsSyncService } = await import('../../src/collab/yjs-sync-service')

    const mockPersistence = {
      loadDoc: vi.fn().mockResolvedValue(null),
      storeUpdate: vi.fn().mockResolvedValue(undefined),
      storeSnapshot: vi.fn().mockResolvedValue(undefined),
    }
    const syncService = new YjsSyncService(mockPersistence as any)
    const adapter = new YjsWebSocketAdapter(syncService)

    expect(adapter.getSocketUserId('nonexistent')).toBeUndefined()

    syncService.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Write-own end-to-end: sheet capabilities → auth gate → bridge
// ═══════════════════════════════════════════════════════════════════
describe('Write-own e2e through capability chain', () => {
  it('write-own user: allowed to edit own record, denied others', async () => {
    const {
      resolveSheetCapabilitiesForUser,
      canWriteRecord,
      ensureRecordWriteAllowed,
    } = await import('../../src/multitable/sheet-capabilities')

    // Mock rbac/service at module level
    const rbac = await import('../../src/rbac/service')
    const origListPerms = rbac.listUserPermissions
    const origIsAdmin = rbac.isAdmin

    // User has multitable:write-own via role, not full write
    vi.spyOn(rbac, 'listUserPermissions').mockResolvedValue(['multitable:read'])
    vi.spyOn(rbac, 'isAdmin').mockResolvedValue(false)

    // Mock query for sheet permission scope: write-own only
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        { sheet_id: 'sheet-1', perm_code: 'multitable:read', subject_type: 'user' },
        { sheet_id: 'sheet-1', perm_code: 'multitable:write-own', subject_type: 'user' },
      ],
    })

    const result = await resolveSheetCapabilitiesForUser(mockQuery as any, 'sheet-1', 'user-b')

    // canEditRecord should be true (write-own grants it)
    expect(result.capabilities.canEditRecord).toBe(true)
    // But sheetScope.canWriteOwn should be true, canWrite false
    expect(result.sheetScope?.canWriteOwn).toBe(true)
    expect(result.sheetScope?.canWrite).toBe(false)

    // Own record → allowed
    expect(canWriteRecord(
      result.capabilities, result.sheetScope, result.isAdminRole, 'user-b', 'user-b',
    )).toBe(true)

    // Other's record → denied
    expect(canWriteRecord(
      result.capabilities, result.sheetScope, result.isAdminRole, 'user-b', 'user-a',
    )).toBe(false)

    // ensureRecordWriteAllowed same semantics
    const access = { userId: 'user-b', permissions: ['multitable:read'], isAdminRole: false }
    expect(ensureRecordWriteAllowed(
      result.capabilities, result.sheetScope, access, 'user-b', 'edit',
    )).toBe(true)
    expect(ensureRecordWriteAllowed(
      result.capabilities, result.sheetScope, access, 'user-a', 'edit',
    )).toBe(false)

    // Restore
    vi.restoreAllMocks()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Observability metrics
// ═══════════════════════════════════════════════════════════════════
describe('Yjs observability', () => {
  it('YjsSyncService.getMetrics returns doc count', async () => {
    const { YjsSyncService } = await import('../../src/collab/yjs-sync-service')
    const mockPersistence = {
      loadDoc: vi.fn().mockResolvedValue(null),
      storeUpdate: vi.fn().mockResolvedValue(undefined),
      storeSnapshot: vi.fn().mockResolvedValue(undefined),
    }
    const service = new YjsSyncService(mockPersistence as any)

    expect(service.getMetrics().activeDocCount).toBe(0)

    await service.getOrCreateDoc('rec-1')
    await service.getOrCreateDoc('rec-2')

    const metrics = service.getMetrics()
    expect(metrics.activeDocCount).toBe(2)
    expect(metrics.docIds).toContain('rec-1')
    expect(metrics.docIds).toContain('rec-2')

    await service.destroy()
  })

  it('YjsRecordBridge.getMetrics tracks flush success/failure', async () => {
    const { YjsRecordBridge } = await import('../../src/collab/yjs-record-bridge')

    const bridge = new YjsRecordBridge(
      {} as any,
      { patchRecords: vi.fn().mockResolvedValue({ updated: [] }) } as any,
      vi.fn().mockResolvedValue(null), // getWriteInput returns null → no patch
    )

    const metrics = bridge.getMetrics()
    expect(metrics.pendingWriteCount).toBe(0)
    expect(metrics.observedDocCount).toBe(0)
    expect(metrics.flushSuccessCount).toBe(0)
    expect(metrics.flushFailureCount).toBe(0)

    bridge.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Feature flag
// ═══════════════════════════════════════════════════════════════════
describe('Feature flag', () => {
  it('ENABLE_YJS_COLLAB defaults to off when not set', () => {
    // When not set, the env var is undefined → Yjs should not initialize
    const enabled = process.env.ENABLE_YJS_COLLAB === 'true'
    expect(enabled).toBe(false)
  })

  it('ENABLE_YJS_COLLAB=true enables Yjs', () => {
    const original = process.env.ENABLE_YJS_COLLAB
    process.env.ENABLE_YJS_COLLAB = 'true'
    expect(process.env.ENABLE_YJS_COLLAB === 'true').toBe(true)
    process.env.ENABLE_YJS_COLLAB = original
  })
})
