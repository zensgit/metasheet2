/**
 * W6-2 (#4556) — mechanical enum-parity gate.
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   §7.3: "enum values in OpenAPI, TS contract module, and runtime service
 *   are proven equal by one mechanical comparison test (no hand-copied
 *   second list)."
 *
 * §7.3 bullet 2 says EVERY published closed enum, not just a sample. The
 * promoted schema block declares 22 raw `enum:` stanzas. This file pins 20
 * of them, counted as 21 logical positions (`editorRef.kind`'s two
 * one-value oneOf-branch stanzas — `[group_stage]` and
 * `[group_context_route]` — are one logical two-value union, tested as one
 * case, not two): the original three (SourceLabel, Domain, ConflictCode),
 * SourceRef.kind, FSER state, FSER reasonCodes, editorRef
 * kind/stage/step/surface, calculationPosture, groupType,
 * `domains.schedule.strategy` (a SEPARATE runtime-checked position that
 * happens to share the same value domain as `groupType`, not an alias for
 * it), flex mode, rules source, conflicts[].label, `domains.punchMethod.source`,
 * and all three `domains.requestPosture.{overtime,makeupPunch,outdoor}`
 * fields.
 *
 * The ONE deliberate exclusion: the envelope's `ok: { type: boolean, enum:
 * [true] }`. Unlike every field above, this is not a business value domain
 * with alternatives an org or a user could be in — it is the boolean
 * success/failure discriminator of the JSON envelope itself (this schema
 * only describes the success shape; failures are separate 400/403/404
 * responses, not `ok: false` bodies), the same structural tag every other
 * MetaSheet response envelope in this OpenAPI file uses. It has no
 * "TS contract" or "runtime enum" analogue to compare against beyond the
 * single `envelope.ok !== true` check, which is a type/shape guard, not an
 * enum-drift-prone value set.
 *
 * Three independent sources are read for real, never retyped by hand:
 *   1. OpenAPI — the promoted `packages/openapi/src/base.yml`. Read via
 *      sequential key-narrowing over the raw text (core-backend has no
 *      js-yaml dependency), never a fixed top-level-only window: several of
 *      these enums are nested several levels deep, and some field NAMES
 *      collide elsewhere in the same schema with a DIFFERENT enum (e.g.
 *      `domains.rules.source` vs `domains.punchMethod.source`; `groupType`
 *      vs `domains.schedule.strategy`) — a window that isn't scoped through
 *      every intermediate key could silently extract the wrong sibling's
 *      enum and produce a false-passing test. `narrow()` below always
 *      descends schema -> ... -> field, so a same-named field elsewhere in
 *      the document is never in scope. `editorRef.kind` additionally needs
 *      `narrowAll()`: its two legal values are declared as two SEPARATE
 *      single-value stanzas (one per `oneOf` branch), so reading only the
 *      first occurrence would silently drop the second branch's value —
 *      `getOpenApiEnumUnion()` collects every occurrence and unions them.
 *   2. TS contract — either the frozen arrays exported by
 *      `w6-group-effective-policy-contract.ts` (SourceLabel, Domain,
 *      ConflictCode, SourceRef.kind, FSER reasonCodes — the last is itself
 *      derived from the real FSER service's `REASON_ORDER` import, not
 *      hand-copied), or — where that module only carries an inline literal
 *      TYPE union with no reusable array (calculationPosture, groupType,
 *      flex mode, rules source, FSER state, editorRef stage) — the
 *      corresponding array in `w6-group-effective-policy-response-contract.ts`,
 *      exported by this PR for direct import instead of being hand-copied
 *      into this file. `domains.schedule.strategy` reuses the same
 *      `GROUP_TYPES` array `groupType` does (both positions are validated
 *      against the identical set in the real validator — see
 *      `w6-group-effective-policy-response-contract.ts`), but is still its
 *      OWN case here because it is a distinct OpenAPI/runtime POSITION: a
 *      drift only in the `domains.schedule.strategy` YAML stanza, or only
 *      in the runtime check at that specific call site, would not be caught
 *      by the `groupType` case, which never touches that field.
 *      `editorRef.step`/`editorRef.surface` are derived mechanically from
 *      the already-exported `SCHEDULE_ROUTE_SURFACES` object (`Object.keys`
 *      / flattened `Object.values`), never retyped. `conflicts[].label`,
 *      `editorRef.kind`, `domains.punchMethod.source`, and the three
 *      `domains.requestPosture.*` fields have no array anywhere — each is a
 *      literal type (`conflicts[].label`/`punchMethod.source`/
 *      `requestPosture.*` are single fixed strings; `editorRef.kind` is a
 *      two-value discriminator with no reusable union array, only inline
 *      `'group_stage' | 'group_context_route'` in the contract type),
 *      checked in the validator by direct `===`/`!==`/`.includes()` against
 *      a value with no declared-array counterpart. Per "no distinct array
 *      to compare against", these six cases are OpenAPI-vs-runtime only
 *      (2-way), documented as such inline, not padded out with a
 *      fabricated third leg.
 *   3. Runtime service — NOT a second import of (2) under a different name.
 *      Every case probes the production response validator
 *      (`validateAttendanceGroupEffectivePolicyResponseV1`, the exact
 *      function the aggregate service calls on every real response before
 *      returning it) with a pool of candidate values and records which ones
 *      it actually accepts. A validator whose logic silently diverges from
 *      the constant it imports (e.g. a stray extra `||` branch) changes
 *      this accepted set without changing either declared list, so this
 *      leg catches drift the first assertion alone would miss.
 *
 * If any of these enums drifts in ANY ONE of its sources, at least one
 * assertion below reds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_FSER_REASON_CODES_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_REF_KINDS_V1,
} from '../../src/attendance/w6-group-effective-policy-contract'
import {
  CALCULATION_POSTURES,
  FLEX_MODES,
  FSER_STATES,
  GROUP_STAGES,
  GROUP_TYPES,
  RULE_SOURCES,
  SCHEDULE_ROUTE_SURFACES,
  validateAttendanceGroupEffectivePolicyResponseV1,
} from '../../src/attendance/w6-group-effective-policy-response-contract'

const BASE_YAML_PATH = join(__dirname, '../../../openapi/src/base.yml')
const TEST_UUID = 'a4556006-ffff-4000-8000-000000000099'

/**
 * Locates `<key>:` as a YAML mapping key anywhere inside `window`, at
 * whatever indentation it happens to be, and returns the sub-slice of
 * `window` from that key's own line up to (but not including) the next
 * line whose indentation is less than or equal to the key line's own —
 * i.e. exactly that key's nested block, nothing from a sibling or an
 * ancestor's later sibling.
 *
 * Used for progressive narrowing (`schema -> field -> nested field -> ...`)
 * so a field name that repeats elsewhere in the document with a DIFFERENT
 * enum (`source` under both `domains.rules` and `domains.punchMethod`)
 * cannot be confused for the one under test: callers narrow through every
 * intermediate key first, so the window handed to the final `enum:` search
 * is already scoped tightly enough that no sibling's field of the same
 * name is in it.
 */
