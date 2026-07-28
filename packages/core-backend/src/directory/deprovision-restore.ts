/**
 * D6 — restore eligibility from effect ledger (design lock Rev 4.2 companion §6).
 *
 * Restore only when effects are status=applied, current state equals after_active,
 * and access_generation equals event generation. Otherwise 409 DRIFT.
 */

export type RestoreEffectView = {
  id: string
  status: string
  afterActive: boolean
  accessGenerationAtApply: number
  effectType: string
}

export type RestoreEligibilityInput = {
  mode: 'rehire' | 'admin_force'
  /** Directory source still active? Required for rehire, not for admin_force. */
  directorySourceActive: boolean
  currentUserAccessGeneration: number
  eventAccessGeneration: number
  effects: RestoreEffectView[]
  /** Current active flags keyed by effect id (true if system still matches afterActive). */
  currentMatchesAfter: Record<string, boolean>
}

export type RestoreEligibilityResult =
  | { ok: true }
  | { ok: false; code: 'DRIFT' | 'SOURCE_INACTIVE' | 'NO_EFFECTS' | 'NOT_APPLIED'; message: string }

export function evaluateDeprovisionRestoreEligibility(
  input: RestoreEligibilityInput,
): RestoreEligibilityResult {
  if (input.mode === 'rehire' && !input.directorySourceActive) {
    return {
      ok: false,
      code: 'SOURCE_INACTIVE',
      message: 'Directory source is inactive; use admin force restore',
    }
  }

  const applied = input.effects.filter((e) => e.status === 'applied')
  if (applied.length === 0) {
    return { ok: false, code: 'NO_EFFECTS', message: 'No applied effects to reverse' }
  }

  if (input.currentUserAccessGeneration !== input.eventAccessGeneration) {
    return {
      ok: false,
      code: 'DRIFT',
      message: 'access_generation mismatch; effects superseded or graph rewritten',
    }
  }

  for (const effect of applied) {
    if (effect.accessGenerationAtApply !== input.eventAccessGeneration) {
      return {
        ok: false,
        code: 'DRIFT',
        message: `effect ${effect.id} generation drift`,
      }
    }
    if (input.currentMatchesAfter[effect.id] !== true) {
      return {
        ok: false,
        code: 'DRIFT',
        message: `effect ${effect.id} current state no longer equals after_active`,
      }
    }
  }

  return { ok: true }
}
