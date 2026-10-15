import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/plm-record-event-v1-fixtures.json'
import {
  canonicalPlmEvent,
  hashPlmEvent,
  parsePlmRecordEvent,
  isPlmRecordIngressEnabled,
} from '../../src/multitable/plm-record-ingress-wire'

describe('PLM record ingress strict wire', () => {
  for (const fixture of fixtures.cases) {
    it(`preserves cross-language canonical bytes: ${fixture.name}`, () => {
      const event = parsePlmRecordEvent(fixture.event)
      expect(canonicalPlmEvent(event)).toBe(fixture.canonical_json)
      expect(hashPlmEvent(event)).toBe(fixture.sha256)
    })
  }
  it.each([undefined, '', 'TRUE', ' true', 'true ', '1'])('stays disabled for %s', (value) => {
    expect(isPlmRecordIngressEnabled({ PLM_RECORD_INGRESS_ENABLED: value })).toBe(false)
  })
  it('enables only exact true', () =>
    expect(isPlmRecordIngressEnabled({ PLM_RECORD_INGRESS_ENABLED: 'true' })).toBe(true))
  it.each([
    { origin: 'plm_domain_event' },
    { bypass: true },
    { source_sequence: 0 },
    { source_sequence: 9007199254740992 },
    { source_sequence: true },
    { occurred_at: '2026-10-01T00:00:00+08:00' },
    { event_id: 'no' },
    { cells: { quantity: 1, uom: 'ea', find_num: '10', refdes: null } },
    { cells: { quantity: '\u0000', uom: 'ea', find_num: '10', refdes: null } },
    { cells: { quantity: '\ud800', uom: 'ea', find_num: '10', refdes: null } },
    { cells: { quantity: 'x'.repeat(65537), uom: 'ea', find_num: '10', refdes: null } },
  ])('rejects malformed/forged wire %j', (patch) => {
    expect(() => parsePlmRecordEvent({ ...fixtures.cases[0].event, ...patch })).toThrow()
  })
})
