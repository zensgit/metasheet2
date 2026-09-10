import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}))

vi.mock('../src/services/elearningPractice', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningPractice')>(
    '../src/services/elearningPractice',
  )
  return {
    ...actual,
    createElearningPracticeSet: h.create,
    listElearningPracticeSets: h.list,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningPracticeAdminSection from '../src/views/ElearningPracticeAdminSection.vue'

const SET = '11111111-1111-4111-8111-111111111111'
const PAPER = '22222222-2222-4222-8222-222222222222'
const REQUEST_A = '33333333-3333-4333-8333-333333333333'
const REQUEST_B = '44444444-4444-4444-8444-444444444444'
const CREATED = '2026-08-30T01:02:03.456Z'

async function flush(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(root: HTMLElement, testId: string, value: string): void {
  const node = root.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ElearningPracticeAdminSection', () => {
  let app: App<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuid: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    useLocale().setLocale('en')
    h.create.mockReset()
    h.list.mockReset()
    h.list.mockResolvedValue({ practiceSets: [] })
    h.create.mockResolvedValue({
      practiceSetId: SET,
      paperId: PAPER,
      title: 'Safety practice',
      status: 'active',
      createdAt: CREATED,
      duplicate: false,
    })
    uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValue(REQUEST_B)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    uuid?.mockRestore()
  })

  async function mount(): Promise<HTMLElement> {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningPracticeAdminSection)
    app.mount(root)
    await flush()
    return root
  }

  it('creates a set from a published paper and refreshes its closed list', async () => {
    const view = await mount()
    h.list.mockResolvedValueOnce({
      practiceSets: [{
        practiceSetId: SET,
        paperId: PAPER,
        title: 'Safety practice',
        status: 'active',
        createdAt: CREATED,
      }],
    })
    input(view, 'elearning-practice-paper-id', PAPER)
    input(view, 'elearning-practice-title', ' Safety practice ')
    ;(view.querySelector('[data-testid="elearning-practice-create"]') as HTMLButtonElement).click()
    await flush()
    expect(h.create).toHaveBeenCalledWith({
      requestId: REQUEST_A,
      paperId: PAPER,
      title: 'Safety practice',
    })
    expect(view.querySelector('[data-testid="elearning-practice-admin-list"]')?.textContent)
      .toContain('Safety practice')
  })

  it('reuses the request id after failure and rotates it when the logical payload changes', async () => {
    const view = await mount()
    h.create
      .mockRejectedValueOnce(new ElearningApiError('network_error', 0))
      .mockResolvedValue({
        practiceSetId: SET,
        paperId: PAPER,
        title: 'Changed',
        status: 'active',
        createdAt: CREATED,
        duplicate: false,
      })
    input(view, 'elearning-practice-paper-id', PAPER)
    input(view, 'elearning-practice-title', 'Safety practice')
    const button = view.querySelector('[data-testid="elearning-practice-create"]') as HTMLButtonElement
    button.click()
    await flush()
    button.click()
    await flush()
    expect(h.create.mock.calls[0]?.[0].requestId).toBe(REQUEST_A)
    expect(h.create.mock.calls[1]?.[0].requestId).toBe(REQUEST_A)

    input(view, 'elearning-practice-title', 'Changed')
    button.click()
    await flush()
    expect(h.create.mock.calls[2]?.[0].requestId).toBe(REQUEST_B)
  })

  it('fails locally for invalid paper identity without calling the API', async () => {
    const view = await mount()
    input(view, 'elearning-practice-paper-id', 'not-a-uuid')
    input(view, 'elearning-practice-title', 'Safety practice')
    ;(view.querySelector('[data-testid="elearning-practice-create"]') as HTMLButtonElement).click()
    await flush()
    expect(h.create).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="elearning-practice-admin-status"]')?.textContent)
      .toContain('valid published paper ID')
  })
})
