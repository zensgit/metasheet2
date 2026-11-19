import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const contracts = [
  ['parts', yaml.load(readFileSync(resolve(__dirname, '../../../openapi/src/paths/permissions.yml'), 'utf8'))],
  ['root', yaml.load(readFileSync(resolve(__dirname, '../../../openapi/src/openapi.yml'), 'utf8'))],
] as const
const paths = ['/api/permissions/grant', '/api/permissions/revoke', '/api/admin/permission-templates/apply']
const busyBody = { code: 'AUTHORIZATION_INPUT_BUSY', error: 'Authorization inputs are busy; retry this change.' }
const recoveryBody = { ok: false, error: { code: 'RECOVERY_AUTHORITY_BUSY', message: 'Recovery is stabilizing permissions; retry this change.', details: { retryable: true } } }

function at(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = (value as Record<string, unknown>)[key]
  return value
}

describe('direct permission OpenAPI target and conflict contract', () => {
  for (const [name, document] of contracts) {
    for (const path of name === 'root' ? paths.slice(0, 2) : paths) {
      it(`${name} ${path} exactly records the canonical string boundary`, () => {
        const schema = at(document, 'paths', path, 'post', 'requestBody', 'content', 'application/json', 'schema', 'properties', 'userId') as { type: string; minLength: number; not: { anyOf: Array<{ pattern: string }> } }
        expect({ type: schema.type, minLength: schema.minLength, not: schema.not }).toEqual({
          type: 'string', minLength: 1, not: { anyOf: [{ pattern: '^\\s' }, { pattern: '\\s$' }] },
        })
        for (const value of ['user', 'internal space', 'a\tb', 'a\nb', '', ' ', ' user', 'user ', 'user\n', 'user\r\n', '\uFEFFuser', 'user\u00A0', 42, true, null, ['user'], { id: 'user' }]) {
          const accepted = typeof value === schema.type && typeof value === 'string' && value.length >= schema.minLength
            && !schema.not.anyOf.some(({ pattern }) => new RegExp(pattern).test(value))
          expect(accepted).toBe(typeof value === 'string' && value.length > 0 && value === value.trim())
        }
      })

      it(`${name} ${path} keeps the two typed conflict families distinct`, () => {
        const branches = at(document, 'paths', path, 'post', 'responses', '409', 'content', 'application/json', 'schema', 'oneOf') as unknown[]
        expect(branches).toHaveLength(3)
        expect(at(branches[0], 'required')).toEqual(['code', 'error'])
        expect(at(branches[0], 'properties', 'code', 'enum')).toEqual([busyBody.code])
        expect(at(branches[0], 'properties', 'error', 'enum')).toEqual([busyBody.error])
        expect(at(branches[1], 'properties', 'code', 'enum')).toEqual(['STALE', 'USER_IN_RECYCLE_BIN'])
        expect(at(branches[2], 'properties', 'ok', 'enum')).toEqual([recoveryBody.ok])
        expect(at(branches[2], 'properties', 'error', 'properties', 'code', 'enum')).toEqual([recoveryBody.error.code])
        expect(at(branches[2], 'properties', 'error', 'properties', 'message', 'enum')).toEqual([recoveryBody.error.message])
        expect(at(branches[2], 'properties', 'error', 'properties', 'details', 'properties', 'retryable', 'enum')).toEqual([true])
        expect(at(document, 'paths', path, 'post', 'responses', '404')).toBeDefined()
      })
    }
  }
})
