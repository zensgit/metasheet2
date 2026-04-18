import { describe, expect, it } from 'vitest'
import {
  evaluateDirectoryAutoAdmissionEligibility,
  isDirectoryUserWithinAdmissionScope,
} from '../../src/directory/directory-sync'

describe('directory auto admission scope', () => {
  it('matches descendants of an allowlisted department', () => {
    const departments = new Map([
      ['dept-root', { id: 'dept-root', parentId: null }],
      ['dept-parent', { id: 'dept-parent', parentId: 'dept-root' }],
      ['dept-child', { id: 'dept-child', parentId: 'dept-parent' }],
    ])

    expect(
      isDirectoryUserWithinAdmissionScope(
        ['dept-child'],
        ['dept-parent'],
        departments,
      ),
    ).toBe(true)
  })

  it('returns false when the user is outside the allowlisted subtree', () => {
    const departments = new Map([
      ['dept-root', { id: 'dept-root', parentId: null }],
      ['dept-sales', { id: 'dept-sales', parentId: 'dept-root' }],
      ['dept-finance', { id: 'dept-finance', parentId: 'dept-root' }],
    ])

    expect(
      isDirectoryUserWithinAdmissionScope(
        ['dept-finance'],
        ['dept-sales'],
        departments,
      ),
    ).toBe(false)
  })

  it('lets excluded departments override allowlisted parents', () => {
    const departments = new Map([
      ['dept-root', { id: 'dept-root', parentId: null }],
      ['dept-parent', { id: 'dept-parent', parentId: 'dept-root' }],
      ['dept-child', { id: 'dept-child', parentId: 'dept-parent' }],
    ])

    expect(
      evaluateDirectoryAutoAdmissionEligibility({
        admissionMode: 'auto_for_scoped_departments',
        admissionDepartmentIds: ['dept-parent'],
        excludeDepartmentIds: ['dept-child'],
        userDepartmentIds: ['dept-child'],
        departments,
        email: 'linlan@example.com',
      }),
    ).toEqual({
      inScope: false,
      missingEmail: false,
      excluded: true,
    })
  })

  it('flags missing email for in-scope auto-admission candidates', () => {
    const departments = new Map([
      ['dept-root', { id: 'dept-root', parentId: null }],
      ['dept-child', { id: 'dept-child', parentId: 'dept-root' }],
    ])

    expect(
      evaluateDirectoryAutoAdmissionEligibility({
        admissionMode: 'auto_for_scoped_departments',
        admissionDepartmentIds: ['dept-root'],
        excludeDepartmentIds: [],
        userDepartmentIds: ['dept-child'],
        departments,
        email: null,
      }),
    ).toEqual({
      inScope: true,
      missingEmail: true,
    })
  })
})
