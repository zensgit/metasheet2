/**
 * The security_action_challenges migration executed against a recording Kysely driver: the statement
 * sequence of up() and down(), the guarded down(), and the closed sets, constraint names and TTL that
 * must agree with the service and policy constants. No database is contacted.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import { PRIVILEGE_CLASSES, SECURITY_ACTION_ASSURANCE_LEVELS, SECURITY_ACTION_METHODS, SECURITY_ACTION_PURPOSES } from '../../src/auth/external-login-assurance'
import { SECURITY_ACTION_FAILURE_CODES, SECURITY_ACTION_PROOF_STATUSES, SECURITY_ACTION_PROOF_TTL_SECONDS } from '../../src/auth/security-action-proof'
import { down, SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE, up } from '../../src/db/migrations/zzzz20261106120000_create_security_action_challenges'

const MIGRATION = path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations', 'zzzz20261106120000_create_security_action_challenges.ts')
const SOURCE = readFileSync(MIGRATION, 'utf8')

type Recorded = { sql: string; parameters: readonly unknown[] }

function recordingDb(answers: { lockTimeout: string; statementTimeout: string; exists: boolean; present: boolean }) {
  const log: Recorded[] = []
  class RecordingConnection implements DatabaseConnection {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      log.push({ sql: compiled.sql.replace(/\s+/g, ' ').trim(), parameters: compiled.parameters })
      if (/current_setting\('lock_timeout'\)/.test(compiled.sql)) return { rows: [{ lock_timeout: answers.lockTimeout, statement_timeout: answers.statementTimeout } as R] }
      if (/to_regclass/.test(compiled.sql)) return { rows: [{ e: answers.exists } as R] }
      if (/EXISTS \(SELECT 1 FROM security_action_challenges\)/.test(compiled.sql)) return { rows: [{ present: answers.present } as R] }
      return { rows: [] }
    }
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error('no stream') }
  }
  class RecordingDriver implements Driver {
    async init(): Promise<void> {}
    async acquireConnection(): Promise<DatabaseConnection> { return new RecordingConnection() }
    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}
    async releaseConnection(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, log }
}

function heads(log: Recorded[]): string[] {
  return log.map((entry) => entry.sql.replace(/\s*\(.*$/s, '').split(' ').slice(0, 4).join(' ').replace(/ (?:ON|BEFORE)$/, ''))
}

function inList(constraint: string): string[] {
  const match = SOURCE.match(new RegExp(`${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`))
  if (!match) throw new Error(`no closed set for ${constraint}`)
  return match[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''))
}

describe('up()', () => {
  it('reads the timeouts, bounds them, creates the table, the two indexes, the validated foreign key, the function and the trigger, then restores the timeouts', async () => {
    const { db, log } = recordingDb({ lockTimeout: '7s', statementTimeout: '42s', exists: false, present: false })
    await up(db)
    expect(heads(log)).toEqual([
      'SELECT current_setting',
      'SELECT set_config',
      'CREATE TABLE security_action_challenges',
      'CREATE UNIQUE INDEX uq_security_action_live_proof',
      'CREATE INDEX idx_security_action_user_created',
      'ALTER TABLE security_action_challenges ADD',
      'ALTER TABLE security_action_challenges VALIDATE',
      'CREATE FUNCTION guard_security_action_challenge_transition',
      'CREATE TRIGGER security_action_challenge_transition',
      'SELECT set_config',
    ])
    expect(log[1].parameters).toEqual(['5s', '1min'])
    expect(log[9].parameters).toEqual(['7s', '42s'])
    expect(log[3].sql).toContain("ON security_action_challenges (user_id, session_id, purpose) WHERE status = 'issued'")
    expect(log[5].sql).toContain('ADD CONSTRAINT security_action_challenges_user_fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID')
    expect(log[6].sql).toBe('ALTER TABLE security_action_challenges VALIDATE CONSTRAINT security_action_challenges_user_fk')
    expect(log[8].sql).toContain('BEFORE INSERT OR UPDATE ON security_action_challenges FOR EACH ROW EXECUTE FUNCTION guard_security_action_challenge_transition()')
    const fn = log[7].sql
    expect(fn).toContain("IF TG_OP = 'INSERT' THEN IF NEW.status NOT IN ('issued', 'failed') OR NEW.created_at > now() THEN RAISE EXCEPTION")
    expect(fn).toContain("IF OLD.status <> 'issued' OR NEW.status NOT IN ('consumed', 'superseded') OR (to_jsonb(NEW) - ARRAY['status', 'consumed_at', 'consumed_action_ref', 'superseded_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'consumed_at', 'consumed_action_ref', 'superseded_at']) THEN RAISE EXCEPTION")
    expect(fn.split("ERRCODE = '55000'")).toHaveLength(3)
    expect(fn).toContain('SET search_path = pg_catalog')
  })

  it('creates the table without IF NOT EXISTS and names every constraint', () => {
    expect(SOURCE).not.toContain('IF NOT EXISTS')
    // The foreign key is named twice: once when added NOT VALID, once when validated.
    const names = [...new Set([...SOURCE.matchAll(/CONSTRAINT (security_action_challenges_\w+)/g)].map((match) => match[1]))]
    expect(SOURCE.split('CONSTRAINT security_action_challenges_user_fk')).toHaveLength(3)
    expect(names).toEqual([
      'security_action_challenges_pkey', 'security_action_challenges_purpose_chk', 'security_action_challenges_target_kind_chk',
      'security_action_challenges_identity_target_chk', 'security_action_challenges_empty_slot_chk', 'security_action_challenges_binding_revision_chk',
      'security_action_challenges_method_chk', 'security_action_challenges_method_connection_chk', 'security_action_challenges_status_chk',
      'security_action_challenges_privilege_class_chk', 'security_action_challenges_policy_revision_chk', 'security_action_challenges_witness_chk',
      'security_action_challenges_proof_hash_chk', 'security_action_challenges_client_binding_chk', 'security_action_challenges_action_ref_chk',
      'security_action_challenges_failed_shape_chk', 'security_action_challenges_proof_shape_chk', 'security_action_challenges_consumed_chk',
      'security_action_challenges_superseded_chk', 'security_action_challenges_action_ref_status_chk', 'security_action_challenges_ttl_chk',
      'security_action_challenges_user_fk',
    ])
  })

  it('agrees with the service and policy constants on every closed set and the lifetime', () => {
    expect(inList('security_action_challenges_purpose_chk')).toEqual([...SECURITY_ACTION_PURPOSES])
    expect(inList('security_action_challenges_method_chk')).toEqual([...SECURITY_ACTION_METHODS])
    expect(inList('security_action_challenges_status_chk')).toEqual([...SECURITY_ACTION_PROOF_STATUSES])
    expect(inList('security_action_challenges_privilege_class_chk')).toEqual([...PRIVILEGE_CLASSES])
    expect(SOURCE).toContain(`assurance IN (${SECURITY_ACTION_ASSURANCE_LEVELS.map((level) => `'${level}'`).join(', ')})`)
    expect(SOURCE).toContain(`failure_code IN (${SECURITY_ACTION_FAILURE_CODES.map((code) => `'${code}'`).join(', ')})`)
    expect(SOURCE).toContain(`expires_at <= created_at + interval '${SECURITY_ACTION_PROOF_TTL_SECONDS} seconds'`)
    expect(SOURCE).toContain('expires_at > created_at')
    expect(SOURCE).toContain("target_kind IN ('empty_slot', 'identity_revision')")
  })

  it('imports kysely only, never an application module', () => {
    const source = ts.createSourceFile('m.ts', SOURCE, ts.ScriptTarget.Latest, true)
    const specifiers = source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
    expect(specifiers).toEqual(['kysely'])
    expect(SOURCE).not.toMatch(/\brequire\s*\(/)
  })
})

describe('down()', () => {
  it('refuses while the table holds a row, with a values-free message and no DROP', async () => {
    const { db, log } = recordingDb({ lockTimeout: '0', statementTimeout: '0', exists: true, present: true })
    await expect(down(db)).rejects.toMatchObject({ code: SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE })
    const error = await down(db).catch((e: Error) => e)
    expect(error.message).toMatch(/^SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED: down\(\) refused while security_action_challenges holds rows/)
    expect(error.message).not.toMatch(/\d/)
    expect(log.some((entry) => /DROP/i.test(entry.sql))).toBe(false)
    expect(heads(log).slice(0, 4)).toEqual(['SELECT current_setting', 'SELECT set_config', 'SELECT to_regclass', 'SELECT EXISTS'])
  })

  it('drops the table and the function and restores the timeouts when the table is empty or absent', async () => {
    const empty = recordingDb({ lockTimeout: '3s', statementTimeout: '9s', exists: true, present: false })
    await down(empty.db)
    expect(heads(empty.log)).toEqual(['SELECT current_setting', 'SELECT set_config', 'SELECT to_regclass', 'SELECT EXISTS', 'DROP TABLE IF EXISTS', 'DROP FUNCTION IF EXISTS', 'SELECT set_config'])
    expect(empty.log[6].parameters).toEqual(['3s', '9s'])
    const absent = recordingDb({ lockTimeout: '0', statementTimeout: '0', exists: false, present: true })
    await down(absent.db)
    expect(heads(absent.log)).toEqual(['SELECT current_setting', 'SELECT set_config', 'SELECT to_regclass', 'DROP TABLE IF EXISTS', 'DROP FUNCTION IF EXISTS', 'SELECT set_config'])
  })
})
