/**
 * FWB activation flags + Q6 fingerprint + D7 decimal exactness (pure / no DB).
 */
import { describe, expect, test } from 'vitest'

import { isFwbRuntimeEnabled, requireFwbActivationForEnabledRule } from '../../src/multitable/approval-fwb-flags'
import { isDurableDeliveryEnabled } from '../../src/multitable/automation-durable-delivery'
import { assertFwbRuntimeActivatable, parseWriteApprovalFormValuesConfig } from '../../src/multitable/approval-fwb-runtime'
import { computeFwbConfigFingerprint } from '../../src/multitable/approval-fwb-confirmation'
import { coerceExactDecimal } from '../../src/multitable/approval-fwb-target-fields'
import { mapApprovalFormValues } from '../../src/multitable/approval-form-value-mapping'

describe('FWB activation flags (default OFF) + staging nuance', () => {
  test('FWB and durable are OFF by default; FWB cannot activate without both', () => {
    const env = {} as NodeJS.ProcessEnv
    expect(isFwbRuntimeEnabled(env)).toBe(false)
    expect(isDurableDeliveryEnabled(env)).toBe(false)
    expect(assertFwbRuntimeActivatable(env)).toMatch(/disabled|APPROVAL_FWB/i)
  })

  test('FWB ON without durable still blocked; both ON allows activation', () => {
    expect(assertFwbRuntimeActivatable({ APPROVAL_FWB_RUNTIME_ENABLED: 'true' } as NodeJS.ProcessEnv)).toMatch(/DURABLE/i)
    expect(
      assertFwbRuntimeActivatable({
        APPROVAL_FWB_RUNTIME_ENABLED: 'true',
        AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  test('disabled-save staging: flags OFF is allowed for enabled=false drafts', () => {
    const envOff = {} as NodeJS.ProcessEnv
    expect(requireFwbActivationForEnabledRule(false, envOff)).toBeNull()
    // Even with FWB ON but durable OFF, a disabled draft is still stageable.
    expect(
      requireFwbActivationForEnabledRule(false, {
        APPROVAL_FWB_RUNTIME_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  test('enabled-save rejected when flags OFF; allowed only when both ON', () => {
    expect(requireFwbActivationForEnabledRule(true, {} as NodeJS.ProcessEnv)).toMatch(/disabled|APPROVAL_FWB/i)
    expect(
      requireFwbActivationForEnabledRule(true, {
        APPROVAL_FWB_RUNTIME_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toMatch(/DURABLE/i)
    expect(
      requireFwbActivationForEnabledRule(true, {
        APPROVAL_FWB_RUNTIME_ENABLED: 'true',
        AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  test('execution gate matches enabled-save (always requires both flags)', () => {
    const envOff = {} as NodeJS.ProcessEnv
    expect(assertFwbRuntimeActivatable(envOff)).toEqual(
      requireFwbActivationForEnabledRule(true, envOff),
    )
  })
})

describe('Q6 fingerprint', () => {
  test('mapping reorder is stable; target/template change invalidates', () => {
    const a = computeFwbConfigFingerprint({
      templateId: 't',
      templateVersionId: 'v1',
      targetBaseId: null,
      targetSheetId: 's',
      mappings: [
        { formFieldId: 'f2', targetFieldId: 'a' },
        { formFieldId: 'f1', targetFieldId: 'b' },
      ],
    })
    const b = computeFwbConfigFingerprint({
      templateId: 't',
      templateVersionId: 'v1',
      targetBaseId: null,
      targetSheetId: 's',
      mappings: [
        { formFieldId: 'f1', targetFieldId: 'b' },
        { formFieldId: 'f2', targetFieldId: 'a' },
      ],
    })
    expect(a).toBe(b)
    const c = computeFwbConfigFingerprint({
      templateId: 't',
      templateVersionId: 'v2',
      targetBaseId: null,
      targetSheetId: 's',
      mappings: [{ formFieldId: 'f1', targetFieldId: 'b' }],
    })
    expect(c).not.toBe(a)
  })
})

describe('D7/Q5 exact decimal (no Number() loss / no rounding)', () => {
  test('accepts exact decimal strings; rejects over-precision', () => {
    expect(coerceExactDecimal('12.34', 2)).toEqual({ ok: true, v: '12.34' })
    expect(coerceExactDecimal('12.340', 2)).toEqual({ ok: true, v: '12.34' }) // trailing zero strip, not round
    expect(coerceExactDecimal('12.345', 2).ok).toBe(false)
    expect((coerceExactDecimal('12.345', 2) as { code: string }).code).toBe('number_precision_exceeded')
    expect(coerceExactDecimal('1e2', undefined).ok).toBe(false)
    expect(coerceExactDecimal({ x: 1 }, undefined).ok).toBe(false)
  })

  test('mapping stores number as decimal string under precision', () => {
    const r = mapApprovalFormValues(
      [{ formFieldId: 'a', targetFieldId: 'n', targetType: 'number', numberPrecision: 2 }],
      { a: '10.50' },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values.n).toBe('10.5')
  })
})

describe('FWB config parse (confirmationId, no type authority)', () => {
  test('accepts identifier mappings + confirmationId; rejects missing confirmation', () => {
    const ok = parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [{ formFieldId: 'f', targetFieldId: 't' }],
      confirmationId: 'fwbc_x',
    })
    expect(ok.ok).toBe(true)
    expect(parseWriteApprovalFormValuesConfig({
      mode: 'create',
      mappings: [{ formFieldId: 'f', targetFieldId: 't' }],
    }).ok).toBe(false)
  })
})
