/**
 * The runtime test certificate must always be a cert OpenSSL accepts. Its serial is random, and a DER INTEGER
 * must be positive and minimally encoded: a leading 0x00 in front of a byte below 0x80 is padding that OpenSSL
 * rejects ("illegal padding"). Before the serial was normalized that happened about once in 256 runs, so the
 * TLS suites built on this helper went red at random. These seeds pin the bad cases deterministically.
 */
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { generateRuntimeSelfSignedCert } from '../helpers/runtime-self-signed-cert'

const seeds: Array<[string, number[]]> = [
  ['a zero first byte before a byte below 0x80', [0x00, 0x05, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]],
  ['several zero bytes in front', [0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]],
  ['the top bit set and a zero second byte', [0x80, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]],
  ['all zero bytes', [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]],
  ['all 0xff bytes', [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
]

describe('generateRuntimeSelfSignedCert serial', () => {
  it.each(seeds)('OpenSSL accepts the cert when the random serial has %s', (_label, bytes) => {
    const { cert, key } = generateRuntimeSelfSignedCert('localhost', { serialSeed: Buffer.from(bytes) })
    const parsed = new X509Certificate(cert)
    // 8 bytes, first byte 0x40..0x7f: positive, no padding byte, nothing stripped.
    expect(parsed.serialNumber).toMatch(/^[4-7][0-9A-F]{15}$/)
    expect(() => createSecureContext({ cert, key })).not.toThrow()
  })

  it('does not change the caller-supplied seed', () => {
    const seed = Buffer.from([0x00, 0x05, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
    generateRuntimeSelfSignedCert('localhost', { serialSeed: seed })
    expect([...seed]).toEqual([0x00, 0x05, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
  })

  it('still draws a fresh random serial by default', () => {
    const a = new X509Certificate(generateRuntimeSelfSignedCert('localhost').cert).serialNumber
    const b = new X509Certificate(generateRuntimeSelfSignedCert('localhost').cert).serialNumber
    expect(a).not.toBe(b)
  })
})
