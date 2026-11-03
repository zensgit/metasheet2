import { describe, expect, it } from 'vitest'

import { urgeButtonState } from '../src/approvals/urgeButtonState'

// G-B2-12 — the regression this matrix exists to catch: a request in flight on ONE row must not
// disable any OTHER row's 催办 button (the old `remindingId !== null` gate did exactly that).

const NONE: ReadonlySet<string> = new Set()

describe('urgeButtonState', () => {
  it('idle row: enabled, not loading, plain label', () => {
    expect(urgeButtonState('r1', NONE, NONE, true)).toEqual({ disabled: false, loading: false, label: '催办', title: '' })
  })

  it('the in-flight row itself: loading + disabled', () => {
    const state = urgeButtonState('r1', new Set(['r1']), NONE, true)
    expect(state.loading).toBe(true)
    expect(state.disabled).toBe(true)
    expect(state.label).toBe('催办')
  })

  it('REGRESSION: another row stays ENABLED while a different row is in flight', () => {
    const state = urgeButtonState('r2', new Set(['r1']), NONE, true)
    expect(state.disabled).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('concurrent in-flight rows each render as loading, and a third stays enabled', () => {
    const inFlight = new Set(['r1', 'r2'])
    expect(urgeButtonState('r1', inFlight, NONE, true).loading).toBe(true)
    expect(urgeButtonState('r2', inFlight, NONE, true).loading).toBe(true)
    expect(urgeButtonState('r3', inFlight, NONE, true).disabled).toBe(false)
  })

  it('already-reminded row: disabled, relabelled, and says why', () => {
    const state = urgeButtonState('r1', NONE, new Set(['r1']), true)
    expect(state).toEqual({
      disabled: true,
      loading: false,
      label: '已催办',
      title: '本次已催办（服务端每小时限一次）',
    })
  })

  it('a reminded row does not disable other rows', () => {
    expect(urgeButtonState('r2', NONE, new Set(['r1']), true).disabled).toBe(false)
  })

  it('in-flight wins over reminded during the overlapping tick (renders loading, not 已催办)', () => {
    const state = urgeButtonState('r1', new Set(['r1']), new Set(['r1']), true)
    expect(state.loading).toBe(true)
    expect(state.label).toBe('催办')
    expect(state.title).toBe('')
  })
})

// O-8 / F8-1: the label/title follow the shell locale; state semantics are identical in both.
describe('urgeButtonState — en (O-8 / F8-1)', () => {
  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
  it('idle and reminded rows carry English copy, same disabled/loading semantics', () => {
    expect(urgeButtonState('r1', NONE, NONE, false)).toEqual({ disabled: false, loading: false, label: 'Remind', title: '' })
    const reminded = urgeButtonState('r1', NONE, new Set(['r1']), false)
    expect(reminded.disabled).toBe(true)
    expect(reminded.label).toBe('Reminded')
    expect(reminded.title).not.toBe('')
    expect(`${reminded.label} ${reminded.title}`).not.toMatch(CJK)
  })
})
