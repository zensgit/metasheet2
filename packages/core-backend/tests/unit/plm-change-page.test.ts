import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/plm-change-event-v1-fixtures.json'
import { parsePlmChangeEvent, parsePlmChangePage } from '../../src/multitable/plm-change-ingress-wire'
const event = parsePlmChangeEvent(fixtures.cases[0].event)
const request = { binding_id: event.binding_id, binding_version: event.binding_version, source: event.source }
const page = { schema: 'yuantus.plm-change-page.v1', source: event.source,
  head_sequence: 2, next_sequence: 1, events: [{ sequence: 1, event }] }
describe('PLM change page contract', () => {
  it('accepts baseline, bounded page and caught-up empty page', () => {
    expect(parsePlmChangePage({ ...page, next_sequence: 2, events: [] }, request).next_sequence).toBe(2)
    expect(parsePlmChangePage(page, { ...request, after_sequence: 0 }).next_sequence).toBe(1)
    expect(parsePlmChangePage({ ...page, next_sequence: 2, events: [] }, { ...request, after_sequence: 2 }).events).toEqual([])
  })
  it.each([
    { ...page, next_sequence: 2 }, { ...page, head_sequence: 0 }, { ...page, events: [] },
    { ...page, events: [{ sequence: 2, event }], next_sequence: 2 },
    { ...page, events: [{ sequence: 1, event }, { sequence: 2, event }], next_sequence: 2 },
    { ...page, source: { ...event.source, part_id: 'foreign' } },
    { ...page, events: [{ sequence: 1, event: { ...event, binding_version: event.binding_version + 1 } }] },
    { ...page, events: [{ sequence: 1, event: { ...event, source: { ...event.source, org_id: 'foreign' } } }] },
    { ...page, head_sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...page, events: Array.from({ length: 51 }, () => ({ sequence: 1, event })) },
  ])('rejects malformed or discontinuous pages %#', value => {
    expect(() => parsePlmChangePage(value, { ...request, after_sequence: 0 })).toThrow()
  })
  it('rejects history in baseline and invalid caller cursors', () => {
    expect(() => parsePlmChangePage(page, request)).toThrow()
    for (const after_sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 3]) {
      expect(() => parsePlmChangePage({ ...page, events: [], next_sequence: 2 }, { ...request, after_sequence })).toThrow()
    }
  })
})
