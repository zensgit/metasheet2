import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import { optionChipTone } from '../src/multitable/utils/option-chip-tone'

describe('grid cell chip wash', () => {
  it('keeps select chips on the ~14% hue wash', () => {
    expect(optionChipTone('#2563eb')).toEqual({
      background: 'rgba(37, 99, 235, 0.14)',
      color: 'rgb(32, 56, 107)',
    })
    expect(optionChipTone(null)).toEqual({ background: '#f3f4f6', color: '#4b5563' })
  })

  it('renders link and person chips without Element Plus solid fills', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h('div', [
          h(MetaCellRenderer, {
            field: { id: 'fld_vendor', name: 'Vendor', type: 'link' },
            value: ['rec_1'],
            linkSummaries: [{ id: 'rec_1', display: 'Acme Supply' }],
          }),
          h(MetaCellRenderer, {
            field: { id: 'fld_owner', name: 'Owner', type: 'person' },
            value: ['user_1'],
            personSummaries: [{ id: 'user_1', display: 'Jamie Park' }],
          }),
          h(MetaCellRenderer, {
            field: { id: 'fld_site', name: 'Site', type: 'location' },
            value: 'Dock 3',
          }),
        ])
      },
    })
    app.mount(container)
    await nextTick()

    expect(container.querySelector('.meta-cell-renderer__link')?.textContent).toContain('Acme Supply')
    expect(container.querySelector('.meta-cell-renderer__person-chip')?.textContent).toContain('Jamie Park')
    expect(container.querySelector('.meta-cell-renderer__person-avatar')?.textContent?.trim()).toBe('J')
    const location = container.querySelector('.meta-cell-renderer__location')
    expect(location?.textContent).toContain('Dock 3')
    expect(location?.textContent).not.toMatch(/\u{1F4CD}/u)
    expect(container.textContent).not.toContain('📍')

    app.unmount()
    container.remove()
  })
})
