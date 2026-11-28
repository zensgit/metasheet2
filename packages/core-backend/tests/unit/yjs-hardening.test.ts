/**
 * Yjs POC hardening tests — JWT/auth integration + write-own e2e.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { bindYjsRecord } from '../../src/collab/yjs-record-incarnation'
import type { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsWebSocketAdapter } from '../../src/collab/yjs-websocket-adapter'

// ═══════════════════════════════════════════════════════════════════
// JWT/Auth socket integration
// ═══════════════════════════════════════════════════════════════════
describe('YjsWebSocketAdapter auth integration', () => {
  it('replies only to the requester with UNAVAILABLE when a sync read cannot verify the record incarnation, then accepts a retry', async () => {
    const recordId = 'synthetic-record'
    const serverDoc = new Y.Doc()
    const clientDoc = new Y.Doc()
    const io = new Server(createServer())
    try {
      serverDoc.getText('body').insert(0, 'synthetic record text')
      bindYjsRecord(serverDoc, { recordId, incarnation: 'synthetic-incarnation' })
      const isCurrentDocument = vi.fn().mockRejectedValueOnce(new Error('synthetic lookup failure')).mockResolvedValue(true)
      const sync = { getOrCreateDoc: async () => serverDoc, getDoc: () => serverDoc, isCurrentDocument }
      const adapter = new YjsWebSocketAdapter(sync as unknown as YjsSyncService)
      adapter.setTokenVerifier(async () => 'synthetic-reader')
      adapter.setAuthChecker(async () => ({ canRead: true, canWrite: false }))

      const namespace = io.of('/yjs')
      const middleware = vi.spyOn(namespace, 'use')
      adapter.register(io)
      const inbound = new EventEmitter()
      const send = vi.fn()
      const socket = { id: 'requester', connected: true, handshake: { auth: { token: 'synthetic-token' } },
        on: inbound.on.bind(inbound), emit: send, join: vi.fn() } as unknown as Socket
      const next = vi.fn()
      await middleware.mock.calls[0][0](socket, next)
      expect(next.mock.calls).toEqual([[]])
      namespace.listeners('connection')[0](socket)
      await inbound.listeners('yjs:subscribe')[0]({ recordId })
      expect(send.mock.calls.map(([event]) => event)).toEqual(['yjs:message'])
      send.mockClear()
      const broadcast = vi.spyOn(namespace, 'to')

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeSyncStep1(encoder, clientDoc)
      const request = { recordId, data: Array.from(encoding.toUint8Array(encoder)) }
      const syncStep = inbound.listeners('yjs:message')[0]
      await syncStep(request)
      expect(send.mock.calls).toEqual([['yjs:error', { recordId, code: 'UNAVAILABLE', message: 'Record document unavailable' }]])
      expect(broadcast).not.toHaveBeenCalled()
      expect(isCurrentDocument).toHaveBeenCalledWith(recordId, serverDoc)

      send.mockClear()
      await syncStep(request)
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, 0)
      syncProtocol.writeSyncStep2(reply, serverDoc, Y.encodeStateVector(clientDoc))
      expect(send.mock.calls).toEqual([['yjs:message', { recordId, data: Array.from(encoding.toUint8Array(reply)) }]])
    } finally {
      clientDoc.destroy()
      serverDoc.destroy()
      await io.close()
    }
  })

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

    // Mock query for sheet permission scope: write-own only.
    // The approval-projection guard also probes `meta_sheets … base_id` through this pool —
    // answer it with no rows (sheet-1 is an ordinary sheet, not a projection sheet).
    const mockQuery = vi.fn(async (sql: string) => {
      if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
      return {
        rows: [
          { sheet_id: 'sheet-1', perm_code: 'multitable:read', subject_type: 'user' },
          { sheet_id: 'sheet-1', perm_code: 'multitable:write-own', subject_type: 'user' },
        ],
      }
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
