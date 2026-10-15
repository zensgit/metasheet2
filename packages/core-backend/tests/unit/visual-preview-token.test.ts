import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const replay = vi.hoisted(() => ({ used: new Set<string>(), unavailable: false, calls: vi.fn() }))
vi.mock('../../src/auth/embed-jti-store', () => ({ consumeEmbedJti: async (key: string, ttl: number) => {
  replay.calls(key, ttl)
  if (replay.unavailable) throw new Error('Redis unavailable')
  if (replay.used.has(key)) return false
  replay.used.add(key)
  return true
} }))
import { consumeVisualPreviewJti, verifyVisualPreviewToken, visualPreviewJtiKey } from '../../src/auth/visual-preview-token'

const NOW = 2_000_000_000
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const publicRaw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')
const embed = {
  sub: '7', tenant_id: 'tenant', org_id: 'org', part_id: 'part', feature_key: 'bom_multitable',
  embed_origin: 'https://parent.example', aud: 'metasheet2.embed', typ: 'embed',
  jti: 'embed-jti', iat: NOW - 10, exp: NOW + 300,
}
const BASE = {
  ...embed, typ: 'visual_preview', aud: 'metasheet2.visual-preview', jti: 'preview-jti',
  embed_jti: embed.jti, embed_iat: embed.iat, iat: NOW, exp: NOW + 60,
  file_id: 'file', version_id: 'version', checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64),
  media_type: 'image/png', width: 2048, height: 1536, page: 0, version_is_current: true,
}
const OPTIONS = { publicKeysByKid: { key1: publicRaw }, embed, fileId: 'file', versionId: 'version', origin: embed.embed_origin, now: NOW }
function signed(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'key1', ...headerOverrides })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ ...BASE, ...overrides })).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`
}

describe('independent Visual V1 preview capability validation', () => {
  it('constructs only the descriptor from independently verified claims, including historical false', () => {
    for (const current of [true, false]) {
      const descriptor = verifyVisualPreviewToken(signed({ version_is_current: current }), OPTIONS).descriptor
      expect(Object.keys(descriptor)).toEqual([
        'schema_version', 'part_id', 'file_id', 'file_version', 'content_checksum', 'preview_checksum',
        'page', 'preview_width', 'preview_height', 'version_is_current',
      ])
      expect(descriptor).toEqual({
        schema_version: 1, part_id: 'part', file_id: 'file', file_version: 'version',
        content_checksum: BASE.checksum, preview_checksum: BASE.preview_checksum,
        page: 0, preview_width: 2048, preview_height: 1536, version_is_current: current,
      })
    }
  })

  it.each([
    ['typ', 'embed'], ['aud', 'metasheet2.embed'], ['sub', '8'], ['tenant_id', 'other'],
    ['org_id', 'other'], ['part_id', 'other'], ['feature_key', 'other'], ['embed_origin', 'https://other.example'],
    ['jti', undefined], ['jti', 'x'.repeat(65)], ['embed_jti', 'other'], ['embed_iat', NOW],
    ['iat', NOW + 121], ['iat', NOW + 0.5], ['exp', NOW], ['exp', NOW + 0.5], ['exp', NOW + 121],
    ['file_id', 'other'], ['version_id', 'other'], ['checksum', 'A'.repeat(64)], ['checksum', 'sha256:abc'],
    ['preview_checksum', 'B'.repeat(64)], ['preview_checksum', undefined], ['media_type', 'text/html'],
    ['width', true], ['height', false], ['width', 0], ['height', -1], ['width', 0.5],
    ['width', 16_000_001], ['width', Number.MAX_SAFE_INTEGER + 1], ['height', 16_000_000],
    ['page', 1], ['page', false], ['version_is_current', undefined], ['version_is_current', 'true'],
  ])('rejects the independently signed %s mutation (%s)', (field, value) => {
    expect(() => verifyVisualPreviewToken(signed({ [field as string]: value }), OPTIONS)).toThrow()
  })

  it('rejects expiry beyond its original embed and wrong caller selection/origin', () => {
    expect(() => verifyVisualPreviewToken(signed(), { ...OPTIONS, embed: { ...embed, exp: NOW + 30 } })).toThrow()
    for (const overrides of [{ fileId: 'other' }, { versionId: 'other' }, { origin: 'https://other.example' }]) {
      expect(() => verifyVisualPreviewToken(signed(), { ...OPTIONS, ...overrides })).toThrow()
    }
  })

  it('rejects signature, key, algorithm and noncanonical encodings before trusting claims', () => {
    expect(() => verifyVisualPreviewToken(signed({}, { kid: 'unknown' }), OPTIONS)).toThrow()
    expect(() => verifyVisualPreviewToken(signed({}, { alg: 'HS256' }), OPTIONS)).toThrow()
    const token = signed()
    const [header, payload, signature] = token.split('.')
    const broken = Buffer.from(signature, 'base64url'); broken[0] ^= 1
    expect(() => verifyVisualPreviewToken(`${header}.${payload}.${broken.toString('base64url')}`, OPTIONS)).toThrow()
    expect(() => verifyVisualPreviewToken(`${header}.${payload}.${signature}=`, OPTIONS)).toThrow()
    expect(() => verifyVisualPreviewToken('x'.repeat(16_385), OPTIONS)).toThrow()
  })
})

describe('independent preview nonce consumption', () => {
  beforeEach(() => {
    replay.used.clear(); replay.unavailable = false; replay.calls.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  })
  afterEach(() => vi.restoreAllMocks())

  it('consumes one preview exactly once in a separate shared-store namespace', async () => {
    const { claims } = verifyVisualPreviewToken(signed(), OPTIONS)
    expect(await consumeVisualPreviewJti(claims)).toBe(true)
    expect(await consumeVisualPreviewJti(claims)).toBe(false)
    expect(replay.calls).toHaveBeenCalledTimes(2)
    expect(replay.calls).toHaveBeenLastCalledWith(visualPreviewJtiKey(claims), 60)
    expect(visualPreviewJtiKey(claims)).toMatch(/^plm-visual-preview:jti:[a-f0-9]{64}$/)
    expect(visualPreviewJtiKey(claims)).not.toContain('preview-jti')
    const rebound = verifyVisualPreviewToken(signed({ jti: 'preview-jti', embed_jti: 'fresh-embed', embed_iat: NOW - 5 }), {
      ...OPTIONS, embed: { ...embed, jti: 'fresh-embed', iat: NOW - 5 },
    }).claims
    expect(visualPreviewJtiKey(rebound)).toBe(visualPreviewJtiKey(claims))
    expect(await consumeVisualPreviewJti(rebound)).toBe(false)
  })

  it('fails closed on expired authority or shared-store failure', async () => {
    const { claims } = verifyVisualPreviewToken(signed(), OPTIONS)
    expect(await consumeVisualPreviewJti({ ...claims, exp: NOW })).toBe(false)
    expect(replay.calls).not.toHaveBeenCalled()
    replay.unavailable = true
    await expect(consumeVisualPreviewJti(claims)).rejects.toThrow()
  })
})
