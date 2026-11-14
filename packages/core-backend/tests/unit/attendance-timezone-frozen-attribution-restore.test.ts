import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { isSupportedFrozenAttributionSnapshotV1 } from '../../src/attendance/w4c1-segment-calculator'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAttendanceTimezoneCompanionStore } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-companion-store.cjs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { canonicalContextFingerprint } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs')

function fixture() {
  const window = { startAt: '2026-10-20T00:00:00.000Z', endAt: '2026-10-20T23:59:00.000Z' }
  const attribution = {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2, resolverVersion: 'w2', orgId: 'org', userId: 'user', workDate: '2026-10-20',
      shiftId: 'shift', reasonCode: 'matched', resolvedAt: '2026-10-20T00:00:00.000Z',
      absoluteWindow: window, attributionWindow: window, attributionTailMinutes: 0,
      extendedByApprovedOvertime: false, windowEvidenceFingerprint: 'evidence', source: 'import_resolution',
    },
  }
  const identity = { source: 'frozen_v2', frozenAttribution: attribution }
  const fingerprint = canonicalContextFingerprint(identity)
  const frame = {
    orgId: 'org', userId: 'user', timezone: 'UTC', workDate: '2026-10-20', fingerprint, identity,
    absoluteWindow: window, attributionWindow: window,
    resolution: { frozenAttribution: attribution, fullWinner: { absoluteWindow: window, attributionWindow: window } },
  }
  const original = { calculation: { attribution_snapshot: attribution } }
  const row = {
    record_id: 'record', org_id: 'org', user_id: 'user', timezone: 'UTC',
    frame_snapshot: JSON.parse(JSON.stringify(frame)), context_fingerprint: fingerprint,
    original_freeze_snapshot: original, original_freeze_fingerprint: canonicalContextFingerprint(original),
  }
  class HttpError extends Error {
    constructor(public status: number, public code: string) { super(code) }
  }
  const store = createAttendanceTimezoneCompanionStore({
    HttpError, validateFrozenContext: () => true, validateFrozenAttribution: isSupportedFrozenAttributionSnapshotV1,
  })
  const restore = () => store.readForWorkDate({ query: async () => [row] }, { orgId: 'org', userId: 'user', workDate: '2026-10-20' })
  return { attribution, row, restore }
}

describe('frozen V2 attribution survives timezone companion restoration', () => {
  it('keeps the immutable attribution as validator-supported ISO strings in identity and resolution', async () => {
    const { attribution, restore } = fixture()
    expect(isSupportedFrozenAttributionSnapshotV1(attribution)).toBe(true)
    const result = await restore()
    expect(result.frame.resolution.frozenAttribution).toEqual(attribution)
    expect(result.frame.identity.frozenAttribution).toEqual(attribution)
    expect(isSupportedFrozenAttributionSnapshotV1(result.frame.resolution.frozenAttribution)).toBe(true)
  })

  it('still revives operational windows without changing the persisted row or identity fingerprint', async () => {
    const { row, restore } = fixture()
    const before = JSON.parse(JSON.stringify(row))
    const { frame } = await restore()
    expect(frame.absoluteWindow.startAt).toBeInstanceOf(Date)
    expect(frame.attributionWindow.endAt).toBeInstanceOf(Date)
    expect(frame.resolution.fullWinner.absoluteWindow.startAt).toBeInstanceOf(Date)
    expect(frame.resolution.fullWinner.attributionWindow.endAt).toBeInstanceOf(Date)
    expect(canonicalContextFingerprint(frame.identity)).toBe(frame.fingerprint)
    expect(row).toEqual(before)
  })

  it('continues rejecting a modified frozen snapshot before restoration', async () => {
    const { row, restore } = fixture()
    row.frame_snapshot.identity.frozenAttribution.value.absoluteWindow.startAt = '2026-10-20T01:00:00.000Z'
    await expect(restore()).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID' })
  })
})
