import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isPreCompanionLegacyTarget } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-companion-store.cjs')

const fresh = { timezone: 'UTC', timezoneContext: { mode: 'default_only' }, identity: { source: 'rule' } }
const prior = [{ id: 'record', timezone: 'UTC', current_calculation_id: null }]

describe('pre-companion legacy target (multi-timezone OFF, unfrozen)', () => {
  it('admits one untracked same-zone record for a fresh default-only frame', () => {
    expect(isPreCompanionLegacyTarget(fresh, prior)).toBe(true)
    expect(isPreCompanionLegacyTarget({ ...fresh, identity: { source: 'shift' } }, prior)).toBe(true)
  })
  it.each([
    ['multi-timezone ON', { ...fresh, timezoneContext: { mode: 'multi_timezone' } }, prior],
    ['no provenance (explicit-zone projection)', { ...fresh, timezoneContext: null }, prior],
    ['a different zone', { ...fresh, timezone: 'Asia/Tokyo' }, prior],
    ['a calculation-tracked record', fresh, [{ ...prior[0], current_calculation_id: 'calc' }]],
    ['two active records', fresh, [...prior, { ...prior[0], id: 'other' }]],
    ['no record', fresh, []],
    ['a repair frame', { ...fresh, legacyRecordId: 'record', legacyFrozenCalculationId: null, identity: { source: 'legacy_repair' } }, prior],
    ['a frozen v2 frame', { ...fresh, legacyRecordId: 'record', legacyFrozenCalculationId: 'calc', identity: { source: 'frozen_v2' } }, prior],
    ['a repair source without legacy ids', { ...fresh, identity: { source: 'legacy_repair' } }, prior],
  ])('refuses %s', (_label, frame, rows) => {
    expect(isPreCompanionLegacyTarget(frame, rows)).toBe(false)
  })
})
