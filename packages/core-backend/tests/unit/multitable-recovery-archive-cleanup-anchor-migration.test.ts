import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, test } from 'vitest'
import { up, down } from '../../src/db/migrations/zzzz20261007120000_amend_recovery_archive_cleanup_anchor'

// Compiler/ordering controls only; genuine deferred PostgreSQL behavior is covered
// by the separately armed owned-cleanup real-DB file, never inferred from this port.
function port(options: { invalidAudit?: number; incompatible?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let audits = 0
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      const rows = sql.includes('AS valid') ? [{ valid: ++audits !== options.invalidAudit }]
        : sql.includes('AS incompatible') ? [{ incompatible: options.incompatible ?? false }] : []
      return { command: 'SELECT', rowCount: rows.length, rows }
    },
    release: () => {},
  }
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: {
    connect: async () => client, end: async () => {},
  } as unknown as Pool }) })
  return { db, calls }
}
const body = (sql: string) => sql.split('$cleanup_anchor$')[1]
const installs = (calls: ReturnType<typeof port>['calls']) => calls.filter(call => call.sql.startsWith('CREATE OR REPLACE FUNCTION'))

describe('cleanup anchor additive migration contract', () => {
  test('keeps predecessor bytes and both compatibility arms, with a narrowly inserted cleanup arm', async () => {
    const upPort = port(); await up(upPort.db)
    const downPort = port(); await down(downPort.db)
    const next = body(installs(upPort.calls)[0].sql), previous = body(installs(downPort.calls)[0].sql)
    expect(createHash('md5').update(previous).digest('hex')).toBe('9d0e0a0832d262412b4464ba103ace82')
    const begin = next.indexOf('      -- Cleanup ownership is mutable;')
    const end = next.indexOf('      PERFORM 1\n        FROM public.meta_record_history_operations operation')
    expect(begin).toBeGreaterThan(0)
    expect(next.slice(0, begin) + next.slice(end)).toBe(previous)
    expect(next).toContain('FOR KEY SHARE;')
    expect(upPort.calls[0].sql).toContain('IN ACCESS EXCLUSIVE MODE')
    expect(installs(upPort.calls)).toHaveLength(1); expect(installs(downPort.calls)).toHaveLength(1)
    expect(upPort.calls.filter(call => call.sql.includes('AS valid'))).toHaveLength(28)
    expect(upPort.calls[7].params).toEqual(['3b4da1ee807a3bb87e7a2c425367bda6', '3b4da1ee807a3bb87e7a2c425367bda6', 'meta_recovery_archives_claim_anchor_operation_delete_guard'])
    expect(upPort.calls[14].params).toContain('trg_mrho_claim_anchor_delete_guard')
  })

  test('requires the complete original producer roster, scope, vector, anchor and eligible cleanup posture', async () => {
    const { db, calls } = port(); await up(db)
    const next = body(installs(calls)[0].sql)
    for (const predicate of ["NEW.state = 'building' AND NEW.build_status = 'abandoned'",
      "NEW.coverage_status = 'incomplete' AND NEW.owner_kind = 'archive_cleanup'",
      'NEW.owner_fence > 1', 'NEW.lease_expires_at > clock_timestamp()',
      'HAVING count(*) = 10', 'ARRAY[1,2,3,4,5,6,7,8,9,10]', 'count(DISTINCT r.operation_id) = 10',
      'r.sheet_id = NEW.sheet_id AND r.source_vector_hash = NEW.source_vector_hash',
      "r.owner_kind = 'archive_builder' AND r.owner_id = NEW.generation_id::text",
      'r.owner_fence = 1 AND r.created_at = NEW.created_at',
      'count(DISTINCT r.reservation_kind) FILTER (WHERE r.ordinal < 10) = 1',
      "'auto_number','attachments_index','permission_evidence','views_config'",
      'r.operation_id = NEW.anchor_operation_id AND r.endpoint_seq = NEW.anchor_seq']) expect(next).toContain(predicate)
    expect(next).not.toMatch(/meta_recovery_archive_attachment_refs|meta_recovery_archive_staging_objects/)
    expect(calls.map(call => call.sql).join('\n')).not.toMatch(/ALTER TABLE|DROP TRIGGER|DISABLE TRIGGER|UPDATE public\.|DELETE FROM/)
  })

  test('compiled delete-guard audits match the original BEFORE DELETE row DDL and independent legal-hold contract', async () => {
    const trigger = 'trg_mrho_claim_anchor_delete_guard'
    const fn = 'meta_recovery_archives_claim_anchor_operation_delete_guard'
    const original = readFileSync(resolve(__dirname, '../../src/db/migrations/zzzz20260828126000_amend_recovery_archive_claim_anchor.ts'), 'utf8')
    const ddl = original.match(new RegExp(`CREATE TRIGGER ${trigger}\\s+(BEFORE|AFTER) (DELETE) ON public\\.meta_record_history_operations\\s+FOR EACH (ROW|STATEMENT)\\s+EXECUTE FUNCTION public\\.${fn}\\(\\)`))
    expect(ddl).not.toBeNull()
    // PostgreSQL trigger event bits: ROW=1, BEFORE=2, DELETE=8.
    const canonicalType = (ddl![3] === 'ROW' ? 1 : 0) | (ddl![1] === 'BEFORE' ? 2 : 0) | 8
    const legalHold = readFileSync(resolve(__dirname, '../../src/db/migrations/zzzz20260828130000_add_recovery_archive_legal_hold_authority.ts'), 'utf8')
    const legacy = legalHold.match(new RegExp(`'meta_record_history_operations',\\s*'${trigger}',\\s*'${fn}',\\s*(\\d+),\\s*(false),\\s*(false),\\s*(false)`))
    expect(legacy).not.toBeNull()
    expect(canonicalType).toBe(Number(legacy![1]))
    expect(canonicalType).toBe(11)
    for (const migrate of [up, down]) {
      const { db, calls } = port(); await migrate(db)
      const audits = calls.filter(call => call.sql.includes('FROM pg_trigger') && call.params.includes(trigger))
      expect(audits).toHaveLength(2)
      for (const audit of audits) {
        expect(audit.sql).toContain('t.tgtype=$1')
        expect(audit.params).toEqual([canonicalType, false, false, fn, false, 'meta_record_history_operations', trigger])
      }
    }
  })

  test.each([1, 7, 8, 14])('fails closed before replacement if protected function/trigger audit %i drifts', async invalidAudit => {
    const { db, calls } = port({ invalidAudit })
    await expect(up(db)).rejects.toThrow('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_SCHEMA_DRIFT')
    expect(installs(calls)).toEqual([])
  })

  test('rollback refuses incompatible live data without replacement or data writes', async () => {
    const { db, calls } = port({ incompatible: true })
    await expect(down(db)).rejects.toThrow('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_IN_USE')
    expect(installs(calls)).toEqual([])
    const check = calls.find(call => call.sql.includes('AS incompatible'))!.sql
    expect(check).toContain('r.owner_kind=a.owner_kind AND r.owner_id=a.owner_id AND r.owner_fence=a.owner_fence')
    expect(check).toContain('o.operation_id=a.anchor_operation_id AND o.endpoint_seq=a.anchor_seq')
  })

  test('prepared native guard tests isolate the deferred transition after committed corruption under restored origin', () => {
    const native = readFileSync(resolve(__dirname, '../integration/multitable-recovery-archive-owned-cleanup-realdb.test.ts'), 'utf8')
    expect(native).toContain('await expiry(generationId); await abandon(generationId)')
    expect(native).toMatch(/await fixture.transaction[\s\S]*SET LOCAL session_replication_role='replica'[\s\S]*await assertOrigin\(\)[\s\S]*expect\(lowerTransition/)
    expect(native).toContain("code: '23514', message: 'recovery_archive_binding_invalid'")
    expect(native).toContain('new Set(release.map(row => row.xid)).size).toBe(1)')
  })

  test('historical claim-anchor fixture removes and restores newer dependencies in causal order, without swallowing drift', () => {
    const native = readFileSync(resolve(__dirname, '../integration/multitable-recovery-archive-claim-anchor-realdb.test.ts'), 'utf8')
    const validOrder = (source: string) => {
      const before = source.split('beforeAll(async () => {')[1]?.split("  test('the exact real-DB")[0] ?? ''
      const after = source.split('afterAll(async () => {')[1]?.split("  test('anchor id/seq")[0] ?? ''
      return before.includes("pg_catalog.to_regprocedure('public.meta_recovery_archives_claim_anchor_reservation_guard()')")
        && before.includes("body_hash !== '9d0e0a0832d262412b4464ba103ace82'")
        && before.indexOf('cleanupAnchorMigration.down') > 0
        && before.indexOf('cleanupAnchorMigration.down') < before.indexOf('checkpointMigration.down')
        && before.indexOf('restoreCleanupAnchorSchema = true') > before.indexOf('cleanupAnchorMigration.down')
        && !/\bcatch\b/.test(before)
        && after.indexOf('checkpointMigration.up') > 0
        && after.indexOf('checkpointMigration.up') < after.indexOf('cleanupAnchorMigration.up')
        && after.includes('if (restoreCleanupAnchorSchema) await db.transaction().execute(cleanupAnchorMigration.up)')
    }
    expect(validOrder(native)).toBe(true)
    expect(validOrder(native.replace('cleanupAnchorMigration.down', 'checkpointMigration.down'))).toBe(false)
    expect(validOrder(native.replace('checkpointMigration.up', 'cleanupAnchorMigration.up'))).toBe(false)
    expect(validOrder(native.replace('if (restoreCleanupAnchorSchema)', 'if (true)'))).toBe(false)
  })

})
