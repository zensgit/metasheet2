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

import IntegrationHelpView, { INTEGRATION_HELP_GLOSSARY } from '../src/views/IntegrationHelpView.vue'
import { integrationErrorCodeEntries } from '../src/services/integration/errorCodeLabels'
import { useLocale } from '../src/composables/useLocale'

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
    // G12/G41 locale-switch test below flips the shared `useLocale()` singleton state — reset it so
    // a locale change in one test never bleeds into a later test in this same file (module state is
    // NOT reset between `it` blocks by vitest by default).
    useLocale().setLocale('en')
  })

  async function mountView(): Promise<HTMLDivElement> {
    app = createApp(IntegrationHelpView)
    app.mount(container!)
    await flushUi()
    return container!
  }

  it('renders all six sections', async () => {
    const root = await mountView()
    expect(root.querySelector('[data-testid="help-section-glossary"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-case-sql-source"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-case-k3-wise"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-when-to-use"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-error-codes"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="help-section-faq"]')).not.toBeNull()
  })

  // G12/G41 gap-close: the terminology table must be driven by the view's own exported
  // INTEGRATION_HELP_GLOSSARY constant (single-source, same pattern as errorCodeEntries below) — not
  // a hand-typed <tr> list. The literal `.toBe(7)` is the mutation probe: if a future edit deletes a
  // row straight from INTEGRATION_HELP_GLOSSARY, this line goes red even though the row count and the
  // rendered DOM count would still trivially agree with EACH OTHER (both are driven by the same
  // array). Bump this literal deliberately whenever a row is intentionally added/removed.
  it('glossary table renders one row per INTEGRATION_HELP_GLOSSARY entry (single-source, row-count tripwire)', async () => {
    expect(INTEGRATION_HELP_GLOSSARY.length).toBe(7)
    const root = await mountView()
    const rows = root.querySelectorAll('[data-testid="help-glossary-table"] tbody tr')
    expect(rows.length).toBe(INTEGRATION_HELP_GLOSSARY.length)
    for (const entry of INTEGRATION_HELP_GLOSSARY) {
      expect(root.querySelector(`[data-testid="help-glossary-row-${entry.id}"]`)).not.toBeNull()
    }
    // Spot-check the terms the gap analysis explicitly called out as multi-named.
    const ids = INTEGRATION_HELP_GLOSSARY.map((entry) => entry.id)
    expect(ids).toEqual(
      expect.arrayContaining(['connection', 'dataset-object', 'staging-table', 'read-source', 'composition', 'pipeline', 'dead-letter']),
    )
  })

  it('glossary rows carry non-empty alias text grounded in real UI copy', async () => {
    const root = await mountView()
    const connectionRow = root.querySelector('[data-testid="help-glossary-row-connection"]') as HTMLElement
    expect(connectionRow.textContent).toMatch(/adapter/i)
    expect(connectionRow.textContent).toMatch(/connection draft/i)
    const staging = root.querySelector('[data-testid="help-glossary-row-staging-table"]') as HTMLElement
    expect(staging.textContent).toMatch(/staging/i)
  })

  it('case one (SQL read-only source -> multi-dimensional table) anchor and all six step anchors exist', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-case-sql-source"]') as HTMLElement
    expect(section).not.toBeNull()
    for (let i = 1; i <= 6; i += 1) {
      expect(root.querySelector(`[data-testid="help-case-sql-source-step-${i}"]`)).not.toBeNull()
    }
    expect(section.textContent).toMatch(/connectionId/)
    expect(section.textContent).toMatch(/dry-run/i)
    // values-free: no digit-run > 4 anywhere in this section's copy.
    expect(section.textContent).not.toMatch(/\d{5,}/)
  })

  it('case two (K3 WISE preset) anchor and all four step anchors exist, and states the K3 target is permanently read-only', async () => {
    const root = await mountView()
    const section = root.querySelector('[data-testid="help-section-case-k3-wise"]') as HTMLElement
    expect(section).not.toBeNull()
    for (let i = 1; i <= 4; i += 1) {
      expect(root.querySelector(`[data-testid="help-case-k3-wise-step-${i}"]`)).not.toBeNull()
    }
    expect(section.textContent).toMatch(/k3-wise/i)
    // #5597 alignment: K3 is read-only as a target — never phrase this as writable.
    expect(section.textContent).toMatch(/permanently read-only/i)
    // Bounded proximity (not `.*`) so this only catches a regression IN THE SAME SENTENCE — an
    // unbounded pattern would also match unrelated "write"/"back"/"k3" tokens that happen to occur
    // in that relative order elsewhere in the section (false positive), which defeats the point of a
    // guardrail test.
    expect(section.textContent).not.toMatch(/write.{0,40}back.{0,40}k3|save.{0,40}only.{0,40}(push|write).{0,40}k3/i)
  })

  it('case titles switch language when the shared locale switches (zh-CN <-> en)', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountView()
    const caseOneHeading = () => (root.querySelector('[data-testid="help-section-case-sql-source"] h2') as HTMLElement).textContent
    const caseTwoHeading = () => (root.querySelector('[data-testid="help-section-case-k3-wise"] h2') as HTMLElement).textContent
    expect(caseOneHeading()).toContain('SQL 只读源')
    expect(caseTwoHeading()).toContain('K3 WISE 预设')

    useLocale().setLocale('en')
    await flushUi()
    expect(caseOneHeading()).toMatch(/SQL read-only source/i)
    expect(caseTwoHeading()).toMatch(/K3 WISE preset/i)
    expect(caseOneHeading()).not.toContain('只读源')
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

  // G12/G41 added two FAQ entries (read-source-vs-pipeline, permission-visibility) on top of the
  // original 7 — widened from 5-8 to 7-10 to fit; the lower bound still protects against silent
  // deletion and the upper bound is not unbounded, so a runaway FAQ list still fails loudly.
  it('FAQ section renders 7-10 values-free Q&A entries', async () => {
    const root = await mountView()
    const items = root.querySelectorAll('[data-testid="help-section-faq"] [data-testid^="help-faq-question-"]')
    expect(items.length).toBeGreaterThanOrEqual(7)
    expect(items.length).toBeLessThanOrEqual(10)
    const faqSection = root.querySelector('[data-testid="help-section-faq"]') as HTMLElement
    for (const item of Array.from(items)) {
      expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    }
    // values-free: no digit-run > 4 anywhere in the FAQ copy.
    expect(faqSection.textContent).not.toMatch(/\d{5,}/)
    // The two design-lock-named FAQ examples must be present.
    expect(faqSection.textContent).toMatch(/container/i)
    expect(faqSection.textContent).toMatch(/ambiguous|multiple BOMs/i)
    // The two G12/G41 additions must be present, and the permission-visibility answer must NOT
    // hand-copy a permission code list (it should point at the design doc instead).
    expect(faqSection.textContent).toMatch(/read source.*pipeline|pipeline.*read source/i)
    expect(faqSection.textContent).toMatch(/why can't i see|section or button/i)
    expect(faqSection.textContent).not.toMatch(/integration:write|stock-prep:read/)
  })

  it('has a back-to-workbench link in the page header', async () => {
    const root = await mountView()
    const back = root.querySelector('.ms-page-header__back') as HTMLElement | null
    expect(back).not.toBeNull()
  })
})