function narrow(window: string, key: string): string {
  const re = new RegExp(`\\n( *)${key}:(?=[ \\t\\n]|$)`)
  const m = re.exec(window)
  if (!m) {
    throw new Error(`narrow: key not found — ${key}`)
  }
  const indent = m[1].length
  const rest = window.slice(m.index + 1)
  const firstNewline = rest.indexOf('\n')
  const tail = firstNewline === -1 ? '' : rest.slice(firstNewline + 1)
  const siblingRe = new RegExp(`\\n {0,${indent}}\\S`)
  const siblingMatch = siblingRe.exec(`\n${tail}`)
  const tailEnd = siblingMatch ? siblingMatch.index : tail.length + 1
  const end = (firstNewline === -1 ? rest.length : firstNewline + 1) + Math.max(tailEnd - 1, 0)
  return rest.slice(0, end)
}

/** Extracts an `enum:` list (inline `[a, b]` form — either on its own line
 * or embedded in a flow-style mapping like `{ type: string, enum: [a, b] }`,
 * used by the single-value `requestPosture.*` fields — or block `- a\n  - b`
 * form) from an already-narrowed window. Throws rather than returning an
 * empty array on a miss, so a broken extraction cannot silently pass as
 * "the empty set equals the empty set". */
function extractEnum(window: string): string[] {
  const inline = /enum:[ \t]*\[([^\]]*)\]/.exec(window)
  if (inline) {
    const values = inline[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (values.length === 0) throw new Error('extractEnum: empty inline enum')
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
    if (values.length === 0) throw new Error('extractEnum: empty block enum')
    return values
  }
  throw new Error(`extractEnum: no enum found in window:\n${window.slice(0, 300)}`)
}

