import { describe, it, expect } from 'vitest'
import { narrowPersonAllowedByGroups, personRestrictGroupIds } from '../../src/multitable/field-codecs'

describe('P1 — native person restrictToMemberGroupIds narrowing helpers', () => {
  it('personRestrictGroupIds extracts non-empty trimmed string ids only', () => {
    expect(personRestrictGroupIds(undefined)).toEqual([])
    expect(personRestrictGroupIds({})).toEqual([])
    expect(personRestrictGroupIds({ restrictToMemberGroupIds: 'g1' })).toEqual([]) // not an array
    expect(
      personRestrictGroupIds({ restrictToMemberGroupIds: ['g1', ' g2 ', '', 3, null] as unknown[] }),
    ).toEqual(['g1', 'g2'])
  })

  it('empty restrict → the sheet member set unchanged (returns a copy)', () => {
    const sheet = new Set(['a', 'b'])
    const out = narrowPersonAllowedByGroups(sheet, [], new Set<string>())
    expect([...out].sort()).toEqual(['a', 'b'])
    expect(out).not.toBe(sheet) // copy, not the same ref
  })

  it('restrict → INTERSECTION of sheet members and group members (only tightens)', () => {
    const sheet = new Set(['a', 'b', 'c'])
    const groups = new Set(['b', 'c', 'd']) // d is in the group but NOT a sheet member
    const out = narrowPersonAllowedByGroups(sheet, ['g1'], groups)
    expect([...out].sort()).toEqual(['b', 'c']) // a excluded (not in group); d excluded (not a sheet member)
  })

  it('restrict with empty group membership → closed set (all assignments rejected)', () => {
    const sheet = new Set(['a', 'b'])
    const out = narrowPersonAllowedByGroups(sheet, ['g1'], new Set<string>())
    expect(out.size).toBe(0)
  })

  it('never widens beyond sheet membership (a group-only member is not granted)', () => {
    const sheet = new Set(['a'])
    const groups = new Set(['a', 'z']) // z in group but not a sheet member
    const out = narrowPersonAllowedByGroups(sheet, ['g1'], groups)
    expect(out.has('z')).toBe(false)
    expect([...out]).toEqual(['a'])
  })
})
