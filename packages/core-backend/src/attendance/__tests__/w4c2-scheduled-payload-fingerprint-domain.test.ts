/**
 * W4C-2 Gate D3 (#4556 / #4844) — the SCHEDULED payload fingerprint's domain separator is pinned BY
 * BYTES, its digest is pinned against an INDEPENDENT oracle, and the producer is pinned to derive
 * from the resolved command payload alone.
 *
 * The scheduled sibling of `w4c2-live-punch-payload-fingerprint-domain.test.ts`, and it exists for
 * the same two reasons:
 *
 *  1. The domain ends in a NUL. Written as a RAW 0x00 byte in the `.ts` source it makes `file(1)`
 *     classify the module as `data` and makes `grep`/`rg` treat it as binary and skip it SILENTLY —
 *     a real hazard, because the repo's own DML and SELECT-inventory collectors are source-TEXT
 *     scanners, so a module that reads as binary can drop out of an audit with nothing failing. The
 *     escape `\u0000` must produce the identical runtime string, and "an escape equals the raw byte"
 *     is a claim to MEASURE, not assert.
 *  2. The digest is load-bearing for retry idempotency: the D1 core reads
 *     `input_provenance.payloadFingerprint` verbatim off the stored row and fails `REPLAY_CONFLICT`
 *     on a mismatch. If the domain or the canonical payload projection moves silently, a genuine
 *     retry starts refusing.
 *
 * Both digest oracles below were computed OUTSIDE this codebase (`python3 -c "import hashlib; ..."`
 * over the same literal bytes), so they cannot be back-fitted from whatever the implementation
 * happens to produce.
 *
 * No-DB, no fixtures: this runs in the ungated `src/attendance/__tests__` set.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1,
  ATTENDANCE_W4C2_SCHEDULED_PAYLOAD_FINGERPRINT_DOMAIN_V1,
  computeAuthoritativeScheduledPayloadFingerprintV1,
} from '../w4c2-live-scheduled-boundary'

describe('W4C-2 Gate D3 — scheduled payload fingerprint domain', () => {
  const DOMAIN = ATTENDANCE_W4C2_SCHEDULED_PAYLOAD_FINGERPRINT_DOMAIN_V1

  it('is the exact byte sequence the raw-NUL literal would encode — escape and raw byte are the same runtime string', () => {
    // Built here from a JS escape, i.e. independently of how the source spells it.
    const expected = 'metasheet2:attendance:w4c2:scheduled-authoritative-payload:v1' + '\u0000'
    expect(DOMAIN).toBe(expected)
    expect(DOMAIN.length).toBe(62)
    expect(DOMAIN.charCodeAt(DOMAIN.length - 1)).toBe(0)
    // Exactly ONE NUL, and it terminates the string — not a stray one mid-domain.
    expect(DOMAIN.split('\u0000').length - 1).toBe(1)
    expect(DOMAIN.slice(0, -1)).toBe('metasheet2:attendance:w4c2:scheduled-authoritative-payload:v1')
    // UTF-8 encodes to the same length (pure ASCII plus the NUL), so the bytes fed to the hash are
    // exactly the code units asserted above.
    expect(Buffer.byteLength(DOMAIN, 'utf8')).toBe(62)
  })

  it('is DISJOINT from the live-punch domain — the two entrypoints can never mint the same digest for the same bytes', () => {
    expect(DOMAIN).not.toBe(ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1)
    // Not merely unequal strings: neither is a prefix of the other, so no payload appended to one
    // can reproduce a value derived from the other.
    expect(DOMAIN.startsWith(ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1)).toBe(false)
    expect(ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1.startsWith(DOMAIN)).toBe(false)
    const probe = '{"probe":1}'
    expect(
      crypto.createHash('sha256').update(DOMAIN + probe, 'utf8').digest('hex'),
    ).not.toBe(
      crypto
        .createHash('sha256')
        .update(ATTENDANCE_W4C2_LIVE_PUNCH_PAYLOAD_FINGERPRINT_DOMAIN_V1 + probe, 'utf8')
        .digest('hex'),
    )
  })

  it('produces the domain digest an INDEPENDENT oracle computes for the same input', () => {
    // Oracle: python3 -c "import hashlib; print(hashlib.sha256(
    //   ('metasheet2:attendance:w4c2:scheduled-authoritative-payload:v1\\x00' + '{\"probe\":1}')
    //   .encode('utf8')).hexdigest())"
    const ORACLE_DIGEST = '38576b82c254057121ddc44ccaedcb72c3dc5297c3fecb2370eae06f9b841038'
    const digest = crypto.createHash('sha256').update(DOMAIN + '{"probe":1}', 'utf8').digest('hex')
    expect(digest).toBe(ORACLE_DIGEST)
  })

  it('the PRODUCER reproduces an INDEPENDENT oracle over the resolved command payload — domain + canonical projection both pinned end to end', () => {
    // Oracle (canonical JSON = sorted keys, JSON.stringify per value, no whitespace):
    //   python3 -c "import hashlib; print(hashlib.sha256((
    //     'metasheet2:attendance:w4c2:scheduled-authoritative-payload:v1\\x00'
    //     + '{\"expectedRunVersion\":1,\"scheduledAbsenceSource\":\"auto_absence_cron\",'
    //       '\"scheduledRunId\":\"11111111-1111-4111-8111-111111111111\",'
    //       '\"userId\":\"22222222-2222-4222-8222-222222222222\",\"workDate\":\"2026-05-04\"}'
    //   ).encode('utf8')).hexdigest())"
    const ORACLE_DIGEST = 'b3b2920efe3de3fe2492f95cf88b69f6aa0ca4d4dd19a0bd44bcd49a360ec97f'
    expect(
      computeAuthoritativeScheduledPayloadFingerprintV1({
        scheduledRunId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        workDate: '2026-05-04',
        expectedRunVersion: 1,
        scheduledAbsenceSource: 'auto_absence_cron',
      }),
    ).toBe(ORACLE_DIGEST)
  })

  it('is DETERMINISTIC in the payload and SENSITIVE to every one of its five fields', () => {
    const base = {
      scheduledRunId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      workDate: '2026-05-04',
      expectedRunVersion: 1,
      scheduledAbsenceSource: 'auto_absence_cron',
    }
    const baseline = computeAuthoritativeScheduledPayloadFingerprintV1(base)
    // Same payload, computed twice, across a clock tick: no clock, no random, no operation id.
    expect(computeAuthoritativeScheduledPayloadFingerprintV1({ ...base })).toBe(baseline)
    expect(baseline).toMatch(/^[0-9a-f]{64}$/)
    // Single-field perturbation, one field at a time — a field silently dropped from the canonical
    // projection would leave its perturbation digest equal to the baseline.
    const perturbations: ReadonlyArray<Partial<typeof base>> = [
      { scheduledRunId: '11111111-1111-4111-8111-111111111112' },
      { userId: '22222222-2222-4222-8222-222222222223' },
      { workDate: '2026-05-05' },
      { expectedRunVersion: 2 },
      { scheduledAbsenceSource: 'auto_absence_admin_run' },
    ]
    for (const perturbation of perturbations) {
      expect(
        computeAuthoritativeScheduledPayloadFingerprintV1({ ...base, ...perturbation }),
      ).not.toBe(baseline)
    }
    // All five perturbed digests are distinct from each other too, so no two fields collapse into
    // one canonical slot.
    const digests = perturbations.map((perturbation) =>
      computeAuthoritativeScheduledPayloadFingerprintV1({ ...base, ...perturbation }),
    )
    expect(new Set(digests).size).toBe(perturbations.length)
  })

  it('the source file spells the NUL as an escape, so static text scanners do not skip this module', () => {
    // The property the escape exists for, asserted directly rather than trusted: a raw 0x00 in the
    // source is what makes `file(1)` report `data` and makes grep/rg bail out. Both domains live in
    // the same module, so this covers the D3 addition as well as the D2 one.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const source = fs.readFileSync(path.join(__dirname, '..', 'w4c2-live-scheduled-boundary.ts'))
    expect(source.includes(0x00)).toBe(false)
  })
})
