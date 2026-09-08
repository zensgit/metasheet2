import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaFieldHeader from '../src/multitable/components/MetaFieldHeader.vue'
import { fieldTypeGlyph } from '../src/multitable/utils/field-type-glyph'
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

describe('field header type glyphs', () => {
  it('does not render 「?」 for unknown field types (no icon instead)', () => {
    expect(fieldTypeGlyph('not-a-real-type')).toBe('')
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

  it('keeps a quiet glyph for known types including duration', () => {
    expect(fieldTypeGlyph('duration')).toBe('\u23F1')
    const root = mountHeader({ id: 'f2', name: '工时', type: 'duration' })
    const icon = root.querySelector('.meta-field-header__icon')
    expect(icon?.textContent).toBe('\u23F1')
    expect(icon?.textContent).not.toBe('?')
  })
})
