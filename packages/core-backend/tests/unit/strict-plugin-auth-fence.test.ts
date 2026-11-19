import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authService, type User } from '../../src/auth/AuthService'
import { MetaSheetServer, coreBackendIsDirectEntry } from '../../src/index'
import type { CoreAPI, TokenOptions, UserInfo } from '../../src/types/plugin'

const receiver = Object.create(MetaSheetServer.prototype) as {
  createCoreAPI(): CoreAPI
}
const pluginAuth = receiver.createCoreAPI().auth

const strictRows: Array<{
  name: string
  token: string
  payload: { sid: string; userId: string; xa?: boolean }
}> = [
  {
    name: 'strict xs and own xa',
    token: 'token-strict',
    payload: { sid: 'xs.1', xa: true, userId: 'user-1' },
  },
  {
    name: 'xs without xa',
    token: 'token-xs-only',
    payload: { sid: 'xs.1', userId: 'user-1' },
  },
  {
    name: 'xa without xs',
    token: 'token-xa-only',
    payload: { sid: 'sid-1', xa: true, userId: 'user-1' },
  },
  {
    name: 'own xa false',
    token: 'token-xa-false',
    payload: { sid: 'sid-1', xa: false, userId: 'user-1' },
  },
]

function decoded(
  payload: { sid: string; userId: string; xa?: boolean },
): NonNullable<ReturnType<typeof authService.readTokenPayload>> {
  return payload as NonNullable<ReturnType<typeof authService.readTokenPayload>>
}

function acceptedUser(id: string): User {
  return { id } as User
}

function converted(fields: {
  id: string
  email: string
  name: string
  role: string
  permissions: string[]
}) {
  return {
    id: fields.id,
    email: fields.email,
    name: fields.name,
    role: fields.role,
    permissions: fields.permissions,
    created_at: expect.any(Date),
    updated_at: expect.any(Date),
  }
}

const populated: UserInfo = {
  id: 'user-1',
  email: 'ada@example.com',
  name: 'Ada',
  roles: ['admin', 'auditor'],
  permissions: ['sheet:read'],
  metadata: { sid: 'xs.injected', xa: true },
}

beforeEach(() => {
  vi.spyOn(authService, 'readTokenPayload')
  vi.spyOn(authService, 'verifyToken')
  vi.spyOn(authService, 'createToken')
  vi.spyOn(authService, 'checkPermission')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('strict plugin auth fence', () => {
  it('imports index without taking the direct entry', () => {
    expect(coreBackendIsDirectEntry).toBe(false)
  })

  it.each(strictRows)(
    '$name returns null and does not call the accepting delegate',
    async ({ token, payload }) => {
      const accepted = acceptedUser('accepted-user')
      vi.mocked(authService.readTokenPayload).mockReturnValue(decoded(payload))
      vi.mocked(authService.verifyToken).mockResolvedValue(accepted)

      await expect(pluginAuth.verifyToken(token)).resolves.toBeNull()

      expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledWith(token)
      expect(vi.mocked(authService.verifyToken)).not.toHaveBeenCalled()
    },
  )

  it('returns the ordinary delegate reference after reading the payload', async () => {
    const sentinel = acceptedUser('ordinary-sentinel')
    vi.mocked(authService.readTokenPayload).mockReturnValue(
      decoded({ sid: 'sid-1', userId: 'user-1' }),
    )
    vi.mocked(authService.verifyToken).mockResolvedValue(sentinel)

    await expect(pluginAuth.verifyToken('token-ordinary')).resolves.toBe(sentinel)

    expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledWith('token-ordinary')
    expect(vi.mocked(authService.verifyToken)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authService.verifyToken)).toHaveBeenCalledWith('token-ordinary')
    expect(vi.mocked(authService.readTokenPayload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authService.verifyToken).mock.invocationCallOrder[0],
    )
  })

  it('delegates a null payload and returns the delegate null', async () => {
    vi.mocked(authService.readTokenPayload).mockReturnValue(null)
    vi.mocked(authService.verifyToken).mockResolvedValue(null)

    await expect(pluginAuth.verifyToken('token-invalid')).resolves.toBeNull()

    expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authService.readTokenPayload)).toHaveBeenCalledWith('token-invalid')
    expect(vi.mocked(authService.verifyToken)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authService.verifyToken)).toHaveBeenCalledWith('token-invalid')
    expect(vi.mocked(authService.readTokenPayload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(authService.verifyToken).mock.invocationCallOrder[0],
    )
  })

  it('converts a sparse plugin user and ignores ordinary token options', () => {
    vi.mocked(authService.createToken).mockReturnValue('sentinel-token')

    expect(
      pluginAuth.createToken({ id: 'user-blank' }, { expiresIn: '1h', issuer: 'plugin' }),
    ).toBe('sentinel-token')

    expect(vi.mocked(authService.createToken)).toHaveBeenCalledTimes(1)
    const [user, options] = vi.mocked(authService.createToken).mock.calls[0]
    expect(user).toEqual(converted({
      id: 'user-blank',
      email: '',
      name: '',
      role: 'user',
      permissions: [],
    }))
    expect(options).toEqual({ externalAuth: false })
    expect(user).not.toHaveProperty('sid')
    expect(user).not.toHaveProperty('xa')
    expect(options).not.toHaveProperty('sid')
    expect(options).not.toHaveProperty('xa')
  })

  it('ignores an injected strict mint on plugin options', () => {
    vi.mocked(authService.createToken).mockReturnValue('sentinel-token')
    const injected = { sid: 'xs.injected', externalAuth: true } as TokenOptions

    expect(pluginAuth.createToken(populated, injected)).toBe('sentinel-token')

    expect(vi.mocked(authService.createToken)).toHaveBeenCalledTimes(1)
    const [user, options] = vi.mocked(authService.createToken).mock.calls[0]
    expect(user).toEqual(converted({
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
      permissions: ['sheet:read'],
    }))
    expect(options).toEqual({ externalAuth: false })
    expect(user).not.toHaveProperty('sid')
    expect(user).not.toHaveProperty('xa')
    expect(user).not.toHaveProperty('metadata')
    expect(options).not.toHaveProperty('sid')
    expect(options).not.toHaveProperty('xa')
  })

  it('forwards the same user conversion from checkPermission', () => {
    vi.mocked(authService.checkPermission).mockReturnValue(false)

    expect(pluginAuth.checkPermission(populated, 'sheet', 'read')).toBe(false)

    expect(vi.mocked(authService.checkPermission)).toHaveBeenCalledTimes(1)
    const [user, resource, action] = vi.mocked(authService.checkPermission).mock.calls[0]
    expect(user).toEqual(converted({
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
      permissions: ['sheet:read'],
    }))
    expect(resource).toBe('sheet')
    expect(action).toBe('read')
    expect(user).not.toHaveProperty('sid')
    expect(user).not.toHaveProperty('xa')
    expect(user).not.toHaveProperty('metadata')
  })
})
