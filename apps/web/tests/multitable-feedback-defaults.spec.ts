import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, h } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import { resolveCalendarViewConfig } from '../src/multitable/utils/view-config'
import type { MetaField } from '../src/multitable/types'

const fields: MetaField[] = [
  { id: 'amount', name: 'Amount', type: 'number' },
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'start', name: 'Start', type: 'dateTime' },
  { id: 'end', name: 'End', type: 'date' },
]

describe('calendar defaults', () => {
  it.each([fields, [fields[1], fields[0], fields[3], fields[2]]])('selects only date candidates regardless of preceding fields', (...ordered) => {
    const config = resolveCalendarViewConfig(ordered)
    expect(config.dateFieldId).toBe(ordered[2].id)
    expect(config.endDateFieldId).toBe(ordered[3].id)
    expect(config.titleFieldId).toBe('title')
  })

  it('leaves dates unbound without eligible fields', () => {
    expect(resolveCalendarViewConfig(fields.slice(0, 2))).toMatchObject({ dateFieldId: null, endDateFieldId: null, titleFieldId: 'title' })
    expect(resolveCalendarViewConfig([fields[0]])).toMatchObject({ dateFieldId: null, endDateFieldId: null, titleFieldId: null })
  })

  it('uses the single date for both boundaries without a numeric title fallback', () => {
    expect(resolveCalendarViewConfig([fields[0], fields[2]])).toMatchObject({ dateFieldId: 'start', endDateFieldId: 'start', titleFieldId: null })
  })

  it('preserves explicit configuration', () => {
    const config = { dateFieldId: 'end', endDateFieldId: 'start', titleFieldId: 'title', defaultView: 'week', weekStartsOn: 1 }
    expect(resolveCalendarViewConfig(fields, config)).toEqual(config)
  })

  it('renders existing date-selection guidance when no date is available', () => {
    const root = document.createElement('div')
    const app = createApp({ render: () => h(MetaCalendarView, { fields: fields.slice(0, 2), rows: [], loading: false }) })
    try {
      app.mount(root)
      expect(root.querySelector('.meta-calendar__picker p')?.textContent?.trim()).toBeTruthy()
      expect(root.querySelector('.meta-calendar__field-select')).not.toBeNull()
      expect(root.querySelector('.meta-calendar__header')).toBeNull()
    } finally {
      app.unmount()
    }
  })
})

describe('normal creation seed wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/multitable/views/MultitableWorkbench.vue'), 'utf8')

  it('creates sheets with seed explicitly disabled', () => {
    expect(source).toContain('createSheet({ name, baseId: workbench.activeBaseId.value || undefined, seed: false })')
    expect(source).not.toMatch(/seed:\s*true/)
  })

  it('creates bases without opting into demo seeding', () => {
    const handler = source.slice(source.indexOf('async function onCreateBase('), source.indexOf('async function onRenameBase('))
    expect(handler).toContain('workbench.client.createBase({ name })')
    expect(handler).not.toMatch(/seed|createSheet/)
  })
})
