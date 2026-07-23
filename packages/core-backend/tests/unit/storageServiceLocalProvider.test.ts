import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  StorageServiceImpl,
  toSafeStorageBasename,
  resolveWithinBase,
} from '../../src/services/StorageService'

// F3 files-storage-integrity design-lock (2026-07-10), G9: LocalStorageProvider had ZERO dedicated
// coverage before this slice. These are REAL-filesystem tests (temp dirs, real writes/reads) — not mocks —
// covering the security-load-bearing behavior: server-generated keys (no overwrite/traversal), containment,
// and the index-free `downloadByKey` read that fixes F3-2 (restart/new-instance/cold-index 404).

const BASE_URL = 'http://localhost:8900/files'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let root: string
let basePath: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'f3-storage-'))
  basePath = path.join(root, 'uploads')
  await fs.mkdir(basePath, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeService(): StorageServiceImpl {
  return StorageServiceImpl.createLocalService(basePath, BASE_URL)
}

describe('toSafeStorageBasename (G1)', () => {
  it('keeps a plain filename, strips any directory component and traversal', () => {
    expect(toSafeStorageBasename('photo.jpg')).toBe('photo.jpg')
    expect(toSafeStorageBasename('a/b/c.jpg')).toBe('c.jpg')
    expect(toSafeStorageBasename('../../etc/passwd')).toBe('passwd')
    expect(toSafeStorageBasename('..\\..\\windows\\x.dll')).toBe('x.dll')
  })

  it('collapses a name that is only dots/separators to a safe fallback', () => {
    expect(toSafeStorageBasename('..')).toBe('file')
    expect(toSafeStorageBasename('.')).toBe('file')
    expect(toSafeStorageBasename('/')).toBe('file')
    expect(toSafeStorageBasename('')).toBe('file')
  })

  it('strips leading dots (hidden/traversal) and control chars', () => {
    expect(toSafeStorageBasename('.env')).toBe('env')
    expect(toSafeStorageBasename('\0\x1fname.txt')).toBe('name.txt')
  })
})

describe('resolveWithinBase (G2 containment)', () => {
  it('returns the resolved path for a key inside the base', () => {
    const resolved = resolveWithinBase(basePath, 'uuid-dir/photo.jpg')
    expect(resolved).toBe(path.resolve(basePath, 'uuid-dir/photo.jpg'))
  })

  it('throws for a traversal key that escapes the base', () => {
    expect(() => resolveWithinBase(basePath, '../escape.txt')).toThrow()
    expect(() => resolveWithinBase(basePath, 'a/../../escape.txt')).toThrow()
  })

  it('throws for an absolute key outside the base and for the base directory itself', () => {
    expect(() => resolveWithinBase(basePath, '/etc/passwd')).toThrow()
    expect(() => resolveWithinBase(basePath, '.')).toThrow()
  })
})

describe('LocalStorageProvider.upload (G1/G2)', () => {
  it('test 1 — two users upload the same filename → two INDEPENDENT physical objects (no overwrite)', async () => {
    const svc = makeService()
    const a = await svc.upload(Buffer.from('alice-bytes'), { filename: 'photo.jpg' })
    const b = await svc.upload(Buffer.from('bob-bytes'), { filename: 'photo.jpg' })

    expect(a.id).not.toBe(b.id)
    expect(a.storageKey).not.toBe(b.storageKey)
    // id is the uuid dir segment; key is <uuid>/<safeBasename>
    expect(a.id).toMatch(UUID_RE)
    expect(a.storageKey).toBe(`${a.id}/photo.jpg`)
    expect(b.storageKey).toBe(`${b.id}/photo.jpg`)

    // both physical files exist with their own bytes — nothing was overwritten
    expect((await fs.readFile(path.join(basePath, a.storageKey!))).toString()).toBe('alice-bytes')
    expect((await fs.readFile(path.join(basePath, b.storageKey!))).toString()).toBe('bob-bytes')
  })

  it('test 7 — same filename twice with different bytes → each key reads back its OWN bytes (isolation, not last-write-wins)', async () => {
    const svc = makeService()
    const first = await svc.upload(Buffer.from('first-content'), { filename: 'dup.bin' })
    const second = await svc.upload(Buffer.from('second-content'), { filename: 'dup.bin' })

    expect((await svc.downloadByKey(first.storageKey!)).toString()).toBe('first-content')
    expect((await svc.downloadByKey(second.storageKey!)).toString()).toBe('second-content')
  })

  it('test 2 — a client filename with traversal cannot escape the base (server owns the physical layout)', async () => {
    const svc = makeService()
    const uploaded = await svc.upload(Buffer.from('x'), { filename: '../../../../tmp/pwned.txt', path: '../../evil' })

    // client `path` is ignored; filename is reduced to a safe basename under a server uuid dir
    expect(uploaded.storageKey).toBe(`${uploaded.id}/pwned.txt`)
    const full = path.resolve(basePath, uploaded.storageKey!)
    expect(full.startsWith(path.resolve(basePath) + path.sep)).toBe(true)
    // nothing was written outside the base
    await expect(fs.access(path.join(root, 'tmp', 'pwned.txt'))).rejects.toThrow()
    await expect(fs.access(path.resolve(root, 'evil'))).rejects.toThrow()
  })
})

describe('LocalStorageProvider.downloadByKey (G3 — index-free, restart-stable)', () => {
  it('test 3 + F provider-contract — a fileId/key uploaded on one instance is still readable on a FRESH instance (cold index)', async () => {
    const writer = makeService()
    const uploaded = await writer.upload(Buffer.from('evidence-photo'), { filename: 'punch.jpg' })

    // a brand-new provider instance over the same basePath — models a process restart / a second replica.
    const reader = makeService()
    const bytes = await reader.downloadByKey(uploaded.storageKey!)
    expect(bytes.toString()).toBe('evidence-photo')
  })

  it('test 5 — downloadByKey bypasses the in-memory index entirely (no warmup window / no id-drift)', async () => {
    // Write the physical object + its uuid dir DIRECTLY, never through upload(), so no index anywhere ever
    // saw it. downloadByKey must still serve it purely from the key.
    const uuid = '11111111-2222-3333-4444-555555555555'
    const key = `${uuid}/direct.bin`
    await fs.mkdir(path.join(basePath, uuid), { recursive: true })
    await fs.writeFile(path.join(basePath, key), 'written-out-of-band')

    const svc = makeService()
    expect((await svc.downloadByKey(key)).toString()).toBe('written-out-of-band')

    // Contrast that proves downloadByKey is NOT a disguised index-by-key lookup: treating the full key as
    // an id goes through the index and misses (the index keys new-layout files by the uuid segment, never
    // by the full `<uuid>/<name>` string). If downloadByKey were reverted to read the index, it would miss
    // here too — this is the mutation-#5 tripwire.
    await expect(svc.download(key)).rejects.toThrow()
  })

  it('test 2 (read side) — downloadByKey re-asserts containment: a traversal key is rejected even against a real out-of-base file', async () => {
    // plant a file OUTSIDE the base
    await fs.writeFile(path.join(root, 'secret.txt'), 'outside-the-base')
    const svc = makeService()
    await expect(svc.downloadByKey('../secret.txt')).rejects.toThrow()
  })
})

// F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-2: deleteByKey is the symmetric
// write-side counterpart to downloadByKey — same containment re-assertion, plus ENOENT-as-success
// idempotency (the property the whole GF5-8 test-matrix #2/#3 depend on). Real filesystem, no mocks.
describe('LocalStorageProvider.deleteByKey (GF5-2 — index-free, idempotent, contained)', () => {
  it('deletes the real physical object addressed by its storage key', async () => {
    const svc = makeService()
    const uploaded = await svc.upload(Buffer.from('to-be-purged'), { filename: 'purge.bin' })
    const full = path.resolve(basePath, uploaded.storageKey!)
    await expect(fs.access(full)).resolves.toBeUndefined()

    await svc.deleteByKey(uploaded.storageKey!)

    await expect(fs.access(full)).rejects.toThrow()
  })

  it('mutation-#3 tripwire — deleting an ALREADY-GONE key (ENOENT) resolves successfully instead of throwing', async () => {
    const svc = makeService()
    const neverWrittenKey = '99999999-8888-7777-6666-555555555555/ghost.bin'

    await expect(svc.deleteByKey(neverWrittenKey)).resolves.toBeUndefined()
  })

  it('is idempotent — deleting the same key twice never throws on the second call', async () => {
    const svc = makeService()
    const uploaded = await svc.upload(Buffer.from('idempotent-delete'), { filename: 'dup-delete.bin' })

    await expect(svc.deleteByKey(uploaded.storageKey!)).resolves.toBeUndefined()
    await expect(svc.deleteByKey(uploaded.storageKey!)).resolves.toBeUndefined()
  })

  it('re-asserts containment: a traversal key is rejected and never unlinks a real out-of-base file', async () => {
    const outside = path.join(root, 'secret-to-keep.txt')
    await fs.writeFile(outside, 'outside-the-base')
    const svc = makeService()

    await expect(svc.deleteByKey('../secret-to-keep.txt')).rejects.toThrow()

    // the out-of-base file must still exist — containment rejected the delete before any unlink call
    await expect(fs.access(outside)).resolves.toBeUndefined()
  })

  it('a non-ENOENT failure (deleting a directory, not a file) rejects rather than silently succeeding', async () => {
    const svc = makeService()
    const dirKey = 'a-directory-not-a-file'
    await fs.mkdir(path.join(basePath, dirKey), { recursive: true })

    await expect(svc.deleteByKey(dirKey)).rejects.toThrow()
  })
})

/**
 * B3-07 §7 — `uploadByKey`, the key-addressed WRITE that completes the by-key triple alongside
 * `downloadByKey`/`deleteByKey`. It is security-load-bearing for the same reason its siblings are:
 * it takes a caller-chosen key, so containment (G2) must be re-asserted, and it must never silently
 * overwrite an existing object. Added to the F3 canary lane because it is a new write path into the
 * shared storage root.
 */
describe('LocalStorageProvider.uploadByKey (B3-07 key-addressed write)', () => {
  it('writes at the EXACT caller key and reads back index-free through downloadByKey', async () => {
    const svc = makeService()
    const key = 'approval-attachments/2026-07/fixed-key.pdf'
    await svc.uploadByKey(key, Buffer.from('%PDF-by-key'))

    // the physical layout is exactly the key — no uuid dir, no client-filename segment appended
    expect((await fs.readFile(path.join(basePath, key))).toString()).toBe('%PDF-by-key')
    expect((await svc.downloadByKey(key)).toString()).toBe('%PDF-by-key')

    // and a FRESH service (cold index, as a separate process would have) still reads it
    expect((await makeService().downloadByKey(key)).toString()).toBe('%PDF-by-key')
  })

  it('re-asserts containment (G2): a traversal / absolute key is refused and writes NOTHING', async () => {
    const svc = makeService()
    const outside = path.join(root, 'escaped.txt')
    for (const bad of ['../escaped.txt', '../../escaped.txt', 'a/../../escaped.txt']) {
      await expect(svc.uploadByKey(bad, Buffer.from('pwned'))).rejects.toThrow()
    }
    // nothing escaped the base path
    await expect(fs.access(outside)).rejects.toThrow()
  })

  it('is exclusive-create: writing an existing key REJECTS instead of silently overwriting', async () => {
    const svc = makeService()
    const key = 'approval-attachments/2026-07/no-overwrite.pdf'
    await svc.uploadByKey(key, Buffer.from('original'))
    await expect(svc.uploadByKey(key, Buffer.from('overwritten'))).rejects.toThrow()
    // POSITIVE CONTROL: the original bytes survived the refused second write
    expect((await svc.downloadByKey(key)).toString()).toBe('original')
  })

  it('enforces the service upload limit (a by-key caller cannot bypass the size cap)', async () => {
    const svc = makeService()
    svc.setUploadLimit(8)
    await expect(svc.uploadByKey('approval-attachments/big.bin', Buffer.alloc(9))).rejects.toThrow(/exceeds limit/)
    // POSITIVE CONTROL: at-limit still writes
    await expect(svc.uploadByKey('approval-attachments/ok.bin', Buffer.alloc(8))).resolves.toBeUndefined()
  })
})
