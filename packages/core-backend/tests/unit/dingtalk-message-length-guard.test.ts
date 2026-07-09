import { describe, expect, it } from 'vitest'
import {
  composeDingTalkBodyWithLinks,
  truncateDingTalkMessageText,
} from '../../src/multitable/automation-executor'

const BODY_MAX = 20_000

describe('DT-HARDEN-08 DingTalk message length guards', () => {
  describe('truncateDingTalkMessageText', () => {
    it('leaves text within the limit untouched', () => {
      expect(truncateDingTalkMessageText('hello', 10)).toBe('hello')
      expect(truncateDingTalkMessageText('hello', 5)).toBe('hello')
    })

    it('truncates with an ellipsis and never exceeds the limit', () => {
      const out = truncateDingTalkMessageText('abcdefghij', 5)
      expect(out).toBe('abcd…')
      expect(out.length).toBe(5)
    })

    it('degrades safely at pathological limits', () => {
      expect(truncateDingTalkMessageText('abc', 1)).toBe('a')
      expect(truncateDingTalkMessageText('abc', 0)).toBe('')
    })
  })

  describe('composeDingTalkBodyWithLinks', () => {
    const links = ['[打开记录](https://example.test/r/1)', '[查看视图](https://example.test/v/2)']

    it('keeps body and links intact when within the limit', () => {
      const out = composeDingTalkBodyWithLinks('short body', links)
      expect(out).toContain('short body')
      expect(out).toContain('**快捷入口**')
      for (const link of links) expect(out).toContain(link)
    })

    it('preserves the link block when the body overflows (links are the actionable part)', () => {
      // Truncating the ASSEMBLED string — the pre-fix behavior — would have cut the
      // links off entirely, silently shipping a card nobody can act on.
      const out = composeDingTalkBodyWithLinks('x'.repeat(BODY_MAX + 5_000), links)
      expect(out.length).toBeLessThanOrEqual(BODY_MAX)
      expect(out).toContain('**快捷入口**')
      for (const link of links) expect(out).toContain(link)
      expect(out).toContain('…')
    })

    it('emits body only when there are no links', () => {
      expect(composeDingTalkBodyWithLinks('just body', [])).toBe('just body')
    })

    it('emits the link block alone when the body is empty', () => {
      const out = composeDingTalkBodyWithLinks('', links)
      expect(out.startsWith('**快捷入口**')).toBe(true)
    })
  })
})
