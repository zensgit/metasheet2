import { describe, expect, it } from 'vitest'
import { sniffImageContentType } from '../../src/services/imageMagicBytes'

// Adversarial review #4044 P2-1: every signature branch and edge guard gets a direct
// unit test — the E2E outdoor-punch path only exercises PNG-hit and text-miss, so a
// regression in any other branch (JPEG being the dominant phone-camera format) would
// 422 every genuine outdoor photo with zero test signal.
describe('sniffImageContentType — signature branches', () => {
  it('detects PNG', () => {
    expect(sniffImageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  })

  it('detects JPEG', () => {
    expect(sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg')
  })

  it('detects GIF (87a and 89a share the GIF8 prefix)', () => {
    expect(sniffImageContentType(Buffer.from('GIF87a', 'ascii'))).toBe('image/gif')
    expect(sniffImageContentType(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif')
  })

  it('detects BMP', () => {
    expect(sniffImageContentType(Buffer.from('BM\x00\x00\x00\x00', 'ascii'))).toBe('image/bmp')
  })

  it('detects WEBP (RIFF at 0 AND WEBP at offset 8)', () => {
    const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'ascii')])
    expect(sniffImageContentType(webp)).toBe('image/webp')
  })

  it('does NOT treat a non-WEBP RIFF container (e.g. WAVE audio) as an image — offset-8 discrimination', () => {
    const wave = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVEfmt ', 'ascii')])
    expect(sniffImageContentType(wave)).toBeUndefined()
  })
})

describe('sniffImageContentType — edge guards (never throws, never indexes out of bounds)', () => {
  it('misses on plain text', () => {
    expect(sniffImageContentType(Buffer.from('not an image', 'utf8'))).toBeUndefined()
  })

  it('misses on a truncated signature (shorter than any full match)', () => {
    expect(sniffImageContentType(Buffer.from([0x89, 0x50]))).toBeUndefined()
    expect(sniffImageContentType(Buffer.from('RIFF', 'ascii'))).toBeUndefined() // RIFF but nothing at offset 8
  })

  it('misses on empty / null / undefined input', () => {
    expect(sniffImageContentType(Buffer.alloc(0))).toBeUndefined()
    expect(sniffImageContentType(null)).toBeUndefined()
    expect(sniffImageContentType(undefined)).toBeUndefined()
  })
})
