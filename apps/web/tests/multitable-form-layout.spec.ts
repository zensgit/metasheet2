import { describe, expect, it } from 'vitest'

import {
  parsePrefillQuery,
  resolveFormPages,
  safeRedirectPath,
} from '../src/multitable/utils/form-layout'
import type { FormLayoutConfig, MetaField } from '../src/multitable/types'

// A4 public-form LOGIC layer — frontend pure resolvers. CI-real (no DB / no
// mount). Covers page grouping + dangling-ref discipline, prefill allowlist
// parsing, and the open-redirect-safe navigation check (defense-in-depth mirror
// of the backend normalizer).

const field = (id: string): MetaField => ({ id, name: id, type: 'string' })

describe('resolveFormPages', () => {
  const fields = [field('fld_a'), field('fld_b'), field('fld_c')]

  it('returns a single implicit page when there is no layout (flat-form backward compat)', () => {
    expect(resolveFormPages(null, fields)).toEqual([{ id: '__default__', fields }])
    expect(resolveFormPages({}, fields)).toEqual([{ id: '__default__', fields }])
  })

  it('groups visible fields into the declared pages in order', () => {
    const layout: FormLayoutConfig = {
      pages: [
        { id: 'p1', title: 'Step 1', fieldIds: ['fld_a'] },
        { id: 'p2', description: 'Final', fieldIds: ['fld_b', 'fld_c'] },
      ],
    }
    const pages = resolveFormPages(layout, fields)
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(pages[0]).toMatchObject({ id: 'p1', title: 'Step 1' })
    expect(pages[0].fields.map((f) => f.id)).toEqual(['fld_a'])
    expect(pages[1]).toMatchObject({ id: 'p2', description: 'Final' })
    expect(pages[1].fields.map((f) => f.id)).toEqual(['fld_b', 'fld_c'])
  })

  it('drops a dangling page reference to a deleted/hidden field', () => {
    const layout: FormLayoutConfig = {
      pages: [{ id: 'p1', fieldIds: ['fld_a', 'fld_gone'] }],
    }
    const pages = resolveFormPages(layout, [field('fld_a')])
    expect(pages[0].fields.map((f) => f.id)).toEqual(['fld_a'])
  })

  it('appends un-paged visible fields to a trailing default page (never vanish)', () => {
    const layout: FormLayoutConfig = {
      pages: [{ id: 'p1', fieldIds: ['fld_a'] }],
    }
    const pages = resolveFormPages(layout, fields)
    expect(pages.map((p) => p.id)).toEqual(['p1', '__default__'])
    expect(pages[1].fields.map((f) => f.id)).toEqual(['fld_b', 'fld_c'])
  })

  it('skips a page that filtered to empty', () => {
    const layout: FormLayoutConfig = {
      pages: [
        { id: 'p1', fieldIds: ['fld_gone'] },
        { id: 'p2', fieldIds: ['fld_a'] },
      ],
    }
    const pages = resolveFormPages(layout, [field('fld_a')])
    expect(pages.map((p) => p.id)).toEqual(['p2'])
  })

  it('assigns a field to the first page that claims it (no duplication)', () => {
    const layout: FormLayoutConfig = {
      pages: [
        { id: 'p1', fieldIds: ['fld_a'] },
        { id: 'p2', fieldIds: ['fld_a', 'fld_b'] },
      ],
    }
    const pages = resolveFormPages(layout, [field('fld_a'), field('fld_b')])
    expect(pages[0].fields.map((f) => f.id)).toEqual(['fld_a'])
    expect(pages[1].fields.map((f) => f.id)).toEqual(['fld_b'])
  })
})

describe('parsePrefillQuery', () => {
  const layout: FormLayoutConfig = { prefill: { prefillableFieldIds: ['fld_a', 'fld_b'] } }

  it('parses allowlisted prefill params', () => {
    const seed = parsePrefillQuery({ prefill_fld_a: 'Alpha', prefill_fld_b: 'Bravo' }, layout)
    expect(seed).toEqual({ fld_a: 'Alpha', fld_b: 'Bravo' })
  })

  it('ignores non-allowlisted and unknown params', () => {
    const seed = parsePrefillQuery(
      { prefill_fld_a: 'Alpha', prefill_fld_secret: 'leak', publicToken: 'tok', other: 'x' },
      layout,
    )
    expect(seed).toEqual({ fld_a: 'Alpha' })
  })

  it('returns empty when there is no allowlist or no query', () => {
    expect(parsePrefillQuery({ prefill_fld_a: 'Alpha' }, null)).toEqual({})
    expect(parsePrefillQuery({ prefill_fld_a: 'Alpha' }, { prefill: { prefillableFieldIds: [] } })).toEqual({})
    expect(parsePrefillQuery(null, layout)).toEqual({})
  })

  it('takes the first value of an array param', () => {
    const seed = parsePrefillQuery({ prefill_fld_a: ['one', 'two'] } as Record<string, unknown>, layout)
    expect(seed).toEqual({ fld_a: 'one' })
  })
})

describe('safeRedirectPath (pre-navigation defense-in-depth)', () => {
  it('accepts a same-origin relative path', () => {
    expect(safeRedirectPath('/thanks')).toBe('/thanks')
    expect(safeRedirectPath('/thanks?ref=1#x')).toBe('/thanks?ref=1#x')
  })

  it('rejects javascript:/data:/cross-origin/protocol-relative/backslash targets', () => {
    expect(safeRedirectPath('javascript:alert(1)')).toBeNull()
    expect(safeRedirectPath('JavaScript:alert(1)')).toBeNull()
    expect(safeRedirectPath('java\tscript:alert(1)')).toBeNull()
    expect(safeRedirectPath('data:text/html,x')).toBeNull()
    expect(safeRedirectPath('https://evil.com')).toBeNull()
    expect(safeRedirectPath('//evil.com')).toBeNull()
    expect(safeRedirectPath('/\\evil.com')).toBeNull()
    expect(safeRedirectPath('thanks')).toBeNull()
    expect(safeRedirectPath(null)).toBeNull()
  })
})
