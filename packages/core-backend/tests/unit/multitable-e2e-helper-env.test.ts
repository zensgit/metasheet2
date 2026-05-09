import { afterEach, describe, expect, it, vi } from 'vitest'
import type { APIRequestContext } from '@playwright/test'

const originalEnv = {
  AUTH_TOKEN: process.env.AUTH_TOKEN,
  API_BASE_URL: process.env.API_BASE_URL,
  FE_BASE_URL: process.env.FE_BASE_URL,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function loadHelpers() {
  vi.resetModules()
  return import('../e2e/multitable-helpers')
}

describe('multitable E2E helper environment bootstrap', () => {
  afterEach(() => {
    restoreEnv()
    vi.resetModules()
  })

  it('defaults to local frontend and backend URLs', async () => {
    delete process.env.FE_BASE_URL
    delete process.env.API_BASE_URL

    const helpers = await loadHelpers()

    expect(helpers.FE_BASE_URL).toBe('http://127.0.0.1:8899')
    expect(helpers.API_BASE_URL).toBe('http://localhost:7778')
  })

  it('reads staging URLs from env and strips trailing slashes', async () => {
    process.env.FE_BASE_URL = 'http://127.0.0.1:18081///'
    process.env.API_BASE_URL = 'http://127.0.0.1:18990///'

    const helpers = await loadHelpers()

    expect(helpers.FE_BASE_URL).toBe('http://127.0.0.1:18081')
    expect(helpers.API_BASE_URL).toBe('http://127.0.0.1:18990')
  })

  it('uses AUTH_TOKEN before attempting phase0 login', async () => {
    process.env.AUTH_TOKEN = 'staging-token-from-file'
    const helpers = await loadHelpers()
    const request = {
      post: () => {
        throw new Error('phase0 login should not be called when AUTH_TOKEN is set')
      },
    } as unknown as APIRequestContext

    await expect(helpers.resolveE2EAuthToken(request)).resolves.toBe('staging-token-from-file')
  })

  it('injects tokens into current frontend auth storage keys and legacy smoke keys', async () => {
    const helpers = await loadHelpers()

    expect(helpers.AUTH_STORAGE_KEYS).toEqual([
      'auth_token',
      'jwt',
      'devToken',
      'metasheet_token',
      'token',
    ])
  })
})
