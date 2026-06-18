import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import MetaConditionalRuleBuilder from '../src/multitable/components/MetaConditionalRuleBuilder.vue'

let app: VueApp | null = null
let container: HTMLDivElement | null = null

async function flush(cycles = 5) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [
  { id: 'fld_status', name: 'Status', type: 'select' },
  { id: 'fld_amount', name: 'Amount', type: 'number' },
  { id: 'fld_link', name: 'Linked', type: 'link' }, // unsupported → hidden from picker
]

function mount(opts: {
  getConditionalRules: ReturnType<typeof vi.fn>
  setConditionalRules: ReturnType<typeof vi.fn>
  flagEnabled?: boolean
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(MetaConditionalRuleBuilder, {
    sheetId: 'sheet_x',
    client: { getConditionalRules: opts.getConditionalRules, setConditionalRules: opts.setConditionalRules } as any,
    fields: FIELDS,
    flagEnabled: opts.flagEnabled ?? true,
  })
  app.mount(container)
}

const q = (sel: string) => container!.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(container!.querySelectorAll(sel)) as HTMLElement[]
function setSelect(sel: string, value: string) {
  const el = q(sel) as HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event('change'))
}
function setInput(sel: string, value: string) {
  const el = q(sel) as HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input'))
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('MetaConditionalRuleBuilder', () => {
  it('builds a rule and saves it with the correct PUT payload (coerced value)', async () => {
    const get = vi.fn().mockResolvedValue({ rules: [], rejected: [] })
    const set = vi.fn().mockImplementation((_s: string, rules: unknown[]) => Promise.resolve(rules))
    mount({ getConditionalRules: get, setConditionalRules: set })
    await flush()

    setSelect('[data-testid="cond-rule-field"]', 'fld_amount') // number field
    await flush()
    setSelect('[data-testid="cond-rule-operator"]', 'gt')
    await flush()
    setInput('[data-testid="cond-rule-value"]', '100')
    await flush()
    ;(q('[data-testid="cond-rule-add"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-testid="cond-rule-save"]') as HTMLButtonElement).click()
    await flush()

    expect(set).toHaveBeenCalledTimes(1)
    const payload = set.mock.calls[0][1] as any[]
    expect(payload).toHaveLength(1)
    expect(payload[0]).toMatchObject({ fieldId: 'fld_amount', operator: 'gt', value: 100, effect: 'deny_read' })
    expect(typeof payload[0].value).toBe('number') // numeric coercion
  })

  it('filters the operator list per field type', async () => {
    const get = vi.fn().mockResolvedValue({ rules: [], rejected: [] })
    mount({ getConditionalRules: get, setConditionalRules: vi.fn() })
    await flush()

    setSelect('[data-testid="cond-rule-field"]', 'fld_amount') // number
    await flush()
    let ops = qa('[data-testid="cond-rule-operator"] option').map((o) => (o as HTMLOptionElement).value)
    expect(ops).toContain('gt')
    expect(ops).not.toContain('contains')

    setSelect('[data-testid="cond-rule-field"]', 'fld_status') // select
    await flush()
    ops = qa('[data-testid="cond-rule-operator"] option').map((o) => (o as HTMLOptionElement).value)
    expect(ops).toContain('contains')
    expect(ops).not.toContain('gt')
  })

  it('hides unsupported field types from the picker', async () => {
    mount({ getConditionalRules: vi.fn().mockResolvedValue({ rules: [], rejected: [] }), setConditionalRules: vi.fn() })
    await flush()
    const fieldOpts = qa('[data-testid="cond-rule-field"] option').map((o) => (o as HTMLOptionElement).value)
    expect(fieldOpts).toContain('fld_status')
    expect(fieldOpts).toContain('fld_amount')
    expect(fieldOpts).not.toContain('fld_link') // 'link' is unsupported
  })

  it('preserves an unknown-field rule on save (no silent loss)', async () => {
    const unknownRule = { id: 'r_old', fieldId: 'fld_deleted', operator: 'eq', value: 'x', effect: 'deny_read' }
    const get = vi.fn().mockResolvedValue({ rules: [unknownRule], rejected: [] })
    const set = vi.fn().mockImplementation((_s: string, rules: unknown[]) => Promise.resolve(rules))
    mount({ getConditionalRules: get, setConditionalRules: set })
    await flush()

    // it renders, flagged as unknown
    expect(q('[data-testid="cond-rule-row-0"]')).toBeTruthy()
    expect(container!.textContent).toContain('fld_deleted')

    ;(q('[data-testid="cond-rule-save"]') as HTMLButtonElement).click()
    await flush()
    const payload = set.mock.calls[0][1] as any[]
    expect(payload.find((r) => r.id === 'r_old')).toBeTruthy() // preserved
  })

  it('deletes a rule', async () => {
    const get = vi.fn().mockResolvedValue({
      rules: [{ id: 'r1', fieldId: 'fld_status', operator: 'eq', value: 'secret', effect: 'deny_read' }],
      rejected: [],
    })
    mount({ getConditionalRules: get, setConditionalRules: vi.fn() })
    await flush()
    expect(q('[data-testid="cond-rule-row-0"]')).toBeTruthy()
    ;(q('[data-testid="cond-rule-remove-0"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-testid="cond-rule-row-0"]')).toBeNull()
  })
})
