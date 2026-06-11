/**
 * M4 / Lane B2 — MetaFieldManager NL→formula suggest section (matrix leg
 * M4-T9): describe → generate → candidate → accept fills the expression
 * textarea → Test (dry-run) validates; blocked/quota state UX.
 *
 * The suggest fn is injected as a prop (dryRunFn/aiPreviewFn precedent); the
 * spec asserts the wire shape and the accept→textarea copy, never a real call.
 */
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import type { AiFormulaSuggestOutcome } from '../src/multitable/composables/useAiShortcut'
import type { DryRunResult } from '../src/multitable/api/client'

type SuggestFn = (params: { instruction: string }) => Promise<AiFormulaSuggestOutcome | null>

function candidate(text: string): AiFormulaSuggestOutcome {
  return {
    data: {
      status: 'succeeded',
      action: 'suggest',
      candidate: text,
      usage: { promptTokens: 14, completionTokens: 9 },
      estimatedCostUsd: 0.0005,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
  }
}

async function mountFormulaConfig(opts: {
  formulaSuggestFn?: SuggestFn
  dryRunFn?: (p: { sheetId: string; expression: string; sampleValues: Record<string, unknown>; recordId?: string }) => Promise<DryRunResult>
  aiPreviewBusy?: boolean
} = {}) {
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
          { id: 'fld_price', name: 'Unit Price', type: 'number' },
          { id: 'fld_tax', name: 'Tax Rate', type: 'percent' },
          { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
        ],
        ...(opts.formulaSuggestFn ? { formulaSuggestFn: opts.formulaSuggestFn } : {}),
        ...(opts.dryRunFn ? { dryRunFn: opts.dryRunFn } : {}),
        ...(opts.aiPreviewBusy !== undefined ? { aiPreviewBusy: opts.aiPreviewBusy } : {}),
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

const q = <T extends HTMLElement = HTMLElement>(c: HTMLElement, sel: string) => c.querySelector(sel) as T | null
function setInstruction(c: HTMLElement, value: string) {
  const ta = q<HTMLTextAreaElement>(c, '[data-test="formula-suggest-instruction"]')!
  ta.value = value
  ta.dispatchEvent(new Event('input'))
}
async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }

afterEach(() => { useLocale().setLocale('en'); document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('MetaFieldManager NL→formula suggest (M4)', () => {
  it('the section renders only when a formulaSuggestFn is wired', async () => {
    const { container: without } = await mountFormulaConfig()
    expect(q(without, '[data-test="formula-suggest"]')).toBeNull()

    const { container: withFn } = await mountFormulaConfig({ formulaSuggestFn: vi.fn() })
    expect(q(withFn, '[data-test="formula-suggest"]')).not.toBeNull()
  })

  it('M4-T9: describe → generate → candidate → accept fills the expression textarea', async () => {
    const suggestFn = vi.fn<Parameters<SuggestFn>, ReturnType<SuggestFn>>(async () => candidate('={fld_price}*(1+{fld_tax})'))
    const { container } = await mountFormulaConfig({ formulaSuggestFn: suggestFn })

    // Generate is disabled with an empty instruction.
    const generate = q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!
    expect(generate.disabled).toBe(true)

    setInstruction(container, 'unit price times one plus tax')
    await nextTick()
    expect(generate.disabled).toBe(false)
    generate.click()
    await flush()

    // The fn was called with the trimmed instruction (and NOTHING else — no
    // record id, no values: data minimization is server-side, the wire is just
    // the instruction).
    expect(suggestFn).toHaveBeenCalledTimes(1)
    expect(suggestFn.mock.calls[0][0]).toEqual({ instruction: 'unit price times one plus tax' })

    const code = q(container, '[data-test="formula-suggest-candidate-code"]')!
    expect(code.textContent).toBe('={fld_price}*(1+{fld_tax})')

    // Accept copies the candidate into the expression textarea (no auto-persist).
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-accept"]')!.click()
    await nextTick()
    const expression = q<HTMLTextAreaElement>(container, '.meta-field-mgr__textarea')!
    expect(expression.value).toBe('={fld_price}*(1+{fld_tax})')
    // Candidate block is gone; the "run Test" hint appears.
    expect(q(container, '[data-test="formula-suggest-candidate"]')).toBeNull()
    expect(q(container, '[data-test="formula-suggest-accepted"]')).not.toBeNull()
  })

  it('M4-T9: an accepted candidate validates through the existing Test (dry-run) flow', async () => {
    const suggestFn = vi.fn<Parameters<SuggestFn>, ReturnType<SuggestFn>>(async () => candidate('={fld_price}*2'))
    const dryRunFn = vi.fn(async () => ({
      success: true, result: 84, resultType: 'number', referencedFields: ['fld_price'], diagnostics: [],
    } satisfies DryRunResult))
    const { container } = await mountFormulaConfig({ formulaSuggestFn: suggestFn, dryRunFn })

    setInstruction(container, 'price doubled')
    await nextTick()
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!.click()
    await flush()
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-accept"]')!.click()
    await nextTick()

    // The accepted expression flows into the dry-run/Test button — click it.
    const testBtn = q<HTMLButtonElement>(container, '.meta-field-mgr__dryrun-btn')
    // first dryrun button in the dry-run block: re-query within the dryrun zone
    const dryrunZone = q(container, '.meta-field-mgr__dryrun')!
    ;(dryrunZone.querySelector('.meta-field-mgr__dryrun-btn') as HTMLButtonElement).click()
    await flush()

    expect(dryRunFn).toHaveBeenCalledTimes(1)
    expect(dryRunFn.mock.calls[0][0].expression).toBe('={fld_price}*2')
    expect(testBtn).not.toBeNull()
  })

  it('M4-T9: reject clears the candidate without touching the expression', async () => {
    const suggestFn = vi.fn<Parameters<SuggestFn>, ReturnType<SuggestFn>>(async () => candidate('=BAD()'))
    const { container } = await mountFormulaConfig({ formulaSuggestFn: suggestFn })
    setInstruction(container, 'something')
    await nextTick()
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!.click()
    await flush()
    expect(q(container, '[data-test="formula-suggest-candidate"]')).not.toBeNull()

    q<HTMLButtonElement>(container, '[data-test="formula-suggest-reject"]')!.click()
    await nextTick()
    expect(q(container, '[data-test="formula-suggest-candidate"]')).toBeNull()
    expect(q<HTMLTextAreaElement>(container, '.meta-field-mgr__textarea')!.value).toBe('')
  })

  it('M4-T9: an AI-state error (blocked/quota) renders localized copy, never the raw code', async () => {
    const suggestFn = vi.fn<Parameters<SuggestFn>, ReturnType<SuggestFn>>(async () => ({
      error: { code: 'AI_QUOTA_EXHAUSTED', message: 'AI usage quota exhausted (user_daily_tokens).' },
    }))
    const { container } = await mountFormulaConfig({ formulaSuggestFn: suggestFn })
    setInstruction(container, 'price times tax')
    await nextTick()
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!.click()
    await flush()

    const err = q(container, '[data-test="formula-suggest-error"]')!
    expect(err).not.toBeNull()
    expect(err.textContent).not.toContain('AI_QUOTA_EXHAUSTED') // localized, not the raw code
    expect(err.textContent?.length).toBeGreaterThan(0)
    expect(q(container, '[data-test="formula-suggest-candidate"]')).toBeNull()
  })

  it('M4-T9: a null outcome (unified in-flight guard refused) is a no-op, not an error', async () => {
    const suggestFn = vi.fn<Parameters<SuggestFn>, ReturnType<SuggestFn>>(async () => null)
    const { container } = await mountFormulaConfig({ formulaSuggestFn: suggestFn })
    setInstruction(container, 'price times tax')
    await nextTick()
    q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!.click()
    await flush()

    expect(suggestFn).toHaveBeenCalledTimes(1)
    expect(q(container, '[data-test="formula-suggest-error"]')).toBeNull()
    expect(q(container, '[data-test="formula-suggest-candidate"]')).toBeNull()
  })

  it('M4-T9: aiPreviewBusy (cross-surface in-flight / countdown) disables Generate', async () => {
    const { container } = await mountFormulaConfig({ formulaSuggestFn: vi.fn(), aiPreviewBusy: true })
    setInstruction(container, 'price times tax')
    await nextTick()
    expect(q<HTMLButtonElement>(container, '[data-test="formula-suggest-generate"]')!.disabled).toBe(true)
  })
})
