import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlmEmbedBomReadTokenClient,
  createPlmEmbedReadTokenClient,
  PlmEmbedBomReadTokenError,
  PlmEmbedBomReadTokenTimeoutError,
} from '../src/services/integration/plmEmbedWriteToken'

const PARENT_ORIGIN = 'https://plm.example'

function restoreParent(original: Window): void {
  Object.defineProperty(window, 'parent', { configurable: true, value: original })
}

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('bom-read embed token client', () => {
  it('posts only a nonce-correlated bom-read request to the pinned parent and keeps the token in memory', async () => {
    const posts: { data: Record<string, unknown>; origin: string }[] = []
    const original = window.postMessage.bind(window)
    window.postMessage = ((data: unknown, origin?: string) => {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
      posts.push({ data: record, origin: String(origin) })
    }) as typeof window.postMessage
    const before = JSON.stringify(localStorage)
    const client = createPlmEmbedBomReadTokenClient(() => PARENT_ORIGIN)
    const pending = client.requestBomReadToken()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.origin).toBe(PARENT_ORIGIN)
    expect(Object.keys(posts[0]?.data ?? {}).sort()).toEqual(['nonce', 'purpose', 'type'])
    expect(posts[0]?.data).toMatchObject({ type: 'plm-embed:token-request', purpose: 'bom-read' })
    expect(JSON.stringify(posts[0]?.data)).not.toContain('yur_')
    expect(JSON.stringify(posts[0]?.data)).not.toContain('Bearer')
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'plm-embed:token-response', nonce: posts[0]?.data.nonce, token: 'embed-token-value' },
      origin: PARENT_ORIGIN,
      source: window.parent,
    }))
    await expect(pending).resolves.toBe('embed-token-value')
    expect(JSON.stringify(localStorage)).toBe(before)
    expect(JSON.stringify(localStorage)).not.toContain('embed-token-value')
    client.dispose()
    window.postMessage = original
  })

  it('rejects a wrong origin, wrong parent, null sender, stale nonce, and a malformed token', async () => {
    const originalParent = window.parent
    const posts: { data: Record<string, unknown> }[] = []
    const parent = {
      postMessage(data: unknown) {
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
        posts.push({ data: record })
      },
    }
    Object.defineProperty(window, 'parent', { configurable: true, value: parent })
    const client = createPlmEmbedBomReadTokenClient(() => PARENT_ORIGIN)
    const pending = client.requestBomReadToken()
    const nonce = posts[0]?.data.nonce
    const deliver = (data: unknown, origin = PARENT_ORIGIN, source: unknown = parent) => {
      window.dispatchEvent(new MessageEvent('message', {
        data,
        origin,
        source: source as Window,
      }))
    }
    deliver({ type: 'plm-embed:token-response', nonce: 'other-nonce', token: 'stale' })
    deliver({ type: 'plm-embed:token-response', nonce, token: 'wrong-origin' }, 'https://evil.example')
    deliver({ type: 'plm-embed:token-response', nonce, token: 'wrong-parent' }, PARENT_ORIGIN, window)
    deliver({ type: 'plm-embed:token-response', nonce, token: 'null-sender' }, PARENT_ORIGIN, null)
    deliver({ type: 'plm-embed:token-response', nonce, token: '' })
    await expect(pending).rejects.toBeInstanceOf(PlmEmbedBomReadTokenError)
    client.dispose()
    restoreParent(originalParent)
  })

  it('times out without replaying the same nonce and does not accept a discussion purpose as this client', async () => {
    vi.useFakeTimers()
    const originalParent = window.parent
    const posts: { data: Record<string, unknown>; origin: string }[] = []
    const parent = {
      postMessage(data: Record<string, unknown>, origin: string) {
        posts.push({ data, origin })
      },
    }
    Object.defineProperty(window, 'parent', { configurable: true, value: parent })
    const bom = createPlmEmbedBomReadTokenClient(() => PARENT_ORIGIN)
    const read = createPlmEmbedReadTokenClient(() => PARENT_ORIGIN)
    const bomPending = bom.requestBomReadToken()
    const readPending = read.requestReadToken()
    expect(posts.map((entry) => entry.data.purpose)).toEqual(['bom-read', 'discussion-read'])
    const bomError = bomPending.then(() => null, (error: unknown) => error)
    const readError = readPending.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(bomError).resolves.toBeInstanceOf(PlmEmbedBomReadTokenTimeoutError)
    const retry = bom.requestBomReadToken()
    expect(posts).toHaveLength(3)
    expect(posts[2]?.data.nonce).not.toBe(posts[0]?.data.nonce)
    expect(posts[2]?.data.purpose).toBe('bom-read')
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'plm-embed:token-response', nonce: posts[2]?.data.nonce, token: 'fresh' },
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
    }))
    await expect(retry).resolves.toBe('fresh')
    read.dispose()
    await expect(readError).resolves.toBeInstanceOf(Error)
    bom.dispose()
    restoreParent(originalParent)
  })
})
