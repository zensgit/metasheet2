import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const responses = {
  catalog: { status: 503, body: { ok: false, error: {
    code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED', message: 'Archive recovery is disabled.',
  } } },
  preview: { status: 503, body: { ok: false, error: {
    code: 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE', message: 'Archive recovery runtime is unavailable.',
  } } },
}

async function fixture(present = true, stableTimestamps = false) {
  const root = await mkdtemp(join(tmpdir(), 'tm-local-rollback-witness-'))
  const attachmentPath = join(root, 'attachments')
  const file = join(attachmentPath, 'nested', 'object')
  if (present) {
    await mkdir(join(attachmentPath, 'nested'), { recursive: true, mode: 0o700 })
    await writeFile(file, 'captured', { mode: 0o600 })
  }
  const attachment = { id: 'synthetic-attachment', sheet_id: 'synthetic-sheet', storage_path: 'nested/object' }
  const sheet = { id: 'synthetic-sheet', name: 'synthetic-before', recovery_writer_state: null as string | null,
    recovery_writer_owner_kind: null, recovery_writer_owner_id: null, recovery_writer_owner_fence: null,
    recovery_writer_lease_until: null, recovery_writer_updated_at: null }
  const operation = { sheet_id: 'synthetic-sheet', operation_id: 'synthetic-operation', endpoint_seq: '17',
    event_count: 1, operation_kind: 'ordinary', event_contract_version: 2, component_count: null }
  const member = { sheet_id: 'synthetic-sheet', parent_operation_id: 'synthetic-parent', ordinal: 1,
    child_operation_id: operation.operation_id, child_endpoint_seq: '17', child_event_count: 1 }
  const sequence = { last_value: '17', is_called: true }
  const auth = { last_login_at: null as string | null, updated_at: 'synthetic-before-login' }
  const missingTables = new Set<string>()
  let sheetPresent = true
  let sequencePresent = true
  const start = vi.fn<[], Promise<void>>(async () => {})
  const end = vi.fn(async () => {})
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('current_database()')) return { rows: [{ name: 'synthetic-db' }] }
    expect(sql).not.toMatch(/\b(?:nextval|setval)\s*\(/i)
    if (sql.includes('pg_catalog.pg_tables')) {
      const names = [
        'meta_recovery_archives', 'meta_recovery_archive_jobs',
        'meta_recovery_archive_job_chunks', 'meta_recovery_archive_nonce_reservations',
        'meta_sheets', 'meta_records', 'meta_record_revisions', 'multitable_attachments',
        'meta_record_history_operations', 'meta_record_history_operation_members', 'users',
      ]
      return { rows: names.filter(name => !missingTables.has(name)
        && (!sql.includes('left(tablename') || name.startsWith('meta_recovery_')))
        .map(tablename => ({ tablename })) }
    }
    if (sql.includes('FROM public.meta_record_chain_seq')) {
      expect(sql).toMatch(/SELECT last_value::text, is_called FROM public\.meta_record_chain_seq/)
      expect(values).toBeUndefined()
      return { rows: sequencePresent ? [{ ...sequence }] : [] }
    }
    const table = sql.match(/FROM public\."([a-z_]+)"/)?.[1]
    if (table && missingTables.has(table)) throw new Error('synthetic missing table')
    if (table === 'users') return { rows: [{ value: { ...auth } }] }
    if (table === 'meta_sheets') {
      expect(sql).toContain('WHERE id=$1')
      expect(values).toEqual(['synthetic-sheet'])
      const columns = sql.match(/\(SELECT ([\s\S]+?)\s+FROM public\."meta_sheets"/)?.[1]
        .split(',').map(column => column.trim())
      const value = columns ? Object.fromEntries(Object.entries(sheet).filter(([key]) => columns.includes(key))) : { ...sheet }
      return { rows: sheetPresent ? [{ value }] : [] }
    }
    if (table === 'meta_record_history_operations' || table === 'meta_record_history_operation_members') {
      expect(sql).toContain('WHERE sheet_id=$1')
      expect(values).toEqual(['synthetic-sheet'])
      return { rows: [{ value: { ...(table === 'meta_record_history_operations' ? operation : member) } }] }
    }
    if (table === 'multitable_attachments') {
      expect(sql).toContain('WHERE sheet_id=$1')
      expect(values).toEqual(['synthetic-sheet'])
      return { rows: [{ value: { ...attachment } }] }
    }
    assert.ok(table?.startsWith('meta_'))
    return { rows: [] }
  })
  class Server {
    private running = false
    async start() { await start(); this.running = true }
    async stop() { this.running = false }
    getAddress() { return this.running ? { port: 12345 } : null }
  }
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-rollback.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('rollback.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && ['snapshot', 'snapshotAttachmentFiles', 'run'].includes(statement.name?.text ?? ''))
  expect(functions.some(fn => fn.name?.text === 'snapshot')).toBe(true)
  expect(functions.some(fn => fn.name?.text === 'run')).toBe(true)
  const program = ts.transpileModule(`${functions.map(fn => fn.getText(parsed)).join('\n')}\nrun`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  // Execute the real rollback functions with simulated server/SQL/HTTP and owned temporary files.
  const run = new Function('dependencies', `
    const { assert, createHash, constants, lstat, open, readdir, join, require, process, fetch, connect } = dependencies
    ${program.outputText}
    return run
  `)({
    assert, createHash, constants, open, readdir, join,
    lstat: async (path: string, options?: { bigint: boolean }) => {
      const stat = options?.bigint ? await lstat(path, { bigint: true }) : await lstat(path)
      if (stableTimestamps && options?.bigint) Object.assign(stat, { mtimeNs: 0n, ctimeNs: 0n })
      return stat
    },
    require: (path: string) => {
      if (path === 'pg') return { Pool: class { query = query; end = end } }
      assert.equal(path, '../src/index.ts')
      return { MetaSheetServer: Server }
    },
    process: { env: { NODE_ENV: 'test', MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'false',
      MULTITABLE_ENABLE_WRITER_FENCE: 'false', ATTACHMENT_PATH: attachmentPath } },
    fetch: async (url: string) => {
      if (url.endsWith('/api/auth/login')) {
        auth.last_login_at = 'synthetic-login'
        auth.updated_at = 'synthetic-after-login'
        return new Response(JSON.stringify({ data: { token: 'synthetic-only' } }))
      }
      const response = url.endsWith('/preview') ? responses.preview : responses.catalog
      return new Response(JSON.stringify(response.body), { status: response.status })
    },
    connect: () => {
      const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, destroy: () => {} })
      queueMicrotask(() => socket.emit('error', new Error('synthetic closed listener')))
      return socket
    },
  }) as (input: { databaseName: string; identity: { sheetId: string; actorId: string }; password: string; generationId: string }) => Promise<{
    responses: typeof responses; tableCount: number
  }>
  return { root, attachmentPath, file, attachment, sheet, operation, member, sequence, auth, missingTables,
    omitSheet: () => { sheetPresent = false }, omitSequence: () => { sequencePresent = false },
    start, end, query, run: () => run({ databaseName: 'synthetic-db',
    identity: { sheetId: 'synthetic-sheet', actorId: 'synthetic-actor' }, password: 'synthetic-only', generationId: 'synthetic-generation' }) }
}

