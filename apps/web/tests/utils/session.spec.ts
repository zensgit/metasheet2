import { describe, expect, it } from 'vitest'
import { parseUserSessionRecord } from '../../src/utils/session'

describe('parseUserSessionRecord', () => {
  it('supports camelCase session payloads', () => {
    const result = parseUserSessionRecord({
      id: 'session-123',
      userId: 'user-001',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
      lastSeenAt: '2026-01-01T12:00:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: 'manual',
      ipAddress: '10.0.0.1',
      userAgent: 'agent/1',
      createdAt: '2025-12-31T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })

    expect(result).toEqual({
      id: 'session-123',
      userId: 'user-001',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
      lastSeenAt: '2026-01-01T12:00:00.000Z',
      revokedAt: null,
      revokedBy: null,
      revokeReason: 'manual',
      ipAddress: '10.0.0.1',
      userAgent: 'agent/1',
      createdAt: '2025-12-31T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
  })

  it('supports snake_case session payloads', () => {
    const result = parseUserSessionRecord({
      id: 'session-456',
      user_id: 'user-002',
      issued_at: '2026-01-02T00:00:00.000Z',
      expires_at: '2026-01-09T00:00:00.000Z',
      last_seen_at: '2026-01-02T12:00:00.000Z',
      revoked_at: null,
      revoked_by: 'operator-2',
      revoke_reason: 'admin-force',
      ip_address: '10.0.0.2',
      user_agent: 'agent/2',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:01.000Z',
    })

    expect(result).toMatchObject({
      id: 'session-456',
      userId: 'user-002',
      issuedAt: '2026-01-02T00:00:00.000Z',
      expiresAt: '2026-01-09T00:00:00.000Z',
      lastSeenAt: '2026-01-02T12:00:00.000Z',
      revokedBy: 'operator-2',
      revokeReason: 'admin-force',
      ipAddress: '10.0.0.2',
      userAgent: 'agent/2',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:01.000Z',
    })
  })

  it('normalizes invalid strings to empty fallback', () => {
    const result = parseUserSessionRecord({
      id: 'session-789',
      userId: 123,
      issuedAt: 1,
      expiresAt: undefined,
      lastSeenAt: null,
      revokedAt: 5,
      revokedBy: false,
      revokeReason: {},
      ipAddress: [],
      userAgent: '',
      createdAt: '',
      updatedAt: 0,
    })

    expect(result).toEqual({
      id: 'session-789',
      userId: '',
      issuedAt: '',
      expiresAt: '',
      lastSeenAt: '',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      ipAddress: null,
      userAgent: null,
      createdAt: '',
      updatedAt: '',
    })
  })

  it('returns null for non-object input', () => {
    expect(parseUserSessionRecord(null)).toBeNull()
    expect(parseUserSessionRecord('abc')).toBeNull()
    expect(parseUserSessionRecord(123)).toBeNull()
  })

  it('returns null when id is empty', () => {
    expect(parseUserSessionRecord({ id: 0, issuedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
    expect(parseUserSessionRecord({ userId: 'user-1' })).toBeNull()
  })

  it('returns null when id is only whitespace', () => {
    expect(parseUserSessionRecord({ id: '   ', issuedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })
})
