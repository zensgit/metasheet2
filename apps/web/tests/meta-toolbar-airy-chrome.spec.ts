import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// Visual-composition lock for the 简约大气 pass: first-row data tools are icon-only
// (title tooltip), rare actions live in 「更多」, primary CTA keeps short text.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  expect(document.querySelectorAll('.meta-toolbar').length).toBe(0)
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'select', options: [{ value: 'a' }] },
]

function mountToolbar() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup: () => () => h(MetaToolbar, {
      fields: FIELDS,
      hiddenFieldIds: [],
      sortRules: [],
      filterRules: [],
      filterConjunction: 'and',
      canCreateRecord: true,
      canExport: true,
      canUndo: true,
      canRedo: true,
      sortFilterDirty: false,
    }),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('MetaToolbar 简约大气 chrome', () => {
  it('keeps Fields / Sort / Filter / Group as icon-only first-row triggers with title tooltips', () => {
    const root = mountToolbar()
    const primary = root.querySelector('.meta-toolbar__primary') as HTMLElement
    for (const title of ['Fields', 'Sort', 'Filter', 'Group']) {
      const btn = primary.querySelector(`button[title="${title}"]`) as HTMLButtonElement
      expect(btn, `expected first-row ${title}`).toBeTruthy()
      expect(btn.classList.contains('meta-toolbar__icon-btn')).toBe(true)
      expect(btn.textContent?.replace(/\s+/g, '')).not.toContain(title)
    }
  })

  it('uses the 13px / 16px / 38px sheet grammar tokens (not EP 14/16 admin density)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, '../src/multitable/components/MetaToolbar.vue'), 'utf-8')
    expect(source).toMatch(/--ms-sheet-toolbar-height,\s*38px/)
    expect(source).toMatch(/--ms-sheet-font-body,\s*13px/)
    expect(source).toMatch(/--ms-sheet-icon-size,\s*16px/)
    expect(source).toMatch(/--ms-sheet-icon-color,\s*#6b7280/)
    const root = mountToolbar()
    const toolbar = root.querySelector('.meta-toolbar') as HTMLElement
    expect(toolbar).toBeTruthy()
  })

  it('keeps the new-record CTA labeled and moves density / fit / print / import / export into 更多', () => {
    const root = mountToolbar()
    const primary = root.querySelector('.meta-toolbar__primary') as HTMLElement
    const panel = root.querySelector('[data-testid="toolbar-more-panel"]') as HTMLElement
    expect(Array.from(primary.querySelectorAll('button')).some((b) => b.textContent?.trim() === '+ New Record')).toBe(true)
    expect(root.querySelector('[data-testid="toolbar-more"]')).toBeTruthy()
    for (const title of ['Row height', 'Auto-fit columns', 'Print', 'Import records', 'Export CSV', 'Export Excel (.xlsx)']) {
      const btn = panel.querySelector(`button[title="${title}"]`) as HTMLButtonElement
      expect(btn, `expected overflow ${title}`).toBeTruthy()
      expect(primary.contains(btn)).toBe(false)
    }
  })
})
