import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGanttView from '../src/multitable/components/MetaGanttView.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaGanttView's toolbar "Add task" control was migrated from a bespoke <button> to the shared
// MtButton primitive (variant="primary"; the bespoke #2563eb == --ms-color-primary). Its class is unique, so
// the bespoke hex CSS was removed (only the toolbar `align-self` layout kept). Behavior-preservation proof:
// it stays a native, keyboard-operable <button> gated by canCreate; clicking it still runs onQuickCreate →
// emits `create-record` with the SAME date-field payload.

const fields: MetaField[] = [
  { id: 'fld_name', name: 'Name', type: 'string' },
  { id: 'fld_start', name: 'Start', type: 'date' },
  { id: 'fld_end', name: 'End', type: 'date' },
]
const viewConfig = { startFieldId: 'fld_start', endFieldId: 'fld_end', titleFieldId: 'fld_name' }

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-gantt').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaGanttView, { fields, rows: [], loading: false, viewConfig, ...props }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const createBtn = (r: HTMLElement) => r.querySelector('.meta-gantt__create') as HTMLButtonElement | null

describe('MetaGanttView — MtButton migration (UI-P2-1c)', () => {
  it('renders Add-task as a native <button> only when canCreate', () => {
    expect(createBtn(mount({ canCreate: false }))).toBeNull() // v-if="canCreate" preserved
    const root = mount({ canCreate: true })
    expect(createBtn(root)!.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
  })

  it('clicking Add-task runs onQuickCreate → emits `create-record` with the date-field payload (unchanged)', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, onCreateRecord })
    createBtn(root)!.click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    const payload = onCreateRecord.mock.calls[0][0]
    expect(typeof payload).toBe('object')
    expect(payload.fld_start).toBeTruthy() // startFieldId set → onQuickCreate seeds it (handler unchanged)
  })
})
