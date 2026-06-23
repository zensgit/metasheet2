import { describe, expect, it } from 'vitest'
import { validateDelegationForm, buildCreatePayload, type DelegationForm } from '../src/approvals/delegations'

const base: DelegationForm = {
  delegatorUserId: 'A',
  delegateeUserId: 'B',
  scope: 'all',
  scopeTemplateId: '',
  startAt: '2026-06-22T00:00',
  endAt: '2026-06-23T00:00',
}

describe('validateDelegationForm', () => {
  it('passes a valid all-scope form', () => {
    expect(validateDelegationForm(base)).toBeNull()
  })
  it('requires delegator and delegatee', () => {
    expect(validateDelegationForm({ ...base, delegatorUserId: '  ' })).toBe('请填写委托人')
    expect(validateDelegationForm({ ...base, delegateeUserId: '' })).toBe('请填写被委托人')
  })
  it('rejects self-delegation', () => {
    expect(validateDelegationForm({ ...base, delegateeUserId: 'A' })).toBe('委托人与被委托人不能相同')
  })
  it("requires a template for scope='template'", () => {
    expect(validateDelegationForm({ ...base, scope: 'template' })).toBe('指定模板范围需要选择模板')
  })
  it('rejects an inverted / empty window', () => {
    expect(validateDelegationForm({ ...base, startAt: '2026-06-23T00:00', endAt: '2026-06-22T00:00' })).toBe('结束时间必须晚于开始时间')
    expect(validateDelegationForm({ ...base, endAt: '' })).toBe('请填写时间窗')
  })
})

describe('buildCreatePayload', () => {
  it('trims ids and nulls the template id for all-scope', () => {
    expect(buildCreatePayload({ ...base, delegatorUserId: ' A ', scope: 'all', scopeTemplateId: 't1' })).toMatchObject({
      delegatorUserId: 'A',
      delegateeUserId: 'B',
      scope: 'all',
      scopeTemplateId: null,
    })
  })
  it('keeps the trimmed template id for template-scope and ISO-normalizes the window', () => {
    const p = buildCreatePayload({ ...base, scope: 'template', scopeTemplateId: ' t1 ' })
    expect(p.scopeTemplateId).toBe('t1')
    expect(p.startAt).toMatch(/Z$/)
    expect(p.endAt).toMatch(/Z$/)
  })
})
