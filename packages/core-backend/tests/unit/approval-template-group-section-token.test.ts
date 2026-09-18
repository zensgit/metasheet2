import { describe, expect, it } from 'vitest'
import { parseApprovalTemplateSectionToken } from '../../src/services/ApprovalTemplateGroupSectionService'

/**
 * Approval form grouping lock v2.13, §4 acceptance row C / row J — "三个令牌、四个桶" and "未知
 * section= 令牌 ⇒ 400". This is the pure, DB-free half of that acceptance row: the SQL-bucket
 * mapping and the 400 wiring live in `routes/approvals.ts` + the real-DB acceptance test (a later
 * unit in this slice); this file only pins the token grammar itself.
 */
describe('parseApprovalTemplateSectionToken (lock §4 rows C/J)', () => {
  it('recognizes the literal "ungrouped" token', () => {
    expect(parseApprovalTemplateSectionToken('ungrouped')).toEqual({ kind: 'ungrouped' })
  })

  it('splits "group:<id>" on the FIRST colon only', () => {
    expect(parseApprovalTemplateSectionToken('group:atg_abc123')).toEqual({
      kind: 'group',
      groupId: 'atg_abc123',
    })
  })

  it('splits "category:<name>" on the first colon, keeping the name verbatim (§2 "name 原样")', () => {
    // A category name may itself contain ':' — normalizeTemplateCategory only trims + caps at 64
    // chars, it never rejects ':' — so only the FIRST colon is the token separator.
    expect(parseApprovalTemplateSectionToken('category:HR:Onboarding')).toEqual({
      kind: 'category',
      name: 'HR:Onboarding',
    })
  })

  it('does not trim or otherwise normalize the category name', () => {
    expect(parseApprovalTemplateSectionToken('category: leading space')).toEqual({
      kind: 'category',
      name: ' leading space',
    })
  })

  it.each([
    ['', 'empty string'],
    ['unknown', 'no colon and not the literal "ungrouped"'],
    ['group:', 'empty id after the colon'],
    ['category:', 'empty name after the colon'],
    [':bare', 'colon-as-first-character has no prefix'],
    ['GROUP:atg_1', 'prefix is case-sensitive'],
    ['ungrouped:extra', 'the ungrouped literal does not take a suffix'],
    ['section:group:atg_1', 'unknown prefix even though a recognized one appears later'],
  ])('returns null for %j (%s)', (raw) => {
    expect(parseApprovalTemplateSectionToken(raw)).toBeNull()
  })
})
