import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIMIT = 16_384
type Root = { configured: string; real: string; dev: bigint; ino: bigint }
export interface LocalCustodyReceipt {
  backupId: string
  sha256: string
  size: number
}

function refuse(): never { throw new Error('RECOVERY_LOCAL_CUSTODY_STORE_REFUSED') }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch { refuse() }
}
async function directory(configured: string): Promise<Root> {
  if (!path.isAbsolute(configured) || !process.getuid) refuse()
  const stat = await fs.lstat(configured, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n) refuse()
  const real = await fs.realpath(configured)
  const filesystem = await fs.statfs(real)
  const supported = process.platform === 'linux' ? [0xef53, 0x58465342, 0x9123683e] : process.platform === 'darwin' ? [25] : []
  if (!supported.includes(filesystem.type)) refuse()
  return { configured, real, dev: stat.dev, ino: stat.ino }
}
function nested(first: string, second: string): boolean {
  const relative = path.relative(first, second)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/** Conservative Linux admission: no subdirectory mounts or device aliases. */
export function assertLocalCustodyMountIsolation(mountInfo: string, roots: readonly string[]): void {
  const mounts = mountInfo.trim().split('\n').map(line => {
    const fields = line.split(' ')
    if (fields.length < 10 || !fields.includes('-') || !/^\d+:\d+$/.test(fields[2])) refuse()
    const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    return { device: fields[2], root: decode(fields[3]), point: decode(fields[4]) }
  })
  for (const root of roots) {
    const selected = mounts.filter(mount => nested(mount.point, root)).sort((a, b) => b.point.length - a.point.length)[0]
    if (!selected || selected.root !== '/' || mounts.filter(mount => mount.device === selected.device).length !== 1) refuse()
  }
}
function envelope(bytes: Buffer, custodyId: string): void {
  if (bytes.length === 0 || bytes.length > LIMIT) refuse()
  const value = JSON.parse(bytes.toString())
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'assurance,ciphertext,custodyId,nonce,tag,version') refuse()
  if (value.version !== 1 || value.assurance !== 'local-v1' || value.custodyId !== custodyId) refuse()
  for (const [field, min, max] of [['nonce', 12, 12], ['tag', 16, 16], ['ciphertext', 102, 6402]] as const) {
    if (typeof value[field] !== 'string') refuse()
    const decoded = Buffer.from(value[field], 'base64')
    if (decoded.toString('base64') !== value[field] || decoded.length < min || decoded.length > max) refuse()
  }
}

/** Encrypted packages only. No secret input, active pointer, unlock, overwrite or deletion. */
export async function createLocalCustodyStore(options: {
  custodyPath: string
  archivePath: string
  custodyId: string
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}) {
  return guarded(async () => {
    const { custodyPath, archivePath, custodyId, transactionDepth } = options
    const depth = () => { if (transactionDepth.currentTransactionDepth() !== 0) refuse() }
    depth()
    if (!UUID.test(custodyId)) refuse()
    const root = await directory(custodyPath)
    const archive = await directory(archivePath)
    if ((root.dev === archive.dev && root.ino === archive.ino) || nested(root.real, archive.real) || nested(archive.real, root.real)) refuse()
    const mounts = async () => {
      if (process.platform === 'linux') {
        assertLocalCustodyMountIsolation(await fs.readFile('/proc/self/mountinfo', 'utf8'), [root.real, archive.real])
      }
    }
    await mounts()
    const check = async () => {
      depth()
      for (const pinned of [root, archive]) {
        const current = await directory(pinned.configured)
        if (current.real !== pinned.real || current.dev !== pinned.dev || current.ino !== pinned.ino) refuse()
      }
      await mounts()
      depth()
    }
    const sync = async () => {
      await check()
      const handle = await fs.open(root.real, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat({ bigint: true })
        if (stat.dev !== root.dev || stat.ino !== root.ino) refuse()
        await handle.sync()
      } finally { await handle.close() }
    }
    const filename = (backupId: string) => {
      if (!UUID.test(backupId)) refuse()
      return path.join(root.real, `${custodyId}-${backupId}.custody`)
    }
    const read = async (backupId: string): Promise<Buffer> => {
      await check()
      const handle = await fs.open(filename(backupId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > LIMIT) refuse()
        const buffer = Buffer.alloc(LIMIT + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, null)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        if (length !== stat.size || length > LIMIT) refuse()
        const bytes = buffer.subarray(0, length)
        envelope(bytes, custodyId)
        await check()
        return bytes
      } finally { await handle.close() }
    }
    const receipt = (backupId: string, bytes: Buffer): LocalCustodyReceipt => ({
      backupId, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    })
    return Object.freeze({
      putBackup(backupId: string, backup: Uint8Array): Promise<LocalCustodyReceipt> {
        return guarded(async () => {
          depth()
          if (!(backup instanceof Uint8Array) || backup.byteLength > LIMIT) refuse()
          const bytes = Buffer.from(backup)
          envelope(bytes, custodyId)
          const destination = filename(backupId)
          await check()
          const temporary = path.join(root.real, `.pending-${randomUUID()}`)
          let created = false
          try {
            const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            created = true
            try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
            await check()
            try { await fs.link(temporary, destination) } catch (error) {
              if (!hasCode(error, 'EEXIST')) throw error
            }
            if (!(await read(backupId)).equals(bytes)) refuse()
            await sync()
            return receipt(backupId, bytes)
          } finally {
            if (created) {
              await check()
              await fs.unlink(temporary)
              await sync()
            }
          }
        })
      },
      readBackup(expected: LocalCustodyReceipt): Promise<Uint8Array> {
        return guarded(async () => {
          if (!expected || !/^[0-9a-f]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > LIMIT) refuse()
          const { backupId, sha256, size } = expected
          const bytes = await read(backupId)
          const actual = receipt(backupId, bytes)
          if (actual.sha256 !== sha256 || actual.size !== size) refuse()
          return bytes
        })
      },
    })
  })
}
