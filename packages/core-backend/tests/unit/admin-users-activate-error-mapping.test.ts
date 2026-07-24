import { describe, expect, it } from 'vitest'
import { mapActivateError } from '../../src/routes/admin-users'

/**
 * The activate endpoint's error surface. #4581 r2 stopped `ACTIVATE_ALIAS_FAILED` being reported
 * as a client 409 and stopped it echoing the alias claim's message — but nothing asserted either,
 * so both were one edit away from coming back.
 *
 * The last case is the one that motivated extracting this function: `pg` puts its SQLSTATE in the
 * same `.code` property `throwCoded` uses, so any unmapped database failure used to publish the
 * SQLSTATE as the API error code and the driver's sentence as the message. Verified against real
 * Postgres by renaming a column out from under the activate transaction: the client received
 * `500 / 42703 / column "created_at" of relation "user_orgs" does not exist`.
 */
describe('mapActivateError (activate endpoint error surface)', () => {
  const codedError = (code: string, message: string) =>
    Object.assign(new Error(message), { code })

  it('classifies client/config conflicts as 409 and keeps our authored message', () => {
    for (const code of [
      'ACTIVATE_NOT_PENDING',
      'ACTIVATE_LINK_MISMATCH',
      'ACTIVATE_ALIAS_CONFLICT',
      'ACTIVATE_ALIAS_REQUIRED',
      'ACTIVATE_SOURCE_INACTIVE',
    ]) {
      const mapped = mapActivateError(codedError(code, `authored: ${code}`))
      expect({ code: mapped.code, status: mapped.status }).toEqual({ code, status: 409 })
      expect(mapped.message).toBe(`authored: ${code}`)
    }
  })

  it('classifies a missing/blank target as 404 / 400', () => {
    expect(mapActivateError(codedError('ACTIVATE_USER_NOT_FOUND', 'nope')).status).toBe(404)
    expect(mapActivateError(codedError('ACTIVATE_USER_REQUIRED', 'nope')).status).toBe(400)
  })

  it('classifies a failed alias WRITE as infrastructure: 500, never 409, never the raw text', () => {
    const mapped = mapActivateError(
      codedError('ACTIVATE_ALIAS_FAILED', 'connection refused 5432 DETAIL: secret'),
    )
    expect(mapped.status).toBe(500)
    expect(mapped.code).toBe('ACTIVATE_ALIAS_FAILED')
    expect(mapped.message).toBe('Failed to claim login alias during activation')
    expect(mapped.message).not.toMatch(/5432|DETAIL|secret/i)
  })

  it('never publishes a PostgreSQL SQLSTATE as the API error code, nor driver text as the message', () => {
    const pgError = codedError('42703', 'column "created_at" of relation "user_orgs" does not exist')
    const mapped = mapActivateError(pgError)

    expect(mapped.status).toBe(500)
    expect(mapped.code).toBe('ACTIVATE_FAILED')
    expect(mapped.message).toBe('Activation failed')
    expect(mapped.code).not.toMatch(/^[0-9A-Z]{5}$/)
    expect(mapped.message).not.toMatch(/column|relation|does not exist|user_orgs/i)
  })

  it('collapses an uncoded throw rather than leaking whatever it happened to say', () => {
    const mapped = mapActivateError(new Error('Cannot read properties of undefined (reading foo)'))
    expect(mapped).toEqual({ status: 500, code: 'ACTIVATE_FAILED', message: 'Activation failed' })
  })
})
