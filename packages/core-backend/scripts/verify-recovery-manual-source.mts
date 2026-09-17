/** Synthetic acceptance only; requires the dedicated local cluster below. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const require = createRequire(import.meta.url)
const { readRecoveryArchiveRelationalSource } = require('../src/multitable/recovery-archive-relational-source.ts') as typeof import('../src/multitable/recovery-archive-relational-source')
assert.equal(process.env.NODE_ENV, 'test', 'SYNTHETIC_TEST_MODE_REQUIRED')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const connection = { host: '127.0.0.1', port: 55483, user: 'tm_manual' }
const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 5000 })
const database = `tm_manual_source_${randomUUID().replaceAll('-', '')}`
const root = await mkdtemp('/private/tmp/tm-manual-source-run-')
let created = false
let reader: Client | undefined
let writer: Client | undefined
try {
  await admin.connect()
  assert.deepEqual((await admin.query('SHOW data_directory')).rows, [
    { data_directory: '/private/tmp/tm-manual-source-pg-20260918' },
  ])
  assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner, 'tm_manual')
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  await writeFile(`${root}/config.json`, '{}', { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root,
    NODE_ENV: 'test', METASHEET_ENV_DIR: root, CONFIG_FILE: `${root}/config.json`,
    DATABASE_URL: `postgresql://tm_manual@127.0.0.1:55483/${database}`,
    SECRET_PROVIDER: 'env', JWT_SECRET: randomUUID(),
  }
  for (const phase of ['fresh', 'replay']) {
    const run = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'migrate'], {
      cwd: repo, env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    })
    await writeFile(`${root}/${phase}.log`, `${run.stdout ?? ''}${run.stderr ?? ''}`, { mode: 0o600 })
    assert.equal(run.status, 0, `MIGRATION_${phase.toUpperCase()}_FAILED`)
  }
  reader = new Client({ ...connection, database })
  writer = new Client({ ...connection, database })
  await reader.connect()
  await writer.connect()
  await reader.query(`
    INSERT INTO meta_bases(id,name,workspace_id) VALUES ('b','Synthetic','w');
    INSERT INTO meta_sheets(id,name,base_id) VALUES ('s','Synthetic','b'),('empty','Empty','b');
    INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES ('f','s','Before','string','{}',1);
    INSERT INTO meta_records(id,sheet_id,data,version) VALUES ('r','s','{"f":"before"}',7);
    INSERT INTO meta_links(id,field_id,record_id,foreign_record_id) VALUES ('l','f','r','target');
    INSERT INTO meta_field_auto_number_sequences(field_id,sheet_id,next_value) VALUES ('f','s',9007199254740993);
    INSERT INTO meta_views(id,sheet_id,name,type) VALUES ('v','s','Grid','grid');
    INSERT INTO meta_field_value_tombstones(id,sheet_id,field_id,record_id,value,reason,created_at)
      VALUES ('00000000-0000-0000-0000-000000000001','s','gone','r','"old"','field_delete','2026-09-17T12:00:00.123Z');
    INSERT INTO meta_link_tombstones(id,sheet_id,field_id,record_id,foreign_record_id,reason,created_at)
      VALUES ('00000000-0000-0000-0000-000000000002','s','gone','r','target','field_delete','2026-09-17T12:00:00.123Z');
  `)
  const query = (text: string, params: unknown[]) => reader!.query(text, params)
  const scope = { sheetId: 's', baseId: 'b', workspaceId: 'w' }
  const read = () => readRecoveryArchiveRelationalSource(query, scope)
  const first = await read()
  assert.equal(Object.keys(first).length, 7)
  assert.ok(Object.values(first).every((rows) => rows.length === 1))
  assert.deepEqual(JSON.parse(JSON.stringify(first.auto_number)), [{ field_id: 'f', next_value: '9007199254740993' }])
  assert.equal((first.field_value_tombstones[0] as { created_at: string }).created_at, '2026-09-17T12:00:00.123Z')
  const unavailable = { code: 'RECOVERY_ARCHIVE_RELATIONAL_SOURCE_UNAVAILABLE' }
  for (const mismatch of [{ ...scope, workspaceId: 'other' }, { ...scope, baseId: 'other' }, { ...scope, sheetId: 'missing' }]) {
    await assert.rejects(readRecoveryArchiveRelationalSource(query, mismatch), unavailable)
  }
  assert.ok(Object.values(await readRecoveryArchiveRelationalSource(query, { ...scope, sheetId: 'empty' })).every((rows) => rows.length === 0))

  // An atomic writer changes two sections. Uncommitted state is invisible;
  // a pinned transaction remains coherent after commit; a fresh read advances.
  await writer.query('BEGIN')
  await writer.query(`UPDATE meta_fields SET name='After' WHERE id='f'`)
  await writer.query(`UPDATE meta_records SET data='{"f":"after"}',version=8 WHERE id='r'`)
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.deepEqual(await read(), first)
  await writer.query('COMMIT')
  assert.deepEqual(await read(), first)
  await reader.query('COMMIT')
  const after = await read()
  assert.equal((after.schema[0] as { name: string }).name, 'After')
  assert.deepEqual(JSON.parse(JSON.stringify(after.records)), [{ record_id: 'r', exists: true, version: 8, data: { f: 'after' } }])
  await reader.query(`UPDATE meta_bases SET deleted_at=now() WHERE id='b'`)
  await assert.rejects(read(), unavailable)
  await reader.query(`UPDATE meta_bases SET deleted_at=NULL WHERE id='b'`)
  await reader.query(`UPDATE meta_sheets SET deleted_at=now() WHERE id='s'`)
  await assert.rejects(read(), unavailable)
  console.log('PASS: full migration/replay; seven sections; scope/base/sheet liveness; two-connection snapshot visibility')
} finally {
  await writer?.end()
  await reader?.end()
  if (created) {
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)
    await admin.query(`DROP DATABASE "${database}"`)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [database])).rows[0].n, 0)
    console.log('CLEAN: owned database and connections = 0')
  }
  await admin.end()
  await rm(root, { recursive: true })
}
