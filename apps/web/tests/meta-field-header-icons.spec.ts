import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, type App } from 'vue'
import MetaFieldHeader from '../src/multitable/components/MetaFieldHeader.vue'
import { fieldTypeGlyph, fieldTypeHeaderMark } from '../src/multitable/utils/field-type-glyph'
import type { MetaField, MetaFieldType } from '../src/multitable/types'

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
})

function mountHeader(field: MetaField) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup: () => () => h('table', [h('thead', [h('tr', [h(MetaFieldHeader, { field })])])]),
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

describe('field header type marks', () => {
  it('does not render 「?」 for unknown field types (no mark instead)', () => {
    expect(fieldTypeGlyph('not-a-real-type')).toBe('')
    expect(fieldTypeHeaderMark('not-a-real-type')).toEqual({ kind: 'none' })
    const root = mountHeader({
      id: 'f1',
      name: 'Mystery',
      type: 'not-a-real-type' as MetaFieldType,
    })
    const icon = root.querySelector('.meta-field-header__icon')
    expect(icon).toBeNull()
    expect(root.textContent).not.toContain('?')
    expect(root.textContent).toContain('Mystery')
  })

  it('uses a 12px muted outline for known types and drops leftover glyphs / dots', () => {
    expect(fieldTypeHeaderMark('duration')).toEqual({ kind: 'outline', name: 'clock' })
    expect(fieldTypeHeaderMark('select')).toEqual({ kind: 'outline', name: 'filter' })
    expect(fieldTypeHeaderMark('number')).toEqual({ kind: 'none' })

    const duration = mountHeader({ id: 'f2', name: '工时', type: 'duration' })
    const durationIcon = duration.querySelector('.meta-field-header__icon') as HTMLElement | null
    expect(durationIcon).not.toBeNull()
    expect(durationIcon?.textContent).not.toBe('\u23F1')
    expect(durationIcon?.textContent).not.toBe('?')
    expect(duration.querySelector('[data-sheet-icon="clock"]')).not.toBeNull()
    expect(getComputedStyle(durationIcon!).width).toBe('12px')
    expect(getComputedStyle(durationIcon!).height).toBe('12px')

    const select = mountHeader({ id: 'f3', name: 'Status', type: 'select' })
    expect(select.querySelector('.meta-field-header__icon')?.textContent).not.toContain('\u25CF')
    expect(select.querySelector('[data-sheet-icon="filter"]')).not.toBeNull()
    expect(select.textContent).not.toContain('?')

    const number = mountHeader({ id: 'f4', name: 'Qty', type: 'number' })
    expect(number.querySelector('.meta-field-header__icon')).toBeNull()
    expect(number.textContent).toContain('Qty')
    expect(number.textContent).not.toContain('#')
    expect(number.textContent).not.toContain('?')
  })

  it('keeps 12px header text and 16px header padding', () => {
    const header = readFileSync(join(__dirname, '..', 'src/multitable/components/MetaFieldHeader.vue'), 'utf-8')
    expect(header).toMatch(/font-size:\s*var\(--ms-sheet-font-header,\s*12px\)/)
    expect(header).toMatch(/padding:\s*8px 16px/)
    expect(header).toMatch(/\.meta-field-header__icon \{[\s\S]*width:\s*12px; height:\s*12px/)
    expect(header).not.toMatch(/width:\s*var\(--ms-sheet-icon-size,\s*16px\)/)
  })
})
