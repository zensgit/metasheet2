/**
 * schedule.interval editor round trip. The stored, scheduler-facing field is `intervalMs`; the editor's input
 * edits minutes (`intervalMinutes`). Pinned:
 *   - load: a rule with only intervalMs shows its period in minutes (90000 ms -> 1.5);
 *   - load: a stale stored intervalMinutes never hides the stored intervalMs (that is what runs);
 *   - save: the payload carries intervalMinutes only — never the stored intervalMs beside it — so the backend
 *     (which converts intervalMinutes to intervalMs and lets minutes win) stores what the user sees or typed;
 *   - an untouched rule opens clean (Test Run is not blocked by a phantom unsaved edit).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [{ id: 'fld_status', name: 'Status', type: 'string' }]

function intervalRule(triggerConfig: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_interval',
    sheetId: 'sheet_1',
    name: 'Every so often',
    triggerType: 'schedule.interval',
    triggerConfig,
    trigger: { type: 'schedule.interval', config: triggerConfig },
    actionType: 'update_record',
    actionConfig: { fields: { fld_status: 'x' } },
    actions: [{ type: 'update_record', config: { fields: { fld_status: 'x' } } }],
    enabled: true,
  } as AutomationRule
}

const mounted: Array<{ unmount: () => void }> = []

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, props) })
  app.mount(container)
  mounted.push(app)
  return { container, app }
}

function minutesInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('[data-field="intervalMinutes"]') as HTMLInputElement | null
  expect(input, 'the interval minutes input renders').toBeTruthy()
  return input as HTMLInputElement
}

async function save(container: HTMLElement) {
  ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
  await flushPromises()
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useLocale().setLocale('en')
})

describe('MetaAutomationRuleEditor — schedule.interval minutes round trip', () => {
  it('a rule with only intervalMs opens in minutes, opens clean, and an untouched save sends minutes only', async () => {
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: intervalRule({ intervalMs: 90_000 }), onSave })
    await flushPromises()

    expect(minutesInput(container).value).toBe('1.5')
    const testBtn = container.querySelector('[data-action="test"]') as HTMLButtonElement
    expect(testBtn.disabled, 'an untouched interval rule is not dirty').toBe(false)
    expect(container.querySelector('[data-field="testRunSavedDirtyHint"]')).toBeFalsy()

    await save(container)
    expect(onSave).toHaveBeenCalledTimes(1)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerType).toBe('schedule.interval')
    expect(payload.triggerConfig).toEqual({ intervalMinutes: 1.5 })
    expect(payload.trigger?.config).toEqual({ intervalMinutes: 1.5 })
  })

  it('typed minutes replace the stored period; the stored intervalMs is not sent beside them', async () => {
    const onSave = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: intervalRule({ intervalMs: 3_600_000 }), onSave })
    await flushPromises()

    const input = minutesInput(container)
    expect(input.value).toBe('60')
    input.value = '5'
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    await save(container)
    const payload = onSave.mock.calls[0][0] as AutomationRule
    expect(payload.triggerConfig).toEqual({ intervalMinutes: 5 })
    expect(payload.triggerConfig).not.toHaveProperty('intervalMs')
  })

  it('a stale stored intervalMinutes beside intervalMs shows the stored intervalMs (the period that runs)', async () => {
    const onSave = vi.fn()
    const { container } = mount({
      visible: true,
      sheetId: 'sheet_1',
      fields,
      rule: intervalRule({ intervalMs: 120_000, intervalMinutes: 10 }),
      onSave,
    })
    await flushPromises()

    expect(minutesInput(container).value).toBe('2')
    await save(container)
    expect((onSave.mock.calls[0][0] as AutomationRule).triggerConfig).toEqual({ intervalMinutes: 2 })
  })

  it('a legacy rule saved with only intervalMinutes opens with those minutes', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, rule: intervalRule({ intervalMinutes: 15 }) })
    await flushPromises()
    expect(minutesInput(container).value).toBe('15')
  })
})
