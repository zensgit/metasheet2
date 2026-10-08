import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lock-8 L8-A §2.1 N-1 — the mechanical census this lock names as L8-A's OWN deliverable: "one
// exported table of field types × the sites that must carry them, with every gate iterating it...
// adding a [new] field type with no row reds the equality test."
//
// HONEST SCOPE (M8 — no overclaim). MS-1 through MS-13 name thirteen site FAMILIES
// (docs/development/approval-lock8-field-vocabulary-20260817.md §0.3). This file mechanically
// covers the BACKEND sites that are genuinely anchorable to a real runtime artifact (not a
// re-declared parallel list) WITHOUT mounting a browser component:
//
//   COVERED here, anchored on the REAL exported set/behavior:
//     - MS-2  FORM_FIELD_TYPES            — exact-set equality against the canonical type list
//     - MS-4  DETAIL_LEAF_FIELD_TYPES     — equals FORM_FIELD_TYPES minus the derived exclusions
//     - MS-8  visibility whole-value gate — BEHAVIORAL, one publish attempt per canonical type
//     - MS-10 condition-branch gate       — BEHAVIORAL, one publish attempt per canonical type
//   Each of MS-8/MS-10 carries a completeness meta-assertion: the hand-authored expectation
//   table's key set must equal FORM_FIELD_TYPES exactly — adding a 14th type without adding its
//   row reds that assertion FIRST, before any behavioral row is even reached.
//
//   NOT mechanically covered by a runtime census row here, and why:
//     - MS-1  FE/BE union sync            — a TypeScript union has NO runtime footprint; the
//             real forcing function is the compiler (`Record<FormFieldType,…>` maps — see MS-11)
//             plus this file's own MS-2/MS-4 imports, which would fail to COMPILE if a member
//             were missing from the exported Set literal's inferred type. A regex/AST parse of
//             the two `.ts` union declarations was deliberately NOT built — that is the
//             source-text-assertion antipattern (feedback_source_text_assertions_are_not_behaviour
//             .md): it would assert the TEXT says the right thing, not that anything BEHAVES
//             differently, and buys nothing the compiler doesn't already give for free.
//     - MS-3  submit-time value validation — pinned directly by
//             approval-lock8-explanation-field.test.ts's own describe block (an explicit
//             per-family arm, not a type-indexed table — MS-3's shape is "does X have an arm",
//             which the census's exact-equality style does not fit as cleanly as a dedicated test).
//     - MS-5/MS-6/MS-9/MS-11/MS-12/MS-13  are FRONTEND sites — see
//             apps/web/tests/approval-lock8-field-type-census.test.ts for their FE-side coverage
//             (MS-5/MS-9 as full runtime-predicate loops; MS-6/MS-11/MS-13's label/mark maps are
//             TypeScript-`Record<AuthorableFieldType,…>`-literal COMPILE-forced — verified by
//             `vue-tsc -b`, not a vitest row — MS-13's palette GROUPING is the one non-compile-
//             forced part. It has TWO independent registration sites: the F2
//             `ApprovalFormPalette.vue` component's exported `APPROVAL_FORM_PALETTE_GROUPS`, covered
//             by the pre-existing forcing function `approval-form-palette-chips.spec.ts:107`; and
//             `TemplateAuthoringView.vue`'s own separate `fieldPaletteGroups` local (the array
//             actually shipped into the live inline editor), NOT reachable from :107 (correction,
//             gate P2-1: an earlier version of this comment claimed :107 was "generalized" to cover
//             both — false; deleting `explanation` from the view's own array alone left every
//             then-reachable spec green) — covered separately by
//             apps/web/tests/approval-form-inline-editor-extract.spec.ts's "(o) MS-13 completeness"
//             test, which mounts the real view and queries the rendered chip DOM).
//   COVERED here, but against the COMMITTED artifact, not a live rebuild:
//     - MS-7  OpenAPI (dist/openapi.json)  — reads the COMMITTED `packages/openapi/dist/
//             openapi.json` this PR regenerated (`pnpm --filter @metasheet/openapi run
//             generate:sdk`, verified with `guard:codegen`) and asserts `explanation` is in both
//             `FormFieldGeneric.type`'s enum and `FormField`'s `discriminator.mapping`. This is a
//             STALE-ARTIFACT detector, not a live-rebuild proof: no CI workflow in this repo
//             currently runs `pnpm --filter @metasheet/openapi run build` (or `guard:codegen`)
//             before the backend/frontend vitest suites — a PRE-EXISTING gap this file does not
//             newly introduce or claim to close. If `base.yml` is edited again without
//             regenerating `dist/`, THIS test reds (the committed JSON stops matching), but only
//             because the stale committed file is what it reads — it cannot catch a base.yml edit
//             that regenerates dist/openapi.json for something else and forgets this member.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DETAIL_LEAF_FIELD_TYPES,
  FORM_FIELD_TYPES,
} from '../../src/services/ApprovalProductService'

