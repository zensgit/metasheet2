import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaChartLoadError from '../src/multitable/components/MetaChartLoadError.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaChartLoadError's retry control was migrated from a bespoke <button> to the shared
// MtButton primitive. Interaction-preservation proof: the retry control is still a real, keyboard-
// operable <button> that invokes the `retry` prop callback on click; data-action preserved.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-chart-load-error').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaChartLoadError, props) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const retryBtn = (root: HTMLElement) =>
  root.querySelector('[data-action="retry-chart-load"]') as HTMLButtonElement | null

describe('MetaChartLoadError — MtButton migration (UI-P2-1c)', () => {
  it('renders the retry control as a native <button> with data-action preserved', () => {
    const root = mount({ retry: () => {} })
    const btn = retryBtn(root)
    expect(btn).toBeTruthy()
    expect(btn!.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(btn!.getAttribute('data-action')).toBe('retry-chart-load')
  })

  it('clicking retry invokes the `retry` prop callback (unchanged from pre-migration onRetry)', () => {
    const retry = vi.fn()
    const root = mount({ retry })
    retryBtn(root)!.click()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
