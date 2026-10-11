import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { StorageServiceImpl } from '../../src/services/StorageService'

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(fs.open).mockRestore()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture(bytes = Buffer.from('synthetic immutable attachment')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-bounded-source-'))
  roots.push(root)
  const storage = StorageServiceImpl.createLocalService(root, 'http://localhost/files')
  const object = await storage.uploadContentAddressed(bytes, { filename: 'display.txt' })
  return { storage, bytes, filename: path.join(root, object.path), key: object.path }
}

describe('owned bounded content-addressed attachment read', () => {
  it('reads and authenticates the whole immutable file within its exact budget', async () => {
    const f = await fixture()
    const read = await f.storage.readContentAddressedBounded(f.key, f.bytes.length)
    expect(read).toEqual({ bytes: f.bytes, immutableVersion: `sha256:${f.key.split('sha256-')[1]}`,
      contentSha256: f.key.split('sha256-')[1], sizeBytes: f.bytes.length })
  })

  it('rejects oversized input before reading and closes the opened handle', async () => {
    const f = await fixture()
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(f.filename, 'r')
    const read = vi.spyOn(handle, 'read')
    const close = vi.spyOn(handle, 'close')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(f.storage.readContentAddressedBounded(f.key, f.bytes.length - 1))
      .rejects.toThrow('ATTACHMENT_SOURCE_BYTE_LIMIT_EXCEEDED')
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects growth between stat and read and closes the real file handle', async () => {
    const f = await fixture()
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(f.filename, 'r')
    const stat = handle.stat.bind(handle)
    vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
      const original = await stat()
      await fs.appendFile(f.filename, '!')
      return original
    })
    const close = vi.spyOn(handle, 'close')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(f.storage.readContentAddressedBounded(f.key, f.bytes.length + 8))
      .rejects.toThrow('ATTACHMENT_SOURCE_DRIFTED')
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, NaN, Infinity])('refuses invalid byte budget %s before opening a file', async (budget) => {
    const f = await fixture()
    const calls = vi.mocked(fs.open).mock.calls.length
    await expect(f.storage.readContentAddressedBounded(f.key, budget)).rejects.toThrow('ATTACHMENT_SOURCE_BYTE_LIMIT_EXCEEDED')
    expect(vi.mocked(fs.open).mock.calls.length).toBe(calls)
  })
})
