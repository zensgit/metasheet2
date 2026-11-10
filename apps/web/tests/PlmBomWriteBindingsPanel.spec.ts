import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const listMock = vi.fn()
const urlMock = vi.fn()
const bindMock = vi.fn()
const unbindMock = vi.fn()
const retryMock = vi.fn()
vi.mock('../src/services/plm/plmBomWriteBindings', () => ({
  listPlmBomWriteBindings: (...args: unknown[]) => listMock(...args),
  getPlmBomWriteManagementUrl: (...args: unknown[]) => urlMock(...args),
  bindPlmBomWriteGrant: (...args: unknown[]) => bindMock(...args),
  unbindPlmBomWriteBinding: (...args: unknown[]) => unbindMock(...args),
  retryPlmBomWriteRetiredRevocations: (...args: unknown[]) => retryMock(...args),
  PlmBomWriteBindingError: class PlmBomWriteBindingError extends Error {
    readonly code: string
    constructor(code: string) {
      super('绑定操作未完成。')
      this.code = code
    }
  },
}))

import PlmBomWriteBindingsPanel from '../src/components/plm/PlmBomWriteBindingsPanel.vue'
import { PlmBomWriteBindingError } from '../src/services/plm/plmBomWriteBindings'

const GRANT = `yuw_${'ab'.repeat(16)}_${'c'.repeat(43)}`
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: 'owner-1',
  metaTenantId: null,
  dataSourceId: 'plm-ds',
  connectionId: 'conn-1',
  subjectId: 'person-1',
  targetOrigin: 'https://plm.example',
  yuantusTenantId: 'yt-1',
  yuantusOrgId: 'yo-1',
  workspaceId: null,
  scopeKind: 'legacy_private',
  grantId: 'abc123',
  generation: 1,
  expiresAt: '2026-12-01T00:00:00.000Z',
  bound: true,
  remoteRevokeState: 'pending',
  previousGrantRevokeState: 'unknown',
}

let app: VueApp | null = null
let container: HTMLDivElement

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(PlmBomWriteBindingsPanel, { dataSourceId: 'plm-ds' })
  app.mount(container)
}

