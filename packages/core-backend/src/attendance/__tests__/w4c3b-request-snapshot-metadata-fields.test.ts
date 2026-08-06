/**
 * W4C-5 §3 payload-stale predicate support (issue #4775).
 *
 * `extractAttendanceRequestPayloadMetadataFieldsV1` (`w4c3b-request-snapshots.ts`) is a
 * field-for-field port of the plugin's `buildRequestSnapshotPayloadFieldsFromDraft`
 * (`plugins/plugin-attendance/index.cjs:24414-24445`). This file pins ITS OWN behavior against a
 * fixture table mirroring every branch of that plugin function (nested `leaveType.code`, flat
 * `leaveTypeCode` fallback, valid/invalid `outdoorPunch`, JSON-string metadata, non-object
 * metadata, negative/non-integer minutes). It cannot reach into the CJS plugin closure to
 * cross-check the plugin copy directly — see the exported function's own doc comment for that
 * self-reported drift risk.
 */
import { describe, expect, it } from 'vitest'
import { extractAttendanceRequestPayloadMetadataFieldsV1 } from '../w4c3b-request-snapshots'

describe('extractAttendanceRequestPayloadMetadataFieldsV1', () => {
  it('returns all-null fields for null/undefined/empty metadata', () => {
    expect(extractAttendanceRequestPayloadMetadataFieldsV1(null)).toEqual({
      minutes: null,
      leaveTypeCode: null,
      outdoorPunch: null,
    })
    expect(extractAttendanceRequestPayloadMetadataFieldsV1(undefined)).toEqual({
      minutes: null,
      leaveTypeCode: null,
      outdoorPunch: null,
    })
    expect(extractAttendanceRequestPayloadMetadataFieldsV1({})).toEqual({
      minutes: null,
      leaveTypeCode: null,
      outdoorPunch: null,
    })
  })

  it('parses a JSON-string metadata value (matches normalizeMetadata)', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1('{"minutes":45}'),
    ).toMatchObject({ minutes: 45 })
  })

  it('treats an unparsable JSON string as empty metadata (fail-closed, not throw)', () => {
    expect(extractAttendanceRequestPayloadMetadataFieldsV1('not-json')).toEqual({
      minutes: null,
      leaveTypeCode: null,
      outdoorPunch: null,
    })
  })

  it('truncates a fractional non-negative minutes value', () => {
    expect(extractAttendanceRequestPayloadMetadataFieldsV1({ minutes: 61.9 }).minutes).toBe(61)
  })

  it('rejects a negative minutes value as null (not a clamp)', () => {
    expect(extractAttendanceRequestPayloadMetadataFieldsV1({ minutes: -5 }).minutes).toBeNull()
  })

  it('rejects a non-numeric minutes value as null', () => {
    expect(extractAttendanceRequestPayloadMetadataFieldsV1({ minutes: '45' }).minutes).toBeNull()
  })

  it('prefers nested leaveType.code over the flat leaveTypeCode fallback', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        leaveType: { code: 'annual' },
        leaveTypeCode: 'sick',
      }).leaveTypeCode,
    ).toBe('annual')
  })

  it('falls back to flat leaveTypeCode when leaveType.code is absent', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({ leaveTypeCode: 'sick' }).leaveTypeCode,
    ).toBe('sick')
  })

  it('trims leaveTypeCode and treats whitespace-only as absent', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({ leaveTypeCode: '  annual  ' }).leaveTypeCode,
    ).toBe('annual')
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({ leaveTypeCode: '   ' }).leaveTypeCode,
    ).toBeNull()
  })

  it('ignores leaveType when it is not an object (matches optional-chaining semantics)', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({ leaveType: 'annual', leaveTypeCode: 'sick' })
        .leaveTypeCode,
    ).toBe('sick')
  })

  it('builds a complete outdoorPunch object with the mobile source default', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        outdoorPunch: { eventType: 'check_in', occurredAt: '2026-08-01T09:00:00.000Z', timezone: 'Asia/Shanghai' },
      }).outdoorPunch,
    ).toEqual({
      eventType: 'check_in',
      occurredAt: '2026-08-01T09:00:00.000Z',
      timezone: 'Asia/Shanghai',
      source: 'mobile',
    })
  })

  it('preserves an explicit outdoorPunch source over the default', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        outdoorPunch: {
          eventType: 'check_out',
          occurredAt: '2026-08-01T18:00:00.000Z',
          timezone: 'Asia/Shanghai',
          source: 'web',
        },
      }).outdoorPunch?.source,
    ).toBe('web')
  })

  it('rejects an outdoorPunch missing a required field as null (not partial)', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        outdoorPunch: { eventType: 'check_in', occurredAt: '2026-08-01T09:00:00.000Z' },
      }).outdoorPunch,
    ).toBeNull()
  })

  it('rejects an outdoorPunch with an invalid eventType as null', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        outdoorPunch: { eventType: 'lunch', occurredAt: '2026-08-01T09:00:00.000Z', timezone: 'Asia/Shanghai' },
      }).outdoorPunch,
    ).toBeNull()
  })

  it('parses an outdoorPunch value given as a JSON string (matches normalizeMetadata on the nested field)', () => {
    expect(
      extractAttendanceRequestPayloadMetadataFieldsV1({
        outdoorPunch: '{"eventType":"check_in","occurredAt":"2026-08-01T09:00:00.000Z","timezone":"Asia/Shanghai"}',
      }).outdoorPunch,
    ).toMatchObject({ eventType: 'check_in' })
  })
})
