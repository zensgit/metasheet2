import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewManager } from '../src/services/ViewManager'

describe('ViewManager.submitForm', () => {
  const store: Record<string, string> = {}
  const localStorageMock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
  }

  const originalLocalStorage = globalThis.localStorage as any
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ;(globalThis as any).localStorage = localStorageMock
    Object.keys(store).forEach((key) => delete store[key])
    vi.clearAllMocks()
    vi.stubEnv('VITE_API_URL', 'http://localhost:8900')
  })

  afterEach(() => {
    ;(globalThis as any).localStorage = originalLocalStorage
    globalThis.fetch = originalFetch
    vi.unstubAllEnvs()
  })

  it('passes through legacy success responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'resp_legacy',
          message: '提交成功',
        },
      }),
    } as any)

    const manager = ViewManager.getInstance()
    const response = await manager.submitForm('view_legacy', { fld_title: 'Legacy' })

    expect(response).toEqual({
      success: true,
      data: {
        id: 'resp_legacy',
        message: '提交成功',
      },
    })
  })

  it('normalizes multitable ok responses into legacy FormSubmissionResponse shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          mode: 'create',
          record: {
            id: 'rec_multitable',
            version: 1,
          },
        },
      }),
    } as any)

    const manager = ViewManager.getInstance()
    const response = await manager.submitForm('view_form_ops', { fld_title: 'Meta' })

    expect(response).toEqual({
      success: true,
      data: {
        id: 'rec_multitable',
        message: '提交成功',
      },
    })
  })

  it('normalizes multitable error responses into legacy failure shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
        },
      }),
    } as any)

    const manager = ViewManager.getInstance()
    const response = await manager.submitForm('view_form_ops', { fld_title: '' })

    expect(response).toEqual({
      success: false,
      error: 'Validation failed',
    })
  })
})
