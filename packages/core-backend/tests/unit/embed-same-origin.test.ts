import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalOrigin,
  embedOriginsForRequest,
  frameAncestorsForRequest,
  isEmbedOriginAllowed,
  requestOwnOrigin,
  type EmbedRequestView,
} from '../../src/auth/embed-config'

function req(headers: Record<string, string | string[]>, protocol = 'http'): EmbedRequestView {
  const lower: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value
  return {
    protocol,
    headers: lower,
    get(name: string) {
      const value = lower[name.toLowerCase()]
      return typeof value === 'string' ? value : undefined
    },
  }
}

afterEach(() => {
  delete process.env.PLM_EMBED_SAME_ORIGIN
  delete process.env.PLM_EMBED_ALLOWED_ORIGINS
})

describe('embed same-origin mode', () => {
  it('flag off is the exact allow-list, including when the request host matches', () => {
    process.env.PLM_EMBED_ALLOWED_ORIGINS = 'https://plm.example.com'
    const tunnel = req({ host: 'tunnel.example', 'x-forwarded-proto': 'https', origin: 'https://tunnel.example' })
    expect(isEmbedOriginAllowed('https://plm.example.com', tunnel)).toBe(true)
    expect(isEmbedOriginAllowed('https://tunnel.example', tunnel)).toBe(false)
    expect(isEmbedOriginAllowed('https://plm.example.com', req({ host: 'other.example', origin: 'https://evil.example' }))).toBe(true)
    expect(embedOriginsForRequest(tunnel)).toEqual(['https://plm.example.com'])
    expect(frameAncestorsForRequest(tunnel)).toBe('frame-ancestors https://plm.example.com')
  })

  it('flag on accepts the request origin and rejects a foreign origin', () => {
    process.env.PLM_EMBED_SAME_ORIGIN = 'true'
    process.env.PLM_EMBED_ALLOWED_ORIGINS = 'https://plm.example.com'
    const tunnel = req({ host: 'tunnel.example', 'x-forwarded-proto': 'https', origin: 'https://tunnel.example' })
    expect(isEmbedOriginAllowed('https://tunnel.example', tunnel)).toBe(true)
    expect(isEmbedOriginAllowed('https://evil.example', tunnel)).toBe(false)
    expect(isEmbedOriginAllowed('https://plm.example.com', tunnel)).toBe(true)
    expect(embedOriginsForRequest(tunnel)).toEqual(['https://plm.example.com', 'https://tunnel.example'])
    expect(frameAncestorsForRequest(tunnel)).toBe("frame-ancestors 'self' https://plm.example.com")
  })

  it('uses a forwarded host only for an internal upstream, and requires the browser Origin', () => {
    process.env.PLM_EMBED_SAME_ORIGIN = 'true'
    const upstream = req({
      host: 'localhost:8900',
      'x-forwarded-host': 'tunnel.example',
      'x-forwarded-proto': 'https',
      origin: 'https://tunnel.example',
    })
    expect(requestOwnOrigin(upstream)).toBe('https://tunnel.example')
    expect(isEmbedOriginAllowed('https://tunnel.example', upstream)).toBe(true)
    const missingOrigin = req({ host: 'backend:8900', 'x-forwarded-host': 'tunnel.example', 'x-forwarded-proto': 'https' })
    expect(isEmbedOriginAllowed('https://tunnel.example', missingOrigin)).toBe(false)
    const renamed = req({
      host: 'tunnel.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      origin: 'https://evil.example',
    })
    expect(requestOwnOrigin(renamed)).toBe('https://tunnel.example')
    expect(isEmbedOriginAllowed('https://evil.example', renamed)).toBe(false)
  })

  it('rejects an ambiguous forwarded proto and a disagreeing port', () => {
    process.env.PLM_EMBED_SAME_ORIGIN = 'true'
    expect(requestOwnOrigin(req({ host: 'tunnel.example', 'x-forwarded-proto': 'https,http' }))).toBeNull()
    expect(requestOwnOrigin(req({ host: 'tunnel.example:8443', 'x-forwarded-host': 'tunnel.example', 'x-forwarded-proto': 'https' }))).toBeNull()
    expect(canonicalOrigin('https://tunnel.example:443')).toBe('https://tunnel.example')
    expect(isEmbedOriginAllowed('https://tunnel.example', req({ host: 'tunnel.example:443', 'x-forwarded-proto': 'https', origin: 'https://tunnel.example' }))).toBe(true)
  })

  it.each(['TRUE', '1', ' true', undefined])('non-exact flag %# does not open the request origin', (value) => {
    if (value === undefined) delete process.env.PLM_EMBED_SAME_ORIGIN
    else process.env.PLM_EMBED_SAME_ORIGIN = value
    const tunnel = req({ host: 'tunnel.example', 'x-forwarded-proto': 'https', origin: 'https://tunnel.example' })
    expect(isEmbedOriginAllowed('https://tunnel.example', tunnel)).toBe(false)
  })
})
