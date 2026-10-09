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
  const start = vi.fn<[], Promise<void>>(async () => {})
  const end = vi.fn(async () => {})
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('current_database()')) return { rows: [{ name: 'synthetic-db' }] }
    if (sql.includes('pg_catalog.pg_tables')) return { rows: [
      'meta_recovery_archives', 'meta_recovery_archive_jobs',
      'meta_recovery_archive_job_chunks', 'meta_recovery_archive_nonce_reservations',
    ].map(tablename => ({ tablename })) }
    const table = sql.match(/FROM public\."([a-z_]+)"/)?.[1]
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
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ data: { token: 'synthetic-only' } }))
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
  return { root, attachmentPath, file, attachment, start, end, run: () => run({ databaseName: 'synthetic-db',
    identity: { sheetId: 'synthetic-sheet', actorId: 'synthetic-actor' }, password: 'synthetic-only', generationId: 'synthetic-generation' }) }
}

describe('local flag-off rollback attachment witness', () => {
  it.each([true, false])('accepts unchanged attachment state with root present=%s', async present => {
    const f = await fixture(present)
    try {
      const result = await f.run()
      expect(result.responses).toEqual(responses)
      expect(Number.isSafeInteger(result.tableCount) && result.tableCount >= 6).toBe(true)
      expect(f.end).toHaveBeenCalledTimes(1)
      if (!present) await expect(lstat(f.attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' })
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
