import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaTemplateCard from '../src/multitable/components/MetaTemplateCard.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaTemplateCard's two card action controls (detail = ghost, install = variant="primary")
// were migrated from bespoke <button>s to the shared MtButton primitive. Their classes are unique (not
// shared), so the bespoke hex CSS was removed; only the install control's layout `flex: 1 1 auto` is kept.
// Behavior-preservation proof: both stay native, keyboard-operable <button>s; the install :disabled binding
// survives; clicking still emits the SAME detail/install events with the SAME template payload.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-template-card').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

const template = {
  id: 't1', name: 'CRM Template', description: 'A CRM starter', category: 'sales', icon: '📊', color: '#2563eb',
  sheets: [{ id: 's1', name: 'Contacts', fields: [], views: [] }],
}

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaTemplateCard, { template, ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const detailBtn = (r: HTMLElement) => r.querySelector('.meta-template-card__detail') as HTMLButtonElement | null
const installBtn = (r: HTMLElement) => r.querySelector('.meta-template-card__install') as HTMLButtonElement

describe('MetaTemplateCard — MtButton migration (UI-P2-1c)', () => {
  it('renders detail + install as native <button>s; install disabled while installing', () => {
    const root = mount({ showDetail: true, installing: true })
    expect(detailBtn(root)!.tagName).toBe('BUTTON') // keyboard-operable
    expect(installBtn(root).tagName).toBe('BUTTON')
    expect(installBtn(root).disabled).toBe(true) // :disabled="installing" preserved
  })

  it('clicking detail emits `detail` with the template (unchanged)', () => {
    const onDetail = vi.fn()
    const root = mount({ showDetail: true }, { onDetail })
    detailBtn(root)!.click()
    expect(onDetail).toHaveBeenCalledTimes(1)
    expect(onDetail.mock.calls[0][0]).toBe(template)
  })

  it('clicking install emits `install` with the template (unchanged)', () => {
    const onInstall = vi.fn()
    const root = mount({}, { onInstall }) // showDetail defaults falsy → detail hidden, install always present
    expect(detailBtn(root)).toBeNull()
    installBtn(root).click()
    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(onInstall.mock.calls[0][0]).toBe(template)
  })
})
