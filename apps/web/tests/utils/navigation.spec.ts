import { describe, expect, it } from 'vitest'
import { resolvePostLoginRedirect } from '../../src/utils/navigation'

describe('resolvePostLoginRedirect', () => {
  it('returns the fallback path for empty or root redirects', () => {
    expect(resolvePostLoginRedirect(undefined, '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('', '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('   ', '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('/', '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('/login', '/attendance')).toBe('/attendance')
  })

  it('keeps valid internal redirects', () => {
    expect(resolvePostLoginRedirect('/settings', '/attendance')).toBe('/settings')
    expect(resolvePostLoginRedirect('/attendance?tab=me', '/grid')).toBe('/attendance?tab=me')
  })

  it('rejects external and protocol-relative redirects', () => {
    expect(resolvePostLoginRedirect('https://example.com', '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('//evil.test/path', '/attendance')).toBe('/attendance')
    expect(resolvePostLoginRedirect('login', '/attendance')).toBe('/attendance')
  })
})
