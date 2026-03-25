import { describe, expect, it } from 'vitest'
import { PLM_AUDIT_KIND_OPTIONS } from '../src/views/plmAuditFilterOptions'

describe('plmAuditFilterOptions', () => {
  it('keeps audit as a first-class selectable kind', () => {
    expect(PLM_AUDIT_KIND_OPTIONS).toContainEqual({
      value: 'audit',
      label: 'Audit',
      labelZh: '审计',
    })
  })
})
