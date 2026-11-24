/**
 * The administrator diagnostics route behind its real default gate.
 *
 * Nothing of the gate is replaced: the route is built without arguments, so it uses the platform
 * administrator gate the other administrator routes use. Only the role read below that gate is
 * answered from memory. An authenticated caller without administrator access answers 403 before any
 * state is read; an administrator answers 200.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rbac = vi.hoisted(() => ({ isAdmin: vi.fn(async (_userId: string) => false) }))

vi.mock('../../src/rbac/service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAdmin: rbac.isAdmin,
}))

import { decideRealtimeAdmission } from '../../src/realtime-authz/admission'
import { realtimeDiagnostics } from '../../src/realtime-authz/diagnostics'
import { adminRealtimeDiagnosticsRouter } from '../../src/routes/admin-realtime-diagnostics'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

function appFor(user: Record<string, unknown> | null) {
  const app = express()
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: unknown }).user = user
    next()
  })
  // No arguments: the process-wide diagnostics and the default gate.
  app.use('/api/admin/realtime', adminRealtimeDiagnosticsRouter())
  return app
}

beforeEach(() => {
  rbac.isAdmin.mockReset()
  rbac.isAdmin.mockResolvedValue(false)
  realtimeDiagnostics.recordDecision(decideRealtimeAdmission({
    revalidation: 'off',
    credentialChain: 'on',
    facts: { strictScope: { state: 'never-installed' }, enablement: { state: 'never-installed', definedInThisBuild: false } },
    listener: 'not-started',
  }))
})

describe('administrator diagnostics route, default gate', () => {
  it('no authenticated user: 401, and the role read is not reached', async () => {
    pinned.setApp(appFor(null))
    const response = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
    expect(rbac.isAdmin).not.toHaveBeenCalled()
  })

  it('an authenticated user without administrator access: 403, and nothing of the diagnostics is answered', async () => {
    pinned.setApp(appFor({ id: 'member-1', role: 'user', roles: ['user'], permissions: ['multitable:read'] }))
    const response = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
    expect(JSON.stringify(response.body)).not.toMatch(/admission|notices|CREDENTIAL_CHAIN|ENABLEMENT_RECORD/)
    expect(rbac.isAdmin).toHaveBeenCalledWith('member-1')
  })

  it('an administrator by role read: 200 with the admission state and its notices (control)', async () => {
    rbac.isAdmin.mockResolvedValue(true)
    pinned.setApp(appFor({ id: 'admin-1', role: 'user' }))
    const response = await request(pinned.url()).get('/api/admin/realtime/diagnostics')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data.admission.row).toBe('off-baseline')
    expect(response.body.data.notices.filter((notice: { active: boolean }) => notice.active).map((notice: { code: string }) => notice.code))
      .toEqual(['CREDENTIAL_CHAIN_ON_BUT_ENVIRONMENT_NOT_ENABLED', 'ENABLEMENT_RECORD_NOT_READABLE_BY_THIS_BUILD'])
    expect(rbac.isAdmin).toHaveBeenCalledWith('admin-1')
  })
})
