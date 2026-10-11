import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runYidaInitializationBootstrapCli } from '../../scripts/bootstrap-yida-initialization-owner'

const inputPath = path.resolve('tmp', 'synthetic-yida-anchor.json')
const input = JSON.stringify({ ownerId: 'synthetic-owner', tenantId: 'synthetic-tenant' })

describe('operator-only Yida initializer bootstrap CLI', () => {
  it('requires an explicit absolute server file and apply; invalid arguments do no IO', async () => {
    for (const args of [[], ['--apply'], ['--input', 'relative.json', '--apply'],
      ['--input', inputPath], ['--input', inputPath, '--apply', '--ownerId', 'claimed'],
      ['--input', inputPath, '--force']]) {
      const read = vi.fn(), provision = vi.fn()
      expect(await runYidaInitializationBootstrapCli(args, { read, provision }))
        .toEqual({ ok: false, status: 'unconfirmed' })
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
      })).toEqual({ ok: false, status: 'unconfirmed' })
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
})
