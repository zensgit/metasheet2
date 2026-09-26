/**
 * A11 (customer feedback 2026-09-24 #7c) — the multitable AI surfaces render only when the server
 * reports AI available (GET /api/multitable/ai/availability). AI is off on the customer's deployment,
 * so the DEFAULT/absent state must show nothing that can only ever answer AI_BLOCKED.
 *
 * Covered here (component level; the workbench → component wiring is pinned separately in
 * multitable-workbench-ai-availability-wiring.spec.ts):
 *   - resolveAiAvailability is fail-closed (only `{ available: true }` counts);
 *   - client.aiAvailability() GETs the right path;
 *   - MetaFieldManager: collapsed one-line notice + 了解更多 help; no config controls, preview,
 *     bulk fill, usage card (and no usage probe) or formula AI-suggest while unavailable; the
 *     AVAILABLE state still renders all of them;
 *   - a SAVED aiShortcut survives a save while collapsed (never dropped), and a saved config whose
 *     sources were all deleted keeps its toggle + warning reachable so the field can still be saved;
 *   - drawer AI preview/run buttons (MetaRecordFieldsPanel, and through the MetaRecordDrawer shell).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaRecordFieldsPanel from '../src/multitable/components/MetaRecordFieldsPanel.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { resetAiUsageSummarySessionCache, resolveAiAvailability } from '../src/multitable/composables/useAiShortcut'
import { managerLabel } from '../src/multitable/utils/meta-manager-labels'
import { useLocale } from '../src/composables/useLocale'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const AI_CONFIG = {
  kind: 'classify',
  sourceFieldIds: ['fld_src'],
  params: { options: ['A', 'B'], instruction: 'pick one' },
}

function fieldsWithSavedConfig(): MetaField[] {
  return [
    {
      id: 'fld_target',
      name: 'Summary',
      type: 'string',
      property: { aiShortcut: structuredClone(AI_CONFIG), validation: [{ type: 'required' }] },
    } as unknown as MetaField,
    { id: 'fld_src', name: 'Notes', type: 'string', property: {} } as unknown as MetaField,
    { id: 'fld_plain', name: 'Plain', type: 'string', property: {} } as unknown as MetaField,
    { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } } as unknown as MetaField,
  ]
}

interface ManagerOptions {
  fields?: MetaField[]
  aiAvailable?: boolean
  currentRecordId?: string | null
  aiPreviewFn?: (params: { recordId: string; config: unknown }) => Promise<unknown>
  aiUsageSummaryFn?: () => Promise<unknown>
  formulaSuggestFn?: (params: { instruction: string }) => Promise<unknown>
  onUpdateField?: (fieldId: string, input: Record<string, unknown>) => void
  onBulkFill?: (payload: { fieldId: string }) => void
}

let mounted: App | null = null

function mountManager(options: ManagerOptions = {}): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [],
        fields: options.fields ?? fieldsWithSavedConfig(),
        currentRecordId: options.currentRecordId ?? 'rec_1',
        // Omitted entirely when undefined, to exercise the fail-closed DEFAULT.
        ...(options.aiAvailable !== undefined ? { aiAvailable: options.aiAvailable } : {}),
        aiPreviewFn: options.aiPreviewFn ?? vi.fn().mockResolvedValue({ data: { output: 'x' } }),
        aiUsageSummaryFn: options.aiUsageSummaryFn ?? vi.fn().mockResolvedValue({
          callerDayTokens: 1, callerWeekTokens: 2, instanceDayUsd: 0,
          caps: { tenantDailyTokenCap: 100000, tenantWeeklyTokenCap: 500000, accountDailyUsdCap: 10 },
        }),
        formulaSuggestFn: options.formulaSuggestFn ?? vi.fn().mockResolvedValue({ data: { candidate: '1' } }),
        ...(options.onUpdateField ? { onUpdateField: options.onUpdateField } : {}),
        ...(options.onBulkFill ? { onBulkFill: options.onBulkFill } : {}),
      })
    },
  })
  app.mount(container)
  mounted = app
  return container
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function openConfigFor(container: HTMLElement, fieldName: string): Promise<void> {
  const row = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
    .find((candidate) => candidate.querySelector('.meta-field-mgr__name')?.textContent === fieldName)
  expect(row, `field row for ${fieldName}`).toBeTruthy()
  ;(row!.querySelector('[title="Configure"]') as HTMLButtonElement).click()
  await flush()
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('.meta-field-mgr__btn-add'))
    .find((candidate) => candidate.textContent?.includes('Save field settings'))
  expect(button, 'save button').toBeTruthy()
  return button as HTMLButtonElement
}

const q = (c: ParentNode, testId: string) => c.querySelector(`[data-test="${testId}"]`)

/** Every AI control that must NOT render while AI is unavailable (the one-line notice aside). */
const AVAILABLE_ONLY_TEST_IDS = [
  'ai-shortcut-kind',
  'ai-shortcut-instruction',
  'ai-shortcut-preview-btn',
  'ai-bulk-fill-trigger',
  'ai-bulk-fill-trigger-row',
  'ai-usage-card',
  'ai-shortcut-source-fld_src',
]

