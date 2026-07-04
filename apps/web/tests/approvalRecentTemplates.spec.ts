/**
 * B1-08: 最近使用模板捷径 — localStorage module contract.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { listRecentTemplates, recordRecentTemplate } from '../src/approvals/recentTemplates'

describe('approvals/recentTemplates', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('records and lists most-recent-first, deduping by templateId', () => {
    recordRecentTemplate('u1', { templateId: 't1', name: '请假申请' }, 1000)
    recordRecentTemplate('u1', { templateId: 't2', name: '报销申请', category: '财务' }, 2000)
    recordRecentTemplate('u1', { templateId: 't1', name: '请假申请' }, 3000)

    const list = listRecentTemplates('u1')
    expect(list.map((e) => e.templateId)).toEqual(['t1', 't2'])
    expect(list[0].at).toBe(3000)
    expect(list[1].category).toBe('财务')
  })

  it('caps at 5 entries, evicting the oldest', () => {
    for (let i = 1; i <= 6; i++) {
      recordRecentTemplate('u1', { templateId: `t${i}`, name: `模板${i}` }, i * 1000)
    }
    const list = listRecentTemplates('u1')
    expect(list).toHaveLength(5)
    expect(list.map((e) => e.templateId)).toEqual(['t6', 't5', 't4', 't3', 't2'])
  })

  it('isolates per user and no-ops without a userId', () => {
    recordRecentTemplate('u1', { templateId: 't1', name: 'A' }, 1000)
    recordRecentTemplate(null, { templateId: 't9', name: 'X' }, 2000)
    expect(listRecentTemplates('u2')).toEqual([])
    expect(listRecentTemplates(null)).toEqual([])
    expect(listRecentTemplates('u1')).toHaveLength(1)
  })

  it('degrades corrupted storage to an empty list', () => {
    localStorage.setItem('approval-recent-templates:u1', '{not json')
    expect(listRecentTemplates('u1')).toEqual([])
    localStorage.setItem('approval-recent-templates:u1', JSON.stringify({ nope: true }))
    expect(listRecentTemplates('u1')).toEqual([])
    // malformed entries are filtered, valid ones survive
    localStorage.setItem(
      'approval-recent-templates:u1',
      JSON.stringify([{ templateId: 't1', name: 'A', category: null, at: 1 }, { bogus: true }, null]),
    )
    expect(listRecentTemplates('u1').map((e) => e.templateId)).toEqual(['t1'])
  })
})
