import { readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { checkNewMigration } from '../helpers/authorization-input-migration-rules'
import { APPLICATION_SCHEMA_FINGERPRINT, EVENT_SCHEMA_QUERIES, assertEventSchema, inspectEventSchema } from '../../src/security-events/schema'
import { REASON_CODES, RESULT_CODES, SOURCE_KINDS, PRODUCERS, BOOLEAN_FACTS, COUNT_FACTS } from '../../src/security-events/registry'
import { up, down } from '../../src/db/migrations/zzzz20261122140000_security_events'

const file = 'packages/core-backend/src/db/migrations/zzzz20261122140000_security_events.ts'
const source = readFileSync(new URL('../../src/db/migrations/zzzz20261122140000_security_events.ts', import.meta.url), 'utf8')
let assertionCount = 0
afterEach(() => { assertionCount += expect.getState().assertionCalls; expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
afterAll(() => { console.info('E1_ASSERTIONS_SCHEMA=' + assertionCount) })

describe('E1-A migration and exact schema judgment', () => {
  it('T01 passes the existing checkNewMigration gate without exemptions', () => {
    expect(checkNewMigration(file, source, true).problems).toEqual([])
  })
  it('T01 adds two independent tables, only one internal FK and no public function', () => {
    expect(source.match(/CREATE TABLE/g)).toHaveLength(2)
    expect(source.match(/REFERENCES public\.\w+/g)).toEqual(['REFERENCES public.security_events'])
    expect(source).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION|CREATE TRIGGER|CREATE EXTENSION|ALTER TABLE/)
    expect(source).toContain('se_org_type_time')
    expect(source).toContain('se_system_type_time')
    expect(source).toContain("event_type ~ '^[a-z_]+[.][a-z_]+$'")
    expect(source).not.toContain('event_type IN')
  })
  it('T38 all generic application closed sets and facts have named DB constraints', () => {
    for (const values of [REASON_CODES, RESULT_CODES, SOURCE_KINDS, PRODUCERS]) for (const value of values) expect(source).toContain(`'${value}'`)
    for (const fact of [...BOOLEAN_FACTS, ...COUNT_FACTS, 'duration_ms']) expect(source).toContain(`CONSTRAINT se_fact_${fact} CHECK`)
    expect(source).toContain('octet_length(source_id) <= 2048')
    expect(source).toContain('octet_length(facts::text) <= 2048')
    expect(source).toContain('CONSTRAINT sed_channel_shape CHECK')
    expect(source).toContain("attempt_no <= 1 AND status <> 'queued'")
  })
  it('T34 refuses bypass of the migration transaction and retains a nonempty down', async () => {
    await expect(up({ isTransaction: false } as never)).rejects.toThrow('E1_MIGRATION_TRANSACTION_REQUIRED')
    await expect(down({ isTransaction: false } as never)).rejects.toThrow('E1_MIGRATION_TRANSACTION_REQUIRED')
    expect(source.indexOf('LOCK TABLE')).toBeLessThan(source.indexOf('SELECT EXISTS'))
    expect(source.indexOf('E1_DOWN_BLOCKED')).toBeLessThan(source.indexOf('DROP TABLE'))
    expect(source).toContain('verified compatible image containing this migration')
  })
  it('T38 missing approval or any column/CHECK/index/FK drift fails closed without automatic enrollment', async () => {
    const rows = [
      ['security_event_deliveries', 'security_events'].map(relname => ({ relname, relkind: 'r', relpersistence: 'p', owner_trusted: true, relispartition: false, relrowsecurity: false, relforcerowsecurity: false })),
      [{ attname: 'schema_version', type: 'smallint' }], [{ conname: 'se_facts', definition: 'CHECK fixed' }], [{ index_name: 'se_org_type_time' }], [], [], [],
    ]
    const sql = { async query<R>(text: string) { return { rows: (text.includes('server_version_num') ? [{ major: 16 }] : rows[EVENT_SCHEMA_QUERIES.indexOf(text as never)]) as R[] } } }
    const baseline = await inspectEventSchema(sql)
    expect(baseline.applicationFingerprint).toBe(APPLICATION_SCHEMA_FINGERPRINT)
    await expect(assertEventSchema(sql, [])).rejects.toThrow('E1_SCHEMA_UNAVAILABLE')
    await expect(assertEventSchema(sql, [baseline])).resolves.toBeUndefined()
    for (let section = 1; section < rows.length; section++) {
      const before = rows[section]
      rows[section] = [{ changed: true }] as never
      await expect(assertEventSchema(sql, [baseline])).rejects.toThrow('E1_SCHEMA_UNAVAILABLE')
      rows[section] = before
    }
    await expect(assertEventSchema(sql, [{ ...baseline, applicationFingerprint: 'different' }])).rejects.toThrow()
  })
})
