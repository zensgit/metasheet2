import { describe, expect, it } from 'vitest'
import { evaluateDeprovisionRestoreEligibility } from '../../src/directory/deprovision-restore'

describe('evaluateDeprovisionRestoreEligibility (D6)', () => {
  const baseEffects = [
    {
      id: 'e1',
      status: 'applied',
      afterActive: false,
      accessGenerationAtApply: 3,
      effectType: 'set_user_inactive',
    },
  ]

  it('allows rehire when generation matches and current==after', () => {
    const r = evaluateDeprovisionRestoreEligibility({
      mode: 'rehire',
      directorySourceActive: true,
      currentUserAccessGeneration: 3,
      eventAccessGeneration: 3,
      effects: baseEffects,
      currentMatchesAfter: { e1: true },
    })
    expect(r).toEqual({ ok: true })
  })

  it('rejects rehire when directory source inactive', () => {
    const r = evaluateDeprovisionRestoreEligibility({
      mode: 'rehire',
      directorySourceActive: false,
      currentUserAccessGeneration: 3,
      eventAccessGeneration: 3,
      effects: baseEffects,
      currentMatchesAfter: { e1: true },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SOURCE_INACTIVE')
  })

  it('allows admin_force despite inactive source when no drift', () => {
    const r = evaluateDeprovisionRestoreEligibility({
      mode: 'admin_force',
      directorySourceActive: false,
      currentUserAccessGeneration: 3,
      eventAccessGeneration: 3,
      effects: baseEffects,
      currentMatchesAfter: { e1: true },
    })
    expect(r).toEqual({ ok: true })
  })

  it('rejects generation drift with 409-class DRIFT', () => {
    const r = evaluateDeprovisionRestoreEligibility({
      mode: 'rehire',
      directorySourceActive: true,
      currentUserAccessGeneration: 4,
      eventAccessGeneration: 3,
      effects: baseEffects,
      currentMatchesAfter: { e1: true },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('DRIFT')
  })

  it('rejects when current state no longer equals after_active', () => {
    const r = evaluateDeprovisionRestoreEligibility({
      mode: 'admin_force',
      directorySourceActive: true,
      currentUserAccessGeneration: 3,
      eventAccessGeneration: 3,
      effects: baseEffects,
      currentMatchesAfter: { e1: false },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('DRIFT')
  })
})
