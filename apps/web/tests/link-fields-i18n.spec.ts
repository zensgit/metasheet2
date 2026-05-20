import { describe, it, expect } from 'vitest'
import { linkActionLabel } from '../src/multitable/utils/link-fields'
import type { MetaField } from '../src/multitable/types'

const personField: MetaField = { id: 'owner', name: 'Owner', type: 'person' as MetaField['type'] }
const recordField: MetaField = { id: 'parent', name: 'Parent', type: 'link' as MetaField['type'] }

describe('linkActionLabel — backwards compatibility (isZh default = false)', () => {
  it('defaults to English when no isZh arg is passed — MetaCellEditor / MetaImportModal stay unchanged', () => {
    // record branch (the T3A2 unreachable-fallback case + MetaImportModal)
    expect(linkActionLabel(recordField, 0)).toBe('Choose linked records...')
    expect(linkActionLabel(recordField, 1)).toBe('Edit linked record (1)')
    expect(linkActionLabel(recordField, 5)).toBe('Edit linked records (5)')
    // person branch
    expect(linkActionLabel(personField, 0)).toBe('Choose people...')
    expect(linkActionLabel(personField, 1)).toBe('Edit person (1)')
    expect(linkActionLabel(personField, 3)).toBe('Edit people (3)')
  })

  it('explicit isZh=false equals the legacy default (regression guard)', () => {
    expect(linkActionLabel(recordField, 0, false)).toBe('Choose linked records...')
    expect(linkActionLabel(recordField, 1, false)).toBe('Edit linked record (1)')
    expect(linkActionLabel(personField, 1, false)).toBe('Edit person (1)')
    expect(linkActionLabel(personField, 4, false)).toBe('Edit people (4)')
  })

  it('treats null/undefined as the record branch (no person classification)', () => {
    expect(linkActionLabel(null, 0)).toBe('Choose linked records...')
    expect(linkActionLabel(undefined, 0)).toBe('Choose linked records...')
    expect(linkActionLabel(null, 2)).toBe('Edit linked records (2)')
  })
})

describe('linkActionLabel — zh forms (T3B1 opt-in)', () => {
  it('record branch zh covers count 0/1/N (MD §6, all collapse to 关联记录)', () => {
    expect(linkActionLabel(recordField, 0, true)).toBe('选择关联记录...')
    expect(linkActionLabel(recordField, 1, true)).toBe('编辑关联记录 (1)')
    expect(linkActionLabel(recordField, 7, true)).toBe('编辑关联记录 (7)')
  })

  it('person branch zh covers count 0/1/N (MD §6, all collapse to 人员)', () => {
    expect(linkActionLabel(personField, 0, true)).toBe('选择人员...')
    expect(linkActionLabel(personField, 1, true)).toBe('编辑人员 (1)')
    expect(linkActionLabel(personField, 9, true)).toBe('编辑人员 (9)')
  })

  it('zh has no singular/plural distinction — count=1 and count=N share the same entity word', () => {
    // EN has different nouns by count; zh keeps the same noun.
    expect(linkActionLabel(recordField, 1, false)).toBe('Edit linked record (1)')
    expect(linkActionLabel(recordField, 2, false)).toBe('Edit linked records (2)')
    expect(linkActionLabel(recordField, 1, true)).toBe('编辑关联记录 (1)')
    expect(linkActionLabel(recordField, 2, true)).toBe('编辑关联记录 (2)')
  })

  it('null/undefined field with zh still maps to the record branch', () => {
    expect(linkActionLabel(null, 0, true)).toBe('选择关联记录...')
    expect(linkActionLabel(undefined, 3, true)).toBe('编辑关联记录 (3)')
  })
})
