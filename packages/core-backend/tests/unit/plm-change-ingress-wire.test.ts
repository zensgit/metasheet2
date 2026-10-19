import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/plm-change-event-v1-fixtures.json'
import { parsePlmChangeEvent, hashPlmChangeEvent } from '../../src/multitable/plm-change-ingress-wire'
import { canonicalPlmEvent } from '../../src/multitable/plm-wire'

describe('PLM success event contract', () => {
  for (const fixture of fixtures.cases) {
    it(`preserves Python canonical bytes: ${fixture.name}`, () => {
      const event = parsePlmChangeEvent(fixture.event)
      expect(canonicalPlmEvent(event)).toBe(fixture.canonical_json)
      expect(hashPlmChangeEvent(event)).toBe(fixture.sha256)
    })
  }
  for (const fixture of fixtures.invalid) {
    it(`rejects invalid or mixed event: ${fixture.name}`, () => {
      expect(() => parsePlmChangeEvent(fixture.event)).toThrow()
    })
  }
})
