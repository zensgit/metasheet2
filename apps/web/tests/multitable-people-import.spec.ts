import { describe, expect, it } from 'vitest'
import { addPeopleLookupToken, inferPeopleLookupKind, resolvePeopleImportValue } from '../src/multitable/utils/people-import'

describe('people import lookup priorities', () => {
  it('prefers exact name matches over ambiguous alias matches', () => {
    const nameLookup = new Map<string, string | null>()
    const aliasLookup = new Map<string, string | null>()

    addPeopleLookupToken(nameLookup, 'Alice', 'rec_alice')
    addPeopleLookupToken(aliasLookup, 'Alice', 'rec_alice')
    addPeopleLookupToken(aliasLookup, 'Alice', 'rec_alice_2')

    expect(resolvePeopleImportValue({
      rawValue: 'Alice',
      lookups: { name: nameLookup, alias: aliasLookup },
    })).toEqual(['rec_alice'])
  })

  it('surfaces actionable ambiguity guidance for alias-only matches', () => {
    const aliasLookup = new Map<string, string | null>()
    addPeopleLookupToken(aliasLookup, 'Alex', 'rec_alex_1')
    addPeopleLookupToken(aliasLookup, 'Alex', 'rec_alex_2')

    expect(() => resolvePeopleImportValue({
      rawValue: 'Alex',
      lookups: { alias: aliasLookup },
    })).toThrow('Use email for an exact match.')
  })

  it('respects single-select people fields after lookup resolution', () => {
    const emailLookup = new Map<string, string | null>()
    addPeopleLookupToken(emailLookup, 'amy@example.com', 'rec_amy')
    addPeopleLookupToken(emailLookup, 'jamie@example.com', 'rec_jamie')

    expect(() => resolvePeopleImportValue({
      rawValue: 'amy@example.com, jamie@example.com',
      currentField: {
        id: 'fld_owner',
        name: 'Owner',
        type: 'link',
        property: { refKind: 'user', limitSingleRecord: true },
      },
      lookups: { email: emailLookup },
    })).toThrow('People field only allows one person')
  })

  it('classifies email, name and alias fields consistently', () => {
    expect(inferPeopleLookupKind('Email')).toBe('email')
    expect(inferPeopleLookupKind('Display Name')).toBe('name')
    expect(inferPeopleLookupKind('Alias')).toBe('alias')
  })
})