const pgState = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { query: vi.fn(), connect: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildRuntimeGraph(policyOverrides?: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: { allowRevoke: true, ...policyOverrides },
  }
}

function mockSuccessfulCreate(tplId: string, verId: string) {
  pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('INSERT INTO approval_templates')) {
      return {
        rows: [{
          id: tplId, key: String(params?.[0]), name: String(params?.[1]), description: null, category: null,
          visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('INSERT INTO approval_template_versions')) {
      return {
        rows: [{
          id: verId, template_id: tplId, version: 1, status: 'draft',
          form_schema: JSON.parse(String(params?.[1])),
          approval_graph: JSON.parse(String(params?.[2])),
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'Census Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

const create = async (request: unknown) => {
  const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
  return new ApprovalProductService().createTemplate(request as never)
}

/** One minimal-but-VALID top-level field of each canonical type — just enough to pass every
 * OTHER publish check, so a create() failure in the tests below is attributable ONLY to the
 * gate under test (visibility / condition), never an unrelated shape error. */
function minimalField(type: string): Record<string, unknown> {
  switch (type) {
    case 'select':
    case 'multi-select':
      return { id: 'src', type, label: 'Src', options: [{ label: 'A', value: 'a' }] }
    case 'detail':
      return { id: 'src', type, label: 'Src', columns: [{ id: 'c1', type: 'text', label: 'C' }] }
    case 'record-link':
      return { id: 'src', type, label: 'Src', props: { baseId: 'base_1', sheetId: 'sheet_1' } }
    case 'date_range':
      return { id: 'src', type, label: 'Src', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }
    case 'explanation':
      return { id: 'src', type, label: 'Src', props: { text: 'x' } }
    case 'department':
      return { id: 'src', type, label: 'Src', props: { selection: 'single', display: 'leaf_only' } }
    default:
      return { id: 'src', type, label: 'Src' }
  }
}

// MS-8 expectation table (whole-value visibility dependency admission). Hand-authored ONCE, per
// the same "N-1 style census" doctrine as the props-allowlist exact-set tests — the mutation
// probe is deleting a row's exclusion at the real site (ApprovalProductService.ts), not editing
// this table. Completeness (key-set === FORM_FIELD_TYPES) is asserted below.
const MS8_VISIBILITY_ADMITTED: Readonly<Record<string, boolean>> = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  datetime: true,
  select: true,
  'multi-select': true,
  user: true,
  attachment: true,
  detail: false,
  'record-link': false,
  date_range: false,
  explanation: false,
  department: false,
}

// Named refusal pattern per REFUSED MS-8 type. Required so a REFUSED row's assertion can never be
// satisfied by an unrelated crash (e.g. an unmocked DB call reached because validation silently
// let the reference through) — `.rejects.toThrow(pattern)` fails outright if create() actually
// RESOLVES, since every row below (admitted or not) gets a fully-wired successful-create mock.
const MS8_REFUSAL_MESSAGE: Readonly<Record<string, RegExp>> = {
  detail: /cannot reference a detail field/,
  'record-link': /cannot reference a record-link field/,
  date_range: /cannot reference a date_range field/,
  explanation: /cannot reference an explanation field/,
  department: /cannot reference a department field/,
}

// MS-10 expectation table (condition-branch rule admission). `detail` is TRUE here — a PRE-
// EXISTING gap (validateNonScalarFieldsNotUsedInConditions never listed it, and no other check
// validates a condition rule's fieldId against the schema at all), NOT something L8-A introduces
// or is scoped to close; recorded so the table reflects reality rather than intent.
const MS10_CONDITION_ADMITTED: Readonly<Record<string, boolean>> = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  datetime: true,
  select: true,
  'multi-select': true,
  user: true,
  attachment: true,
  detail: true,
  'record-link': false,
  date_range: false,
  explanation: false,
  department: false,
}

// Named refusal pattern per REFUSED MS-10 type — same rejects-must-be-attributable discipline as
// MS8_REFUSAL_MESSAGE above.
const MS10_REFUSAL_MESSAGE: Readonly<Record<string, RegExp>> = {
  'record-link': /cannot reference record-link field/,
  date_range: /cannot reference date_range field/,
  explanation: /cannot reference explanation field/,
  department: /cannot reference department field/,
}

describe('Lock-8 L8-A field-type census (N-1) — backend sites', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  it('MS-2: FORM_FIELD_TYPES is exactly the 14 canonical types (mutation: drop one → reds directly)', () => {
    expect([...FORM_FIELD_TYPES].sort()).toEqual([
      'attachment', 'date', 'date_range', 'datetime', 'department', 'detail', 'explanation',
      'multi-select', 'number', 'record-link', 'select', 'text', 'textarea', 'user',
    ].sort())
  })

  it('MS-4: DETAIL_LEAF_FIELD_TYPES is DERIVED — exactly FORM_FIELD_TYPES minus the excluded set', () => {
    const expected = new Set(
      [...FORM_FIELD_TYPES].filter(
        (type) => type !== 'detail' && type !== 'record-link' && type !== 'date_range' && type !== 'explanation' && type !== 'department',
      ),
    )
    expect([...DETAIL_LEAF_FIELD_TYPES].sort()).toEqual([...expected].sort())
    // Anchored, not re-declared: the exclusion set itself, named explicitly (so a mutation
    // removing ONLY 'explanation' from the real filter is caught even though the derivation
    // above would otherwise recompute the SAME (wrong) answer from a stale local copy).
    expect(DETAIL_LEAF_FIELD_TYPES.has('detail')).toBe(false)
    expect(DETAIL_LEAF_FIELD_TYPES.has('record-link')).toBe(false)
    expect(DETAIL_LEAF_FIELD_TYPES.has('date_range')).toBe(false)
    expect(DETAIL_LEAF_FIELD_TYPES.has('explanation')).toBe(false)
    expect(DETAIL_LEAF_FIELD_TYPES.has('department')).toBe(false)
    expect(DETAIL_LEAF_FIELD_TYPES.has('text')).toBe(true)
  })

  describe('MS-8: visibility whole-value dependency admission, one publish attempt per type', () => {
    it('completeness: the expectation table covers EXACTLY the canonical type set', () => {
      // Adding a 14th type to FORM_FIELD_TYPES with no row here reds THIS assertion first.
      expect(Object.keys(MS8_VISIBILITY_ADMITTED).sort()).toEqual([...FORM_FIELD_TYPES].sort())
    })

    for (const type of [...FORM_FIELD_TYPES].sort()) {
      const admitted = MS8_VISIBILITY_ADMITTED[type]
      it(`${type}: ${admitted ? 'ADMITTED' : 'REFUSED'} as a bare visibility dependency`, async () => {
        const request = {
          key: `census-vis-${type}-${Date.now()}`,
          name: 'Census Visibility',
          formSchema: {
            fields: [
              minimalField(type),
              { id: 'dep', type: 'text', label: 'Dep', visibilityRule: { fieldId: 'src', operator: 'notEmpty' } },
            ],
          },
          approvalGraph: buildRuntimeGraph(),
        }
        // ALWAYS wire a successful-create mock, for BOTH admitted and refused rows: a REFUSED
        // row must fail because the VALIDATOR rejected it, never because an unmocked DB call
        // crashed after validation silently let a mutated reference through — that crash would
        // ALSO satisfy a bare `.rejects.toThrow()` and hide the very half-registration this
        // census exists to catch (mutation-verified below).
        mockSuccessfulCreate(`tpl-vis-${type}`, `ver-vis-${type}`)
        if (admitted) {
          const result = await create(request)
          expect(result.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'src', operator: 'notEmpty' })
        } else {
          const pattern = MS8_REFUSAL_MESSAGE[type]
          expect(pattern, `missing MS8_REFUSAL_MESSAGE row for ${type}`).toBeDefined()
          await expect(create(request)).rejects.toThrow(pattern)
        }
      })
    }
  })

  describe('MS-10: condition-branch rule admission, one publish attempt per type', () => {
    it('completeness: the expectation table covers EXACTLY the canonical type set', () => {
      expect(Object.keys(MS10_CONDITION_ADMITTED).sort()).toEqual([...FORM_FIELD_TYPES].sort())
    })

    for (const type of [...FORM_FIELD_TYPES].sort()) {
      const admitted = MS10_CONDITION_ADMITTED[type]
      it(`${type}: ${admitted ? 'ADMITTED' : 'REFUSED'} as a condition-branch rule field`, async () => {
        const request = {
          key: `census-cond-${type}-${Date.now()}`,
          name: 'Census Condition',
          formSchema: { fields: [minimalField(type)] },
          approvalGraph: {
            nodes: [
              { key: 'start', type: 'start', config: {} },
              {
                key: 'route',
                type: 'condition',
                config: {
                  branches: [{ edgeKey: 'edge-yes', rules: [{ fieldId: 'src', operator: 'eq', value: 'x' }] }],
                  defaultEdgeKey: 'edge-no',
                },
              },
              { key: 'yes', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
              { key: 'no', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
              { key: 'end', type: 'end', config: {} },
            ],
            edges: [
              { key: 'edge-start-route', source: 'start', target: 'route' },
              { key: 'edge-yes', source: 'route', target: 'yes' },
              { key: 'edge-no', source: 'route', target: 'no' },
              { key: 'edge-yes-end', source: 'yes', target: 'end' },
              { key: 'edge-no-end', source: 'no', target: 'end' },
            ],
            policy: { allowRevoke: true },
          },
        }
        // Same discipline as MS-8 above: always wire a successful-create mock so a REFUSED row's
        // rejection is attributable to the VALIDATOR, never an unmocked-DB crash.
        mockSuccessfulCreate(`tpl-cond-${type}`, `ver-cond-${type}`)
        if (admitted) {
          const result = await create(request)
          expect(result.formSchema.fields[0].type).toBe(type)
        } else {
          const pattern = MS10_REFUSAL_MESSAGE[type]
          expect(pattern, `missing MS10_REFUSAL_MESSAGE row for ${type}`).toBeDefined()
          await expect(create(request)).rejects.toThrow(pattern)
        }
      })
    }
  })
})

describe('Lock-8 L8-A MS-7: OpenAPI dist/openapi.json (stale-artifact detector, see file-header note)', () => {
  const openapiJsonPath = join(__dirname, '../../../openapi/dist/openapi.json')
  const openapi = JSON.parse(readFileSync(openapiJsonPath, 'utf-8')) as {
    components: {
      schemas: {
        FormFieldGeneric: { properties: { type: { enum: string[] } } }
        DepartmentFieldProps: {
          additionalProperties: boolean
          required: string[]
          properties: Record<string, unknown>
        }
        FormFieldDepartment: {
          additionalProperties: boolean
          properties: { type: { enum: string[] }; props: { $ref: string } }
          required: string[]
        }
        FormField: { discriminator: { mapping: Record<string, string> } }
      }
    }
  }

  it('FormFieldGeneric.type enum contains explanation', () => {
    expect(openapi.components.schemas.FormFieldGeneric.properties.type.enum).toContain('explanation')
  })

  it('FormField discriminator.mapping routes explanation to FormFieldGeneric', () => {
    expect(openapi.components.schemas.FormField.discriminator.mapping.explanation)
      .toBe('#/components/schemas/FormFieldGeneric')
  })

  it('positive control: date_range (the prior family) is ALSO present — proves this reads a real, non-empty artifact', () => {
    expect(openapi.components.schemas.FormFieldGeneric.properties.type.enum).toContain('date_range')
    expect(openapi.components.schemas.FormField.discriminator.mapping.date_range)
      .toBe('#/components/schemas/FormFieldGeneric')
  })

  it('registers department through a dedicated strict props schema', () => {
    const department = openapi.components.schemas.FormFieldDepartment
    const props = openapi.components.schemas.DepartmentFieldProps
    expect(openapi.components.schemas.FormFieldGeneric.properties.type.enum).not.toContain('department')
    expect(department.additionalProperties).toBe(false)
    expect(department.properties.type.enum).toEqual(['department'])
    expect(department.properties.props.$ref).toBe('#/components/schemas/DepartmentFieldProps')
    expect(department.required).toEqual(['id', 'type', 'label', 'props'])
    expect(props.additionalProperties).toBe(false)
    expect(props.required).toEqual(['selection', 'display'])
    expect(Object.keys(props.properties).sort()).toEqual([
      'defaultDepartmentIds',
      'defaultMode',
      'display',
      'maxSelections',
      'selection',
    ])
    expect(openapi.components.schemas.FormField.discriminator.mapping.department)
      .toBe('#/components/schemas/FormFieldDepartment')
  })
})
