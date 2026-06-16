import { describe, expect, it } from 'vitest'

import {
  projectPublicFormLayout,
  sanitizeFormLayout,
  sanitizeFormRedirectUrl,
  withFormLayout,
} from '../../src/multitable/form-layout'

// A4 public-form LOGIC layer (multi-page/section · URL-prefill · post-submit
// redirect · thank-you). These are CI-real pure-function tests (no DB) for the
// two security controls — open-redirect rejection and the SAFE form-context
// projection that must never leak publicForm secrets to anonymous callers — plus
// the normalize/round-trip discipline.

describe('sanitizeFormRedirectUrl (open-redirect defense)', () => {
  it('accepts a same-origin relative path', () => {
    expect(sanitizeFormRedirectUrl('/thanks')).toBe('/thanks')
    expect(sanitizeFormRedirectUrl('/thanks?ref=form#section')).toBe('/thanks?ref=form#section')
    expect(sanitizeFormRedirectUrl('  /thanks  ')).toBe('/thanks')
  })

  it('rejects the javascript: scheme (incl. whitespace/tab/case obfuscation)', () => {
    expect(sanitizeFormRedirectUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeFormRedirectUrl('JavaScript:alert(1)')).toBeNull()
    expect(sanitizeFormRedirectUrl('java\tscript:alert(1)')).toBeNull()
    expect(sanitizeFormRedirectUrl('java\nscript:alert(1)')).toBeNull()
    expect(sanitizeFormRedirectUrl(' javascript:alert(1)')).toBeNull()
  })

  it('rejects the data: scheme', () => {
    expect(sanitizeFormRedirectUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects absolute http(s) (cross-origin) URLs', () => {
    expect(sanitizeFormRedirectUrl('https://evil.com/steal')).toBeNull()
    expect(sanitizeFormRedirectUrl('http://evil.com')).toBeNull()
  })

  it('rejects protocol-relative and backslash-obfuscated targets', () => {
    expect(sanitizeFormRedirectUrl('//evil.com')).toBeNull()
    expect(sanitizeFormRedirectUrl('/\\evil.com')).toBeNull()
    expect(sanitizeFormRedirectUrl('\\/\\/evil.com')).toBeNull()
    expect(sanitizeFormRedirectUrl('\\\\evil.com')).toBeNull()
  })

  it('rejects a non-relative path (no leading slash) and non-string input', () => {
    expect(sanitizeFormRedirectUrl('thanks')).toBeNull()
    expect(sanitizeFormRedirectUrl('')).toBeNull()
    expect(sanitizeFormRedirectUrl(null)).toBeNull()
    expect(sanitizeFormRedirectUrl(42)).toBeNull()
  })

  it('rejects a scheme smuggled into the first path segment', () => {
    expect(sanitizeFormRedirectUrl('/a:b/c')).toBeNull()
  })
})

describe('sanitizeFormLayout', () => {
  it('returns null for absent / empty input', () => {
    expect(sanitizeFormLayout(null)).toBeNull()
    expect(sanitizeFormLayout({})).toBeNull()
    expect(sanitizeFormLayout('nope')).toBeNull()
  })

  it('normalizes pages (trim ids, dedup, drop blank/duplicate)', () => {
    const result = sanitizeFormLayout({
      pages: [
        { id: '  p1  ', title: 'Step 1', fieldIds: ['fld_a', 'fld_a', 'fld_b'] },
        { id: 'p1', title: 'dup id dropped', fieldIds: ['fld_c'] },
        { id: '', fieldIds: ['fld_x'] },
        { id: 'p2', description: 'Final', fieldIds: ['  fld_d  ', 42 as unknown as string] },
      ],
    })
    expect(result?.pages).toEqual([
      { id: 'p1', title: 'Step 1', fieldIds: ['fld_a', 'fld_b'] },
      { id: 'p2', description: 'Final', fieldIds: ['fld_d'] },
    ])
  })

  it('normalizes a prefillable allowlist and drops it when empty', () => {
    expect(sanitizeFormLayout({ prefill: { prefillableFieldIds: ['fld_a', 'fld_a', ' fld_b '] } })?.prefill).toEqual({
      prefillableFieldIds: ['fld_a', 'fld_b'],
    })
    expect(sanitizeFormLayout({ prefill: { prefillableFieldIds: [] } })).toBeNull()
  })

  it('keeps a safe redirect and DROPS an unsafe one (rest of layout survives)', () => {
    expect(sanitizeFormLayout({ redirect: { url: '/thanks' } })?.redirect).toEqual({ url: '/thanks' })
    const withUnsafe = sanitizeFormLayout({
      redirect: { url: 'javascript:alert(1)' },
      confirmation: { title: 'Thanks!' },
    })
    expect(withUnsafe?.redirect).toBeUndefined()
    expect(withUnsafe?.confirmation).toEqual({ title: 'Thanks!' })
  })

  it('normalizes confirmation text and drops it when blank', () => {
    expect(sanitizeFormLayout({ confirmation: { title: '  Done  ', body: 'See you' } })?.confirmation).toEqual({
      title: 'Done',
      body: 'See you',
    })
    expect(sanitizeFormLayout({ confirmation: { title: '   ' } })).toBeNull()
  })
})

describe('withFormLayout', () => {
  it('merges a sanitized layout under formLayout, leaving sibling keys intact', () => {
    const config = { publicForm: { publicToken: 'tok', allowedUserIds: ['u1'] } }
    const next = withFormLayout(config, { confirmation: { title: 'Thanks' } })
    expect(next.publicForm).toEqual({ publicToken: 'tok', allowedUserIds: ['u1'] })
    expect(next.formLayout).toEqual({ confirmation: { title: 'Thanks' } })
  })

  it('omits the formLayout key for an empty/invalid candidate (and clears a stale one)', () => {
    expect('formLayout' in withFormLayout({ publicForm: {} }, null)).toBe(false)
    const cleared = withFormLayout({ formLayout: { confirmation: { title: 'old' } }, publicForm: {} }, {})
    expect('formLayout' in cleared).toBe(false)
    expect('publicForm' in cleared).toBe(true)
  })
})

describe('projectPublicFormLayout (SAFE anonymous form-context projection)', () => {
  it('returns ONLY the sanitized formLayout — never publicForm secrets', () => {
    const config = {
      // secrets that must NEVER reach an anonymous caller:
      publicForm: { publicToken: 'super-secret-token', allowedUserIds: ['u1', 'u2'], accessMode: 'dingtalk' },
      // some unrelated future config key:
      frozenLeftColumnIds: ['fld_a'],
      // the A4 layout that IS safe to project:
      formLayout: {
        pages: [{ id: 'p1', title: 'Step 1', fieldIds: ['fld_a'] }],
        prefill: { prefillableFieldIds: ['fld_a'] },
        redirect: { url: '/thanks' },
        confirmation: { title: 'Thanks!', body: 'We got it.' },
      },
    }

    const projected = projectPublicFormLayout(config)
    const serialized = JSON.stringify(projected)

    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain('allowedUserIds')
    expect(serialized).not.toContain('publicForm')
    expect(serialized).not.toContain('frozenLeftColumnIds')

    expect(projected).toEqual({
      pages: [{ id: 'p1', title: 'Step 1', fieldIds: ['fld_a'] }],
      prefill: { prefillableFieldIds: ['fld_a'] },
      redirect: { url: '/thanks' },
      confirmation: { title: 'Thanks!', body: 'We got it.' },
    })
  })

  it('strips an unsafe persisted redirect on the read path too (defense-in-depth)', () => {
    const projected = projectPublicFormLayout({
      formLayout: { redirect: { url: 'https://evil.com' }, confirmation: { title: 'Hi' } },
    })
    expect(projected?.redirect).toBeUndefined()
    expect(projected?.confirmation).toEqual({ title: 'Hi' })
  })

  it('returns null when there is no usable layout (renderer falls back to flat form)', () => {
    expect(projectPublicFormLayout({ publicForm: { publicToken: 'x' } })).toBeNull()
    expect(projectPublicFormLayout(null)).toBeNull()
  })
})
