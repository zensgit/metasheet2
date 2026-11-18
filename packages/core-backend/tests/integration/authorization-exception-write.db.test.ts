import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeAuthorizationException } from '../../src/admin/authorization-exception-write'
import type { LockedAccessGraphUser } from '../../src/directory/access-graph-mutex'

const url = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') throw new Error('isolated loopback fixture required')
}
const suite = url ? describe : describe.skip
const user = (id: string): LockedAccessGraphUser => ({ id, name: null, email: null, username: null, mobile: null, role: null, isActive: true, activationStatus: 'activated', accessGeneration: 0, deletedAt: null, purgedAt: null })
suite('authorization exception writes on isolated PostgreSQL', () => {
  const schema = `exception_${randomUUID().replaceAll('-', '')}`
  const client = new Client({ connectionString: url })
  const executor = { query: async (sql: string, params?: unknown[]) => client.query(sql, params) }
  const base = { actorId: 'actor', userId: 'target', actor: user('actor'), target: user('target') }
  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query(`CREATE TABLE users (id text PRIMARY KEY, permissions jsonb, access_generation bigint DEFAULT 0, updated_at timestamptz DEFAULT now());
      CREATE TABLE user_roles (user_id text, role_id text, PRIMARY KEY(user_id, role_id));
      CREATE TABLE permissions (code text PRIMARY KEY);
      CREATE TABLE user_permissions (user_id text NOT NULL, permission_code text NOT NULL REFERENCES permissions(code), PRIMARY KEY(user_id, permission_code));
      CREATE TABLE directory_deprovision_effects (local_user_id text, status text, updated_at timestamptz);
      CREATE TABLE directory_deprovision_events (local_user_id text, status text, updated_at timestamptz, resolved_at timestamptz, resolved_by text, resolve_note text);
      INSERT INTO users(id, permissions) VALUES ('actor', '[]'), ('target', '["read", null, " write "]');
      INSERT INTO user_roles VALUES ('actor', 'admin');
      INSERT INTO permissions VALUES ('read'), ('write'), ('export');
      INSERT INTO user_permissions VALUES ('target', 'read');
      INSERT INTO directory_deprovision_effects VALUES ('target', 'applied', now());
      INSERT INTO directory_deprovision_events(local_user_id, status) VALUES ('target', 'applied')`)
  })
  afterAll(async () => { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end() })
  it('rolls back a multi-code grant and evidence together', async () => {
    await client.query('BEGIN')
    expect(await writeAuthorizationException(executor, { ...base, action: { kind: 'template.grant', codes: ['read', 'write', 'export'] }, expectedDirectCodes: ['read'] })).toEqual({ changedCodes: ['write', 'export'] })
    expect((await client.query("SELECT status FROM directory_deprovision_events")).rows).toEqual([{ status: 'superseded' }])
    await client.query('ROLLBACK')
    expect((await client.query('SELECT permission_code FROM user_permissions ORDER BY permission_code')).rows).toEqual([{ permission_code: 'read' }])
    expect((await client.query('SELECT status FROM directory_deprovision_events')).rows).toEqual([{ status: 'applied' }])
    expect((await client.query("SELECT access_generation FROM users WHERE id='target'")).rows[0].access_generation).toBe('0')
  })
  it('uses catalog FK and commits direct and legacy changes with exact before-image', async () => {
    await client.query('BEGIN')
    await expect(writeAuthorizationException(executor, { ...base, action: { kind: 'template.grant', codes: ['write', 'missing'] }, expectedDirectCodes: ['read'] })).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' })
    await client.query('ROLLBACK')
    await client.query('BEGIN')
    expect(await writeAuthorizationException(executor, { ...base, action: { kind: 'direct.revoke', code: 'read' }, expectedDirectCodes: ['read'] })).toEqual({ changedCodes: ['read'] })
    expect(await writeAuthorizationException(executor, { ...base, action: { kind: 'legacy.revoke', code: 'write' }, expectedLegacy: { value: ['read', null, ' write '] } })).toEqual({ changedCodes: ['write'] })
    await client.query('COMMIT')
    expect((await client.query("SELECT permissions, access_generation FROM users WHERE id='target'")).rows).toEqual([{ permissions: ['read', null], access_generation: '2' }])
    expect((await client.query('SELECT status FROM directory_deprovision_effects')).rows).toEqual([{ status: 'superseded' }])
    expect((await client.query('SELECT permission_code FROM user_permissions')).rows).toEqual([])
  })
  it('preserves text array nulls and unrelated whitespace', async () => {
    await client.query('ALTER TABLE users DROP COLUMN permissions')
    await client.query('ALTER TABLE users ADD COLUMN permissions text[]')
    await client.query("UPDATE users SET permissions = ARRAY['read', NULL, ' write ']::text[] WHERE id = 'target'")
    await client.query('BEGIN')
    expect(await writeAuthorizationException(executor, { ...base, action: { kind: 'legacy.revoke', code: 'write' }, expectedLegacy: { value: ['read', null, ' write '] } })).toEqual({ changedCodes: ['write'] })
    await client.query('COMMIT')
    expect((await client.query("SELECT permissions FROM users WHERE id='target'")).rows).toEqual([{ permissions: ['read', null] }])
  })

})
