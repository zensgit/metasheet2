import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runYidaInitializationBootstrapCli } from '../../scripts/bootstrap-yida-initialization-owner'
import { YidaInitializationError } from '../../src/integration/yida-initialization-bootstrap'

const inputPath = path.resolve('tmp', 'synthetic-yida-anchor.json')
const input = JSON.stringify({ ownerId: 'synthetic-owner', tenantId: 'synthetic-tenant' })

describe('operator-only Yida initializer bootstrap CLI', () => {
  it('requires an explicit absolute server file and apply; invalid arguments do no IO', async () => {
    for (const args of [[], ['--apply'], ['--input', 'relative.json', '--apply'],
      ['--input', inputPath], ['--input', inputPath, '--apply', '--ownerId', 'claimed'],
      ['--input', inputPath, '--force']]) {
      const read = vi.fn(), provision = vi.fn()
      expect(await runYidaInitializationBootstrapCli(args, { read, provision }))
        .toEqual({ ok: false, status: 'input' })
      expect(read).not.toHaveBeenCalled()
      expect(provision).not.toHaveBeenCalled()
    }
  })
  it('passes only the server-owned identity, never returns it or a command id', async () => {
    const read = vi.fn(async () => input)
    const provision = vi.fn(async (_manifest: Readonly<{ ownerId: string; tenantId: string }>) => ({ commandId: 'private-command', ownerId: 'private-owner' }))
    const result = await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], { read, provision })
    expect(read).toHaveBeenCalledWith(inputPath)
    expect(provision).toHaveBeenCalledWith({ ownerId: 'synthetic-owner', tenantId: 'synthetic-tenant' })
    expect(result).toEqual({ ok: true, status: 'provisioned' })
    expect(Object.isFrozen(provision.mock.calls[0][0])).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/owner|tenant|command|private|synthetic/)
  })
  it('closed/oversized/malformed/whitespace authority manifests do not reach the database', async () => {
    for (const text of ['', '{', '[]', 'null', '{}', JSON.stringify({ ownerId: 'owner', tenantId: 'tenant', commandId: 'claimed' }),
      JSON.stringify({ ownerId: ' owner', tenantId: 'tenant' }), JSON.stringify({ ownerId: 'owner', tenantId: 'tenant\n' }),
      JSON.stringify({ ownerId: '', tenantId: 'tenant' }), JSON.stringify({ ownerId: 'owner', tenantId: 'x'.repeat(129) }),
      ' '.repeat(4097)]) {
      const provision = vi.fn()
      expect(await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], {
        read: async () => text, provision,
      })).toEqual({ ok: false, status: 'input' })
      expect(provision).not.toHaveBeenCalled()
    }
  })
  it('a lost COMMIT response is unconfirmed, not absent; never retries or inspects foreign errors', async () => {
    let inspected = 0
    const rejection = new Proxy({}, { get() { inspected++; throw new Error('private') }, getPrototypeOf() { inspected++; throw new Error('private') } })
    const provision = vi.fn(async () => { throw rejection })
    expect(await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], {
      read: async () => input, provision,
    })).toEqual({ ok: false, status: 'unconfirmed' })
    expect(provision).toHaveBeenCalledTimes(1)
    expect(inspected).toBe(0)
  })
  it('an unreadable manifest file is an input refusal before any database work', async () => {
    const provision = vi.fn()
    expect(await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], {
      read: async () => { throw new Error('private') }, provision,
    })).toEqual({ ok: false, status: 'input' })
    expect(provision).not.toHaveBeenCalled()
  })
  it.each([['CONFLICT', 'conflict'], ['DENIED', 'denied'], ['INPUT', 'input'], ['UNAVAILABLE', 'unconfirmed'], ['CANCELLED', 'unconfirmed']])(
    'the bootstrap module own %s refusal reports %s, values-free and non-success', async (code, status) => {
      const provision = vi.fn(async () => { throw new YidaInitializationError(code) })
      const result = await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], { read: async () => input, provision })
      expect(result).toEqual({ ok: false, status })
      expect(Object.isFrozen(result)).toBe(true)
      expect(JSON.stringify(result)).not.toMatch(/owner|tenant|command|synthetic|YIDA/)
    })
  it('loading the CLI evaluates no server module; a lazy bootstrap load failure is unconfirmed', async () => {
    const evaluated: string[] = []
    vi.resetModules()
    vi.doMock('../../src/integration/automation-live-authority', () => {
      evaluated.push('automation-live-authority')
      throw new Error('synthetic load failure')
    })
    const directory = await mkdtemp(path.join(tmpdir(), 'yida-bootstrap-cli-'))
    const saved = process.env.DATABASE_URL
    try {
      const cli = await import('../../scripts/bootstrap-yida-initialization-owner')
      expect(evaluated).toEqual([])
      const file = path.join(directory, 'manifest.json')
      await writeFile(file, input)
      // Refused before the load: neither provision nor its decoder imports the server modules.
      delete process.env.DATABASE_URL
      expect(await cli.runYidaInitializationBootstrapCli(['--input', file, '--apply'])).toEqual({ ok: false, status: 'unconfirmed' })
      expect(evaluated).toEqual([])
      // The bootstrap module fails while loading its server imports: no pool, no connection.
      process.env.DATABASE_URL = 'postgres://synthetic.invalid/none'
      expect(await cli.runYidaInitializationBootstrapCli(['--input', file, '--apply'])).toEqual({ ok: false, status: 'unconfirmed' })
      expect(evaluated).toContain('automation-live-authority')
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
      await rm(directory, { recursive: true, force: true })
      vi.doUnmock('../../src/integration/automation-live-authority')
      vi.resetModules()
    }
  })
  it('a foreign error that only imitates a definite code stays unconfirmed', async () => {
    const forged = Object.assign(new Error('YIDA_INITIALIZATION_CONFLICT'), { code: 'YIDA_INITIALIZATION_CONFLICT' })
    Object.setPrototypeOf(forged, YidaInitializationError.prototype)
    const provision = vi.fn(async () => { throw forged })
    expect(await runYidaInitializationBootstrapCli(['--input', inputPath, '--apply'], {
      read: async () => input, provision,
    })).toEqual({ ok: false, status: 'unconfirmed' })
  })
})
