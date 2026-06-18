import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'

// 2c-S4 — a stored person assignee whose user is deactivated renders with the muted "inactive" cue
// (read-only; the directory endpoint already excludes inactive users from being re-assignable). The
// chip is still SHOWN (never silently dropped) — only visually marked.

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(defineComponent({ render: () => h(MetaCellRenderer, props) }))
  app.mount(container)
  return { container, app }
}

const personField = { id: 'f', name: 'Owner', type: 'person', property: {} }

describe('MetaCellRenderer person inactive cue (2c-S4)', () => {
  it('marks only the deactivated stored assignee, and still shows it', async () => {
    const { container, app } = mount({
      field: personField,
      value: ['u_active', 'u_gone'],
      personSummaries: [
        { id: 'u_active', display: 'Alice' },
        { id: 'u_gone', display: 'Ghost', inactive: true },
      ],
    })
    await nextTick()
    const chips = container.querySelectorAll('.meta-cell-renderer__person-chip')
    expect(chips.length).toBe(2) // both shown — the inactive one is NOT dropped
    const inactive = container.querySelectorAll('[data-inactive="true"]')
    expect(inactive.length).toBe(1)
    expect((inactive[0] as HTMLElement).textContent).toContain('Ghost')
    expect(inactive[0].classList.contains('meta-cell-renderer__person-chip--inactive')).toBe(true)
    app.unmount(); container.remove()
  })

  it('does not mark active assignees', async () => {
    const { container, app } = mount({
      field: personField,
      value: ['u_active'],
      personSummaries: [{ id: 'u_active', display: 'Alice' }],
    })
    await nextTick()
    expect(container.querySelectorAll('.meta-cell-renderer__person-chip').length).toBe(1)
    expect(container.querySelectorAll('[data-inactive="true"]').length).toBe(0)
    app.unmount(); container.remove()
  })
})
