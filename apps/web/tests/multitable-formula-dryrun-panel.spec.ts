import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import type { DryRunResult } from '../src/multitable/api/client'
import { localizeDryRunDiagnostic } from '../src/multitable/utils/meta-formula-labels'

// Drives MetaFieldManager into formula-config state and exposes the dry-run panel (#5b).
async function mountFormulaConfig(
  dryRunFn: (p: { sheetId: string; expression: string; sampleValues: Record<string, unknown> }) => Promise<DryRunResult>,
  extraFields: Array<{ id: string; name: string; type: string }> = [],
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [],
        // formula field kept LAST so the last Configure button always targets it
        fields: [
          { id: 'fld_price', name: 'Price', type: 'number' },
          ...extraFields,
          { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
        ],
        dryRunFn,
      })
    },
  })
  app.mount(container)
  await nextTick()
  const configs = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
  configs[configs.length - 1]?.click() // the formula field
  await nextTick()
  return { container, app }
}

async function setExpression(container: HTMLElement, expr: string) {
  const ta = container.querySelector('.meta-field-mgr__textarea') as HTMLTextAreaElement
  ta.value = expr
  ta.dispatchEvent(new Event('input'))
  await nextTick()
}
async function setSample(container: HTMLElement, value: string) {
  const input = container.querySelector('.meta-field-mgr__dryrun-sample input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}
const clickEvaluate = (c: HTMLElement) => (c.querySelector('.meta-field-mgr__dryrun-btn') as HTMLButtonElement).click()
async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }

afterEach(() => { useLocale().setLocale('en'); document.body.innerHTML = '' ; vi.restoreAllMocks() })

describe('MetaFieldManager formula dry-run panel (#5b)', () => {
  it('renders LOCALIZED diagnostics, never the raw server message (strict-zero)', async () => {
    const fn = vi.fn().mockResolvedValue({
      success: true, result: 43, resultType: 'number', referencedFields: ['fld_price'],
      diagnostics: [{ severity: 'warning', kind: 'type_mismatch', fieldId: 'fld_price', expectedType: 'number', actualType: 'string', message: 'RAW_SERVER_MESSAGE_DO_NOT_SHOW' }],
    } satisfies DryRunResult)
    const { container } = await mountFormulaConfig(fn)
    await setExpression(container, '={fld_price}+1')
    clickEvaluate(container)
    await flush()
    const zone = container.querySelector('.meta-field-mgr__dryrun-result') as HTMLElement
    expect(zone).not.toBeNull()
    expect(zone.textContent).toContain('43') // success value
    expect(zone.textContent).toContain('fld_price') // localized template interpolates structured context
    expect(zone.textContent).not.toContain('RAW_SERVER_MESSAGE_DO_NOT_SHOW') // never the server message
  })

  it('serializes a numeric sample as a NUMBER and a text sample as a STRING (both branches)', async () => {
    const fn = vi.fn().mockResolvedValue({ success: true, result: 0, resultType: 'number', referencedFields: ['fld_name', 'fld_price'], diagnostics: [] } satisfies DryRunResult)
    const { container } = await mountFormulaConfig(fn, [{ id: 'fld_name', name: 'Name', type: 'string' }])
    await setExpression(container, '=CONCAT({fld_name}, {fld_price})') // refs both; input order = name, price
    const inputs = Array.from(container.querySelectorAll('.meta-field-mgr__dryrun-sample input')) as HTMLInputElement[]
    inputs[0].value = 'hello'; inputs[0].dispatchEvent(new Event('input')) // fld_name (string)
    inputs[1].value = '3.5'; inputs[1].dispatchEvent(new Event('input')) // fld_price (number)
    await nextTick()
    clickEvaluate(container)
    await nextTick()
    const payload = fn.mock.calls[0][0].sampleValues
    expect(payload.fld_price).toBe(3.5) // number (not "3.5")
    expect(payload.fld_name).toBe('hello') // string (not coerced)
    expect(typeof payload.fld_name).toBe('string')
  })

  it('drops a STALE response when the expression changed mid-flight', async () => {
    let resolveFn!: (r: DryRunResult) => void
    const fn = vi.fn().mockReturnValue(new Promise<DryRunResult>((r) => { resolveFn = r }))
    const { container } = await mountFormulaConfig(fn)
    await setExpression(container, '={fld_price}+1')
    clickEvaluate(container) // seq 1, pending
    await nextTick()
    await setExpression(container, '={fld_price}+2') // expression edit → clears result + bumps seq + clears running
    resolveFn({ success: true, result: 1, resultType: 'number', referencedFields: ['fld_price'], diagnostics: [] }) // stale resolve
    await flush()
    expect(container.querySelector('.meta-field-mgr__dryrun-result')).toBeNull() // stale response NOT shown
    // and the panel must RECOVER: button re-enabled, a second Evaluate fires
    const btn = container.querySelector('.meta-field-mgr__dryrun-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    clickEvaluate(container)
    await nextTick()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('serializes a boolean sample as true/false, not "true"', async () => {
    const fn = vi.fn().mockResolvedValue({ success: true, result: 1, resultType: 'number', referencedFields: ['fld_flag'], diagnostics: [] } satisfies DryRunResult)
    const { container } = await mountFormulaConfig(fn, [{ id: 'fld_flag', name: 'Flag', type: 'boolean' }])
    await setExpression(container, '=IF({fld_flag}, 1, 0)')
    await setSample(container, 'true') // single referenced field → first input
    clickEvaluate(container)
    await nextTick()
    expect(fn.mock.calls[0][0].sampleValues).toEqual({ fld_flag: true }) // boolean, not the string "true"
  })

  it('a dry-run runtime error does NOT disable Save (dry-run is informational only)', async () => {
    const fn = vi.fn().mockResolvedValue({
      success: false, result: '#DIV/0!', referencedFields: ['fld_price'],
      diagnostics: [{ severity: 'error', kind: 'runtime', code: '#DIV/0!', message: 'x' }],
    } satisfies DryRunResult)
    const { container } = await mountFormulaConfig(fn)
    await setExpression(container, '={fld_price}/0') // syntactically valid
    clickEvaluate(container)
    await flush()
    const saveBtn = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings'))
    expect(saveBtn).toBeTruthy()
    expect(saveBtn!.disabled).toBe(false) // dry-run error must not gate save
  })

  it('clears sample values on reopen — they are ephemeral (C1)', async () => {
    const fn = vi.fn().mockResolvedValue({ success: true, result: 0, resultType: 'number', referencedFields: ['fld_price'], diagnostics: [] } satisfies DryRunResult)
    const { container } = await mountFormulaConfig(fn)
    await setExpression(container, '={fld_price}+1')
    await setSample(container, '99')
    expect((container.querySelector('.meta-field-mgr__dryrun-sample input') as HTMLInputElement).value).toBe('99')
    // reopen the formula field's config → resetDrafts() clears the ephemeral dry-run state
    const configs = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
    configs[configs.length - 1].click()
    await nextTick()
    await setExpression(container, '={fld_price}+1') // expression reloads empty on reopen; re-enter it
    const input = container.querySelector('.meta-field-mgr__dryrun-sample input') as HTMLInputElement
    expect(input.value).toBe('') // NOT the stale '99'
  })

  it('localizer never returns the server message, even for an unknown future kind', () => {
    const known = localizeDryRunDiagnostic({ kind: 'unknown_field', fieldId: 'fld_x' }, false)
    expect(known).toContain('fld_x')
    // a kind the client doesn't know → localized generic fallback (raw kind token), NEVER the message
    const future = localizeDryRunDiagnostic({ kind: 'some_future_kind' }, true)
    expect(future).toContain('some_future_kind')
    expect(future).toBe('诊断：some_future_kind')
  })
})
