import { describe, expect, it } from 'vitest'

import { amountToChineseWords } from '../src/approvals/amountInWords'

// G-B2-16 — 金额大写 matrix: boundary digits, 零 collapsing, 角/分 vocabulary, honest omissions.

describe('amountToChineseWords', () => {
  it('basic integers with 整 suffix', () => {
    expect(amountToChineseWords(1)).toBe('壹圆整')
    expect(amountToChineseWords(10)).toBe('壹拾圆整')
    expect(amountToChineseWords(100)).toBe('壹佰圆整')
    expect(amountToChineseWords(5000)).toBe('伍仟圆整')
    expect(amountToChineseWords(100.0)).toBe('壹佰圆整')
  })

  it('零 collapsing inside a group and across groups', () => {
    expect(amountToChineseWords(1005)).toBe('壹仟零伍圆整')
    expect(amountToChineseWords(1050)).toBe('壹仟零伍拾圆整')
    expect(amountToChineseWords(10005)).toBe('壹万零伍圆整')
    expect(amountToChineseWords(100050000)).toBe('壹亿零伍万圆整')
    expect(amountToChineseWords(1000500)).toBe('壹佰万零伍佰圆整')
  })

  it('万/亿 group units', () => {
    expect(amountToChineseWords(12345)).toBe('壹万贰仟叁佰肆拾伍圆整')
    expect(amountToChineseWords(100000000)).toBe('壹亿圆整')
    expect(amountToChineseWords(500060007)).toBe('伍亿零陆万零柒圆整')
  })

  it('角/分 vocabulary incl. the 零-join rules', () => {
    expect(amountToChineseWords(0.5)).toBe('伍角')
    expect(amountToChineseWords(0.05)).toBe('伍分')
    expect(amountToChineseWords(10.1)).toBe('壹拾圆壹角')
    expect(amountToChineseWords(1005.06)).toBe('壹仟零伍圆零陆分')
    expect(amountToChineseWords(3.45)).toBe('叁圆肆角伍分')
  })

  it('zero, negatives, rounding half-up in 分', () => {
    expect(amountToChineseWords(0)).toBe('零圆整')
    expect(amountToChineseWords(-12.3)).toBe('负壹拾贰圆叁角')
    expect(amountToChineseWords(0.005)).toBe('壹分') // rounds up at the 分 boundary
    expect(amountToChineseWords(0.004)).toBe('零圆整')
  })

  it('honest omissions: NaN / non-number / beyond 万亿 → empty string, never throws', () => {
    expect(amountToChineseWords(Number.NaN)).toBe('')
    expect(amountToChineseWords(Infinity)).toBe('')
    expect(amountToChineseWords('12' as never)).toBe('')
    expect(amountToChineseWords(1e13)).toBe('')
    expect(amountToChineseWords(9999999999999)).not.toBe('') // just under the cap still works
  })
})
