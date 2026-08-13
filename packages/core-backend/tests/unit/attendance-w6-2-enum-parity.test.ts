/**
 * W6-2 (#4556) — mechanical enum-parity gate.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   §7.3: "enum values in OpenAPI, TS contract module, and runtime service
 *   are proven equal by one mechanical comparison test (no hand-copied
 *   second list)."
 *
 * Three independent sources are read for real, never retyped by hand:
 *   1. OpenAPI — the promoted `packages/openapi/src/base.yml` (this file's
 *      own text is parsed at test time; nothing here is a copy of its
 *      values).
 *   2. TS contract — the frozen arrays exported by
 *      `w6-group-effective-policy-contract.ts`, imported directly.
 *   3. Runtime service — NOT a second import of (2) under a different name.
 *      This probes the production response validator
 *      (`validateAttendanceGroupEffectivePolicyResponseV1`, the exact
 *      function the aggregate service calls on every real response before
 *      returning it) with a pool of candidate values and records which ones
 *      it actually accepts. A validator whose logic silently diverges from
 *      the constant it imports (e.g. a stray extra `||` branch) changes
 *      this accepted set without changing either declared list, so this
 *      leg catches drift the first assertion alone would miss.
 *
 * If SourceLabel, Domain, or ConflictCode drifts in ANY ONE of the three
 * sources, at least one assertion below reds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
} from '../../src/attendance/w6-group-effective-policy-contract'
import { validateAttendanceGroupEffectivePolicyResponseV1 } from '../../src/attendance/w6-group-effective-policy-response-contract'

const BASE_YAML_PATH = join(__dirname, '../../../openapi/src/base.yml')
const TEST_UUID = 'a4556006-ffff-4000-8000-000000000099'

/**
 * Extracts the flat `enum:` list under a top-level `components.schemas.<name>`
 * key from the raw OpenAPI YAML text.
 *
 * This is a mechanical text extraction, not a hand-copied list: core-backend
 * has no js-yaml dependency (only packages/openapi does), so this mirrors
 * the same regex-over-raw-text technique the pre-existing
 * "OpenAPI draft — hand-kept THIRD face" test in
 * `attendance-w6-group-effective-policy-response-contract.test.ts` already
 * uses for `AttendanceGroupEffectivePolicySourceRef.kind`, extended to also
 * accept the multi-line `enum:\n  - a\n  - b` block form (used by
 * `AttendanceGroupEffectivePolicyConflictCode`). The window is bounded by
 * the next sibling 4-space-indented schema key so it cannot swallow a
 * neighbouring schema's enum.
 */
function extractOpenApiEnum(yamlText: string, schemaName: string): string[] {
  const anchor = `\n    ${schemaName}:\n`
  const anchorAt = yamlText.indexOf(anchor)
  if (anchorAt === -1) {
    throw new Error(`extractOpenApiEnum: schema anchor not found — ${schemaName}`)
  }
  const searchFrom = anchorAt + anchor.length
  const nextSibling = /\n {4}[A-Za-z]/.exec(yamlText.slice(searchFrom))
  const windowEnd = nextSibling ? searchFrom + nextSibling.index : yamlText.length
  const window = yamlText.slice(anchorAt, windowEnd)

  const inline = /^[ \t]*enum:[ \t]*\[([^\]]*)\][ \t]*$/m.exec(window)
  if (inline) {
    const values = inline[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (values.length === 0) {
      throw new Error(`extractOpenApiEnum: empty inline enum — ${schemaName}`)
    }
    return values
  }

  const block = /enum:[ \t]*\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)+)/.exec(window)
  if (block) {
    const values = block[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.slice(1).trim())
      .filter((value) => value.length > 0)
    if (values.length === 0) {
      throw new Error(`extractOpenApiEnum: empty block enum — ${schemaName}`)
    }
    return values
  }

  throw new Error(`extractOpenApiEnum: no enum found under schema — ${schemaName}`)
}

/** A minimally-shaped, fully closed-shape valid response (matches the
 * "positive control" fixture already proven-valid in
 * `attendance-w6-group-effective-policy-response-contract.test.ts`, plus one
 * conflict entry so `conflicts[].domain` / `conflicts[].code` can be probed
 * without also constructing a membership-overlap or FSER scenario). */
