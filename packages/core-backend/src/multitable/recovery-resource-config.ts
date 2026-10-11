import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RecoveryRemoteResourceCompositionConfig } from './recovery-remote-composition'

function refuse(): never { throw new Error('RECOVERY_ARCHIVE_RESOURCE_CONFIG_REFUSED') }
export async function readRecoveryResourcePrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || !process.getuid) refuse()
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let bytes: Buffer | undefined
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > maxBytes) refuse()
      bytes = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      const after = await handle.stat()
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.uid !== before.uid || after.mode !== before.mode) { bytes.fill(0); refuse() }
      return bytes.subarray(0, length)
    } catch { bytes?.fill(0); return refuse() }
    finally { await handle.close() }
  } catch { return refuse() }
}
export async function readRecoveryResourceJson(path: string): Promise<Record<string, unknown>> {
  const bytes = await readRecoveryResourcePrivateFile(path, 16384)
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse()
    return value as Record<string, unknown>
  } catch { return refuse() }
  finally { bytes.fill(0) }
}
export function exactRecoveryResourceConfig(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) refuse()
  return value as Record<string, unknown>
}
export async function readRecoveryRemoteResourceConfig(path: string): Promise<RecoveryRemoteResourceCompositionConfig> {
  const input = exactRecoveryResourceConfig(await readRecoveryResourceJson(path), ['objectStore', 'keyCustody', 'policy', 'worker'])
  const object = exactRecoveryResourceConfig(input.objectStore, ['url', 'tokenPath', 'caPath', 'timeoutMs', 'storeId', 'maxObjectBytes'])
  const custody = exactRecoveryResourceConfig(input.keyCustody, ['url', 'tokenPath', 'caPath', 'timeoutMs', 'keyId', 'wrappingKey', 'fingerprintKey', 'fingerprintKeyVersion', 'manifestKey', 'manifestKeyVersion'])
  exactRecoveryResourceConfig(input.worker, ['leaseMs', 'replayHorizonMs', 'sweepLimit', 'maxChunksPerRun'])
  const policy = input.policy as Record<string, unknown>
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some(k => !['auditedReplayHorizonMs', 'asyncResumeHorizonMs', 'workerIntervalMs', 'manualCapture', 'manualCaptureLimits'].includes(k))) refuse()
  const load = async (value: Record<string, unknown>) => {
    const tokenBytes = await readRecoveryResourcePrivateFile(value.tokenPath as string, 1024)
    try {
      const token = tokenBytes.toString('utf8').trim()
      const ca = await readRecoveryResourcePrivateFile(value.caPath as string, 65536)
      const { tokenPath: _tokenPath, caPath: _caPath, ...rest } = value
      return { ...rest, token, ca }
    } finally { tokenBytes.fill(0) }
  }
  try {
    // Closed JSON keys above; concrete adapters and canonical application admission validate values.
    return { objectStore: await load(object), keyCustody: await load(custody), policy: { ...policy }, worker: { ...input.worker as object } } as unknown as RecoveryRemoteResourceCompositionConfig
  } catch { return refuse() }
}
