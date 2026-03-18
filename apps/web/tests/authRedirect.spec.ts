import { describe, expect, it } from 'vitest'
import { normalizePostLoginRedirect } from '../src/utils/authRedirect'

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
