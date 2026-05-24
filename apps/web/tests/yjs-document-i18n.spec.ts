import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef, type App } from 'vue'

// Mock socket.io-client so the module under test resolves; the L126
// no-token branch returns before any socket call so the mock body is
// intentionally minimal.
const ioMock = vi.fn(() => ({
  connected: false,
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}))

// Force the no-token branch at useYjsDocument.ts:126 by returning null
// from auth.getToken(). The existing yjs-document-invalidation.spec.ts
// keeps its own mock with a real token; vi.mock is scoped per spec file.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: vi.fn(() => null),
    getCurrentUserId: vi.fn().mockResolvedValue(null),
  }),
}))

import { useYjsDocument } from '../src/multitable/composables/useYjsDocument'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('useYjsDocument i18n (#1803 file-location closure)', () => {
  const { setLocale } = useLocale()
  let app: App<Element> | null = null

  beforeEach(() => {
    ioMock.mockClear()
    setLocale('en')
  })

  afterEach(() => {
    app?.unmount()
    app = null
    setLocale('en')
  })

  function mountDocument(recordId = 'rec_1') {
    let apiRef: ReturnType<typeof useYjsDocument> | null = null
    const recordRef = shallowRef<string | null>(recordId)
    app = createApp(defineComponent({
      setup() {
        apiRef = useYjsDocument(recordRef as any)
        return () => h('div')
      },
    }))
    app.mount(document.createElement('div'))
    return {
      get api() {
        if (!apiRef) throw new Error('api not mounted')
        return apiRef
      },
      recordRef,
    }
  }

  it('T1: surfaces the EN localized "Not authenticated" when the local token is missing', async () => {
    setLocale('en')
    const { api } = mountDocument('rec_token_missing_en')
    await flushUi()

    // L126 returns early before any socket creation; ioMock must not fire.
    expect(ioMock).not.toHaveBeenCalled()
    expect(api.error.value).toBe('Not authenticated')
    expect(api.connected.value).toBe(false)
  })

  it('T2: surfaces the zh localized "未登录" when the local token is missing', async () => {
    setLocale('zh-CN')
    const { api } = mountDocument('rec_token_missing_zh')
    await flushUi()

    expect(ioMock).not.toHaveBeenCalled()
    expect(api.error.value).toBe('未登录')
    expect(api.connected.value).toBe(false)
  })
})
