import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'
import { assertLocalCustodyMountIsolation, createLocalCustodyStore } from '../../src/multitable/recovery-local-custody-store'

const roots: string[] = []
const refusal = 'RECOVERY_LOCAL_CUSTODY_STORE_REFUSED'
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-custody-store-'))
  roots.push(root)
  const custodyPath = path.join(root, 'custody')
  const archivePath = path.join(root, 'archive')
  await fs.mkdir(custodyPath, { mode: 0o700 })
  await fs.mkdir(archivePath, { mode: 0o700 })
  let depth: number | undefined = 0
  const transactionDepth = { currentTransactionDepth: () => depth }
  const custodyId = randomUUID()
  const recoverySecret = randomBytes(32)
  const backup = createLocalCustodyBackup({ custodyId, recoverySecret, transactionDepth })
  const options = { custodyPath, archivePath, custodyId, transactionDepth }
  return { ...options, root, recoverySecret, backup, options, setDepth(value: number | undefined) { depth = value } }
}

describe('explicit encrypted local custody package storage', () => {
  test('mount admission rejects device aliases and subdirectory mounts, without mounting anything', () => {
    const base = '1 0 8:1 / / rw - ext4 /dev/synthetic rw'
    expect(() => assertLocalCustodyMountIsolation(base, ['/custody', '/archive'])).not.toThrow()
    expect(() => assertLocalCustodyMountIsolation(`${base}\n2 1 8:2 / /private\\040disk rw - ext4 /dev/synthetic2 rw`, ['/private disk/custody', '/archive'])).not.toThrow()
    for (const extra of [
      '2 1 8:1 / /alias rw - ext4 /dev/synthetic rw',
      '2 1 8:1 /archive /alias rw - ext4 /dev/synthetic rw',
      '2 1 8:2 /subdir /custody rw - ext4 /dev/synthetic2 rw',
    ]) expect(() => assertLocalCustodyMountIsolation(`${base}\n${extra}`, ['/custody', '/archive'])).toThrow(refusal)
    expect(() => assertLocalCustodyMountIsolation('malformed', ['/custody'])).toThrow(refusal)
    expect(() => assertLocalCustodyMountIsolation('1 0 8:1 / /elsewhere rw - ext4 /dev/synthetic rw', ['/custody'])).toThrow(refusal)
  })
  test('persists immutable packages for a fresh locked session; keeps old rotation packages', async () => {
    const f = await fixture()
    const store = await createLocalCustodyStore(f.options)
    const first = await store.putBackup(randomUUID(), f.backup)
    expect(await store.putBackup(first.backupId, f.backup)).toEqual(first)
    const session = createLocalCustodySession(f.transactionDepth)
    expect(session.isUnlocked()).toBe(false)
    session.unlock({ custodyId: f.custodyId, recoverySecret: f.recoverySecret, backup: await store.readBackup(first) })
    const generationId = randomUUID()
    const dek = session.issueLocalDek(generationId)
    const second = await store.putBackup(randomUUID(), session.exportRotatedBackup(f.recoverySecret))
    session.lock()
    const reopened = await createLocalCustodyStore(f.options)
    session.unlock({ custodyId: f.custodyId, recoverySecret: f.recoverySecret, backup: await reopened.readBackup(second) })
    expect(session.openLocalDek({ ...dek, generationId })).toEqual(dek.dek)
    expect(await reopened.readBackup(first)).toEqual(f.backup)
    session.lock()
    const names = await fs.readdir(f.custodyPath)
    expect(names.sort()).toEqual([first, second].map(x => `${f.custodyId}-${x.backupId}.custody`).sort())
    for (const name of names) expect((await fs.stat(path.join(f.custodyPath, name))).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(f.archivePath)).toEqual([])
  })

  test('same-ID concurrent different packages have exactly one winner, without overwrite', async () => {
    const f = await fixture()
    const store = await createLocalCustodyStore(f.options)
    const other = createLocalCustodyBackup({ ...f.options, recoverySecret: f.recoverySecret })
    const id = randomUUID()
    const results = await Promise.allSettled([store.putBackup(id, f.backup), store.putBackup(id, other)])
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(x => x.status === 'rejected')).toHaveLength(1)
    const winner = results.find(x => x.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('missing winner')
    expect(await store.readBackup(winner.value)).toEqual(results[0].status === 'fulfilled' ? f.backup : other)
    expect(await fs.readdir(f.custodyPath)).toHaveLength(1)
  })

  test('rejects same-root or nested roots including ancestor aliases', async () => {
    const f = await fixture()
    await expect(createLocalCustodyStore({ ...f.options, archivePath: f.custodyPath })).rejects.toThrow(refusal)
    const nested = path.join(f.custodyPath, 'nested')
    await fs.mkdir(nested, { mode: 0o700 })
    await expect(createLocalCustodyStore({ ...f.options, archivePath: nested })).rejects.toThrow(refusal)
    await expect(createLocalCustodyStore({ ...f.options, custodyPath: nested, archivePath: f.custodyPath })).rejects.toThrow(refusal)
    await fs.symlink(f.custodyPath, path.join(f.root, 'alias'))
    await expect(createLocalCustodyStore({ ...f.options, archivePath: path.join(f.root, 'alias', 'nested') })).rejects.toThrow(refusal)
  })

  test('rejects root symlinks and permissive directories without chmod or creation', async () => {
    const f = await fixture()
    const link = path.join(f.root, 'link')
    await fs.symlink(f.custodyPath, link)
    await expect(createLocalCustodyStore({ ...f.options, custodyPath: link })).rejects.toThrow(refusal)
    await fs.chmod(f.custodyPath, 0o755)
    await expect(createLocalCustodyStore(f.options)).rejects.toThrow(refusal)
    expect((await fs.stat(f.custodyPath)).mode & 0o777).toBe(0o755)
  })

  test('rejects package symlinks, unsafe permissions and mismatched receipts', async () => {
    const f = await fixture()
    const store = await createLocalCustodyStore(f.options)
    const receipt = await store.putBackup(randomUUID(), f.backup)
    await expect(store.readBackup({ ...receipt, sha256: '0'.repeat(64) })).rejects.toThrow(refusal)
    await expect(store.readBackup({ ...receipt, size: receipt.size + 1 })).rejects.toThrow(refusal)
    const file = path.join(f.custodyPath, `${f.custodyId}-${receipt.backupId}.custody`)
    await fs.chmod(file, 0o644)
    await expect(store.readBackup(receipt)).rejects.toThrow(refusal)
    await fs.chmod(file, 0o600)
    const saved = path.join(f.root, 'saved')
    await fs.rename(file, saved)
    await fs.symlink(saved, file)
    await expect(store.readBackup(receipt)).rejects.toThrow(refusal)
    expect(await fs.readFile(saved)).toEqual(f.backup)
  })

  test('rejects plaintext, wrong custody, extra keys, traversal and transaction IO', async () => {
    const f = await fixture()
    const store = await createLocalCustodyStore(f.options)
    const value = JSON.parse(Buffer.from(f.backup).toString())
    for (const backup of [f.recoverySecret, Buffer.alloc(20_000), Buffer.from(JSON.stringify({ ...value, custodyId: randomUUID() })), Buffer.from(JSON.stringify({ ...value, secret: 'no' }))]) {
      await expect(store.putBackup(randomUUID(), backup)).rejects.toThrow(refusal)
    }
    await expect(store.putBackup('../outside', f.backup)).rejects.toThrow(refusal)
    const receipt = await store.putBackup(randomUUID(), f.backup)
    for (const depth of [1, undefined, NaN]) {
      f.setDepth(depth)
      await expect(store.putBackup(randomUUID(), f.backup)).rejects.toThrow(refusal)
      await expect(store.readBackup(receipt)).rejects.toThrow(refusal)
      await expect(createLocalCustodyStore(f.options)).rejects.toThrow(refusal)
    }
    expect(await fs.readdir(f.custodyPath)).toHaveLength(1)
  })
})
