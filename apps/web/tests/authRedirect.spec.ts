import { describe, expect, it } from 'vitest'
import { normalizePostLoginRedirect, normalizePreLoginRedirect } from '../src/utils/authRedirect'

describe('normalizePostLoginRedirect', () => {
  it('drops root and login redirects so login can go straight to the resolved home path', () => {
    expect(normalizePostLoginRedirect('/')).toBeNull()
    expect(normalizePostLoginRedirect('/login')).toBeNull()
    expect(normalizePostLoginRedirect('/login?redirect=%2Fattendance')).toBeNull()
  })

  it('keeps safe in-app paths and rejects unsafe values', () => {
    expect(normalizePostLoginRedirect('/attendance')).toBe('/attendance')
    expect(normalizePostLoginRedirect('/plm?tab=bom')).toBe('/plm?tab=bom')
    expect(normalizePostLoginRedirect('https://example.com')).toBeNull()
    expect(normalizePostLoginRedirect('//example.com')).toBeNull()
  })
})

describe('normalizePreLoginRedirect', () => {
  it('redirects root and login paths to the attendance home target', () => {
    expect(normalizePreLoginRedirect('/')).toBe('/attendance')
    expect(normalizePreLoginRedirect('/login')).toBe('/attendance')
    expect(normalizePreLoginRedirect('/login?redirect=%2Fattendance')).toBe('/attendance')
  })

  it('keeps safe in-app paths and falls back for unsafe values', () => {
    expect(normalizePreLoginRedirect('/attendance')).toBe('/attendance')
    expect(normalizePreLoginRedirect('/plm?tab=bom')).toBe('/plm?tab=bom')
    expect(normalizePreLoginRedirect('https://example.com')).toBe('/attendance')
    expect(normalizePreLoginRedirect('//example.com')).toBe('/attendance')
  })
})
