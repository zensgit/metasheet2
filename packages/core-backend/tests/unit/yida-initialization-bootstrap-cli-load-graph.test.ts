import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

// Its own file on purpose: vitest gives every test file its own module registry, so the mocks here
// cannot hand a fresh bootstrap module to yida-initialization-bootstrap-cli.test.ts, whose
// forged-prototype case needs the CLI and the test to share one YidaInitializationError class.
const input = JSON.stringify({ ownerId: 'synthetic-owner', tenantId: 'synthetic-tenant' })

it('loading the CLI evaluates neither the automation-live-authority chain nor pg; a lazy bootstrap load failure is unconfirmed and constructs no pool or client', async () => {
  const evaluated: string[] = []
  const constructed: string[] = []
  vi.doMock('../../src/integration/automation-live-authority', () => {
    evaluated.push('automation-live-authority')
    throw new Error('synthetic load failure')
  })
  vi.doMock('pg', () => {
    evaluated.push('pg')
    class Pool { constructor() { constructed.push('Pool') } }
    class Client { constructor() { constructed.push('Client') } }
    return { Pool, Client, default: { Pool, Client } }
  })
  const directory = await mkdtemp(path.join(tmpdir(), 'yida-bootstrap-cli-'))
  const saved = process.env.DATABASE_URL
  try {
    const cli = await import('../../scripts/bootstrap-yida-initialization-owner')
    expect(evaluated).toEqual([])
    expect(constructed).toEqual([])
    const file = path.join(directory, 'manifest.json')
    await writeFile(file, input)
    // Refused before the load: neither provision nor its decoder imports the server modules.
    delete process.env.DATABASE_URL
    expect(await cli.runYidaInitializationBootstrapCli(['--input', file, '--apply'])).toEqual({ ok: false, status: 'unconfirmed' })
    expect(evaluated).toEqual([])
    // The bootstrap module fails while loading its server imports: no pool, no client, no connection.
    process.env.DATABASE_URL = 'postgres://synthetic.invalid/none'
    expect(await cli.runYidaInitializationBootstrapCli(['--input', file, '--apply'])).toEqual({ ok: false, status: 'unconfirmed' })
    expect(evaluated).toContain('automation-live-authority')
    expect(constructed).toEqual([])
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
    await rm(directory, { recursive: true, force: true })
    vi.doUnmock('../../src/integration/automation-live-authority')
    vi.doUnmock('pg')
  }
})

it('importing the CLI as a module never runs it: no summary written and no exit code set', async () => {
  // A fresh evaluation, so the CommonJS entry check runs again under the test runner.
  vi.resetModules()
  const write = vi.spyOn(process.stdout, 'write')
  const saved = process.exitCode
  try {
    await import('../../scripts/bootstrap-yida-initialization-owner')
    await new Promise(resolve => setImmediate(resolve))
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes('"status"'))).toBe(false)
    expect(process.exitCode).toBe(saved)
  } finally {
    write.mockRestore()
    process.exitCode = saved
  }
})
