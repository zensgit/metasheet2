import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'

// The embed page's only data dependencies are the two plm-embed service calls; mock them so the
// tests drive the handshake/state machine directly.
const getPlmEmbedConfigMock = vi.fn()
const getPlmEmbedBomContextMock = vi.fn()
vi.mock('../src/services/integration/plmEmbed', () => ({
  getPlmEmbedConfig: (...args: unknown[]) => getPlmEmbedConfigMock(...args),
  getPlmEmbedBomContext: (...args: unknown[]) => getPlmEmbedBomContextMock(...args),
}))

import PlmEmbedBomReviewView from '../src/views/PlmEmbedBomReviewView.vue'

const PLM_ORIGIN = 'https://plm.example.com'
const EVIL_ORIGIN = 'https://attacker.example.com'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function sampleContext() {
  return {
    part: { part_id: 'P1', item_number: 'ITM-1', name: 'Widget', state: 'Released', generation: 2 },
    source_updated_at: '2026-06-01T00:00:00Z',
    lines: [
      {
        bom_line_id: 'L1',
        level: 1,
        part_id: 'C1',
        item_number: 'ITM-C1',
        name: 'Bolt',
        state: 'Released',
        quantity: 4,
        uom: 'EA',
        refdes: 'B1',
        source_version: 3,
        source_updated_at: '2026-06-01T00:00:00Z',
      },
    ],
  }
}

describe('PlmEmbedBomReviewView — P3-D2 token-bound embed handshake', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    getPlmEmbedConfigMock.mockReset()
    getPlmEmbedBomContextMock.mockReset()
    // default: a single allowlisted PLM origin (never '*')
    getPlmEmbedConfigMock.mockResolvedValue({
      allowedOrigins: [PLM_ORIGIN],
      frameAncestors: `frame-ancestors ${PLM_ORIGIN}`,
    })
    getPlmEmbedBomContextMock.mockResolvedValue({ available: true, entitled: true, context: sampleContext() })
  })

  afterEach(() => {
    if (app) app.unmount()
    app = null
    if (container?.parentNode) container.parentNode.removeChild(container)
    container = null
  })

  function mountView(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(PlmEmbedBomReviewView)
    app.mount(container)
    return container
  }

  function postMessageFromParent(origin: string, data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { origin, data }))
  }

  function tokenMessage(token = 'embed-token-abc'): { type: string; token: string } {
    return { type: 'plm-embed:token', token }
  }

  function state(root: HTMLDivElement): string | null {
    return root.querySelector('[data-testid="plm-embed-bom-state"]')?.getAttribute('data-state') ?? null
  }

  it('waits for a token after config loads and never shows a hand-input Part ID field', async () => {
    const root = mountView()
    await flush()
    expect(state(root)).toBe('awaiting-token')
    // token-bound: there must be NO part input anywhere in the embed surface
    expect(root.querySelector('input')).toBeNull()
    expect(root.querySelector('[data-testid="plm-bom-review-part-input"]')).toBeNull()
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled()
  })

  it('renders the read-only table for a token from an allowlisted origin (part comes from the token)', async () => {
    const root = mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage('embed-token-abc'))
    await flush()
    expect(state(root)).toBe('table')
    expect(root.querySelector('[data-testid="plm-bom-review-row"]')).not.toBeNull()
    // the context call is driven ONLY by the token — no part argument is passed
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledTimes(1)
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledWith('embed-token-abc')
  })

  it('rejects a token from a non-allowlisted origin (stays awaiting, never fetches)', async () => {
    const root = mountView()
    await flush()
    postMessageFromParent(EVIL_ORIGIN, tokenMessage())
    await flush()
    expect(state(root)).toBe('awaiting-token')
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled()
  })

  it('rejects a token whose source window is not the parent, even from an allowlisted origin', async () => {
    const root = mountView()
    await flush()
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    // an allowlisted origin, but the message came from a window that is NOT window.parent
    window.dispatchEvent(new MessageEvent('message', { origin: PLM_ORIGIN, data: tokenMessage(), source: frame.contentWindow }))
    await flush()
    expect(state(root)).toBe('awaiting-token')
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled()
    frame.remove()
  })

  it('accepts a token explicitly sourced from window.parent', async () => {
    const root = mountView()
    await flush()
    window.dispatchEvent(new MessageEvent('message', { origin: PLM_ORIGIN, data: tokenMessage('parent-tok'), source: window.parent }))
    await flush()
    expect(state(root)).toBe('table')
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledWith('parent-tok')
  })

  it('is fail-closed when the allowlist is empty: no origin can deliver a token', async () => {
    getPlmEmbedConfigMock.mockResolvedValue({ allowedOrigins: [], frameAncestors: "frame-ancestors 'none'" })
    const root = mountView()
    await flush()
    expect(state(root)).toBe('not-configured')
    // even a message whose origin matches this frame is rejected when the allowlist is empty
    postMessageFromParent(window.location.origin, tokenMessage())
    await flush()
    expect(state(root)).toBe('not-configured')
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled()
  })

  it('ignores non-token and malformed messages from an allowlisted origin', async () => {
    const root = mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, { type: 'something-else', token: 't' })
    postMessageFromParent(PLM_ORIGIN, { type: 'plm-embed:token' }) // no token
    postMessageFromParent(PLM_ORIGIN, 'not-an-object')
    await flush()
    expect(state(root)).toBe('awaiting-token')
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled()
  })

  it('honors only the first valid token (later tokens are ignored)', async () => {
    mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage('first'))
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage('second'))
    await flush()
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledTimes(1)
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledWith('first')
  })

  it('processes a token posted before /config resolves (buffered, then re-validated)', async () => {
    let resolveConfig: (value: { allowedOrigins: string[]; frameAncestors: string }) => void = () => {}
    getPlmEmbedConfigMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve
      }),
    )
    const root = mountView()
    // token arrives while config is still in flight
    postMessageFromParent(PLM_ORIGIN, tokenMessage('early'))
    await flush()
    expect(getPlmEmbedBomContextMock).not.toHaveBeenCalled() // allowlist not known yet
    resolveConfig({ allowedOrigins: [PLM_ORIGIN], frameAncestors: `frame-ancestors ${PLM_ORIGIN}` })
    await flush()
    expect(getPlmEmbedBomContextMock).toHaveBeenCalledWith('early')
    expect(state(root)).toBe('table')
  })

  it('shows the upgrade state when the tenant is not entitled', async () => {
    getPlmEmbedBomContextMock.mockResolvedValue({ available: true, entitled: false, context: null })
    const root = mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage())
    await flush()
    expect(state(root)).toBe('upgrade')
  })

  it('shows the error state for an entitled+null-context result carrying a transient reason', async () => {
    getPlmEmbedBomContextMock.mockResolvedValue({ available: true, entitled: true, context: null, reason: 'unavailable' })
    const root = mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage())
    await flush()
    expect(state(root)).toBe('error')
    const error = root.querySelector('[data-testid="plm-embed-bom-error"]')
    expect(error?.textContent).toContain('重新打开此嵌入视图以重新授权')
    expect(error?.textContent).not.toContain('重试')
  })

  it('shows the unavailable state when the relay reports the surface is unavailable', async () => {
    getPlmEmbedBomContextMock.mockResolvedValue({ available: false, reason: 'unavailable' })
    const root = mountView()
    await flush()
    postMessageFromParent(PLM_ORIGIN, tokenMessage())
    await flush()
    expect(state(root)).toBe('unavailable')
  })
})
