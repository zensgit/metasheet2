import type { NextFunction, Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rbacGuard, rbacGuardAll, rbacGuardAny } from '../rbac'
import * as rbacService from '../service'

vi.mock('../service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  userHasPermission: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
}))

function createResponse(): Response {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  }
  return response as unknown as Response
}

function createRequest(user?: Express.Request['user']): Request {
  return { user } as Request
}

describe('rbacGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows admin role from the authenticated request user without extra RBAC queries', async () => {
    const guard = rbacGuard('attendance', 'admin')
    const req = createRequest({ id: 'dev-user', role: 'admin', permissions: ['*:*'] })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    await guard(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(rbacService.isAdmin).not.toHaveBeenCalled()
    expect(rbacService.userHasPermission).not.toHaveBeenCalled()
  })

  it('allows wildcard resource permissions from the authenticated request user', async () => {
    const guard = rbacGuard('attendance', 'write')
    const req = createRequest({ id: 'attendance-admin', role: 'user', permissions: ['attendance:*'] })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    await guard(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(rbacService.isAdmin).not.toHaveBeenCalled()
    expect(rbacService.userHasPermission).not.toHaveBeenCalled()
  })

  it('falls back to RBAC tables when the authenticated request user lacks resolved permissions', async () => {
    vi.mocked(rbacService.userHasPermission).mockResolvedValueOnce(true)

    const guard = rbacGuard('attendance', 'admin')
    const req = createRequest({ id: 'db-user', role: 'user', permissions: [] })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    await guard(req, res, next)

    expect(rbacService.isAdmin).toHaveBeenCalledWith('db-user')
    expect(rbacService.userHasPermission).toHaveBeenCalledWith('db-user', 'attendance:admin')
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('rbacGuardAny', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows when any requested permission is already present on req.user', async () => {
    const guard = rbacGuardAny(['attendance:approve', 'attendance:admin'])
    const req = createRequest({ id: 'user-any', role: 'user', permissions: ['attendance:approve'] })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    await guard(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(rbacService.isAdmin).not.toHaveBeenCalled()
    expect(rbacService.userHasPermission).not.toHaveBeenCalled()
  })
})

describe('rbacGuardAll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows when req.user already has a global wildcard permission', async () => {
    const guard = rbacGuardAll(['attendance:read', 'attendance:write', 'attendance:admin'])
    const req = createRequest({ id: 'user-all', role: 'user', permissions: ['*:*'] })
    const res = createResponse()
    const next = vi.fn() as unknown as NextFunction

    await guard(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(rbacService.isAdmin).not.toHaveBeenCalled()
    expect(rbacService.listUserPermissions).not.toHaveBeenCalled()
  })
})