beforeEach(() => {
  resetAiUsageSummarySessionCache()
  useLocale().setLocale('en')
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('resolveAiAvailability (fail-closed)', () => {
  it('only an explicit { available: true } counts', async () => {
    expect(await resolveAiAvailability(async () => ({ available: true }))).toBe(true)
    for (const body of [{ available: false }, { available: 'true' }, { available: 1 }, {}, null, undefined, 'true', true]) {
      expect(await resolveAiAvailability(async () => body), JSON.stringify(body)).toBe(false)
    }
  })

  it('a rejected call (old backend 404, network, 401), a sync throw or a missing fn is false', async () => {
    expect(await resolveAiAvailability(async () => { throw Object.assign(new Error('Not found'), { status: 404 }) })).toBe(false)
    expect(await resolveAiAvailability(() => { throw new TypeError('client.aiAvailability is not a function') })).toBe(false)
    expect(await resolveAiAvailability(undefined)).toBe(false)
    expect(await resolveAiAvailability(null)).toBe(false)
  })

  it('client.aiAvailability() GETs /api/multitable/ai/availability and returns the flat body', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ available: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const client = new MultitableApiClient({ fetchFn })
    await expect(client.aiAvailability()).resolves.toEqual({ available: false })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('/api/multitable/ai/availability')
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET')
  })
})

describe('MetaFieldManager — AI unavailable (default / false)', () => {
  for (const [label, aiAvailable] of [['prop absent (default)', undefined], ['prop false', false]] as const) {
    it(`${label}: the AI section is one line + 了解更多, nothing else AI renders, no usage probe`, async () => {
      const aiUsageSummaryFn = vi.fn().mockResolvedValue({
        callerDayTokens: 1, callerWeekTokens: 2, instanceDayUsd: 0,
        caps: { tenantDailyTokenCap: 1, tenantWeeklyTokenCap: 1, accountDailyUsdCap: 1 },
      })
      const container = mountManager({ aiAvailable, aiUsageSummaryFn })
      await openConfigFor(container, 'Plain') // a string field WITHOUT a saved config

      const section = q(container, 'ai-shortcut-section')
      expect(section, 'the section itself still renders (it is also the no-config fallback)').toBeTruthy()
      const notice = q(container, 'ai-shortcut-unavailable')
      expect(notice).toBeTruthy()
      expect(notice!.textContent).toContain(managerLabel('field.ai.unavailable', false))
      expect(q(container, 'ai-shortcut-enable'), 'no toggle without a saved config').toBeNull()
      for (const id of AVAILABLE_ONLY_TEST_IDS) expect(q(container, id), id).toBeNull()
      expect(container.querySelector('.meta-field-mgr__ai-header')).toBeNull()
      expect(aiUsageSummaryFn).not.toHaveBeenCalled()
      // The no-config fallback is NOT shown for string fields (the AI section covers that space).
      expect(q(container, 'field-config-no-options')).toBeNull()
    })
  }

  it('了解更多 expands the five-point help (and collapses again)', async () => {
    const container = mountManager()
    await openConfigFor(container, 'Plain')

    expect(q(container, 'ai-shortcut-help')).toBeNull()
    const more = q(container, 'ai-shortcut-learn-more') as HTMLButtonElement
    expect(more.getAttribute('aria-expanded')).toBe('false')
    more.click()
    await nextTick()

    const help = q(container, 'ai-shortcut-help')
    expect(help).toBeTruthy()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const items = Array.from(help!.querySelectorAll('li')).map((li) => li.textContent?.trim())
    expect(items).toEqual([
      managerLabel('field.ai.help.kinds', false),
      managerLabel('field.ai.help.sources', false),
      managerLabel('field.ai.help.preview', false),
      managerLabel('field.ai.help.manual', false),
      managerLabel('field.ai.help.local', false),
    ])

    more.click()
    await nextTick()
    expect(q(container, 'ai-shortcut-help')).toBeNull()
  })

  it('zh: the collapsed line reads 「AI 自动填写未开通：…」 and the help names the four task types', async () => {
    const container = mountManager()
    await openConfigFor(container, 'Plain') // row lookup uses the en "Configure" title
    useLocale().setLocale('zh-CN')
    await flush()

    expect(q(container, 'ai-shortcut-unavailable')!.textContent)
      .toContain('AI 自动填写未开通：需要管理员在服务器接入部署在内网的模型后才能使用')
    ;(q(container, 'ai-shortcut-learn-more') as HTMLButtonElement).click()
    await nextTick()
    const help = q(container, 'ai-shortcut-help')!.textContent ?? ''
    for (const kind of ['摘要', '分类', '提取', '翻译']) expect(help).toContain(kind)
    expect(help).toContain('消耗配额')
    expect(help).toContain('内网')
  })

  it('formula AI-suggest is not rendered even with a formulaSuggestFn wired', async () => {
    const container = mountManager()
    await openConfigFor(container, 'Total')
    expect(q(container, 'formula-suggest')).toBeNull()
  })

  it('a SAVED config: kept notice + toggle stay; config controls, preview and bulk fill do not', async () => {
    const container = mountManager()
    await openConfigFor(container, 'Summary')

    expect(q(container, 'ai-shortcut-unavailable')).toBeTruthy()
    expect(q(container, 'ai-shortcut-saved-kept')).toBeTruthy()
    const enable = q(container, 'ai-shortcut-enable') as HTMLInputElement
    expect(enable).toBeTruthy()
    expect(enable.checked).toBe(true)
    for (const id of AVAILABLE_ONLY_TEST_IDS) expect(q(container, id), id).toBeNull()
  })

  it('a SAVED config survives a save while collapsed — property.aiShortcut is re-emitted, never dropped', async () => {
    const updateSpy = vi.fn()
    const container = mountManager({ onUpdateField: updateSpy })
    await openConfigFor(container, 'Summary')

    saveButton(container).click()
    await flush()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [fieldId, input] = updateSpy.mock.calls[0] as [string, { property: Record<string, unknown> }]
    expect(fieldId).toBe('fld_target')
    expect(input.property.aiShortcut).toEqual(AI_CONFIG)
  })

  it('all saved sources deleted: the save is blocked, but the warning AND the toggle are reachable; unticking unblocks it', async () => {
    const updateSpy = vi.fn()
    const fields = fieldsWithSavedConfig().filter((field) => field.id !== 'fld_src')
    const container = mountManager({ fields, onUpdateField: updateSpy })
    await openConfigFor(container, 'Summary')

    saveButton(container).click()
    await flush()
    expect(updateSpy).not.toHaveBeenCalled()
    const warning = q(container, 'ai-source-deleted-warning')
    expect(warning, 'the warning renders in the collapsed section').toBeTruthy()
    expect(warning!.textContent).toMatch(/turn off the AI shortcut/i)

    const enable = q(container, 'ai-shortcut-enable') as HTMLInputElement
    expect(enable, 'the toggle is the way out while collapsed').toBeTruthy()
    enable.checked = false
    enable.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    saveButton(container).click()
    await flush()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [, input] = updateSpy.mock.calls[0] as [string, { property: Record<string, unknown> }]
    // Explicit user removal = key omission (never aiShortcut:null).
    expect('aiShortcut' in input.property).toBe(false)
  })
})

describe('MetaFieldManager — AI available (aiAvailable: true)', () => {
  it('renders the full section: title, toggle, config, preview, bulk fill, usage card; no collapsed notice', async () => {
    const aiUsageSummaryFn = vi.fn().mockResolvedValue({
      callerDayTokens: 1, callerWeekTokens: 2, instanceDayUsd: 0,
      caps: { tenantDailyTokenCap: 1, tenantWeeklyTokenCap: 1, accountDailyUsdCap: 1 },
    })
    const container = mountManager({ aiAvailable: true, aiUsageSummaryFn })
    await openConfigFor(container, 'Summary')

    expect(q(container, 'ai-shortcut-unavailable')).toBeNull()
    expect(q(container, 'ai-shortcut-saved-kept')).toBeNull()
    expect(container.querySelector('.meta-field-mgr__ai-header')?.textContent).toContain(managerLabel('field.ai.title', false))
    expect(q(container, 'ai-shortcut-enable')).toBeTruthy()
    for (const id of AVAILABLE_ONLY_TEST_IDS) expect(q(container, id), id).toBeTruthy()
    expect(aiUsageSummaryFn).toHaveBeenCalledTimes(1)
  })

  it('formula AI-suggest renders', async () => {
    const container = mountManager({ aiAvailable: true })
    await openConfigFor(container, 'Total')
    expect(q(container, 'formula-suggest')).toBeTruthy()
  })
})

const DRAWER_FIELDS = [
  { id: 'fld_ai', name: 'Summary', type: 'string', property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_src'] } } },
  { id: 'fld_src', name: 'Notes', type: 'string', property: {} },
] as unknown as MetaField[]
const DRAWER_RECORD = { id: 'rec_1', version: 1, data: { fld_ai: 'v', fld_src: 'n' } } as unknown as MetaRecord

function mountPanel(aiAvailable: boolean | undefined, host: 'panel' | 'inspector' | 'drawer'): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const common = {
    record: DRAWER_RECORD,
    fields: DRAWER_FIELDS,
    canEdit: true,
    canComment: false,
    aiShortcut: null,
    ...(aiAvailable !== undefined ? { aiAvailable } : {}),
  }
  const app = createApp({
    render() {
      if (host === 'panel') return h(MetaRecordFieldsPanel, common)
      const shell = { ...common, visible: true, canDelete: false }
      return host === 'inspector' ? h(MetaRecordInspector, shell) : h(MetaRecordDrawer, shell)
    },
  })
  app.mount(container)
  mounted = app
  return container
}

describe('record drawer AI preview/run buttons', () => {
  for (const host of ['panel', 'inspector', 'drawer'] as const) {
    it(`${host}: hidden by default and when unavailable, shown when available`, async () => {
      for (const aiAvailable of [undefined, false]) {
        const container = mountPanel(aiAvailable, host)
        await flush()
        expect(container.querySelector('[data-ai-preview="fld_ai"]'), `${String(aiAvailable)}`).toBeNull()
        expect(container.querySelector('[data-ai-run="fld_ai"]'), `${String(aiAvailable)}`).toBeNull()
        mounted?.unmount()
        mounted = null
        container.remove()
      }
      const container = mountPanel(true, host)
      await flush()
      expect(container.querySelector('[data-ai-preview="fld_ai"]')).toBeTruthy()
      expect(container.querySelector('[data-ai-run="fld_ai"]')).toBeTruthy()
    })
  }
})
