import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, afterEach } from 'vitest'
import { createApp, h, type App } from 'vue'

import EmptyState from '../src/components/status/EmptyState.vue'

// UF-8 (design-lock §3.6 / §6) — state-texture pack contracts:
// 1. EmptyState is the ONE shared empty-state renderer (title required, hint/action optional).
// 2. The two first-paint skeleton adoptions (ApprovalCenterView table area, ApprovalDetailView
//    form+timeline) keep their el-skeleton blocks — a source tripwire so a refactor can't
//    silently drop the loading texture (behavioral loading-flag coverage lives in the views'
//    own specs).

let app: App | null = null
let host: HTMLElement | null = null

function mount(props: Record<string, unknown>, slots?: Record<string, () => unknown>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () => h(EmptyState as never, props, slots),
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

describe('EmptyState (UF-8)', () => {
  it('renders the required title and optional hint', () => {
    const el = mount({ title: '暂无自动化运行记录', hint: '触发一条自动化后这里会出现运行历史' })
    expect(el.querySelector('.ms-empty-state__title')?.textContent).toBe('暂无自动化运行记录')
    expect(el.querySelector('.ms-empty-state__hint')?.textContent).toBe('触发一条自动化后这里会出现运行历史')
  })

  it('omits hint and action blocks when not supplied', () => {
    const el = mount({ title: '空' })
    expect(el.querySelector('.ms-empty-state__hint')).toBeNull()
    expect(el.querySelector('.ms-empty-state__action')).toBeNull()
  })

  it('renders the action slot when provided', () => {
    const el = mount({ title: '空' }, { action: () => h('button', { class: 'go' }, '去创建') })
    expect(el.querySelector('.ms-empty-state__action .go')?.textContent).toBe('去创建')
  })
})

describe('first-paint skeleton tripwire (UF-8)', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')

  it('ApprovalCenterView and ApprovalDetailView keep their el-skeleton first-paint blocks', () => {
    expect(read('src/views/approval/ApprovalCenterView.vue')).toContain('el-skeleton')
    // B3-13: ApprovalDetailView's first-paint skeleton now renders through the shared
    // AsyncStateBlock (state="loading"), which is where its el-skeleton texture lives — the
    // tripwire follows the texture: the view must still mount the block, and the block must
    // still be skeleton-based. Behavioral loading coverage lives in approvalDetailPolish.spec.ts.
    expect(read('src/views/approval/ApprovalDetailView.vue')).toContain('AsyncStateBlock')
    expect(read('src/components/status/AsyncStateBlock.vue')).toContain('el-skeleton')
  })
})
