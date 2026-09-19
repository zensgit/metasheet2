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

/** A preexisting directory without this exact proof is never adopted, even if bytes match. */
export async function reserveLocalRecoveryAttachment(root: string, key: string, owner: string): Promise<void> {
  try {
    const target = await location(root, key, owner)
    let created = false
    try { await fs.mkdir(target.directory); created = true } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    if (created) {
      const handle = await fs.open(target.marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(target.proof); await handle.sync() } finally { await handle.close() }
      await syncDirectory(target.directory)
      await syncDirectory(target.base)
    }
    await assertOwned(target)
    try { if (!(await fs.lstat(target.payload)).isFile()) refused() } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  } catch { refused() }
}

/** Storage primitive only: caller must first commit exclusive database abandonment, never live apply. */
export async function retireLocalRecoveryAttachment(root: string, key: string, owner: string): Promise<void> {
  try {
    const target = await location(root, key, owner)
    await assertOwned(target)
    try {
      const stat = await fs.lstat(target.payload)
      if (stat.isDirectory()) {
        if ((await fs.readdir(target.payload)).length) refused()
        await syncDirectory(target.directory)
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
  } catch { refused() }
}

function refused(): never { throw new Error('RECOVERY_ATTACHMENT_STORAGE_OWNERSHIP_REFUSED') }