function mountSwitchable(initial: string) {
  const source = ref(initial)
  const Harness = defineComponent({
    name: 'BomBindingSourceHarness',
    setup() {
      return () => h(PlmBomWriteBindingsPanel, { dataSourceId: source.value })
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(Harness)
  app.mount(container)
  return source
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  listMock.mockReset()
  urlMock.mockReset()
  bindMock.mockReset()
  unbindMock.mockReset()
  retryMock.mockReset()
  localStorage.removeItem('auth_token')
  localStorage.clear()
})

describe('PlmBomWriteBindingsPanel', () => {
  it('clears the grant on submit and keeps it out of the page, storage, and returned state', async () => {
    let resolveBind: (value: unknown) => void = () => {}
    bindMock.mockReturnValue(new Promise((resolve) => {
      resolveBind = resolve
    }))
    listMock.mockResolvedValue([ROW])
    urlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
    const logs: unknown[][] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      logs.push(args)
    })
    mount()
    await flush()
    const connection = container.querySelector('[data-testid="plm-bom-write-connection-id"]') as HTMLInputElement
    const input = container.querySelector('[data-testid="plm-bom-write-grant"]') as HTMLInputElement
    const submit = container.querySelector('[data-testid="plm-bom-write-bind"]') as HTMLButtonElement
    expect(connection.value).toBe('')
    expect(submit.disabled).toBe(true)
    input.value = GRANT
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(submit.disabled).toBe(true)
    submit.click()
    expect(bindMock).not.toHaveBeenCalled()
    connection.value = 'personal-fixture'
    connection.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(submit.disabled).toBe(false)
    submit.click()
    await nextTick()
    expect(input.value).toBe('')
    expect(connection.value).toBe('')
    expect(bindMock).toHaveBeenCalledWith('plm-ds', 'personal-fixture', GRANT, expect.any(AbortSignal))
    expect(container.textContent).not.toContain(GRANT)
    expect(container.textContent).not.toContain('personal-fixture')
    expect(JSON.stringify(localStorage)).not.toContain(GRANT)
    expect(JSON.stringify(localStorage)).not.toContain('personal-fixture')
    expect(JSON.stringify(logs)).not.toContain(GRANT)
    resolveBind(ROW)
    await flush()
    expect(container.textContent).not.toContain(GRANT)
    expect(container.textContent).toContain('pending')
    expect(container.textContent).toContain('unknown')
    expect(container.textContent).not.toContain('已吊销')
    const link = container.querySelector('[data-testid="plm-bom-write-management-link"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://plm.example/personal-approval-grants#bom-write')
    expect(link.hash).toBe('#bom-write')
    expect(container.textContent).toContain('解除绑定不会取消已经生效的 BOM 写入')
    expect(container.textContent).toContain('不会取消已经生效的写入')
    spy.mockRestore()
    warn.mockRestore()
  })

  it('clears the grant when the session changes', async () => {
    listMock.mockResolvedValue([])
    urlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
    mount()
    await flush()
    const input = container.querySelector('[data-testid="plm-bom-write-grant"]') as HTMLInputElement
    const connection = container.querySelector('[data-testid="plm-bom-write-connection-id"]') as HTMLInputElement
    input.value = GRANT
    connection.value = 'personal-fixture'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    connection.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    localStorage.setItem('auth_token', 'next-session')
    notifyAuthPrincipalChange()
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()
    expect(input.value).toBe('')
    expect(connection.value).toBe('')
    expect(container.textContent).toContain('登录账号已变更')
    expect(JSON.stringify(localStorage)).not.toContain(GRANT)
  })

  it('tells unbind and revoke retry that applied writes stay applied', async () => {
    listMock.mockResolvedValue([ROW])
    urlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
    unbindMock.mockResolvedValue({ ...ROW, bound: false })
    retryMock.mockResolvedValue(undefined)
    mount()
    await flush()
    ;(container.querySelector('[data-testid="plm-bom-write-unbind"]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent).toContain('解除绑定不会取消已经生效的 BOM 写入')
    ;(container.querySelector('[data-testid="plm-bom-write-revoke-retry"]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent).toContain('重试吊销不会取消已经生效的写入')
    expect(unbindMock).toHaveBeenCalledWith(ROW.id, expect.anything())
    expect(retryMock).toHaveBeenCalled()
  })

  it('aborts a delayed management URL when the data source changes and loads the new source', async () => {
    const urlA = 'https://a.example/personal-approval-grants#bom-write'
    const urlB = 'https://b.example/personal-approval-grants#bom-write'
    const resolvers: Array<{ id: string; signal: AbortSignal | undefined; resolve: (value: string) => void }> = []
    listMock.mockResolvedValue([])
    urlMock.mockImplementation((id: string, signal?: AbortSignal) => new Promise<string>((resolve) => {
      resolvers.push({ id, signal, resolve })
    }))
    const source = mountSwitchable('plm-ds-a')
    await flush()
    expect(resolvers.map((item) => item.id)).toEqual(['plm-ds-a'])
    const first = resolvers[0]
    source.value = 'plm-ds-b'
    await flush()
    expect(first?.signal?.aborted).toBe(true)
    expect(resolvers.map((item) => item.id)).toEqual(['plm-ds-a', 'plm-ds-b'])
    first?.resolve(urlA)
    await flush()
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()
    resolvers[1]?.resolve(urlB)
    await flush()
    const link = container.querySelector('[data-testid="plm-bom-write-management-link"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(urlB)
    expect(link.hash).toBe('#bom-write')
  })

  it('ignores a delayed bind from the previous source and refreshes the new source', async () => {
    const urlA = 'https://a.example/personal-approval-grants#bom-write'
    const urlB = 'https://b.example/personal-approval-grants#bom-write'
    listMock.mockResolvedValue([{ ...ROW, dataSourceId: 'plm-ds-a' }])
    urlMock.mockResolvedValue(urlA)
    const source = mountSwitchable('plm-ds-a')
    await flush()
    let resolveBind: (value: unknown) => void = () => {}
    bindMock.mockReturnValue(new Promise((resolve) => {
      resolveBind = resolve
    }))
    const held: Array<{ id: string; kind: 'list' | 'url'; resolve: (value: unknown) => void }> = []
    listMock.mockImplementation(() => new Promise((resolve) => {
      held.push({ id: 'list', kind: 'list', resolve })
    }))
    urlMock.mockImplementation((id: string) => new Promise((resolve) => {
      held.push({ id, kind: 'url', resolve })
    }))
    const input = container.querySelector('[data-testid="plm-bom-write-grant"]') as HTMLInputElement
    const connection = container.querySelector('[data-testid="plm-bom-write-connection-id"]') as HTMLInputElement
    input.value = GRANT
    connection.value = 'personal-fixture'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    connection.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(container.querySelector('[data-testid="plm-bom-write-bind"]') as HTMLButtonElement).click()
    await nextTick()
    expect(connection.value).toBe('')
    expect(bindMock).toHaveBeenCalledWith('plm-ds-a', 'personal-fixture', GRANT, expect.any(AbortSignal))
    const bindSignal = bindMock.mock.calls[0]?.[3] as AbortSignal
    source.value = 'plm-ds-b'
    await flush()
    expect(bindSignal.aborted).toBe(true)
    expect(input.value).toBe('')
    expect(held.some((item) => item.kind === 'list')).toBe(true)
    resolveBind({ ...ROW, dataSourceId: 'plm-ds-a' })
    await flush()
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()
    expect(container.textContent).not.toContain('person-1')
    held.find((item) => item.kind === 'list')?.resolve([{ ...ROW, dataSourceId: 'plm-ds-b', subjectId: 'person-b' }])
    await flush()
    const nextUrl = held.find((item) => item.kind === 'url' && item.id === 'plm-ds-b')
    expect(nextUrl).toBeTruthy()
    nextUrl?.resolve(urlB)
    await flush()
    const link = container.querySelector('[data-testid="plm-bom-write-management-link"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(urlB)
    expect(container.textContent).toContain('person-b')
    expect(container.textContent).not.toContain('person-1')
    expect(bindMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'PLM_BOM_WRITE_DISABLED',
    'PLM_BOM_WRITE_FORBIDDEN',
    'PLM_BOM_WRITE_UNAVAILABLE',
  ])('keeps owned metadata and unbind when the management URL fails with %s', async (code) => {
    listMock
      .mockResolvedValueOnce([{ ...ROW }])
      .mockResolvedValueOnce([{ ...ROW, bound: false, remoteRevokeState: 'revoked' }])
    urlMock.mockRejectedValue(new PlmBomWriteBindingError(code))
    unbindMock.mockResolvedValue({ ...ROW, bound: false })
    mount()
    await flush()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(urlMock).toHaveBeenCalledWith('plm-ds', expect.any(AbortSignal))
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()
    expect(container.textContent).toContain('person-1')
    expect(container.textContent).toContain('已绑定')
    const unbind = container.querySelector('[data-testid="plm-bom-write-unbind"]') as HTMLButtonElement
    expect(unbind.disabled).toBe(false)
    unbind.click()
    await flush()

    expect(unbindMock).toHaveBeenCalledWith(ROW.id, expect.any(AbortSignal))
    expect(container.textContent).toContain('绑定已解除')
    expect(container.textContent).toContain('未绑定')
    expect(container.textContent).toContain('person-1')
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-write-binding-status"]')?.classList.contains('error')).toBe(false)
  })

  it('clears rows when metadata or the management URL fails authentication', async () => {
    listMock.mockResolvedValue([{ ...ROW }])
    urlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
    mount()
    await flush()
    expect(container.textContent).toContain('person-1')

    urlMock.mockRejectedValue(new PlmBomWriteBindingError('PLM_BOM_WRITE_UNAUTHORIZED'))
    ;(container.querySelector('[data-testid="plm-bom-write-bindings-refresh"]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent).not.toContain('person-1')
    expect(container.querySelector('[data-testid="plm-bom-write-binding-row"]')).toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()

    listMock.mockResolvedValue([{ ...ROW }])
    urlMock.mockResolvedValue('https://plm.example/personal-approval-grants#bom-write')
    ;(container.querySelector('[data-testid="plm-bom-write-bindings-refresh"]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent).toContain('person-1')

    listMock.mockRejectedValue(new PlmBomWriteBindingError('PLM_BOM_WRITE_UNAUTHORIZED'))
    ;(container.querySelector('[data-testid="plm-bom-write-bindings-refresh"]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent).not.toContain('person-1')
    expect(container.querySelector('[data-testid="plm-bom-write-binding-row"]')).toBeNull()
    expect(container.querySelector('[data-testid="plm-bom-write-management-link"]')).toBeNull()
  })
})
