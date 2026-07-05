/**
 * B1-05: 审批意见「快捷短语」— localStorage module contract.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { phrasesForAction, QUICK_PHRASES, recentPhrases, rememberPhrase } from '../src/approvals/quickPhrases'

describe('approvals/quickPhrases', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('exposes the fixed preset phrases for each action', () => {
    expect(QUICK_PHRASES.approve).toEqual(['同意', '情况属实', '已核实无误'])
    expect(QUICK_PHRASES.reject).toEqual(['不符合要求', '请补充材料后重新提交'])
    expect(QUICK_PHRASES.comment).toEqual(['已阅', '请尽快处理'])
  })

  it('phrasesForAction returns the matching preset list, [] for an unrecognized action', () => {
    expect(phrasesForAction('approve')).toEqual(QUICK_PHRASES.approve)
    expect(phrasesForAction('reject')).toEqual(QUICK_PHRASES.reject)
    expect(phrasesForAction('comment')).toEqual(QUICK_PHRASES.comment)
    expect(phrasesForAction('transfer')).toEqual([])
    expect(phrasesForAction('')).toEqual([])
  })

  it('remembers and lists most-recent-first, deduping by phrase text', () => {
    rememberPhrase('u1', 'approve', '同意')
    rememberPhrase('u1', 'approve', '情况属实')
    rememberPhrase('u1', 'approve', '同意') // re-used -> bumps back to the front, no duplicate entry
    expect(recentPhrases('u1', 'approve')).toEqual(['同意', '情况属实'])
  })

  it('caps at 3 entries, evicting the oldest', () => {
    rememberPhrase('u1', 'reject', 'A')
    rememberPhrase('u1', 'reject', 'B')
    rememberPhrase('u1', 'reject', 'C')
    rememberPhrase('u1', 'reject', 'D')
    expect(recentPhrases('u1', 'reject')).toEqual(['D', 'C', 'B'])
  })

  it('isolates per user and per action, and no-ops without a userId', () => {
    rememberPhrase('u1', 'approve', '同意')
    rememberPhrase(null, 'approve', '不应该被记住')
    expect(recentPhrases('u2', 'approve')).toEqual([])
    expect(recentPhrases(null, 'approve')).toEqual([])
    expect(recentPhrases('u1', 'reject')).toEqual([]) // different action, same user
    expect(recentPhrases('u1', 'approve')).toEqual(['同意'])
  })

  it('no-ops on an empty phrase', () => {
    rememberPhrase('u1', 'comment', '')
    expect(recentPhrases('u1', 'comment')).toEqual([])
  })

  it('degrades corrupted storage to an empty list, keeping only well-formed string entries', () => {
    localStorage.setItem('approval-quick-phrases:u1:approve', '{not json')
    expect(recentPhrases('u1', 'approve')).toEqual([])

    localStorage.setItem('approval-quick-phrases:u1:approve', JSON.stringify({ nope: true }))
    expect(recentPhrases('u1', 'approve')).toEqual([])

    localStorage.setItem('approval-quick-phrases:u1:approve', JSON.stringify(['ok', 123, null, 'ok2']))
    expect(recentPhrases('u1', 'approve')).toEqual(['ok', 'ok2'])
  })
})
