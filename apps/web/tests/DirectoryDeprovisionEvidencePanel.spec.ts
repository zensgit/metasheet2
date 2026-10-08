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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function deprovisionEvent(id: string, status: 'applied' | 'fully_resolved' | 'superseded' = 'applied') {
  return {
    id,
    local_user_id: `user-${id}`,
    access_generation_at_apply: 3,
    status,
    open_effect_count: status === 'applied' ? 1 : 0,
  }
}

function deprovisionEffect(id: string, status: 'applied' | 'reversed' = 'applied') {
  return {
    id,
    effect_type: 'membership_changed',
    status,
    after_active: status !== 'applied',
    access_generation_at_apply: 3,
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
          prospectiveDeactivatedAccountIds: ['account-1', 'account-2'],
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
    expect(root.querySelector('[data-testid="deprovision-preview-scope"]')?.textContent).toMatch(/2 个/)
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

  it('offers explicit compensation only for a superseded deny-row creation effect', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({
          items: [
            {
              id: 'ev-compensate',
              local_user_id: 'u1',
              access_generation_at_apply: 3,
              status: 'superseded',
              open_effect_count: 0,
            },
          ],
        })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({
          items: [
            {
              id: 'fx-creation',
              effect_type: 'grant_changed',
              status: 'superseded',
              after_active: false,
              grant_row_created: true,
              access_generation_at_apply: 3,
            },
          ],
        })
      }
      if (String(url).includes('/compensate-orphan-deny') && init?.method === 'POST') {
        return jsonResponse({
          eventId: 'ev-compensate',
          effectId: 'fx-creation',
          alreadyCompensated: false,
          accessGeneration: 5,
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

    expect(root.querySelector('[data-testid="deprovision-compensation-panel"]')).toBeTruthy()
    const compensate = root.querySelector(
      '[data-testid="deprovision-compensate-orphan-deny"]',
    ) as HTMLButtonElement
    const confirm = root.querySelector(
      '[data-testid="deprovision-compensation-confirm"]',
    ) as HTMLInputElement
    const note = root.querySelector(
      '[data-testid="deprovision-compensation-note"]',
    ) as HTMLTextAreaElement
    expect(compensate.disabled).toBe(true)

    confirm.click()
    note.value = 'owner verified cleanup'
    note.dispatchEvent(new Event('input'))
    await flushUi(2)
    expect(compensate.disabled).toBe(false)
    compensate.click()
    await flushUi()

    const call = apiFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/compensate-orphan-deny'))
    expect(call?.[0]).toContain(
      '/api/admin/directory/deprovision-events/ev-compensate/compensate-orphan-deny',
    )
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      confirm: true,
      note: 'owner verified cleanup',
    })
  })

  it('keeps a mid-refresh event selection and restores that event', async () => {
    const refreshResponse = deferred<ReturnType<typeof jsonResponse>>()
    let eventLoads = 0
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        eventLoads += 1
        if (eventLoads === 2) return refreshResponse.promise
        return jsonResponse({ items: [deprovisionEvent('event-a'), deprovisionEvent('event-b')] })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({ items: [deprovisionEffect(`effect-${String(url).includes('event-a') ? 'a' : 'b'}`)] })
      }
      if (String(url).includes('/reactivate') && init?.method === 'POST') {
        return jsonResponse({ restoreMode: 'rehire', restoredEffectCount: 1 })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const details = Array.from(root.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('详情'))
    details[0]!.click()
    await flushUi()

    const reload = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('加载事件'))!
    reload.click()
    details[1]!.click()
    await flushUi()
    refreshResponse.resolve(
      jsonResponse({ items: [deprovisionEvent('event-a'), deprovisionEvent('event-b')] }),
    )
    await flushUi()

    ;(root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).click()
    await flushUi()
    const restoreCall = apiFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/reactivate'))
    expect(restoreCall?.[0]).toContain('/deprovision-events/event-b/reactivate')
  })

  it('ignores a stale effects response after the selected event changes', async () => {
    const eventAEffects = deferred<ReturnType<typeof jsonResponse>>()
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [deprovisionEvent('event-a'), deprovisionEvent('event-b')] })
      }
      if (String(url).includes('/event-a/effects')) return eventAEffects.promise
      if (String(url).includes('/event-b/effects')) {
        return jsonResponse({ items: [deprovisionEffect('effect-b', 'reversed')] })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const details = Array.from(root.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('详情'))
    details[0]!.click()
    details[1]!.click()
    await flushUi()
    eventAEffects.resolve(jsonResponse({ items: [deprovisionEffect('effect-a')] }))
    await flushUi()

    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('clears old effects when the newly selected event effects request fails', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [deprovisionEvent('event-a'), deprovisionEvent('event-b')] })
      }
      if (String(url).includes('/event-a/effects')) {
        return jsonResponse({ items: [deprovisionEffect('effect-a')] })
      }
      if (String(url).includes('/event-b/effects')) throw new Error('effects unavailable')
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    const details = Array.from(root.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('详情'))
    details[0]!.click()
    await flushUi()
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(false)

    details[1]!.click()
    await flushUi()
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('requires every effect to remain applied before restore', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [deprovisionEvent('event-a')] })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({
          items: [deprovisionEffect('effect-a'), deprovisionEffect('effect-b', 'reversed')],
        })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('详情'))!.click()
    await flushUi()

    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('reloads the selected event effects when the event list is refreshed', async () => {
    let effectsLoads = 0
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        return jsonResponse({ items: [deprovisionEvent('event-a')] })
      }
      if (String(url).includes('/effects')) {
        effectsLoads += 1
        return jsonResponse({
          items: [deprovisionEffect('effect-a', effectsLoads === 1 ? 'applied' : 'reversed')],
        })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('详情'))!.click()
    await flushUi()
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(false)

    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('加载事件'))!.click()
    await flushUi()
    expect(effectsLoads).toBe(2)
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('invalidates selected event effects when the event list refresh fails', async () => {
    let eventLoads = 0
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/deprovision/flags')) {
        return jsonResponse({ enabled: false, maxBatch: 25, policyNote: 'n' })
      }
      if (String(url).includes('/deprovision-events?')) {
        eventLoads += 1
        if (eventLoads === 2) throw new Error('event list unavailable')
        return jsonResponse({ items: [deprovisionEvent('event-a')] })
      }
      if (String(url).includes('/effects')) {
        return jsonResponse({ items: [deprovisionEffect('effect-a')] })
      }
      return jsonResponse({})
    })

    const root = mountPanel({ integrationId: 'integration-1' })
    ;(root.querySelector('[data-testid="deprovision-evidence-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('详情'))!.click()
    await flushUi()
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(false)

    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('加载事件'))!.click()
    await flushUi()
    expect(
      (root.querySelector('[data-testid="deprovision-restore-rehire"]') as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
