import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'

const markerName = '.recovery-restore-owner'

async function location(root: string, key: string, owner: string) {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/sha256-[0-9a-f]{64}$/.exec(key)
  if (!match || !/^[0-9a-f]{64}$/.test(owner)) refused()
  await fs.mkdir(root, { recursive: true })
  const base = await fs.realpath(root)
  const directory = path.join(base, match[1]!)
  return { base, directory, payload: path.join(base, key),
    marker: path.join(directory, markerName), proof: JSON.stringify({ version: 1, key, owner }) }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function assertOwned(target: Awaited<ReturnType<typeof location>>): Promise<void> {
  if (!(await fs.lstat(target.directory)).isDirectory()) refused()
  if (!(await fs.lstat(target.marker)).isFile()) refused()
  const handle = await fs.open(target.marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== Buffer.byteLength(target.proof)) refused()
    if (await handle.readFile('utf8') !== target.proof) refused()
  } finally { await handle.close() }
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

async function reconcileUnpublishedMarkers(target: Awaited<ReturnType<typeof location>>): Promise<void> {
  for (const entry of await fs.readdir(target.base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.recovery-reserve-[A-Za-z0-9]{6}$/.test(entry.name)) continue
    const directory = path.join(target.base, entry.name)
    const marker = path.join(directory, markerName)
    // A name is only a candidate; only the complete original proof authorizes removal.
    try { await assertOwned({ ...target, directory, marker }) } catch { continue }
    const entries = await fs.readdir(directory)
    if (entries.length !== 1 || entries[0] !== markerName) refused()
    await fs.unlink(marker)
    await fs.rmdir(directory)
  }
  await syncDirectory(target.base)
}

/** A preexisting directory without this exact proof is never adopted, even if bytes match. */
export async function reserveLocalRecoveryAttachment(root: string, key: string, owner: string): Promise<void> {
  try {
    const target = await location(root, key, owner)
    let exists = true
    try { await fs.lstat(target.directory) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      exists = false
    }
    if (!exists) {
      const temporary = await fs.mkdtemp(path.join(target.base, '.recovery-reserve-'))
      const marker = path.join(temporary, markerName)
      try {
        const handle = await fs.open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(target.proof); await handle.sync() } finally { await handle.close() }
        await syncDirectory(temporary)
        try { await fs.rename(temporary, target.directory) } catch (error) {
          if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error
        }
      } finally {
        // Remove only our unpublished marker and empty directory, never recursively delete contents.
        await fs.unlink(marker).catch(error => { if (!hasCode(error, 'ENOENT')) throw error })
        await fs.rmdir(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error })
      }
    }
    await assertOwned(target)
    await syncDirectory(target.directory)
    await syncDirectory(target.base)
    try { if (!(await fs.lstat(target.payload)).isFile()) refused() } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  } catch { refused() }
}

/** Same descriptor supplies readback and fsync before the database may mark the object verified. */
export async function readLocalRecoveryAttachment(root: string, key: string, owner: string): Promise<Buffer> {
  try {
    const target = await location(root, key, owner)
    await assertOwned(target)
    if (!(await fs.lstat(target.payload)).isFile()) refused()
    const handle = await fs.open(target.payload, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) refused()
      const bytes = await handle.readFile()
      await handle.sync()
      await syncDirectory(target.directory)
      return bytes
    } finally { await handle.close() }
  } catch { refused() }
}

/** Storage primitive only: caller must first commit exclusive database abandonment, never live apply. */
export async function retireLocalRecoveryAttachment(root: string, key: string, owner: string): Promise<void> {
  try {
    const target = await location(root, key, owner)
    try { await fs.lstat(target.directory) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      await reserveLocalRecoveryAttachment(root, key, owner)
    }
    await assertOwned(target)
    try {
      const stat = await fs.lstat(target.payload)
      if (stat.isDirectory()) {
        if ((await fs.readdir(target.payload)).length) refused()
        await syncDirectory(target.directory)
        await reconcileUnpublishedMarkers(target)
        return
      }
      if (!stat.isFile()) refused()
      await fs.unlink(target.payload)
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    // A directory at the exact file key is a permanent exclusive-create barrier.
    // If a writer wins this gap, refuse rather than stamp cleanup; a later retry rechecks it.
    await fs.mkdir(target.payload)
    await syncDirectory(target.payload)
    await syncDirectory(target.directory)
    await reconcileUnpublishedMarkers(target)
  } catch { refused() }
}

function refused(): never { throw new Error('RECOVERY_ATTACHMENT_STORAGE_OWNERSHIP_REFUSED') }
