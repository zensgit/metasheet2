import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createAuditLogMock, publishMock } = vi.hoisted(() => ({
  createAuditLogMock: vi.fn(),
  publishMock: vi.fn(),
}))

vi.mock('../../src/audit/AuditRepository', () => ({
  AuditRepository: class {
    createAuditLog = createAuditLogMock
  },
}))

vi.mock('../../src/integration/messaging/message-bus', () => ({
  messageBus: {
    publish: publishMock,
  },
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    warn = vi.fn()
    info = vi.fn()
    error = vi.fn()
    debug = vi.fn()
  },
}))

import { AuditRepository, type AuditLogData } from '../../src/audit/AuditRepository'
import { AuditService, type AuditMessageEvent } from '../../src/audit/AuditService'

const UUID = '26979f88-e7cc-4b40-a975-a0353d19aec0'

function published(index: number): AuditMessageEvent {
  return publishMock.mock.calls[index][1] as AuditMessageEvent
}

describe('AuditService who envelope', () => {
  let service: AuditService

  beforeEach(() => {
    createAuditLogMock.mockReset()
    publishMock.mockReset()
    service = new AuditService(new AuditRepository())
  })

  it.each([
    ['uuid', UUID, undefined, UUID],
    ['untrimmed', `  ${UUID}  `, undefined, `  ${UUID}  `],
    ['42', '42', 42, '42'],
    ['042', '042', 42, '042'],
    ['0', '0', 0, '0'],
  ] as const)('publishes typed user %s', async (_label, actorId, userId, whoId) => {
    const actionDetails = { actorId: 'spoof', actorType: 'plugin' }
    await service.logEvent('GRANT', 'grant', { userId, actorId, actorType: 'user', actionDetails })
    const event = published(0)
    expect(event.who.userId).toBe(userId)
    expect(event.who.actorType).toBe('user')
    expect(event.who.actorId).toBe(whoId)
    expect(event.what.details).toBe(actionDetails)
  })

  it.each([
    ['direct42', { userId: 42 }, 42, 'user', '42'],
    ['system', {}, undefined, 'system', 'system'],
    ['direct0', { userId: 0 }, 0, 'system', '0'],
  ] as const)('keeps legacy %s fallback', async (_label, details, userId, actorType, actorId) => {
    await service.logEvent('GRANT', 'grant', details)
    const event = published(0)
    expect(event.who.userId).toBe(userId)
    expect(event.who.actorType).toBe(actorType)
    expect(event.who.actorId).toBe(actorId)
  })

  it.each([
    ['plugin', { actorType: 'plugin', actorId: 'plug-1' }, undefined, 'system', 'system'],
    ['service', { actorType: 'service', actorId: 'svc-1' }, undefined, 'system', 'system'],
    ['named-system', { actorType: 'system', actorId: 'named-system' }, undefined, 'system', 'system'],
    ['empty', { actorType: 'user', actorId: '' }, undefined, 'system', 'system'],
    ['blank', { actorType: 'user', actorId: '   ' }, undefined, 'system', 'system'],
    ['blank0', { actorType: 'user', actorId: '   ', userId: 0 }, 0, 'system', '0'],
    ['missing-type', { actorId: UUID }, undefined, 'system', 'system'],
  ] as const)('falls back for invalid typed %s', async (_label, details, userId, actorType, actorId) => {
    await service.logEvent('GRANT', 'grant', details as Partial<AuditLogData>)
    const event = published(0)
    expect(event.who.userId).toBe(userId)
    expect(event.who.actorType).toBe(actorType)
    expect(event.who.actorId).toBe(actorId)
  })

  it('walks context 99, explicit uuid, context 99, then system after clearContext', async () => {
    const spoof = { actorId: 'spoof', actorType: 'user' }
    service.setContext({ userId: 99, userName: 'context-user', userEmail: 'ctx@example.com' })
    await service.logEvent('GRANT', 'grant', {
      userId: undefined,
      actorId: UUID,
      actorType: 'user',
      actionDetails: spoof,
    })
    await service.logEvent('READ', 'read', {})
    service.clearContext()
    await service.logEvent('REVOKE', 'revoke', {})

    const first = published(0)
    const second = published(1)
    const third = published(2)
    expect(first.who.userId).toBeUndefined()
    expect(first.who.actorType).toBe('user')
    expect(first.who.actorId).toBe(UUID)
    expect(first.who.userName).toBe('context-user')
    expect(first.what.details).toBe(spoof)
    expect(second.who.userId).toBe(99)
    expect(second.who.actorType).toBe('user')
    expect(second.who.actorId).toBe('99')
    expect(second.who.userName).toBe('context-user')
    expect(second.who.userEmail).toBe('ctx@example.com')
    expect(third.who.userId).toBeUndefined()
    expect(third.who.userName).toBeUndefined()
    expect(third.who.actorType).toBe('system')
    expect(third.who.actorId).toBe('system')
    expect(spoof).toEqual({ actorId: 'spoof', actorType: 'user' })
  })

  it('stays system when only actionDetails carries an actor', async () => {
    const actionDetails = { actorId: 'spoof-user', actorType: 'user' }
    await service.logEvent('GRANT', 'grant', { actionDetails })
    const event = published(0)
    expect(event.who.userId).toBeUndefined()
    expect(event.who.actorType).toBe('system')
    expect(event.who.actorId).toBe('system')
    expect(event.what.details).toBe(actionDetails)
  })

  it('publishes nothing when the message bus is disabled', async () => {
    const quiet = new AuditService(new AuditRepository(), { enableMessageBus: false })
    await quiet.logEvent('GRANT', 'grant', { actorId: UUID, actorType: 'user' })
    expect(createAuditLogMock).toHaveBeenCalledTimes(1)
    expect(publishMock).not.toHaveBeenCalled()
  })
})
