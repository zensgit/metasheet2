/**
 * W6-R2 / W6-R6 / W6-R7 / W6-R8 — pure response-contract validator, proved
 * against the full W6-0 fixture pack (`tests/fixtures/attendance/w6/`).
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *
 * Every `aggregate-*.json` fixture MUST validate (they are the exact-key
 * response shapes design-lock §4.3 requires); every `invalid-reject-*.json`
 * fixture's `payload` MUST fail validation (each one is a named red-line
 * violation per the fixture pack's own README table).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseAttendanceGroupEffectivePolicyEditorRefV1,
  validateAttendanceGroupEffectivePolicyResponseV1,
} from '../../src/attendance/w6-group-effective-policy-response-contract'

const FIXTURE_DIR = join(__dirname, '../fixtures/attendance/w6')

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

function loadFixtureNames(prefix: string): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
}

describe('W6 group effective-policy response contract validator', () => {
  describe('aggregate-*.json fixtures MUST validate (W6-R7 byte-exact per fixture)', () => {
    const names = loadFixtureNames('aggregate-')
    it('discovered the full fixture set (guards against a silently-empty directory)', () => {
      expect(names).toEqual([
        'aggregate-configured-scheduled-shift.json',
        'aggregate-conflict-fixed-schedule-changed.json',
        'aggregate-conflict-membership-overlap.json',
        'aggregate-conflict-unpublished-managed-row.json',
        'aggregate-effective-fixed-shift.json',
        'aggregate-needs-configuration.json',
        'aggregate-org-inherited-defaults.json',
        'aggregate-preview-only-segments-flex.json',
      ])
    })

    for (const name of names) {
      it(`${name} validates`, () => {
        const fixture = readFixture(name)
        const result = validateAttendanceGroupEffectivePolicyResponseV1(fixture)
        expect(result).toEqual({ ok: true })
      })
    }
  })

  describe('invalid-reject-*.json fixtures MUST fail validation (W6-R2/R6/R8 negatives)', () => {
    const names = loadFixtureNames('invalid-reject-')
    it('discovered the full negative fixture set', () => {
      expect(names).toEqual([
        'invalid-reject-member-leak.json',
        'invalid-reject-open-editor-ref.json',
        'invalid-reject-unknown-label.json',
      ])
    })

    for (const name of names) {
      it(`${name} payload is rejected`, () => {
        const fixture = readFixture(name) as { payload: unknown }
        const result = validateAttendanceGroupEffectivePolicyResponseV1(fixture.payload)
        expect(result.ok).toBe(false)
      })
    }

    it('invalid-reject-member-leak.json is rejected specifically for a values-free violation (not merely "domains empty")', () => {
      const fixture = readFixture('invalid-reject-member-leak.json') as { payload: { data: Record<string, unknown> } }
      // Strip the leak keys and the (also-invalid) empty `domains: {}` so the
      // ONLY remaining defect this sub-case exercises is the top-level
      // member-ID/user-ID leak — proving the validator catches THAT
      // specifically, not just the incidentally-empty domains object.
      const leakOnly = {
        ok: true,
        data: {
          groupId: fixture.payload.data.groupId,
          groupType: fixture.payload.data.groupType,
          timezone: fixture.payload.data.timezone,
          activeMemberCount: fixture.payload.data.activeMemberCount,
          memberIds: fixture.payload.data.memberIds,
          managerPosture: fixture.payload.data.managerPosture,
          calculationPosture: fixture.payload.data.calculationPosture,
          domains: {
            membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
            schedule: {
              label: 'effective',
              strategy: 'fixed_shift',
              reasonCodes: [],
              fixedSchedule: null,
              editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'assignments' },
            },
            segments: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
            flex: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
            rules: { label: 'org_inherited', source: 'org_default', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' } },
            punchMethod: { label: 'org_inherited', source: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
            requestPosture: { label: 'org_inherited', overtime: 'org_inherited', makeupPunch: 'org_inherited', outdoor: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
          },
          conflicts: [],
          evaluatedAt: fixture.payload.data.evaluatedAt,
        },
      }
      const result = validateAttendanceGroupEffectivePolicyResponseV1(leakOnly)
      expect(result).toEqual({ ok: false, reason: 'data: unexpected key set' })
    })
  })

  describe('positive control: a minimally-valid response passes (proves the validator is not vacuously false-only)', () => {
    it('accepts a hand-built, fully closed-shape response', () => {
      const minimal = {
        ok: true,
        data: {
          groupId: 'g1',
          groupType: 'free_time',
          timezone: 'UTC',
          activeMemberCount: 0,
          managerPosture: { ownerCount: 0, subOwnerCount: 0 },
          calculationPosture: 'legacy',
          domains: {
            membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
            schedule: {
              label: 'effective',
              strategy: 'free_time',
              reasonCodes: [],
              sourceRefs: [],
              fixedSchedule: null,
              editorRef: { kind: 'group_context_route', step: 'schedule' },
            },
            segments: { label: 'effective', reasonCodes: [], sourceRefs: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
            flex: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
            rules: { label: 'org_inherited', source: 'org_default', sourceRefs: [], reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' } },
            punchMethod: { label: 'org_inherited', source: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
            requestPosture: { label: 'org_inherited', overtime: 'org_inherited', makeupPunch: 'org_inherited', outdoor: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
          },
          conflicts: [],
          evaluatedAt: '2026-08-05T00:00:00.000Z',
        },
      }
      expect(validateAttendanceGroupEffectivePolicyResponseV1(minimal)).toEqual({ ok: true })
    })
  })

  describe('W6-R6 enum-strict negatives (one per enum field)', () => {
    const base = {
      ok: true,
      data: {
        groupId: 'g1',
        groupType: 'free_time',
        timezone: 'UTC',
        activeMemberCount: 0,
        managerPosture: { ownerCount: 0, subOwnerCount: 0 },
        calculationPosture: 'legacy',
        domains: {
          membership: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'people' } },
          // `sourceRefs` is REQUIRED on schedule/segments/rules and NOT
          // PERMITTED on the other four — verified against all eight fixtures.
          // It used to be optional everywhere, which let this very `base`
          // object omit it on three domains the fixture pack always pins.
          schedule: {
            label: 'effective',
            strategy: 'free_time',
            reasonCodes: [],
            sourceRefs: [],
            fixedSchedule: null,
            editorRef: { kind: 'group_context_route', step: 'schedule' },
          },
          segments: { label: 'effective', reasonCodes: [], sourceRefs: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
          flex: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
          rules: { label: 'org_inherited', source: 'org_default', sourceRefs: [], reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' } },
          punchMethod: { label: 'org_inherited', source: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
          requestPosture: { label: 'org_inherited', overtime: 'org_inherited', makeupPunch: 'org_inherited', outdoor: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
        },
        conflicts: [],
        evaluatedAt: '2026-08-05T00:00:00.000Z',
      },
    }

    function withData(patch: Record<string, unknown>) {
      return { ok: true, data: { ...base.data, ...patch } }
    }

    it('rejects an unknown groupType', () => {
      expect(validateAttendanceGroupEffectivePolicyResponseV1(withData({ groupType: 'nonexistent_type' })).ok).toBe(false)
    })
    it('rejects an unknown calculationPosture', () => {
      expect(validateAttendanceGroupEffectivePolicyResponseV1(withData({ calculationPosture: 'partially_enabled' })).ok).toBe(false)
    })
    it('rejects an unknown domains.membership.label', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.membership as { label: string }).label = 'mostly_effective'
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched).ok).toBe(false)
    })
    it('rejects an unknown domains.flex.mode', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.flex as Record<string, unknown>).mode = 'lenient'
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched).ok).toBe(false)
    })
    it('rejects an unknown domains.rules.source', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.rules as Record<string, unknown>).source = 'inherited_elsewhere'
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched).ok).toBe(false)
    })
    it('rejects an unknown conflicts[].code', () => {
      const patched = structuredClone(base)
      patched.data.conflicts = [
        { code: 'NOT_A_REAL_CODE', domain: 'membership', label: 'conflict_action_required', editorRef: { kind: 'group_stage', stage: 'people' } },
      ]
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched).ok).toBe(false)
    })
    it('rejects an unknown conflicts[].domain', () => {
      const patched = structuredClone(base)
      patched.data.conflicts = [
        { code: 'TIMEZONE_MISSING', domain: 'not_a_real_domain', label: 'conflict_action_required', editorRef: { kind: 'group_stage', stage: 'basics' } },
      ]
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched).ok).toBe(false)
    })

    // reasonCodes closure is POSITION-SPECIFIC (§4.2), not one flat union.
    // The prior implementation used a single set at both positions, so a test
    // named "must be FSER's own closed list" could only reject a wholly
    // nonexistent code — a W6-authored code passed at the fixedSchedule
    // position and an FSER-only code passed at a domain position. Each case
    // below is paired with its POSITIVE CONTROL, so "rejects" cannot be
    // satisfied by a validator that rejects everything.
    it('rejects a made-up domains.*.reasonCodes value (not FSER-sourced, not W6-authored)', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.membership as Record<string, unknown>).reasonCodes = ['NOT_A_REAL_REASON_CODE']
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'domains.membership.reasonCodes: not a closed-set domain reason-code array',
      })
    })
    it('rejects a raw UUID smuggled into domains.*.reasonCodes (values-free judge does not stand in for enum closure)', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.membership as Record<string, unknown>).reasonCodes = ['3f7a1c2e-0000-4000-8000-000000000001']
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'domains.membership.reasonCodes: not a closed-set domain reason-code array',
      })
    })
    it('rejects EFFECTIVE at a DOMAIN position (§4.3 shows domains carrying [] where FSER carries [EFFECTIVE])', () => {
      const patched = structuredClone(base)
      ;(patched.data.domains.membership as Record<string, unknown>).reasonCodes = ['EFFECTIVE']
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'domains.membership.reasonCodes: not a closed-set domain reason-code array',
      })
    })
    it('POSITIVE CONTROL: a real FSER non-EFFECTIVE code and a real W6 code both PASS at a domain position', () => {
      for (const code of ['DUPLICATE_MATCHING_ASSIGNMENT', 'CALCULATION_GROUP_MEMBERSHIP_OVERLAP']) {
        const patched = structuredClone(base)
        ;(patched.data.domains.membership as Record<string, unknown>).reasonCodes = [code]
        expect(validateAttendanceGroupEffectivePolicyResponseV1(patched), code).toEqual({ ok: true })
      }
    })
    it('rejects a made-up fixedSchedule.reasonCodes value (must be FSER\'s own closed list, §4.2)', () => {
      const fixture = readFixture('aggregate-effective-fixed-shift.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { reasonCodes: string[] } } } }
      }
      const patched = structuredClone(fixture)
      patched.data.domains.schedule.fixedSchedule.reasonCodes = ['MADE_UP_FSER_REASON']
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.reasonCodes: not FSER\u2019s own closed list',
      })
    })
    it('rejects a W6-AUTHORED code at the fixedSchedule position (§4.2: W6 adds no FSER reason code)', () => {
      const fixture = readFixture('aggregate-effective-fixed-shift.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { reasonCodes: string[] } } } }
      }
      const patched = structuredClone(fixture)
      // A REAL W6 domain code — legal at a domain position, illegal here.
      patched.data.domains.schedule.fixedSchedule.reasonCodes = ['SEGMENT_CALCULATION_NOT_AUTHORITATIVE']
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.reasonCodes: not FSER\u2019s own closed list',
      })
    })
    it('POSITIVE CONTROL: EFFECTIVE is legal at the fixedSchedule position (FSER embeds it verbatim)', () => {
      const fixture = readFixture('aggregate-effective-fixed-shift.json')
      expect(validateAttendanceGroupEffectivePolicyResponseV1(fixture)).toEqual({ ok: true })
    })

    // W6-1 rebuild: the P1 class was "validator STRICTER than its producer"
    // (endDate). The NIT class is the opposite polarity — predicates WEAKER
    // than the spec. Both are fixed in this pass so the module has ONE rule:
    // every field's predicate matches its producer's actual range.
    it('accepts a NULL desired.endDate (open-ended managed row is legal — the P1)', () => {
      const fixture = readFixture('aggregate-conflict-unpublished-managed-row.json')
      expect(validateAttendanceGroupEffectivePolicyResponseV1(fixture)).toEqual({ ok: true })
    })
    it('accepts a NULL managedSets[].endDate, and still rejects a non-date string there', () => {
      const fixture = readFixture('aggregate-conflict-unpublished-managed-row.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { drift: { managedSets: { endDate: unknown }[] } } } } }
      }
      expect(fixture.data.domains.schedule.fixedSchedule.drift.managedSets[0].endDate).toBe(null)
      const patched = structuredClone(fixture)
      patched.data.domains.schedule.fixedSchedule.drift.managedSets[0].endDate = 'not-a-date'
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.drift.managedSets[]: field type mismatch',
      })
    })
    it('rejects a NULL desired.startDate (NOT NULL column — widening endDate must not widen startDate)', () => {
      const fixture = readFixture('aggregate-effective-fixed-shift.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { desired: { startDate: unknown } } } } }
      }
      const patched = structuredClone(fixture)
      patched.data.domains.schedule.fixedSchedule.desired.startDate = null
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.desired: field type mismatch',
      })
    })
    it('rejects a NaN or negative desired.revision (OpenAPI says minimum: 1; NaN serialises to JSON null)', () => {
      const fixture = readFixture('aggregate-effective-fixed-shift.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { desired: { revision: unknown } } } } }
      }
      for (const bad of [Number.NaN, -3, 0, 1.5]) {
        const patched = structuredClone(fixture)
        patched.data.domains.schedule.fixedSchedule.desired.revision = bad
        expect(validateAttendanceGroupEffectivePolicyResponseV1(patched), String(bad)).toEqual({
          ok: false,
          reason: 'fixedSchedule.desired: field type mismatch',
        })
      }
      // Positive control on the same field, so "rejects" is not vacuous.
      expect(validateAttendanceGroupEffectivePolicyResponseV1(readFixture('aggregate-effective-fixed-shift.json'))).toEqual({ ok: true })
    })
    it('rejects a non-ISO evaluatedAt that bare Date.parse would have accepted', () => {
      for (const bad of ['March 5 2026', '2026/08/05', '2026-08-05', '2026-08-05 00:00:00']) {
        const patched = structuredClone(base)
        ;(patched.data as Record<string, unknown>).evaluatedAt = bad
        expect(validateAttendanceGroupEffectivePolicyResponseV1(patched), bad).toEqual({
          ok: false,
          reason: 'data.evaluatedAt: not an ISO timestamp',
        })
      }
      const ok = structuredClone(base)
      ;(ok.data as Record<string, unknown>).evaluatedAt = '2026-08-05T00:00:00.000Z'
      expect(validateAttendanceGroupEffectivePolicyResponseV1(ok)).toEqual({ ok: true })
    })
    it('rejects a domain that OMITS sourceRefs where the pack always pins it, and one that ADDS it where the pack never does', () => {
      const omitted = structuredClone(base) as { data: { domains: Record<string, Record<string, unknown>> } }
      delete omitted.data.domains.segments.sourceRefs
      expect(validateAttendanceGroupEffectivePolicyResponseV1(omitted)).toEqual({
        ok: false,
        reason: 'domains.segments: unexpected key set',
      })
      const added = structuredClone(base) as { data: { domains: Record<string, Record<string, unknown>> } }
      added.data.domains.punchMethod.sourceRefs = []
      expect(validateAttendanceGroupEffectivePolicyResponseV1(added)).toEqual({
        ok: false,
        reason: 'domains.punchMethod: unexpected key set',
      })
    })
    it('rejects the removed schedule_group sourceRef kind (declared but never produced)', () => {
      const patched = structuredClone(base) as { data: { domains: Record<string, Record<string, unknown>> } }
      patched.data.domains.segments.sourceRefs = [{ kind: 'schedule_group', id: 'sg-1' }]
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'domains.segments.sourceRefs: invalid shape',
      })
      // Positive control: the three kinds that ARE produced still pass.
      for (const kind of ['shift', 'rule_set', 'fixed_schedule_config']) {
        const ok = structuredClone(base) as { data: { domains: Record<string, Record<string, unknown>> } }
        ok.data.domains.segments.sourceRefs = [{ kind, id: 'x-1' }]
        expect(validateAttendanceGroupEffectivePolicyResponseV1(ok), kind).toEqual({ ok: true })
      }
    })

    // #4814 NIT-3: managedSets[] keys were checked but not value TYPES —
    // `rowCount: {}` or `producerKey: 42` passed.
    it('rejects a managedSets[] entry with a non-string producerKey', () => {
      const fixture = readFixture('aggregate-conflict-fixed-schedule-changed.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { drift: { managedSets: Array<Record<string, unknown>> } } } } }
      }
      expect(fixture.data.domains.schedule.fixedSchedule.drift.managedSets.length).toBeGreaterThan(0)
      const patched = structuredClone(fixture)
      patched.data.domains.schedule.fixedSchedule.drift.managedSets[0].producerKey = 42
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.drift.managedSets[]: field type mismatch',
      })
    })
    it('rejects a managedSets[] entry with a non-numeric rowCount', () => {
      const fixture = readFixture('aggregate-conflict-fixed-schedule-changed.json') as {
        ok: true
        data: { domains: { schedule: { fixedSchedule: { drift: { managedSets: Array<Record<string, unknown>> } } } } }
      }
      const patched = structuredClone(fixture)
      patched.data.domains.schedule.fixedSchedule.drift.managedSets[0].rowCount = {}
      expect(validateAttendanceGroupEffectivePolicyResponseV1(patched)).toEqual({
        ok: false,
        reason: 'fixedSchedule.drift.managedSets[]: rowCount not a non-negative int',
      })
    })
  })

  describe('editorRef closed-table parser (W6-R8)', () => {
    it('accepts every group_stage value', () => {
      for (const stage of ['basics', 'people', 'schedule', 'policies']) {
        expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_stage', stage })).toEqual({ kind: 'group_stage', stage })
      }
    })
    it('accepts every schedule surface', () => {
      for (const surface of ['shifts', 'assignments', 'advanced-scheduling']) {
        expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'schedule', surface })).toEqual({
          kind: 'group_context_route',
          step: 'schedule',
          surface,
        })
      }
    })
    it('accepts schedule with no surface', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'schedule' })).toEqual({
        kind: 'group_context_route',
        step: 'schedule',
      })
    })
    it('accepts calendar with no surface key at all', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'calendar' })).toEqual({
        kind: 'group_context_route',
        step: 'calendar',
      })
    })
    it('rejects calendar carrying a surface key (calendar has no surface table)', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'calendar', surface: 'shifts' })).toBeNull()
    })
    it('accepts rules with rule-sets surface', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'rules', surface: 'rule-sets' })).toEqual({
        kind: 'group_context_route',
        step: 'rules',
        surface: 'rule-sets',
      })
    })
    it('rejects an out-of-table surface for schedule', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'schedule', surface: 'payroll' })).toBeNull()
    })
    it('rejects an out-of-table step', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_context_route', step: 'payroll' })).toBeNull()
    })
    it('rejects an unknown kind (admin_section — the fixture-pinned attack shape)', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'admin_section', section: 'attendance-admin-payroll' })).toBeNull()
    })
    it('rejects a caller-supplied extra key alongside a valid kind/stage pair', () => {
      expect(parseAttendanceGroupEffectivePolicyEditorRefV1({ kind: 'group_stage', stage: 'people', section: 'evil' })).toBeNull()
    })
  })
})
