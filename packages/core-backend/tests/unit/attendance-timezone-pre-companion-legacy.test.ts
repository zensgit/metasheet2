import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isPreCompanionLegacyTarget, admitsPreCompanionLegacyTarget } = require('../../../../plugins/plugin-attendance/lib/attendance-timezone-companion-store.cjs')

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

describe('pre-companion legacy admission needs the persisted legacy posture', () => {
  const orgId = 'org-1'
  function trxWith(rollout: Array<{ state: string }>) {
    const query = vi.fn(async (_sql: string, _args: unknown[]) => rollout)
    return { query }
  }
  it.each([
    ['no rollout row', []],
    ['an explicit legacy row', [{ state: 'legacy' }]],
  ])('admits under %s with exactly one org-keyed posture read', async (_label, rollout) => {
    const trx = trxWith(rollout)
    await expect(admitsPreCompanionLegacyTarget(trx, orgId, fresh, prior)).resolves.toBe(true)
    expect(trx.query.mock.calls).toEqual([['SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [orgId]]])
  })
  it.each(['shadow', 'eligible', 'authoritative', 'suspended', 'unknown_future_state'])('refuses under %s posture', async state => {
    await expect(admitsPreCompanionLegacyTarget(trxWith([{ state }]), orgId, fresh, prior)).resolves.toBe(false)
  })
  it('refuses when more than one posture row is reported', async () => {
    await expect(admitsPreCompanionLegacyTarget(trxWith([{ state: 'legacy' }, { state: 'legacy' }]), orgId, fresh, prior)).resolves.toBe(false)
  })
  it('does not read posture when the pure rule already refuses', async () => {
    const trx = trxWith([])
    await expect(admitsPreCompanionLegacyTarget(trx, orgId, { ...fresh, timezone: 'Asia/Tokyo' }, prior)).resolves.toBe(false)
    await expect(admitsPreCompanionLegacyTarget(trx, orgId, fresh, [])).resolves.toBe(false)
    expect(trx.query).not.toHaveBeenCalled()
  })
})
