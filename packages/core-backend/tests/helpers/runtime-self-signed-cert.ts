/**
 * A self-signed TLS certificate generated AT TEST RUNTIME, in memory, with nothing but `node:crypto`.
 *
 * Why not a fixture file: a committed private key trips secret scanning and is a key that lives forever.
 * Why not `openssl` / a npm helper: neither is a dependency of this package, and spawning a CLI makes the
 * test depend on the host. This writes the X.509 DER by hand (P-256 key, ecdsa-with-SHA256, one SAN), signs
 * it with the fresh key, and hands back PEM strings — the key never touches disk.
 *
 * Scope: loopback test servers only. The cert is its own trust anchor (`ca: cert` on the client side).
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...parts: Buffer[]) => tlv(0x30, ...parts)
const set = (...parts: Buffer[]) => tlv(0x31, ...parts)

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number)
  const out: number[] = [arcs[0] * 40 + arcs[1]]
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f]
    let v = arc >> 7
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0')
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

function pem(label: string, der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

export interface RuntimeCert {
  /** PEM certificate — also the client's trust anchor (`ca`). */
  cert: string
  /** PEM PKCS#8 private key, in memory only. */
  key: string
}

export interface RuntimeCertOptions {
  /** Test seam: the 8 random bytes the serial is built from (default: fresh `randomBytes(8)`). */
  serialSeed?: Buffer
}

/** A fresh self-signed certificate for `dnsName`, valid from one hour ago for one day. */
export function generateRuntimeSelfSignedCert(dnsName: string, options: RuntimeCertOptions = {}): RuntimeCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'))
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(dnsName, 'utf8')))))
  const now = Date.now()
  const serial = Buffer.from(options.serialSeed ?? randomBytes(8))
  // DER INTEGER: top bit clear (positive) and first byte non-zero (minimal). A 0x00 before a byte < 0x80 is
  // padding OpenSSL rejects ("illegal padding"); clearing only the top bit hit that about once in 256 runs.
  serial[0] = 0x40 | (serial[0] & 0x3f)
  const extensions = tlv(
    0xa3,
    seq(
      // basicConstraints (critical) CA:TRUE — the cert is its own trust anchor.
      seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
      // subjectAltName: one dNSName.
      seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(dnsName, 'ascii'))))),
    ),
  )
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), // version v3
    tlv(0x02, serial),
    ecdsaWithSha256,
    name, // issuer
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name, // subject
    spki,
    extensions,
  )
  const signature = sign('sha256', tbs, privateKey) // DER-encoded ECDSA signature
  const certDer = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])))
  return {
    cert: pem('CERTIFICATE', certDer),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  }
}
