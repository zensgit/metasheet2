import { describe, expect, it } from 'vitest'
import { validateOwnDelegationForm, buildOwnCreatePayload, type OwnDelegationForm } from '../src/approvals/delegations'

const base: OwnDelegationForm = {
  delegateeUserId: 'B',
  scope: 'all',
  scopeTemplateId: '',
  startAt: '2026-06-22T00:00',
  endAt: '2026-06-23T00:00',
}

describe('validateOwnDelegationForm (self-service — delegator is implicit)', () => {
  it('passes a valid all-scope form', () => {
    expect(validateOwnDelegationForm(base)).toBeNull()
  })
  it('requires a delegatee', () => {
    expect(validateOwnDelegationForm({ ...base, delegateeUserId: '  ' })).toBe('请填写被委托人')
  })
  it("requires a template for scope='template'", () => {
    expect(validateOwnDelegationForm({ ...base, scope: 'template' })).toBe('指定模板范围需要选择模板')
  })
  it('rejects an inverted / empty window', () => {
    expect(validateOwnDelegationForm({ ...base, startAt: '2026-06-23T00:00', endAt: '2026-06-22T00:00' })).toBe('结束时间必须晚于开始时间')
    expect(validateOwnDelegationForm({ ...base, endAt: '' })).toBe('请填写时间窗')
  })
})

describe('buildOwnCreatePayload', () => {
  it('never carries a delegatorUserId (delegator is forced server-side to the actor)', () => {
    const payload = buildOwnCreatePayload(base)
    expect('delegatorUserId' in payload).toBe(false)
  })
  it('trims the delegatee, nulls the template id for all-scope, and ISO-normalizes the window', () => {
    const p = buildOwnCreatePayload({ ...base, delegateeUserId: ' B ', scope: 'all', scopeTemplateId: 't1' })
    expect(p).toMatchObject({ delegateeUserId: 'B', scope: 'all', scopeTemplateId: null })
    expect(p.startAt).toMatch(/Z$/)
    expect(p.endAt).toMatch(/Z$/)
  })
  it('keeps the trimmed template id for template-scope', () => {
    expect(buildOwnCreatePayload({ ...base, scope: 'template', scopeTemplateId: ' t1 ' }).scopeTemplateId).toBe('t1')
  })
})
