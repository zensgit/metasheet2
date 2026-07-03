import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Mirror-sync tripwire (#1709): the resolver_lookup closed vocabularies are mirrored client-side in
// readSourceConfigs.ts from the server source-of-truth (plugins/plugin-integration-core/lib/*.cjs). If the
// server ever extends a rule, sort direction, or coarse code and the client is not synced, the client
// silently drops the new value. This test fails RED the moment the two diverge — sync readSourceConfigs.ts
// (and the R3 UI/tests) whenever it does.
import {
  RESOLVER_RULES,
  RESOLVER_SORT_DIRECTIONS,
  RESOLVER_ERROR_CODES,
  EVIDENCE_RESOLVER_RULES,
} from '../src/services/integration/readSourceConfigs'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
// The server exports these directly — require, never text-parse.
const { RESOLVER_RULES: SERVER_RESOLVER_RULES, RESOLVER_SORT_DIRECTIONS: SERVER_RESOLVER_SORT_DIRECTIONS } =
  require(path.join(pluginLib, 'read-source-config.cjs'))
const { READ_SOURCE_RESOLVER_ERROR_CODES: SERVER_RESOLVER_ERROR_CODES, READ_SOURCE_RESOLVER_RULES: SERVER_EVIDENCE_RESOLVER_RULES } =
  require(path.join(pluginLib, 'read-source-probe-contract.cjs'))

const set = (values: Iterable<string>): Set<string> => new Set(values)

describe('resolver vocab client/server mirror parity (tripwire)', () => {
  it('client RESOLVER_RULES === server RESOLVER_RULES', () => {
    expect(set(RESOLVER_RULES)).toEqual(set(SERVER_RESOLVER_RULES))
  })

  it('client RESOLVER_SORT_DIRECTIONS === server RESOLVER_SORT_DIRECTIONS', () => {
    expect(set(RESOLVER_SORT_DIRECTIONS)).toEqual(set(SERVER_RESOLVER_SORT_DIRECTIONS))
  })

  it('client RESOLVER_ERROR_CODES === server READ_SOURCE_RESOLVER_ERROR_CODES (the 9 exact codes)', () => {
    expect(set(RESOLVER_ERROR_CODES)).toEqual(set(SERVER_RESOLVER_ERROR_CODES))
    // guard the count so a same-size swap still trips
    expect(RESOLVER_ERROR_CODES.length).toBe(9)
    expect(new Set(RESOLVER_ERROR_CODES).size).toBe(9)
  })

  it('client EVIDENCE_RESOLVER_RULES === server READ_SOURCE_RESOLVER_RULES, both === RESOLVER_RULES', () => {
    expect(EVIDENCE_RESOLVER_RULES).toEqual(set(SERVER_EVIDENCE_RESOLVER_RULES))
    expect(EVIDENCE_RESOLVER_RULES).toEqual(set(RESOLVER_RULES))
    expect(set(SERVER_EVIDENCE_RESOLVER_RULES)).toEqual(set(SERVER_RESOLVER_RULES))
  })
})
