import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import Ajv, { type SchemaObject } from 'ajv'
import { describe, expect, it } from 'vitest'
import { buildAttendancePunchDetailPreviewRecordV1 } from '../../src/attendance/w4c3a-punch-detail-preview-record'
import { punchDetailPreparationFixture } from '../../src/attendance/__tests__/helpers/punch-detail-plan-fixture'

type Operation = {
  requestBody: { content: { 'application/json': { schema: SchemaObject } } }
  responses: Record<string, { content?: { 'application/json': { schema: SchemaObject } }; $ref?: string }>
}
type Contract = { components: { schemas: Record<string, SchemaObject> }; paths: Record<string, { post: Operation }> }
const openapi = new URL('../../../openapi/', import.meta.url)
const contract: Contract = JSON.parse(readFileSync(new URL('dist/openapi.json', openapi), 'utf8'))
const yaml = createRequire(new URL('package.json', openapi))('js-yaml') as { load(text: string): unknown }
const source = yaml.load(readFileSync(new URL('src/base.yml', openapi), 'utf8')) as Contract
const paths = yaml.load(readFileSync(new URL('src/paths/attendance.yml', openapi), 'utf8')) as Contract
const ajv = new Ajv({ strict: false, validateFormats: false })
const compile = (schema: SchemaObject) => ajv.compile({ ...schema, components: contract.components })
const input = punchDetailPreparationFixture().envelope.__punchDetailInput
const endpoints = ['preview', 'preview-async', 'commit', 'commit-async']
const namedRef = '#/components/schemas/AttendancePunchDetailImportRequest'

describe('generated punch-detail four-path import contract', () => {
  for (const endpoint of endpoints) {
    const route = '/api/attendance/import/' + endpoint
    const operation = contract.paths[route].post
    const schema = operation.requestBody.content['application/json'].schema
    const validate = compile(schema)

    it(`${endpoint} accepts both daily input and the explicit physical-event input`, () => {
      expect(schema.$ref).toBe('#/components/schemas/AttendanceImportPublicRequest')
      expect(validate({ rows: [{ userId: 'synthetic', workDate: '2025-11-02' }], futureField: true })).toBe(true)
      expect(validate({ ...input, idempotencyKey: 'preview:', previewLimit: 2, mode: 'override' })).toBe(true)
    })

    it(`${endpoint} rejects an invalid named variant without a daily fallback`, () => {
      for (const candidate of [
        { ...input, inputKind: 'unknown' }, { ...input, inputKind: null },
        { ...input, actorId: 'forged' }, { ...input, rows: [] },
        { ...input, __punchDetailInput: input },
      ]) expect(validate(candidate), JSON.stringify(validate.errors)).toBe(false)
    })

    it(`${endpoint} documents shared refusal statuses and preserves bearer authentication`, () => {
      expect(operation.responses['409']).toEqual({ $ref: '#/components/responses/Conflict' })
      for (const status of ['400', '401', '403', '422', '500', '503']) expect(operation.responses[status]).toBeDefined()
      expect(paths.paths[route].post).toEqual(operation)
      expect((operation as Operation & { security: unknown }).security).toEqual([{ bearerAuth: [] }])
    })
  }

  it('refuses a reserved internal command even without a named discriminator', () => {
    for (const endpoint of endpoints) {
      const schema = contract.paths['/api/attendance/import/' + endpoint].post.requestBody.content['application/json'].schema
      const validate = compile(schema)
      expect(validate({ rows: [], __punchDetailInput: input }), endpoint).toBe(false)
    }
  })

  it('rejects invalid event bounds, directions, instants and transport shapes', () => {
    const validate = compile({ $ref: namedRef })
    for (const candidate of [
      { ...input, punches: [] }, { ...input, punches: Array(7).fill(input.punches[0]) },
      { ...input, punches: [{ ...input.punches[0], direction: 'other' }] },
      { ...input, punches: [{ ...input.punches[0], occurredAt: '2025-11-02T04:30:00Z' }] },
      { ...input, punches: [{ ...input.punches[0], workMinutes: 10 }] },
      { ...input, previewLimit: '2' }, { ...input, itemsLimit: 0 }, { ...input, returnItems: 'false' },
      { ...input, mode: 'merge' }, { ...input, userId: '' }, { ...input, timezone: '' },
    ]) expect(validate(candidate), JSON.stringify(validate.errors)).toBe(false)
  })

  for (const kind of ['fold_start', 'fold_end', 'gap', 'shared_fold'] as const) {
    it(`describes the actual ${kind} frozen preview and job projection`, () => {
      const { record } = buildAttendancePunchDetailPreviewRecordV1({
        jobId: '4311c1de-e548-4a87-a0d6-b57f26301f9b', preparation: punchDetailPreparationFixture(kind), previewLimit: 2,
      })
      const response = contract.paths['/api/attendance/import/preview'].post.responses['200'].content!['application/json'].schema
      const validateResponse = compile(response)
      expect(validateResponse({ ok: true, data: record.preview }), JSON.stringify(validateResponse.errors)).toBe(true)
      const validateJob = compile({ $ref: '#/components/schemas/AttendanceImportJob' })
      expect(validateJob({ kind: 'preview', preview: record.preview }), JSON.stringify(validateJob.errors)).toBe(true)
      expect(validateJob({ kind: 'preview', preview: null }), JSON.stringify(validateJob.errors)).toBe(true)
      expect(validateResponse({ ok: true, data: { ...record.preview, inputKind: 'unknown' } })).toBe(false)
      const first = record.preview.targets[0]
      expect(validateResponse({ ok: true, data: { ...record.preview, targets: [{ ...first, outcome: 'unknown' }] } })).toBe(false)
    })
  }

  it('describes named commit counts without changing daily result acceptance', () => {
    const response = contract.paths['/api/attendance/import/commit'].post.responses['200'].content!['application/json'].schema
    const validate = compile(response)
    expect(validate({ ok: true, data: { imported: 1, items: [], skipped: [] } })).toBe(true)
    expect(validate({ ok: true, data: { inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1, imported: 4, items: [] } })).toBe(true)
    expect(validate({ ok: true, data: { inputKind: 'unknown', eventCount: 4, targetCount: 1 } })).toBe(false)
  })

  it('keeps generated schemas equal to YAML and documents server-only semantic checks', () => {
    const names = Object.keys(source.components.schemas).filter((name) => name.startsWith('AttendancePunchDetail')
      || ['AttendanceImportPublicRequest', 'AttendanceImportPreviewResponseData', 'AttendanceImportCommitResponseData', 'AttendanceImportJob'].includes(name))
    expect(names).toContain('AttendancePunchDetailImportRequest')
    for (const name of names) expect(contract.components.schemas[name]).toEqual(source.components.schemas[name])
    const request = source.components.schemas.AttendancePunchDetailImportRequest
    expect(request.description).toContain('strictly chronological')
    expect(request.description).toContain('alternating')
    expect(request.description).toContain('server')
  })
})
