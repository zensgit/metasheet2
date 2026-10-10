import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

const contract = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../openapi/dist/openapi.json', import.meta.url,
)), 'utf8'))
const operation = contract.paths['/api/attendance/punch'].post
const schema = operation.requestBody.content['application/json'].schema
const validate = new Ajv({ strict: false }).compile(schema)

describe('generated ordinary online punch contract', () => {
  it('accepts current clients and unrelated unknown fields', () => {
    expect(validate({ eventType: 'check_in' })).toBe(true)
    expect(validate({ eventType: 'check_out', timezone: 'Asia/Singapore', meta: { note: 'synthetic' }, futureField: true })).toBe(true)
  })

  for (const alias of ['occurredAt', 'occurred_at']) {
    for (const value of [null, '', 0, '2026-04-15T09:00:00.000Z']) {
      it(`refuses ${alias} by presence (${JSON.stringify(value)})`, () => {
        expect(validate({ eventType: 'check_in', [alias]: value })).toBe(false)
      })
    }
  }

  it('keeps the event enum and required event strict', () => {
    expect(validate({ eventType: 'invalid' })).toBe(false)
    expect(validate({})).toBe(false)
  })

  it('documents the fixed refusal and preserves recorded event timestamps', () => {
    expect(operation.description).toContain('PUNCH_CLIENT_TIMESTAMP_FORBIDDEN')
    expect(operation.description).toContain('The server determines online punch time')
    expect(operation.responses['400']).toEqual({ $ref: '#/components/responses/ValidationError' })
    expect(contract.components.schemas.AttendanceEvent.properties.occurred_at).toEqual({ type: 'string', format: 'date-time' })
  })
})
