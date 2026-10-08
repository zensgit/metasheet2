/**
 * W4C-2 Gate D2 (#4556 / #4844) — the live-punch payload fingerprint's domain separator is pinned
 * BY BYTES, and its digest is pinned against an INDEPENDENT oracle.
 *
 * WHY THIS EXISTS. The domain string ends in a NUL. It was originally written as a RAW 0x00 byte in
 * the `.ts` source, which made `file(1)` classify the module as `data` and `grep`/`rg` treat it as
 * binary and skip it **silently** — a real hazard, because the repo's own DML and SELECT-inventory
 * collectors are source-TEXT scanners, so a module that reads as binary can drop out of an audit
 * without anything failing. The fix rewrote it as the escape `\u0000`.
 *
 * That fix is only safe if the RUNTIME string is unchanged, and "I believe an escape equals the raw
 * byte" is exactly the kind of claim that should be measured rather than asserted. So:
 *
 *  - the code-unit assertions below pin the domain's exact content and length, including that the
 *    terminator is `\u0000` and that it is the ONLY NUL; and
 *  - the digest assertion pins `sha256(domain + fixture)` against a value computed OUTSIDE this
 *    codebase (`python3 -c "import hashlib; hashlib.sha256(...)"` over the same literal bytes), so
 *    it cannot be back-fitted from whatever the implementation happens to produce.
 *
 * If a future edit changes the domain at all — a different escape, a dropped terminator, a renamed
 * version tag — the digest moves and this file reds. Every persisted `payloadFingerprint` and every
 * retry-idempotency comparison depends on that digest staying put.
 *
 * No-DB, no fixtures: this runs in the ungated `src/attendance/__tests__` set.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1 } from '../w4c2-live-scheduled-boundary'

describe('W4C-2 Gate D2 — live-punch payload fingerprint domain', () => {
  const DOMAIN = ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1

  it('is the exact byte sequence the raw-NUL literal encoded — escape and raw byte are the same runtime string', () => {
    // Built here from a JS escape, i.e. independently of how the source spells it.
    const expected = 'metasheet2:attendance:w4c2:live-punch-authoritative-payload:v1' + '\u0000'
    expect(DOMAIN).toBe(expected)
    expect(DOMAIN.length).toBe(63)
    expect(DOMAIN.charCodeAt(DOMAIN.length - 1)).toBe(0)
    // Exactly ONE NUL, and it terminates the string — not a stray one mid-domain.
    expect(DOMAIN.split('\u0000').length - 1).toBe(1)
    expect(DOMAIN.slice(0, -1)).toBe('metasheet2:attendance:w4c2:live-punch-authoritative-payload:v1')
    // UTF-8 encodes to the same length (the domain is pure ASCII plus the NUL), so the bytes fed
    // to the hash are exactly the code units asserted above.
    expect(Buffer.byteLength(DOMAIN, 'utf8')).toBe(63)
  })

  it('produces the digest an INDEPENDENT oracle computes for the same input — the fingerprint has not moved', () => {
    // Oracle: python3 -c "import hashlib; print(hashlib.sha256(
    //   ('metasheet2:attendance:w4c2:live-punch-authoritative-payload:v1\\x00' + '{\"probe\":1}')
    //   .encode('utf8')).hexdigest())"
    const ORACLE_DIGEST = '001b7ab4169abc3193d96c1535d9bf4f8599b26a1f86d581ba1bcbdf82f63fd4'
    const digest = crypto.createHash('sha256').update(DOMAIN + '{"probe":1}', 'utf8').digest('hex')
    expect(digest).toBe(ORACLE_DIGEST)
  })

  it('the source file spells the NUL as an escape, so static text scanners do not skip this module', () => {
    // The property the escape exists for, asserted directly rather than trusted: a raw 0x00 in the
    // source is what made `file(1)` report `data` and made grep/rg bail out.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'w4c2-live-scheduled-boundary.ts'),
    )
    expect(source.includes(0x00)).toBe(false)
  })
})
