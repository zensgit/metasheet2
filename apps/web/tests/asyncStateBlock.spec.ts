import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'

import AsyncStateBlock from '../src/components/status/AsyncStateBlock.vue'

// B3-13 (approval FE polish) — AsyncStateBlock contracts:
// 1. state="loading" renders one el-skeleton section per `skeletonRows` entry (default one
//    3-row section) and nothing of the empty branch.
// 2. state="empty" composes the shipped EmptyState (title/hint/#action slot) — the two branches
//    are mutually exclusive.
// ElSkeleton is explicitly imported by the component, so the REAL skeleton renders here without
// any stub registration.

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: Record<string, unknown>, slots?: Record<string, () => unknown>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(AsyncStateBlock as never, props, slots),
  })
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

describe('AsyncStateBlock (B3-13)', () => {
  it('loading: renders one skeleton section per skeletonRows entry', () => {
    const el = mount({ state: 'loading', skeletonRows: [3, 6] })
    expect(el.querySelector('[data-async-state="loading"]')).toBeTruthy()
    expect(el.querySelectorAll('.ms-async-state__section')).toHaveLength(2)
    // The real ElSkeleton renders (explicit import — not dependent on global registration).
    expect(el.querySelectorAll('.el-skeleton')).toHaveLength(2)
    // Empty branch absent.
    expect(el.querySelector('[data-async-state="empty"]')).toBeNull()
    expect(el.querySelector('.ms-empty-state')).toBeNull()
  })

  it('loading: defaults to a single 3-row section when skeletonRows is omitted', () => {
    const el = mount({ state: 'loading' })
    expect(el.querySelectorAll('.ms-async-state__section')).toHaveLength(1)
  })

  it('empty: composes EmptyState with title + hint and no skeleton', () => {
    const el = mount({ state: 'empty', title: '未找到该审批', hint: '链接可能有误' })
    expect(el.querySelector('[data-async-state="empty"]')).toBeTruthy()
    expect(el.querySelector('.ms-empty-state__title')?.textContent).toBe('未找到该审批')
    expect(el.querySelector('.ms-empty-state__hint')?.textContent).toBe('链接可能有误')
    expect(el.querySelector('[data-async-state="loading"]')).toBeNull()
    expect(el.querySelector('.el-skeleton')).toBeNull()
  })

  it('empty: falls back to the default title and omits the hint block when not supplied', () => {
    const el = mount({ state: 'empty' })
    expect(el.querySelector('.ms-empty-state__title')?.textContent).toBe('暂无数据')
    expect(el.querySelector('.ms-empty-state__hint')).toBeNull()
  })

  it('empty: renders the #action CTA slot through EmptyState', () => {
    const el = mount(
      { state: 'empty', title: '空' },
      { action: () => h('button', { class: 'cta' }, '返回列表') },
    )
    expect(el.querySelector('.ms-empty-state__action .cta')?.textContent).toBe('返回列表')
  })
})
