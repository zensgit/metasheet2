import { describe, expect, it } from 'vitest'
import {
  geoFenceClearedMessage,
  geoFenceIncompleteMessage,
  resolveGeoFenceSave,
} from '../src/views/attendance/attendanceGeoFenceSave'

const tr = (en: string) => en

describe('resolveGeoFenceSave', () => {
  it('keeps a complete fence', () => {
    expect(resolveGeoFenceSave({ lat: '31.2', lng: '121.5', radius: '200' })).toEqual({
      ok: true,
      geoFence: { lat: 31.2, lng: 121.5, radiusMeters: 200 },
      explicitClear: false,
    })
  })

  it('treats all-blank fields as an explicit clear, including whitespace', () => {
    expect(resolveGeoFenceSave({ lat: ' ', lng: '', radius: '\n' })).toEqual({
      ok: true,
      geoFence: null,
      explicitClear: true,
    })
  })

  it('refuses a partial fence instead of mapping it to null', () => {
    expect(resolveGeoFenceSave({ lat: '31.2', lng: '121.5', radius: '' })).toEqual({
      ok: false,
      reason: 'incomplete',
    })
    expect(resolveGeoFenceSave({ lat: '', lng: '', radius: '100' }).ok).toBe(false)
    expect(resolveGeoFenceSave({ lat: '0', lng: '0', radius: '0' }).ok).toBe(false)
    expect(resolveGeoFenceSave({ lat: '1', lng: '2', radius: '1.5' }).ok).toBe(false)
    expect(resolveGeoFenceSave({ lat: 'nope', lng: '2', radius: '10' }).ok).toBe(false)
  })

  it('accepts a zero coordinate when the radius is a whole meter', () => {
    expect(resolveGeoFenceSave({ lat: '0', lng: '0', radius: '1' })).toEqual({
      ok: true,
      geoFence: { lat: 0, lng: 0, radiusMeters: 1 },
      explicitClear: false,
    })
  })

  it('discloses refusal and an explicit clear', () => {
    expect(geoFenceIncompleteMessage(tr)).toContain('Nothing was saved')
    expect(geoFenceClearedMessage(tr)).toContain('Geofence turned off')
  })
})
