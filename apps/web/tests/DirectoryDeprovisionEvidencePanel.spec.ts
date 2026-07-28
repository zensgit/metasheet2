import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryDeprovisionEvidencePanel from '../src/components/directory/DirectoryDeprovisionEvidencePanel.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => (ok ? { data } : { error: data }),
  }
}

describe('DirectoryDeprovisionEvidencePanel (D7)', () => {
  let app: App<Element> | null = null
  let container: HTMLElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mountPanel(props: { integrationId?: string } = {}) {
    app = createApp(DirectoryDeprovisionEvidencePanel, props)
    app.mount(container!)
    return container!
  }

  it('loads flags banner and shows default-off deprovision state', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({
          enabled: false,
          maxBatch: 25,
          policyNote: '策略≠已执行',
        })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [], flags: { enabled: false, maxBatch: 25, policyNote: 'x' } })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'int-1' })
    await flushUi()
    expect(root.querySelector('[data-testid="deprovision-evidence-collapsed"]')).toBeTruthy()

    const toggle = root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement
    toggle.click()
    await flushUi()

    const banner = root.querySelector('[data-testid="deprovision-flags-banner"]')
    expect(banner?.textContent).toMatch(/false/)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/admin/directory/deprovision/flags')
  })

  it('runs plan preview for a user id', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [] })
      }
      if (String(url).includes('/deprovision/preview/')) {
        return jsonResponse({
          flags: { enabled: false, maxBatch: 25, policyNote: 'n' },
          user: { id: 'u1', activationStatus: 'activated', isActive: true, accessGeneration: 2 },
          plan: {
            skipReason: null,
            effects: [{ type: 'user_changed', beforeActive: true, afterActive: false }],
          },
        })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'int-1' })
    await flushUi()
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()

    const input = root.querySelector('[data-testid="deprovision-preview-user-id"]') as HTMLInputElement
    input.value = 'u1'
    input.dispatchEvent(new Event('input'))
    await flushUi(2)

    const btn = root.querySelector('[data-testid="deprovision-preview-run"]') as HTMLButtonElement
    btn.click()
    await flushUi()

    expect(apiFetchMock.mock.calls.some((c) => (
      String(c[0]).includes('/deprovision/preview/u1')
      && String(c[0]).includes('integrationId=int-1')
    ))).toBe(true)
    expect(root.querySelector('[data-testid="deprovision-preview-result"]')?.textContent).toMatch(/user_changed/)
  })

  it('surfaces DRIFT_CONFLICT on restore failure', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (
        String(url).includes('/deprovision-events?')
        && !String(url).includes('/effects')
        && !String(url).includes('/reactivate')
      ) {
        return jsonResponse({
          items: [
            {
              id: 'ev-1',
              local_user_id: 'u1',
              access_generation_at_apply: 3,
              status: 'applied',
              open_effect_count: 1,
            },
          ],
        })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({
          items: [
            {
              id: 'fx-1',
              effect_type: 'membership_changed',
              status: 'applied',
              after_active: false,
              access_generation_at_apply: 3,
            },
          ],
        })
      }
      if (String(url).includes('/reactivate') && init?.method === 'POST') {
        return jsonResponse({ code: 'DRIFT_CONFLICT', message: 'access_generation mismatch' }, false, 409)
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'int-1' })
    await flushUi()
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()

    const detailBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('详情'))
    expect(detailBtn).toBeTruthy()
    detailBtn!.click()
    await flushUi()

    const rehire = root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement
    rehire.click()
    await flushUi()

    expect(root.querySelector('[data-testid="deprovision-drift-conflict"]')?.textContent).toMatch(/DRIFT_CONFLICT/)
  })

  it('requires applied evidence, explicit confirmation, and an eight-character note before force restore', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({
          items: [
            {
              id: 'ev-1',
              local_user_id: 'u1',
              access_generation_at_apply: 3,
              status: 'applied',
              open_effect_count: 1,
            },
          ],
        })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({
          items: [
            {
              id: 'fx-1',
              effect_type: 'membership_changed',
              status: 'applied',
              after_active: false,
              access_generation_at_apply: 3,
            },
          ],
        })
      }
      if (String(url).includes('/force-reactivate') && init?.method === 'POST') {
        return jsonResponse({
          restoreMode: 'admin_force',
          restoredEffectCount: 1,
        })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'int-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const detailBtn = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('详情'))
    detailBtn!.click()
    await flushUi()

    const force = root.querySelector('[data-testid="deprovision-restore-force"]') as HTMLButtonElement
    const confirm = root.querySelector('[data-testid="deprovision-force-confirm"]') as HTMLInputElement
    const note = root.querySelector('[data-testid="deprovision-force-note"]') as HTMLTextAreaElement
    expect(force.disabled).toBe(true)

    confirm.click()
    note.value = 'short'
    note.dispatchEvent(new Event('input'))
    await flushUi(2)
    expect(force.disabled).toBe(true)

    note.value = 'confirmed by owner'
    note.dispatchEvent(new Event('input'))
    await flushUi(2)
    expect(force.disabled).toBe(false)
    force.click()
    await flushUi()

    const call = apiFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/force-reactivate'))
    expect(call?.[0]).toContain('/api/admin/directory/deprovision-events/ev-1/force-reactivate')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      confirm: true,
      note: 'confirmed by owner',
    })
  })
})
