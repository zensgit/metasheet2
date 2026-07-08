/**
 * G-B2-17 — matrix unit tests for the requester template gallery's pure filter function.
 * See docs/research/approval-automation-operation-ux-benchmark-20260704.md line 87.
 *
 * Intentionally does NOT mount TemplateCenterView.vue — the filter logic is pure and
 * independently testable, per the design lock's "no big component test for pure logic" rule.
 */
import { describe, expect, it } from 'vitest'
import { filterGalleryTemplates, type GalleryFilterableTemplate } from '../src/approvals/templateGalleryFilter'

function tpl(overrides: Partial<GalleryFilterableTemplate>): GalleryFilterableTemplate {
  return {
    name: '模板',
    description: null,
    category: null,
    ...overrides,
  }
}

describe('approvals/templateGalleryFilter', () => {
  const fixtures: GalleryFilterableTemplate[] = [
    tpl({ name: '出差申请', description: '因公出差报销申请', category: '差旅' }),
    tpl({ name: '采购申请', description: '办公用品采购', category: '采购' }),
    tpl({ name: '请假申请', description: null, category: '请假' }),
    tpl({ name: '其他申请', description: '未归类的通用申请', category: null }),
  ]

  it('both filters empty → returns the full list unchanged', () => {
    const result = filterGalleryTemplates(fixtures, {})
    expect(result).toEqual(fixtures)
  })

  it('no options argument at all → also returns the full list', () => {
    const result = filterGalleryTemplates(fixtures)
    expect(result).toHaveLength(fixtures.length)
  })

  it('category hit — keeps only templates with an exact category match', () => {
    const result = filterGalleryTemplates(fixtures, { category: '采购' })
    expect(result.map((t) => t.name)).toEqual(['采购申请'])
  })

  it('category miss — a category with no matching templates returns empty', () => {
    const result = filterGalleryTemplates(fixtures, { category: '财务' })
    expect(result).toEqual([])
  })

  it('category filter excludes uncategorized (null-category) templates', () => {
    const result = filterGalleryTemplates(fixtures, { category: '请假' })
    expect(result.map((t) => t.name)).toEqual(['请假申请'])
    expect(result.some((t) => t.category === null)).toBe(false)
  })

  it('search hits the template name', () => {
    const result = filterGalleryTemplates(fixtures, { search: '出差' })
    expect(result.map((t) => t.name)).toEqual(['出差申请'])
  })

  it('search hits the template description (not just the name)', () => {
    const result = filterGalleryTemplates(fixtures, { search: '办公用品' })
    expect(result.map((t) => t.name)).toEqual(['采购申请'])
  })

  it('search is case-insensitive', () => {
    const englishFixtures: GalleryFilterableTemplate[] = [
      tpl({ name: 'Travel Request', description: 'Business trip reimbursement' }),
      tpl({ name: 'Purchase Request', description: 'Office supplies' }),
    ]
    const upper = filterGalleryTemplates(englishFixtures, { search: 'TRAVEL' })
    const lower = filterGalleryTemplates(englishFixtures, { search: 'travel' })
    const mixed = filterGalleryTemplates(englishFixtures, { search: 'TrAvEl' })
    expect(upper.map((t) => t.name)).toEqual(['Travel Request'])
    expect(lower).toEqual(upper)
    expect(mixed).toEqual(upper)
  })

  it('search with no matches anywhere returns an empty array', () => {
    const result = filterGalleryTemplates(fixtures, { search: '不存在的关键词' })
    expect(result).toEqual([])
  })

  it('a template with a null description never throws and is excluded by an unmatched search', () => {
    const result = filterGalleryTemplates(fixtures, { search: '请假' })
    // '请假申请' matches on name even though its description is null.
    expect(result.map((t) => t.name)).toEqual(['请假申请'])
  })

  it('category AND search combine (both must match)', () => {
    const result = filterGalleryTemplates(fixtures, { category: '差旅', search: '报销' })
    expect(result.map((t) => t.name)).toEqual(['出差申请'])
  })

  it('category AND search combine — category matches but search does not → empty', () => {
    const result = filterGalleryTemplates(fixtures, { category: '差旅', search: '采购' })
    expect(result).toEqual([])
  })

  it('whitespace-only category/search behave like empty (no filter)', () => {
    const result = filterGalleryTemplates(fixtures, { category: '   ', search: '   ' })
    expect(result).toEqual(fixtures)
  })
})
