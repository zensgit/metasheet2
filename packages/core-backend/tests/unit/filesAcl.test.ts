import { describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { FILES_ANONYMOUS_OWNER_ID, filesAclAllowsAccess, getFilesRequestUserId } from '../../src/services/filesAcl'

// F1 files-acl-tombstone design-lock (2026-07-10): pure-function coverage for the access decision
// used by all four files.ts endpoints (list/info/download/delete). No HTTP/DB harness needed — the
// decision itself takes plain objects.

function reqWithUser(user: Record<string, unknown> | undefined): Request {
  return { user } as unknown as Request
}

describe('filesAcl: getFilesRequestUserId', () => {
  it('prefers id, then userId, then sub', () => {
    expect(getFilesRequestUserId(reqWithUser({ id: 'u1', userId: 'u2', sub: 'u3' }))).toBe('u1')
    expect(getFilesRequestUserId(reqWithUser({ userId: 'u2', sub: 'u3' }))).toBe('u2')
    expect(getFilesRequestUserId(reqWithUser({ sub: 'u3' }))).toBe('u3')
  })

  it('falls back to the anonymous sentinel when no identity claim is present', () => {
    expect(getFilesRequestUserId(reqWithUser({}))).toBe(FILES_ANONYMOUS_OWNER_ID)
    expect(getFilesRequestUserId(reqWithUser(undefined))).toBe(FILES_ANONYMOUS_OWNER_ID)
    expect(getFilesRequestUserId(reqWithUser({ id: '' }))).toBe(FILES_ANONYMOUS_OWNER_ID)
  })

  it('stringifies a numeric id claim (functionally identical after the TEXT-column round-trip)', () => {
    expect(getFilesRequestUserId(reqWithUser({ id: 42 }))).toBe('42')
  })
})

describe('filesAcl: filesAclAllowsAccess', () => {
  it('admin is always allowed, regardless of row state', () => {
    expect(filesAclAllowsAccess({ admin: true, callerId: 'someone', row: null })).toBe(true)
    expect(filesAclAllowsAccess({ admin: true, callerId: 'someone', row: { ownerId: 'other-user' } })).toBe(true)
    expect(filesAclAllowsAccess({ admin: true, callerId: 'someone', row: { ownerId: FILES_ANONYMOUS_OWNER_ID } })).toBe(true)
  })

  it('non-admin with no active row (never existed, or already tombstoned) is denied', () => {
    expect(filesAclAllowsAccess({ admin: false, callerId: 'owner-1', row: null })).toBe(false)
  })

  it('non-admin owner of the row is allowed', () => {
    expect(filesAclAllowsAccess({ admin: false, callerId: 'owner-1', row: { ownerId: 'owner-1' } })).toBe(true)
  })

  it('non-admin caller who is not the row owner is denied (cross-user access)', () => {
    expect(filesAclAllowsAccess({ admin: false, callerId: 'owner-1', row: { ownerId: 'owner-2' } })).toBe(false)
  })

  it('the anonymous sentinel owner is never treated as "the caller owns it", even if callerId also resolved to the sentinel', () => {
    expect(filesAclAllowsAccess({ admin: false, callerId: FILES_ANONYMOUS_OWNER_ID, row: { ownerId: FILES_ANONYMOUS_OWNER_ID } })).toBe(false)
  })

  it('a null ownerId on an existing row (defensive, should not occur in practice) is denied for non-admins', () => {
    expect(filesAclAllowsAccess({ admin: false, callerId: 'owner-1', row: { ownerId: null } })).toBe(false)
  })
})
