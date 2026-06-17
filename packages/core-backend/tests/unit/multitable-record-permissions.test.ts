/**
 * Unit tests for record-level permission derivation — tests the real exported functions.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveRecordPermissions,
  type RecordPermissionScope,
} from '../../src/multitable/permission-derivation'

describe('deriveRecordPermissions', () => {
  const baseCaps = { canRead: true, canEditRecord: true }

  it('falls back to global caps when no scope map', () => {
    const result = deriveRecordPermissions('r1', baseCaps)
    expect(result).toEqual({ canRead: true, canEdit: true, canDelete: true })
  })

  it('falls back to global caps when record has no entry in scope map', () => {
    const scopeMap = new Map<string, RecordPermissionScope>()
    const result = deriveRecordPermissions('r1', baseCaps, scopeMap)
    expect(result).toEqual({ canRead: true, canEdit: true, canDelete: true })
  })

  it('grants read-only access for read scope', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'read' as const }],
    ])
    const result = deriveRecordPermissions('r1', baseCaps, scopeMap)
    expect(result.canRead).toBe(true)
    expect(result.canEdit).toBe(false)
    expect(result.canDelete).toBe(false)
  })

  it('grants read+edit for write scope', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'write' as const }],
    ])
    const result = deriveRecordPermissions('r1', baseCaps, scopeMap)
    expect(result.canRead).toBe(true)
    expect(result.canEdit).toBe(true)
    expect(result.canDelete).toBe(false)
  })

  it('grants full access for admin scope', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'admin' as const }],
    ])
    const result = deriveRecordPermissions('r1', baseCaps, scopeMap)
    expect(result.canRead).toBe(true)
    expect(result.canEdit).toBe(true)
    expect(result.canDelete).toBe(true)
  })

  it('does not escalate beyond base capabilities — canRead=false', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'admin' as const }],
    ])
    const result = deriveRecordPermissions('r1', { canRead: false, canEditRecord: true }, scopeMap)
    expect(result.canRead).toBe(false)
    expect(result.canEdit).toBe(true)
    expect(result.canDelete).toBe(true)
  })

  it('does not escalate beyond base capabilities — canEditRecord=false', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'admin' as const }],
    ])
    const result = deriveRecordPermissions('r1', { canRead: true, canEditRecord: false }, scopeMap)
    expect(result.canRead).toBe(true)
    expect(result.canEdit).toBe(false)
    expect(result.canDelete).toBe(false)
  })

  it('handles mixed records — some scoped, some unscoped', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'read' as const }],
    ])
    const r1 = deriveRecordPermissions('r1', baseCaps, scopeMap)
    const r2 = deriveRecordPermissions('r2', baseCaps, scopeMap)
    expect(r1.canEdit).toBe(false) // scoped to read
    expect(r2.canEdit).toBe(true) // no assignment -> fallback to global
  })

  it('admin bypass: falls back to global caps when no scope entry exists', () => {
    // Admin users typically have canRead=true and canEditRecord=true;
    // with no scope entry the function returns full global caps.
    const adminCaps = { canRead: true, canEditRecord: true }
    const scopeMap = new Map<string, RecordPermissionScope>()
    const result = deriveRecordPermissions('r1', adminCaps, scopeMap)
    expect(result).toEqual({ canRead: true, canEdit: true, canDelete: true })
  })

  it('creator-owns-record: record with no scope grants global caps', () => {
    // When a creator has no record-level scope, they fall back to global capabilities
    // which is the same as the sheet-level "own-write" policy handling.
    const scopeMap = new Map([
      ['r2', { recordId: 'r2', accessLevel: 'read' as const }],
    ])
    // r1 has no scope entry — creator should still have global access
    const result = deriveRecordPermissions('r1', baseCaps, scopeMap)
    expect(result.canRead).toBe(true)
    expect(result.canEdit).toBe(true)
    expect(result.canDelete).toBe(true)
  })

  it('denies all when both base caps are false regardless of scope', () => {
    const scopeMap = new Map([
      ['r1', { recordId: 'r1', accessLevel: 'admin' as const }],
    ])
    const result = deriveRecordPermissions('r1', { canRead: false, canEditRecord: false }, scopeMap)
    expect(result.canRead).toBe(false)
    expect(result.canEdit).toBe(false)
    expect(result.canDelete).toBe(false)
  })
})

describe('deriveRecordPermissions — #18 read-deny foundation (flag-gated none)', () => {
  const caps = { canRead: true, canEditRecord: true }
  const noneScope = () => new Map([['r1', { recordId: 'r1', accessLevel: 'none' as const }]])

  it('none scope is INERT when the flag is off (default) — grant-additive, reads per sheet', () => {
    const r = deriveRecordPermissions('r1', caps, noneScope())
    expect(r.canRead).toBe(true)
    expect(r.canEdit).toBe(false)
    expect(r.canDelete).toBe(false)
  })

  it('none scope DENIES read only when the flag is on', () => {
    const r = deriveRecordPermissions('r1', caps, noneScope(), true)
    expect(r.canRead).toBe(false)
    expect(r.canEdit).toBe(false)
    expect(r.canDelete).toBe(false)
  })

  it('read/write/admin scopes are grant-additive — flag never reduces their read', () => {
    for (const lvl of ['read', 'write', 'admin'] as const) {
      const m = new Map([['r1', { recordId: 'r1', accessLevel: lvl }]])
      expect(deriveRecordPermissions('r1', caps, m, true).canRead).toBe(true)
      expect(deriveRecordPermissions('r1', caps, m, false).canRead).toBe(true)
    }
  })

  it('flag-on does not deny an UNMAPPED record (no scope) — #2754 canary stays additive', () => {
    expect(deriveRecordPermissions('r2', caps, noneScope(), true).canRead).toBe(true)
  })
})
