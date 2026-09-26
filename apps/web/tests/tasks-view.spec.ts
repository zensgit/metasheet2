import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

const h = vi.hoisted(() => ({ loadTasksContext: vi.fn() }))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h.loadTasksContext,
}))

import TasksView from '../src/views/tasks/TasksView.vue'

let app: App | null = null
let host: HTMLElement | null = null

async function mountWith(result: unknown): Promise<HTMLElement> {
  h.loadTasksContext.mockResolvedValue(result)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(TasksView)
  app.mount(host)
  await Promise.resolve()
  await nextTick()
  await nextTick()
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  h.loadTasksContext.mockReset()
})

const TESTIDS = [
  'tasks-view-placeholder',
  'tasks-view-org-missing',
  'tasks-view-unavailable',
  'tasks-view-forbidden',
  'tasks-view-error',
] as const

function shown(el: HTMLElement): string[] {
  return TESTIDS.filter((id) => el.querySelector(`[data-testid="${id}"]`) !== null)
}

describe('TasksView renders exactly one block per context state (gates 11/12)', () => {
  it('ready shows the heading and placeholder only', async () => {
    const el = await mountWith({ state: 'ready', orgId: 'org1' })
    expect(shown(el)).toEqual(['tasks-view-placeholder'])
    expect(el.querySelector('h1')?.textContent).toBe('任务')
  })

  it('org_missing shows the organization prompt only', async () => {
    const el = await mountWith({ state: 'org_missing' })
    expect(shown(el)).toEqual(['tasks-view-org-missing'])
  })

  it('unavailable shows the not-enabled message, which differs from the ready render', async () => {
    const el = await mountWith({ state: 'unavailable' })
    expect(shown(el)).toEqual(['tasks-view-unavailable'])
    expect(el.textContent).toContain('任务功能未启用或当前服务不支持')
    const ready = await (async () => {
      app?.unmount()
      host?.remove()
      return mountWith({ state: 'ready', orgId: 'org1' })
    })()
    expect(ready.textContent).not.toContain('任务功能未启用或当前服务不支持')
  })

  it('forbidden shows the permission message only', async () => {
    const el = await mountWith({ state: 'forbidden' })
    expect(shown(el)).toEqual(['tasks-view-forbidden'])
  })

  it('error shows the error message only', async () => {
    const el = await mountWith({ state: 'error' })
    expect(shown(el)).toEqual(['tasks-view-error'])
  })
})