/** Reads `components.schemas.<schemaName><.path...>.enum` from the real
 * OpenAPI source text by sequential narrowing — `path` empty means the
 * enum sits directly in the schema's own body (the three original W6-1
 * enums); non-empty descends through nested `properties`/`allOf` keys by
 * field name only (works because each path used in this file is unique
 * within its own already-narrowed parent window — see `narrow()` above). */
function getOpenApiEnum(yamlText: string, schemaName: string, path: readonly string[] = []): string[] {
  let window = narrow(yamlText, schemaName)
  for (const key of path) window = narrow(window, key)
  return extractEnum(window)
}

/** Like `narrow()`, but returns EVERY occurrence of `<key>:` in `window`
 * (each one's own bounded sub-block), not just the first. Needed for
 * `editorRef.kind`: its two legal values are declared as two separate
 * single-value `enum:` stanzas, one per `oneOf` branch — a plain `narrow()`
 * would silently see only the first and miss the second. */
function narrowAll(window: string, key: string): string[] {
  const results: string[] = []
  let remaining = window
  while (true) {
    const re = new RegExp(`\\n( *)${key}:(?=[ \\t\\n]|$)`)
    const m = re.exec(remaining)
    if (!m) break
    const sub = narrow(remaining, key)
    results.push(sub)
    remaining = remaining.slice(m.index + 1 + sub.length)
  }
  if (results.length === 0) throw new Error(`narrowAll: key not found — ${key}`)
  return results
}

/** Unions the `enum:` values across every occurrence of `<key>` under a
 * schema — the multi-occurrence counterpart of `getOpenApiEnum`, used only
 * for `editorRef.kind`. */
function getOpenApiEnumUnion(yamlText: string, schemaName: string, key: string): string[] {
  const schemaWindow = narrow(yamlText, schemaName)
  const occurrences = narrowAll(schemaWindow, key)
  return [...new Set(occurrences.flatMap((w) => extractEnum(w)))]
}

/** A minimally-shaped, fully closed-shape valid response (matches the
 * "positive control" fixture already proven-valid in
 * `attendance-w6-group-effective-policy-response-contract.test.ts`, plus one
 * conflict entry so `conflicts[].domain` / `conflicts[].code` /
 * `conflicts[].label` can be probed without also constructing a
 * membership-overlap scenario). `groupType: 'free_time'` so
 * `domains.schedule.fixedSchedule` stays `null` — FSER fields have their
 * own carrier below. */
function buildBaseResponse() {
  return {
    ok: true,
    data: {
      groupId: TEST_UUID,
      groupType: 'free_time' as string,
      timezone: 'UTC',
      activeMemberCount: 0,
      managerPosture: { ownerCount: 0, subOwnerCount: 0 },
      calculationPosture: 'legacy' as string,
      domains: {
        membership: {
          label: 'effective',
          reasonCodes: [] as string[],
          editorRef: { kind: 'group_stage', stage: 'people' } as Record<string, unknown>,
        },
        schedule: {
          label: 'effective',
          strategy: 'free_time',
          reasonCodes: [] as string[],
          sourceRefs: [] as Record<string, unknown>[],
          fixedSchedule: null as unknown,
          editorRef: { kind: 'group_context_route', step: 'schedule' } as Record<string, unknown>,
        },
        segments: {
          label: 'effective',
          reasonCodes: [] as string[],
          sourceRefs: [] as Record<string, unknown>[],
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } as Record<string, unknown>,
        },
        flex: {
          label: 'effective',
          reasonCodes: [] as string[],
          editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' } as Record<string, unknown>,
        } as Record<string, unknown>,
        rules: {
          label: 'org_inherited',
          source: 'org_default' as string,
          sourceRefs: [] as Record<string, unknown>[],
          reasonCodes: [] as string[],
          editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' } as Record<string, unknown>,
        },
        punchMethod: {
          label: 'org_inherited',
          source: 'org_inherited',
          reasonCodes: [] as string[],
          editorRef: { kind: 'group_stage', stage: 'policies' },
        },
        requestPosture: {
          label: 'org_inherited',
          overtime: 'org_inherited',
          makeupPunch: 'org_inherited',
          outdoor: 'org_inherited',
          reasonCodes: [] as string[],
          editorRef: { kind: 'group_stage', stage: 'policies' },
        },
      } as Record<string, Record<string, unknown>>,
      conflicts: [
        {
          code: 'TIMEZONE_MISSING',
          domain: 'basics',
          label: 'conflict_action_required' as string,
          editorRef: { kind: 'group_stage', stage: 'basics' },
        },
      ] as Array<Record<string, unknown>>,
      evaluatedAt: '2026-08-05T00:00:00.000Z',
    },
  }
}

