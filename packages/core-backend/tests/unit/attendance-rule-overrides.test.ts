import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url), 'utf8')
function declaration(name: string) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`Missing production function: ${name}`)
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error(`Missing function boundary: ${name}`)
  return source.slice(start, end + 2)
}
// Execute the production normalizer and calendar merge without exporting new runtime APIs.
const mergeRule = new Function(`
  ${declaration('normalizeRuleOverride')}
  ${declaration('buildAttendanceRuleWithRuleSetOverride')}
  return buildAttendanceRuleWithRuleSetOverride
`)() as (base: Record<string, unknown>, config: unknown) => Record<string, unknown>

const base = Object.freeze({
  id: 'synthetic-rule',
  timezone: 'Asia/Shanghai',
  workStartTime: '10:00',
  workEndTime: '19:00',
  lateGraceMinutes: 7,
  earlyGraceMinutes: 11,
  roundingMinutes: 5,
  severeLateThresholdMinutes: 37,
  absenceLateThresholdMinutes: 83,
  workingDays: Object.freeze([1, 2, 3, 4, 5]),
})

describe('partial attendance rule overrides', () => {
  const partialOverrides: Array<[string, Record<string, unknown>]> = [
    ['empty', {}],
    ['timezone', { timezone: 'UTC' }],
    ['hours', { workStartTime: '22:00', workEndTime: '06:00' }],
    ['late grace', { lateGraceMinutes: 3 }],
    ['early grace', { earlyGraceMinutes: 4 }],
    ['rounding', { roundingMinutes: 15 }],
    ['late tiers', { severeLateThresholdMinutes: 45, absenceLateThresholdMinutes: 90 }],
    ['working days', { workingDays: [0, 6] }],
  ]
  it.each(partialOverrides)('preserves every unspecified base field for a %s override', (_name, override) => {
    expect(mergeRule(base, { rule: override })).toEqual({ ...base, ...override })
  })

  it('preserves explicit zero rather than treating it as an omitted override', () => {
    const override = {
      lateGraceMinutes: 0, earlyGraceMinutes: 0, roundingMinutes: 0,
      severeLateThresholdMinutes: 0, absenceLateThresholdMinutes: 0,
    }
    expect(mergeRule(base, { rule: override })).toEqual({ ...base, ...override })
  })

  it('keeps existing normalization of accepted string and numeric values', () => {
    expect(mergeRule(base, { rule: {
      timezone: ' UTC ', workStartTime: ' 08:00 ', workEndTime: ' 17:00 ',
      lateGraceMinutes: '12', earlyGraceMinutes: 6, roundingMinutes: '15',
      severeLateThresholdMinutes: '35', absenceLateThresholdMinutes: 80,
      workingDays: ['1', 3, 5],
    } })).toEqual({
      ...base, timezone: 'UTC', workStartTime: '08:00', workEndTime: '17:00',
      lateGraceMinutes: 12, earlyGraceMinutes: 6, roundingMinutes: 15,
      severeLateThresholdMinutes: 35, absenceLateThresholdMinutes: 80, workingDays: [1, 3, 5],
    })
  })

  it('inherits base values when normalization finds no usable override value', () => {
    expect(mergeRule(base, { rule: {
      timezone: ' ', workStartTime: '', workEndTime: undefined,
      lateGraceMinutes: undefined, earlyGraceMinutes: Number.NaN,
      roundingMinutes: Number.POSITIVE_INFINITY, severeLateThresholdMinutes: 'invalid',
      absenceLateThresholdMinutes: undefined, workingDays: [],
    } })).toEqual(base)
  })

  it.each([undefined, null, {}, { rule: null }])('keeps the base rule for absent configuration %j', config => {
    expect(mergeRule(base, config)).toBe(base)
  })
})
