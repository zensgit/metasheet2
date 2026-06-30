import { afterEach, describe, expect, it } from 'vitest'
import { embedPublicKeysByKid } from '../../src/auth/embed-config'

const ENV_KEYS = ['YUANTUS_EMBED_PUBLIC_KEYS', 'YUANTUS_EMBED_PUBLIC_KEY', 'YUANTUS_EMBED_KEY_ID']

describe('embedPublicKeysByKid', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
  })

  it('keeps the legacy single-key env shape working', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEY = 'pub-1'
    process.env.YUANTUS_EMBED_KEY_ID = 'kid-1'

    expect(embedPublicKeysByKid()).toEqual({ 'kid-1': 'pub-1' })
  })

  it('defaults the legacy key id when only the public key is configured', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEY = 'pub-1'

    expect(embedPublicKeysByKid()).toEqual({ 'embed-1': 'pub-1' })
  })

  it('accepts a JSON kid-to-public-key map for rotation windows', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = JSON.stringify({
      'embed-old': 'old-pub',
      'embed-new': 'new-pub',
    })

    expect(embedPublicKeysByKid()).toEqual({
      'embed-old': 'old-pub',
      'embed-new': 'new-pub',
    })
  })

  it('trims and drops empty or non-string JSON map entries', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = JSON.stringify({
      ' embed-old ': ' old-pub ',
      'embed-empty': '  ',
      'embed-number': 123,
      '  ': 'blank-kid',
    })

    expect(embedPublicKeysByKid()).toEqual({ 'embed-old': 'old-pub' })
  })

  it('prefers the JSON map over the legacy single-key env when both are set', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = JSON.stringify({ 'embed-new': 'new-pub' })
    process.env.YUANTUS_EMBED_PUBLIC_KEY = 'legacy-pub'
    process.env.YUANTUS_EMBED_KEY_ID = 'legacy-kid'

    expect(embedPublicKeysByKid()).toEqual({ 'embed-new': 'new-pub' })
  })

  it('fails closed on malformed JSON instead of falling back to an old key', () => {
    process.env.YUANTUS_EMBED_PUBLIC_KEYS = '{not-json'
    process.env.YUANTUS_EMBED_PUBLIC_KEY = 'legacy-pub'
    process.env.YUANTUS_EMBED_KEY_ID = 'legacy-kid'

    expect(embedPublicKeysByKid()).toEqual({})
  })
})
