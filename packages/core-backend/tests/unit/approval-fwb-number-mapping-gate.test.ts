import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { hasUnavailableFwbNumberMapping, normalizeFwbMappings } from '../../src/multitable/approval-fwb-activation'

const ACTIVATION_FILE = path.join(__dirname, '../../src/multitable/approval-fwb-activation.ts')
// M-1 pinning gate, half (i) (approval-lock8-field-vocabulary-20260817.md §3, gate M-1): the FWB
// number-mapping stop rule module must stay BYTE-UNTOUCHED by every L8 family, including L8-C's
// formatted-number display props. Digest recorded at the Lock-8 baseline (`6c0b9162a9`, verified
// there via `shasum -a 256`) and re-verified here at this branch's HEAD; a change to this file
// (intentional or not) reds this test, forcing a deliberate re-pin rather than a silent drift — the
// digest alone is a change detector; the behavioural half below is what makes re-pinning unable to
// paper over a weakened guard.
const PINNED_SHA256 = '46f54ec5b7918388cb2cc5a8a5e2bf1e092963f310118220194d3eb707e00ad2'

describe('FWB exact-number activation stop rule', () => {
  test('rejects any number target while preserving non-numeric mappings', () => {
    expect(hasUnavailableFwbNumberMapping([
      { targetType: 'text' },
      { targetType: 'date' },
      { targetType: 'select' },
    ])).toBe(false)
    expect(hasUnavailableFwbNumberMapping([
      { targetType: 'text' },
      { targetType: 'number' },
    ])).toBe(true)
  })

  test('M-1(i): approval-fwb-activation.ts stays byte-identical to its Lock-8 pin', () => {
    const digest = createHash('sha256').update(readFileSync(ACTIVATION_FILE)).digest('hex')
    expect(digest).toBe(PINNED_SHA256)
  })

  // M-1(ii), STRUCTURAL half only: `hasUnavailableFwbNumberMapping` only ever sees `{targetType}`
  // from the CLIENT-SUPPLIED mapping config (`normalizeFwbMappings`) — an L8-C source field's props
  // never reach this function's input at all, by construction (neither function takes a
  // formSchema/props argument). This proves the guard is UNREACHABLE from a source field's display
  // props, not that the real save/execute call sites behave — those are
  // routes/automation.ts:323, automation-service.ts:2063, automation-executor.ts:3043/:3176, and
  // are exercised end-to-end (not simulated) by
  // packages/core-backend/tests/integration/multitable-fwb-activation-realdb.test.ts, whose shared
  // 'amount' source field now carries every L8-C display prop
  // ({ currencySymbol, thousandsSeparator, uppercaseCny, precision }) — see that file's fixture.
  // Its existing named assertions are the save+execute halves of this gate: 'save gate: placement,
  // D1 outcome lock, mapping negatives, confirmation hash, creator authority' (save, ~:371),
  // 'legacy number-mapped rule cannot bypass the resulting-shape gate through setRuleEnabled'
  // (bypass leg, ~:543), and 'execute-time guard rejects a legacy persisted number mapping before
  // claim or record write' (execute, ~:714) — all re-verified green against a real Postgres
  // instance locally with the L8-C-propped fixture in place (18/18 in that file, 15/15 in its
  // update-activation sibling), before AND after this change.
  test('M-1(ii) structural half: neither function accepts a formSchema/props argument — a formatted-number source field cannot reach the guard', () => {
    const sourceFieldWithL8CProps = {
      id: 'amount', type: 'number', label: 'Amount',
      props: { currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true, precision: 2 },
    }
    const numberRaw = [{ formFieldId: sourceFieldWithL8CProps.id, targetFieldId: 'F_AMOUNT', targetType: 'number' }]
    const numberNormalized = normalizeFwbMappings(numberRaw)
    expect(numberNormalized.ok).toBe(true)
    if (!numberNormalized.ok) throw new Error('unreachable')
    expect(hasUnavailableFwbNumberMapping(numberNormalized.mappings)).toBe(true)
    // Positive control: the SAME source field id, mapped to a non-number target, is NOT rejected —
    // the assertion above is target-type-selected, not vacuously true for any input.
    const textRaw = [{ formFieldId: sourceFieldWithL8CProps.id, targetFieldId: 'F_TITLE', targetType: 'text' }]
    const textNormalized = normalizeFwbMappings(textRaw)
    expect(textNormalized.ok).toBe(true)
    if (!textNormalized.ok) throw new Error('unreachable')
    expect(hasUnavailableFwbNumberMapping(textNormalized.mappings)).toBe(false)
  })
})
