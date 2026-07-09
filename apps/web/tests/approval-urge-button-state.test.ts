import { describe, expect, it } from 'vitest'

import { urgeButtonState } from '../src/approvals/urgeButtonState'

// G-B2-12 — the regression this matrix exists to catch: a request in flight on ONE row must not
// disable any OTHER row's 催办 button (the old `remindingId !== null` gate did exactly that).

const NONE: ReadonlySet<string> = new Set()

describe('urgeButtonState', () => {
  it('idle row: enabled, not loading, plain label', () => {
    expect(urgeButtonState('r1', NONE, NONE)).toEqual({ disabled: false, loading: false, label: '催办', title: '' })
  })

  it('the in-flight row itself: loading + disabled', () => {
    const state = urgeButtonState('r1', new Set(['r1']), NONE)
    expect(state.loading).toBe(true)
    expect(state.disabled).toBe(true)
    expect(state.label).toBe('催办')
  })

  it('REGRESSION: another row stays ENABLED while a different row is in flight', () => {
    const state = urgeButtonState('r2', new Set(['r1']), NONE)
    expect(state.disabled).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('concurrent in-flight rows each render as loading, and a third stays enabled', () => {
    const inFlight = new Set(['r1', 'r2'])
    expect(urgeButtonState('r1', inFlight, NONE).loading).toBe(true)
    expect(urgeButtonState('r2', inFlight, NONE).loading).toBe(true)
    expect(urgeButtonState('r3', inFlight, NONE).disabled).toBe(false)
  })

  it('already-reminded row: disabled, relabelled, and says why', () => {
    const state = urgeButtonState('r1', NONE, new Set(['r1']))
    expect(state).toEqual({
      disabled: true,
      loading: false,
      label: '已催办',
      title: '本次已催办（服务端每小时限一次）',
    })
  })

  it('a reminded row does not disable other rows', () => {
    expect(urgeButtonState('r2', NONE, new Set(['r1'])).disabled).toBe(false)
  })

  it('in-flight wins over reminded during the overlapping tick (renders loading, not 已催办)', () => {
    const state = urgeButtonState('r1', new Set(['r1']), new Set(['r1']))
    expect(state.loading).toBe(true)
    expect(state.label).toBe('催办')
    expect(state.title).toBe('')
  })
})