describe('local flag-off rollback attachment witness', () => {
  it.each([true, false])('accepts unchanged attachment state with root present=%s', async present => {
    const f = await fixture(present)
    try {
      const result = await f.run()
      expect(result.responses).toEqual(responses)
      expect(Number.isSafeInteger(result.tableCount) && result.tableCount >= 6).toBe(true)
      expect(f.auth).toEqual({ last_login_at: 'synthetic-login', updated_at: 'synthetic-after-login' })
      expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM public."users"'))).toBe(false)
      expect(f.end).toHaveBeenCalledTimes(1)
      if (!present) await expect(lstat(f.attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it.each(['sheet', 'sheet-metadata', 'operation', 'member', 'sequence-value', 'sequence-called'] as const)(
    'refuses independent %s drift while flags are off', async mutation => {
      const f = await fixture()
      try {
        f.start.mockImplementation(async () => {
          if (mutation === 'sheet') f.sheet.recovery_writer_state = 'applying'
          else if (mutation === 'sheet-metadata') f.sheet.name = 'synthetic-after'
          else if (mutation === 'operation') f.operation.event_count = 2
          else if (mutation === 'member') f.member.child_event_count = 2
          else if (mutation === 'sequence-value') f.sequence.last_value = '18'
          else f.sequence.is_called = false
        })
        await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_UNEXPECTED_WRITE')
        expect(f.end).toHaveBeenCalledTimes(1)
      } finally { await rm(f.root, { recursive: true, force: true }) }
    },
  )

  it.each(['meta_sheets', 'meta_record_history_operations', 'meta_record_history_operation_members'])(
    'refuses a missing required %s table before starting a server', async table => {
      const f = await fixture()
      try {
        f.missingTables.add(table)
        await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_TABLE_MISSING')
        expect(f.start).not.toHaveBeenCalled()
        expect(f.end).toHaveBeenCalledTimes(1)
      } finally { await rm(f.root, { recursive: true, force: true }) }
    },
  )

  it.each(['sheet', 'sequence'] as const)('refuses missing required %s state before starting a server', async state => {
    const f = await fixture()
    try {
      if (state === 'sheet') f.omitSheet()
      else f.omitSequence()
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_STATE_MISSING')
      expect(f.start).not.toHaveBeenCalled()
      expect(f.end).toHaveBeenCalledTimes(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('refuses attachment metadata changes while flags are off', async () => {
    const f = await fixture()
    try {
      f.start.mockImplementation(async () => { f.attachment.storage_path = 'changed' })
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_UNEXPECTED_WRITE')
      expect(f.end).toHaveBeenCalledTimes(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it.each(['overwrite', 'add', 'delete'] as const)('refuses an attachment file %s while flags are off', async mutation => {
    const f = await fixture()
    try {
      f.start.mockImplementation(async () => {
        if (mutation === 'overwrite') await writeFile(f.file, 'modified', { mode: 0o600 })
        else if (mutation === 'add') await writeFile(join(f.attachmentPath, 'extra'), 'synthetic-only', { mode: 0o600 })
        else await rm(f.file)
      })
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_ATTACHMENT_FILES_CHANGED')
      expect(f.end).toHaveBeenCalledTimes(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('refuses creation of a previously absent attachment root', async () => {
    const f = await fixture(false)
    try {
      f.start.mockImplementation(async () => { await mkdir(f.attachmentPath, { mode: 0o700 }) })
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_ATTACHMENT_FILES_CHANGED')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('refuses changed file bytes even when the stat clock is unchanged', async () => {
    const f = await fixture(true, true)
    try {
      f.start.mockImplementation(async () => { await writeFile(f.file, 'modified', { mode: 0o600 }) })
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_ATTACHMENT_FILES_CHANGED')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('refuses symlink entries before starting a server or reading their targets', async () => {
    const f = await fixture()
    try {
      await symlink(f.file, join(f.attachmentPath, 'link'), 'file')
      await expect(f.run()).rejects.toThrow('RECOVERY_LOCAL_ROLLBACK_ATTACHMENT_ENTRY_REFUSED')
      expect(f.start).not.toHaveBeenCalled()
      expect(f.end).toHaveBeenCalledTimes(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})
