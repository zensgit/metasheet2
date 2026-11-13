/**
 * B1-05: 审批意见「快捷短语」— presets + per-user personal phrases (localStorage module contract).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendPhrase,
  MAX_PERSONAL_PHRASES,
  MAX_PHRASE_LENGTH,
  personalPhrases,
  personalPhrasesRevision,
  phrasesForAction,
  QUICK_PHRASES,
  quickPhraseChips,
  removePersonalPhrase,
  savePersonalPhrase,
} from '../src/approvals/quickPhrases'

const KEY = (userId: string, action: string) => `approval-quick-phrases:personal:${userId}:${action}`

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

  it('saves a trimmed phrase, newest first, and lists personal phrases before the presets', () => {
    expect(savePersonalPhrase('u1', 'approve', '  同意，按预算执行  ')).toBe('saved')
    expect(savePersonalPhrase('u1', 'approve', '请财务复核')).toBe('saved')
    expect(personalPhrases('u1', 'approve')).toEqual(['请财务复核', '同意，按预算执行'])
    expect(quickPhraseChips('u1', 'approve')).toEqual([
      { text: '请财务复核', personal: true },
      { text: '同意，按预算执行', personal: true },
      { text: '同意', personal: false },
      { text: '情况属实', personal: false },
      { text: '已核实无误', personal: false },
    ])
  })

  it('a personal phrase equal to a preset is shown once, as the personal chip', () => {
    expect(savePersonalPhrase('u1', 'approve', '情况属实')).toBe('saved')
    expect(quickPhraseChips('u1', 'approve').map((chip) => `${chip.personal ? 'P' : 'D'}:${chip.text}`)).toEqual([
      'P:情况属实',
      'D:同意',
      'D:已核实无误',
    ])
  })

  it('without saved phrases the chips are exactly the presets, in preset order', () => {
    expect(quickPhraseChips('u1', 'reject')).toEqual(QUICK_PHRASES.reject.map((text) => ({ text, personal: false })))
    expect(quickPhraseChips(null, 'comment')).toEqual(QUICK_PHRASES.comment.map((text) => ({ text, personal: false })))
    expect(quickPhraseChips('u1', 'transfer')).toEqual([])
  })

  it('rejects empty, duplicate, over-long and over-the-cap saves without changing the list', () => {
    expect(savePersonalPhrase('u1', 'reject', '   ')).toBe('empty')
    expect(savePersonalPhrase('u1', 'reject', '缺发票')).toBe('saved')
    expect(savePersonalPhrase('u1', 'reject', ' 缺发票 ')).toBe('duplicate')
    expect(savePersonalPhrase('u1', 'reject', '长'.repeat(MAX_PHRASE_LENGTH + 1))).toBe('too_long')
    expect(savePersonalPhrase('u1', 'reject', '长'.repeat(MAX_PHRASE_LENGTH))).toBe('saved')
    expect(personalPhrases('u1', 'reject')).toEqual(['长'.repeat(MAX_PHRASE_LENGTH), '缺发票'])

    for (let i = personalPhrases('u1', 'reject').length; i < MAX_PERSONAL_PHRASES; i += 1) {
      expect(savePersonalPhrase('u1', 'reject', `理由 ${i}`)).toBe('saved')
    }
    expect(personalPhrases('u1', 'reject')).toHaveLength(MAX_PERSONAL_PHRASES)
    expect(savePersonalPhrase('u1', 'reject', '再多一条')).toBe('full')
    expect(personalPhrases('u1', 'reject')).toHaveLength(MAX_PERSONAL_PHRASES)
    expect(personalPhrases('u1', 'reject')).not.toContain('再多一条')
    // Never evicts: the oldest saved phrase is still there.
    expect(personalPhrases('u1', 'reject')).toContain('缺发票')
  })

  it('counts length in characters, so an emoji or CJK character counts once', () => {
    expect(savePersonalPhrase('u1', 'comment', '👍'.repeat(MAX_PHRASE_LENGTH))).toBe('saved')
  })

  it('removes one phrase; removing the last one clears the key', () => {
    savePersonalPhrase('u1', 'comment', 'A')
    savePersonalPhrase('u1', 'comment', 'B')
    expect(removePersonalPhrase('u1', 'comment', 'A')).toBe(true)
    expect(personalPhrases('u1', 'comment')).toEqual(['B'])
    expect(removePersonalPhrase('u1', 'comment', 'not-there')).toBe(false)
    expect(removePersonalPhrase('u1', 'comment', 'B')).toBe(true)
    expect(localStorage.getItem(KEY('u1', 'comment'))).toBeNull()
  })

  it('isolates per user and per action, and never saves without a userId', () => {
    savePersonalPhrase('u1', 'approve', '同意，尽快付款')
    expect(savePersonalPhrase(null, 'approve', '不应该被记住')).toBe('no_user')
    expect(savePersonalPhrase(undefined, 'approve', '不应该被记住')).toBe('no_user')
    expect(savePersonalPhrase('u1', 'transfer', '不支持的动作')).toBe('failed')
    expect(personalPhrases('u2', 'approve')).toEqual([])
    expect(personalPhrases(null, 'approve')).toEqual([])
    expect(personalPhrases('u1', 'reject')).toEqual([])
    expect(personalPhrases('u1', 'approve')).toEqual(['同意，尽快付款'])
    expect(removePersonalPhrase(null, 'approve', '同意，尽快付款')).toBe(false)
  })

  it('stores under its own per-user, per-action key and ignores the old auto-remembered recents key', () => {
    localStorage.setItem('approval-quick-phrases:u1:approve', JSON.stringify(['情况属实']))
    expect(personalPhrases('u1', 'approve')).toEqual([])
    savePersonalPhrase('u1', 'approve', '同意')
    expect(JSON.parse(localStorage.getItem(KEY('u1', 'approve'))!)).toEqual(['同意'])
  })

  it('bumps the shared revision on every successful save / remove, and only then', () => {
    const start = personalPhrasesRevision.value
    savePersonalPhrase('u1', 'approve', 'X')
    expect(personalPhrasesRevision.value).toBe(start + 1)
    savePersonalPhrase('u1', 'approve', 'X') // duplicate
    savePersonalPhrase(null, 'approve', 'Y')
    expect(personalPhrasesRevision.value).toBe(start + 1)
    removePersonalPhrase('u1', 'approve', 'X')
    expect(personalPhrasesRevision.value).toBe(start + 2)
    removePersonalPhrase('u1', 'approve', 'X') // already gone
    expect(personalPhrasesRevision.value).toBe(start + 2)
  })

  it('degrades corrupted storage to well-formed entries only', () => {
    localStorage.setItem(KEY('u1', 'approve'), '{not json')
    expect(personalPhrases('u1', 'approve')).toEqual([])

    localStorage.setItem(KEY('u1', 'approve'), JSON.stringify({ nope: true }))
    expect(personalPhrases('u1', 'approve')).toEqual([])

    localStorage.setItem(
      KEY('u1', 'approve'),
      JSON.stringify(['ok', 123, null, ' ok2 ', '', 'ok', '长'.repeat(MAX_PHRASE_LENGTH + 1)]),
    )
    expect(personalPhrases('u1', 'approve')).toEqual(['ok', 'ok2'])

    localStorage.setItem(KEY('u1', 'approve'), JSON.stringify(Array.from({ length: 30 }, (_, i) => `p${i}`)))
    expect(personalPhrases('u1', 'approve')).toHaveLength(MAX_PERSONAL_PHRASES)
  })

  it('appendPhrase fills an empty opinion and appends after a full-width comma otherwise', () => {
    expect(appendPhrase('', '同意')).toBe('同意')
    expect(appendPhrase('同意', '情况属实')).toBe('同意，情况属实')
  })
})