function buildBaseResponse(): {
  ok: true
  data: {
    groupId: string
    groupType: string
    timezone: string
    activeMemberCount: number
    managerPosture: { ownerCount: number; subOwnerCount: number }
    calculationPosture: string
    domains: Record<string, Record<string, unknown>>
    conflicts: Array<Record<string, unknown>>
    evaluatedAt: string
  }
} {
  return {
    ok: true,
    data: {
      groupId: TEST_UUID,
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
        segments: {
          label: 'effective',
          reasonCodes: [],
          sourceRefs: [],
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' },
        },
        flex: { label: 'effective', reasonCodes: [], editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } },
        rules: {
          label: 'org_inherited',
          source: 'org_default',
          sourceRefs: [],
          reasonCodes: [],
          editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
        },
        punchMethod: { label: 'org_inherited', source: 'org_inherited', reasonCodes: [], editorRef: { kind: 'group_stage', stage: 'policies' } },
        requestPosture: {
          label: 'org_inherited',
          overtime: 'org_inherited',
          makeupPunch: 'org_inherited',
          outdoor: 'org_inherited',
          reasonCodes: [],
          editorRef: { kind: 'group_stage', stage: 'policies' },
        },
      },
      conflicts: [
        { code: 'TIMEZONE_MISSING', domain: 'basics', label: 'conflict_action_required', editorRef: { kind: 'group_stage', stage: 'basics' } },
      ],
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    },
  }
}

describe('W6-2 enum parity: OpenAPI base.yml <-> TS contract <-> runtime validator behaviour', () => {
  const yamlText = readFileSync(BASE_YAML_PATH, 'utf8')

  it('the probe carrier itself is valid (sanity control on the fixture, independent of the enums under test)', () => {
    expect(validateAttendanceGroupEffectivePolicyResponseV1(buildBaseResponse())).toEqual({ ok: true })
  })

  const CASES = [
    {
      enumName: 'SourceLabel',
      schemaName: 'AttendanceGroupEffectivePolicySourceLabel',
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1 as readonly string[],
      probe: (candidate: string) => {
        const response = buildBaseResponse()
        response.data.domains.membership.label = candidate
        return response
      },
    },
    {
      enumName: 'Domain',
      schemaName: 'AttendanceGroupEffectivePolicyDomain',
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1 as readonly string[],
      probe: (candidate: string) => {
        const response = buildBaseResponse()
        response.data.conflicts[0].domain = candidate
        return response
      },
    },
    {
      enumName: 'ConflictCode',
      schemaName: 'AttendanceGroupEffectivePolicyConflictCode',
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1 as readonly string[],
      probe: (candidate: string) => {
        const response = buildBaseResponse()
        response.data.conflicts[0].code = candidate
        return response
      },
    },
  ] as const

  for (const { enumName, schemaName, contractValues, probe } of CASES) {
    describe(`${enumName} (OpenAPI schema components.schemas.${schemaName})`, () => {
      const openapiValues = extractOpenApiEnum(yamlText, schemaName)
      const contractSet = [...contractValues].sort()
      const openapiSet = [...openapiValues].sort()

      it('discovered a non-empty enum from both real sources (guards against a silently-empty extraction)', () => {
        expect(openapiSet.length).toBeGreaterThan(0)
        expect(contractSet.length).toBeGreaterThan(0)
      })

      it('OpenAPI base.yml enum equals the TS contract frozen array', () => {
        expect(openapiSet).toEqual(contractSet)
      })

      it('the runtime validator accepts EXACTLY the contract set — not a superset, not a subset', () => {
        // Probe pool: every declared value from both real sources (deduped)
        // plus stable near-miss junk that must never validate — this keeps
        // the "accepted equals contract" assertion from being satisfiable by
        // a validator that just accepts everything.
        const junk = [
          '',
          'not_a_real_enum_value__w62_probe',
          schemaName.toUpperCase(),
          `${contractSet[0]}_extra_suffix`,
        ]
        const pool = [...new Set([...contractSet, ...openapiSet, ...junk])]

        const accepted = pool.filter((candidate) => validateAttendanceGroupEffectivePolicyResponseV1(probe(candidate)).ok).sort()

        expect(accepted).toEqual(contractSet)
      })
    })
  }
})