/** A second carrier, `groupType: 'fixed_shift'` with a fully-populated
 * `domains.schedule.fixedSchedule`, so FSER `state`/`reasonCodes` — which
 * only exist on that embedded object — can be probed the same way. */
function buildFixedShiftResponse() {
  const response = buildBaseResponse()
  response.data.groupType = 'fixed_shift'
  response.data.domains.schedule.strategy = 'fixed_shift'
  response.data.domains.schedule.fixedSchedule = {
    state: 'effective',
    reasonCodes: ['EFFECTIVE'],
    desired: null,
    coverage: { targetMembers: 0, matchingMembers: 0, missingMembers: 0, nonMemberTargets: 0, differentKeyRows: 0 },
    drift: { unconfiguredManagedRows: 0, unpublishedManagedRows: 0, managedSets: [] },
    evaluatedAt: '2026-08-05T00:00:00.000Z',
  }
  return response
}

type ResponseT = ReturnType<typeof buildBaseResponse>

/** Every step's allowed surfaces, flattened and deduped — mechanically
 * derived from the real exported table, not hand-copied. `calendar: null`
 * contributes nothing (there is no surface valid there). */
const SCHEDULE_ROUTE_SURFACES_UNION = [...new Set(Object.values(SCHEDULE_ROUTE_SURFACES).filter((v): v is readonly string[] => v !== null).flat())]

