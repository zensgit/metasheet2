import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

// IU-6c (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md,
// #3739): the /help/integration center page. Three sections (when-to-use, error-code table, FAQ);
// the error-code table is the single-source tripwire — it must be driven by the IU-1 label module's
// own registered entries, not a hand-copied list, so a future label add/remove needs zero edits here.

const pushSpy = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

import IntegrationHelpView from '../src/views/IntegrationHelpView.vue'
import { integrationErrorCodeEntries } from '../src/services/integration/errorCodeLabels'

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('IntegrationHelpView (IU-6c)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountView(): Promise<HTMLDivElement> {
    app = createApp(IntegrationHelpView)
    app.mount(container!)
    await flushUi()
    return container!
  }

  it('renders all three sections', async () => {
    const root = await mountView()
    expect(root.querySelector('[data-testid="help-section-when-to-use"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-error-codes"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-faq"]')).not.toBeNull()
  })

  it('when-to-use section explains single-hop read source vs two-hop composition, values-free', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-when-to-use"]') as HTMLElement
    expect(section.textContent).toMatch(/single hop|read source/i)
    expect(section.textContent).toMatch(/two.hop|composition/i)
    // values-free: no digit-run > 4 anywhere in this section's copy (no real material/BOM numbers).
    expect(section.textContent).not.toMatch(/\d{5,}/)
  })

  // Single-source tripwire: the rendered error-code row count must equal the label module's OWN
  // registered entry count. This proves the view iterates the module rather than hand-copying a list
  // — if a future label is added/removed in errorCodeLabels.ts, this test (not a hand-maintained
  // count) stays in sync automatically.
  it('error-code table row count equals the label module registered code count (single-source tripwire)', async () => {
    const root = await mountView()
    const expectedEntries = integrationErrorCodeEntries()
    expect(expectedEntries.length).toBeGreaterThan(0)

    const rows = root.querySelectorAll('[data-testid="help-section-error-codes"] tbody tr')
    expect(rows.length).toBe(expectedEntries.length)

    // Spot-check a couple of known codes actually appear with their label text rendered.
    const ambiguousRow = root.querySelector(
      '[data-testid="help-error-code-row-READ_SOURCE_RESOLVER_AMBIGUOUS"]',
    ) as HTMLElement | null
    expect(ambiguousRow).not.toBeNull()
    expect(ambiguousRow!.textContent).toContain('READ_SOURCE_RESOLVER_AMBIGUOUS')
  })

  it('a planted fake code does NOT appear anywhere in the rendered table', async () => {
    const root = await mountView()
    const table = root.querySelector('[data-testid="help-section-error-codes"]') as HTMLElement
    expect(table.textContent).not.toContain('TOTALLY_MADE_UP_ERROR_CODE_NOT_REAL')
    expect(root.querySelector('[data-testid="help-error-code-row-TOTALLY_MADE_UP_ERROR_CODE_NOT_REAL"]')).toBeNull()
  })

  it('FAQ section renders 5-8 values-free Q&A entries', async () => {
    const root = await mountView()
    const items = root.querySelectorAll('[data-testid="help-section-faq"] [data-testid^="help-faq-question-"]')
    expect(items.length).toBeGreaterThanOrEqual(5)
    expect(items.length).toBeLessThanOrEqual(8)
    const faqSection = root.querySelector('[data-testid="help-section-faq"]') as HTMLElement
    for (const item of Array.from(items)) {
      expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
    // values-free: no digit-run > 4 anywhere in the FAQ copy.
    expect(faqSection.textContent).not.toMatch(/\d{5,}/)
    // The two design-lock-named FAQ examples must be present.
    expect(faqSection.textContent).toMatch(/container/i)
    expect(faqSection.textContent).toMatch(/ambiguous|multiple BOMs/i)
  })

  it('has a back-to-workbench link in the page header', async () => {
    const root = await mountView()
    const back = root.querySelector('.ms-page-header__back') as HTMLElement | null
    expect(back).not.toBeNull()
  })
})
