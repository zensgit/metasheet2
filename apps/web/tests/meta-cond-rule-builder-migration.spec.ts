import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import MetaConditionalRuleBuilder from '../src/multitable/components/MetaConditionalRuleBuilder.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaConditionalRuleBuilder's Add + Save controls were migrated from bespoke <button>s to the
// shared MtButton primitive (ghost — they were neutral bordered-white secondary actions, not primary/soft).
// Their bespoke CSS (+ shared :disabled rule) was removed. Behavior-preservation proof: both stay native,
// keyboard-operable <button>s; :disabled bindings survive; clicking Save still runs save →
// client.setConditionalRules. The per-rule Remove stays bespoke.

const flush = (n = 5) => { let p = Promise.resolve(); for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r))); return p }
const fields = [{ id: 'fld_amount', name: 'Amount', type: 'number' as const }]

let app: App | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); container?.remove(); app = null; container = null; useLocale().setLocale('en') })

function mount(client: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp(MetaConditionalRuleBuilder, { sheetId: 's1', fields, client } as never)
  app.mount(container)
}
const q = (sel: string) => container!.querySelector(sel) as HTMLButtonElement | null

describe('MetaConditionalRuleBuilder — MtButton migration (UI-P2-1c)', () => {
  it('renders Add + Save as native <button>s (MtButton)', async () => {
    mount({ getConditionalRules: vi.fn().mockResolvedValue({ rules: [], rejected: [] }), setConditionalRules: vi.fn().mockResolvedValue([]) })
    await flush()
    expect(q('[data-testid="cond-rule-add"]')!.tagName).toBe('BUTTON') // keyboard-operable
    expect(q('[data-testid="cond-rule-save"]')!.tagName).toBe('BUTTON')
  })

  it('clicking Save runs save → client.setConditionalRules (@click unchanged)', async () => {
    const set = vi.fn().mockResolvedValue([])
    mount({ getConditionalRules: vi.fn().mockResolvedValue({ rules: [], rejected: [] }), setConditionalRules: set })
    await flush()
    q('[data-testid="cond-rule-save"]')!.click()
    await flush()
    expect(set).toHaveBeenCalledTimes(1) // @click="save" load-bearing
  })
})