describe('W6-2 enum parity: OpenAPI base.yml <-> TS contract <-> runtime validator behaviour', () => {
  const yamlText = readFileSync(BASE_YAML_PATH, 'utf8')

  it('the free_time probe carrier itself is valid (sanity control on the fixture, independent of the enums under test)', () => {
    expect(validateAttendanceGroupEffectivePolicyResponseV1(buildBaseResponse())).toEqual({ ok: true })
  })

  it('the fixed_shift probe carrier itself is valid (sanity control for the FSER-scoped cases)', () => {
    expect(validateAttendanceGroupEffectivePolicyResponseV1(buildFixedShiftResponse())).toEqual({ ok: true })
  })

  type Case = {
    enumName: string
    schemaName: string
    path: readonly string[]
    contractValues: readonly string[]
    probe: (candidate: string) => ResponseT
    twoWayOnly?: true
    /** Override for the OpenAPI extraction — only `editorRef.kind` needs
     * this (union across two separate oneOf-branch stanzas via
     * `getOpenApiEnumUnion`); every other case uses the default
     * `getOpenApiEnum(yamlText, schemaName, path)` sequential narrow. */
    getOpenApiValues?: (yamlText: string) => string[]
  }

  const CASES: readonly Case[] = [
    {
      enumName: 'SourceLabel',
      schemaName: 'AttendanceGroupEffectivePolicySourceLabel',
      path: [],
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.membership.label = candidate
        return response
      },
    },
    {
      enumName: 'Domain',
      schemaName: 'AttendanceGroupEffectivePolicyDomain',
      path: [],
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.conflicts[0].domain = candidate
        return response
      },
    },
    {
      enumName: 'ConflictCode',
      schemaName: 'AttendanceGroupEffectivePolicyConflictCode',
      path: [],
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.conflicts[0].code = candidate
        return response
      },
    },
    {
      enumName: 'SourceRef.kind',
      schemaName: 'AttendanceGroupEffectivePolicySourceRef',
      path: ['kind'],
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_REF_KINDS_V1,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.schedule.sourceRefs = [{ kind: candidate, id: TEST_UUID }]
        return response
      },
    },
    {
      enumName: 'FixedSchedule.state (FSER)',
      schemaName: 'AttendanceGroupEffectivePolicyFixedSchedule',
      path: ['state'],
      contractValues: FSER_STATES,
      probe: (candidate) => {
        const response = buildFixedShiftResponse()
        ;(response.data.domains.schedule.fixedSchedule as Record<string, unknown>).state = candidate
        return response
      },
    },
    {
      enumName: 'FixedSchedule.reasonCodes (FSER, position-specific closure)',
      schemaName: 'AttendanceGroupEffectivePolicyFixedSchedule',
      path: ['reasonCodes'],
      contractValues: ATTENDANCE_GROUP_EFFECTIVE_POLICY_FSER_REASON_CODES_V1,
      probe: (candidate) => {
        const response = buildFixedShiftResponse()
        ;(response.data.domains.schedule.fixedSchedule as Record<string, unknown>).reasonCodes = [candidate]
        return response
      },
    },
    {
      enumName: 'EditorRef.stage (group_stage branch)',
      schemaName: 'AttendanceGroupEffectivePolicyEditorRef',
      path: ['stage'],
      contractValues: GROUP_STAGES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.membership.editorRef = { kind: 'group_stage', stage: candidate }
        return response
      },
    },
    {
      enumName: 'EditorRef.step (group_context_route branch)',
      schemaName: 'AttendanceGroupEffectivePolicyEditorRef',
      path: ['step'],
      contractValues: Object.keys(SCHEDULE_ROUTE_SURFACES),
      probe: (candidate) => {
        const response = buildBaseResponse()
        // No `surface` key: every valid step (schedule/calendar/rules)
        // accepts an editorRef with no surface, so this isolates `step`
        // without also depending on a surface choice.
        response.data.domains.flex.editorRef = { kind: 'group_context_route', step: candidate }
        return response
      },
    },
    {
      enumName: 'EditorRef.surface (union across all group_context_route steps)',
      schemaName: 'AttendanceGroupEffectivePolicyEditorRef',
      path: ['surface'],
      contractValues: SCHEDULE_ROUTE_SURFACES_UNION,
      probe: (candidate) => {
        // Surface validity is step-scoped (schedule vs rules allow
        // different surfaces; calendar allows none) but the OpenAPI schema
        // declares one FLAT union across every step. This probe accepts
        // the candidate if EITHER step admits it, matching that union
        // framing rather than falsely requiring it to be valid everywhere.
        const underSchedule = buildBaseResponse()
        underSchedule.data.domains.flex.editorRef = { kind: 'group_context_route', step: 'schedule', surface: candidate }
        if (validateAttendanceGroupEffectivePolicyResponseV1(underSchedule).ok) return underSchedule
        const underRules = buildBaseResponse()
        underRules.data.domains.flex.editorRef = { kind: 'group_context_route', step: 'rules', surface: candidate }
        return underRules
      },
    },
    {
      enumName: 'calculationPosture',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['calculationPosture'],
      contractValues: CALCULATION_POSTURES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.calculationPosture = candidate
        return response
      },
    },
    {
      enumName: 'groupType',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['groupType'],
      contractValues: GROUP_TYPES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.groupType = candidate
        return response
      },
    },
    {
      // Same value domain and same TS array as `groupType` above, but a
      // DISTINCT OpenAPI stanza (`domains.schedule.strategy`, not
      // `data.groupType`) and a DISTINCT runtime call site
      // (`GROUP_TYPES.includes(scheduleValue.strategy...)` vs
      // `GROUP_TYPES.includes(d.groupType...)`). The `groupType` case never
      // touches `strategy`, so a drift confined to this position alone
      // (either the YAML stanza or this specific runtime check) would go
      // unnoticed without a dedicated case — this is that case.
      enumName: 'domains.schedule.strategy',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'schedule', 'strategy'],
      contractValues: GROUP_TYPES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.schedule.strategy = candidate
        return response
      },
    },
    {
      enumName: 'domains.flex.mode',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'flex', 'mode'],
      contractValues: FLEX_MODES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        ;(response.data.domains.flex as Record<string, unknown>).mode = candidate
        return response
      },
    },
    {
      enumName: 'domains.rules.source',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'rules', 'source'],
      contractValues: RULE_SOURCES,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.rules.source = candidate
        return response
      },
    },
    {
      enumName: 'conflicts[].label',
      schemaName: 'AttendanceGroupEffectivePolicyConflict',
      path: ['label'],
      // No array anywhere in TS for this one — `contract.ts` types it as the
      // single-value literal `'conflict_action_required'`, and the
      // validator checks it with a direct `!==`, not an `.includes()`
      // against a declared set. There is no second, distinct place to
      // import a value from without hand-typing a one-element array (which
      // is exactly the "hand-copied literal" this file avoids elsewhere),
      // so this case is OpenAPI-vs-runtime only — see `twoWayOnly` below.
      contractValues: ['conflict_action_required'],
      twoWayOnly: true,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.conflicts[0].label = candidate
        return response
      },
    },
    {
      enumName: 'domains.punchMethod.source',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'punchMethod', 'source'],
      // Single fixed value in v1 (OD-4556-9), checked in the validator by
      // direct `!==` — no array anywhere to import, same shape as
      // `conflicts[].label` above.
      contractValues: ['org_inherited'],
      twoWayOnly: true,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.punchMethod.source = candidate
        return response
      },
    },
    {
      enumName: 'domains.requestPosture.overtime',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'requestPosture', 'overtime'],
      contractValues: ['org_inherited'],
      twoWayOnly: true,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.requestPosture.overtime = candidate
        return response
      },
    },
    {
      enumName: 'domains.requestPosture.makeupPunch',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'requestPosture', 'makeupPunch'],
      contractValues: ['org_inherited'],
      twoWayOnly: true,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.requestPosture.makeupPunch = candidate
        return response
      },
    },
    {
      enumName: 'domains.requestPosture.outdoor',
      schemaName: 'AttendanceGroupEffectivePolicyResponse',
      path: ['domains', 'requestPosture', 'outdoor'],
      contractValues: ['org_inherited'],
      twoWayOnly: true,
      probe: (candidate) => {
        const response = buildBaseResponse()
        response.data.domains.requestPosture.outdoor = candidate
        return response
      },
    },
    {
      // The discriminator of the EditorRef `oneOf` union. Declared as two
      // SEPARATE single-value stanzas in OpenAPI (one per branch) — see
      // `getOpenApiEnumUnion` — and checked in the parser by two literal
      // `===` comparisons, with no reusable array on either side. Like
      // `punchMethod.source`, this is genuinely pinnable with the same
      // 2-way construction already used elsewhere in this file, so it is
      // pinned rather than left out as "structural": unlike the envelope's
      // `ok: [true]` (excluded — see the file header), `kind` is a real
      // business discriminator (which downstream UI navigation shape
      // applies), not a fixed protocol tag.
      enumName: 'EditorRef.kind (discriminator, union of both oneOf branches)',
      schemaName: 'AttendanceGroupEffectivePolicyEditorRef',
      path: ['kind'],
      contractValues: ['group_stage', 'group_context_route'],
      twoWayOnly: true,
      getOpenApiValues: (yamlText) => getOpenApiEnumUnion(yamlText, 'AttendanceGroupEffectivePolicyEditorRef', 'kind'),
      probe: (candidate) => {
        const asGroupStage = buildBaseResponse()
        asGroupStage.data.domains.membership.editorRef = { kind: candidate, stage: 'people' }
        if (validateAttendanceGroupEffectivePolicyResponseV1(asGroupStage).ok) return asGroupStage
        const asContextRoute = buildBaseResponse()
        asContextRoute.data.domains.membership.editorRef = { kind: candidate, step: 'schedule' }
        return asContextRoute
      },
    },
  ] as const

  for (const { enumName, schemaName, path, contractValues, probe, twoWayOnly, getOpenApiValues } of CASES) {
    describe(`${enumName} (OpenAPI components.schemas.${schemaName}${path.length ? '.' + path.join('.') : ''})`, () => {
      const openapiValues = getOpenApiValues ? getOpenApiValues(yamlText) : getOpenApiEnum(yamlText, schemaName, path)
      const contractSet = [...contractValues].sort()
      const openapiSet = [...openapiValues].sort()

      it('discovered a non-empty enum from both real sources (guards against a silently-empty extraction)', () => {
        expect(openapiSet.length).toBeGreaterThan(0)
        expect(contractSet.length).toBeGreaterThan(0)
      })

      it('OpenAPI base.yml enum equals the TS contract set' + (twoWayOnly ? ' (2-way: no separate TS array exists for this literal-constant field)' : ''), () => {
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
