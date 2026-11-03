/**
 * Operator-only private-file workflow body. Loaded by scripts/dingtalk-login-repair.ts through a dynamic
 * import after the client-timeout gate, so the connection pool is first constructed here. No top-level
 * side effects beyond the static imports.
 */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import {
  verifyDingTalkRepair,
  previewDingTalkRepair,
  applyDingTalkRepair,
  rollbackDingTalkRepair,
  releaseDingTalkRepair,
  previewDingTalkRepairRecovery,
} from '../src/auth/dingtalk-identity-repair'
import { poolManager } from '../src/integration/db/connection-pool'

const ACTIONS = [
  'verify',
  'preview',
  'apply',
  'rollback-preview',
  'release-preview',
  'rollback',
  'release',
]

/** Any local input, file-system or JSON failure is an operator input problem with one fixed code. */
async function local<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch {
    throw new Error('REPAIR_INPUT_INVALID')
  }
}

/** The client read timeout the pool really holds (pg-pool keeps a copy of its options). */
export function effectiveClientQueryTimeoutMs(): number | null {
  const options = (
    poolManager.get().getInternalPool() as unknown as {
      options?: { query_timeout?: unknown }
    }
  ).options
  return typeof options?.query_timeout === 'number'
    ? options.query_timeout
    : null
}

export async function run(argv: string[]): Promise<unknown> {
  const [action, file, out, ...rest] = argv
  if (
    rest.length ||
    !file ||
    !ACTIONS.includes(action) ||
    (action === 'verify' ? !out : !!out)
  )
    throw new Error('REPAIR_INPUT_INVALID')
  const input = await local(async () => {
    const stat = await lstat(file)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536)
      throw new Error('private input required')
    return JSON.parse(await readFile(file, 'utf8'))
  })
  const fields =
    action === 'verify'
      ? ['userId', 'password', 'code', 'actorId', 'actorPassword']
      : action === 'preview'
        ? ['proof']
        : action === 'apply'
          ? ['proof', 'digest', 'confirm']
          : action.endsWith('-preview')
            ? ['id', 'actorId', 'actorPassword']
            : ['id', 'actorId', 'actorPassword', 'digest', 'confirm']
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    fields.some((k) => typeof input[k] !== 'string' || !input[k])
  )
    throw new Error('REPAIR_INPUT_INVALID')
  if (action === 'verify') {
    const proof = await verifyDingTalkRepair(
      input.userId,
      input.password,
      input.code,
      input.actorId,
      input.actorPassword,
    )
    await local(() =>
      writeFile(out, JSON.stringify({ proof }), {
        mode: 0o600,
        flag: 'wx',
      }),
    )
    return {
      verified: true,
      expiresInSeconds: 300,
      localSessionIssued: false,
      businessRowsChanged: false,
    }
  }
  if (action === 'preview') return previewDingTalkRepair(input.proof)
  if (action === 'apply')
    return applyDingTalkRepair(input.proof, input.digest, input.confirm)
  if (action.endsWith('-preview'))
    return previewDingTalkRepairRecovery(
      input.id,
      input.actorId,
      input.actorPassword,
      action === 'rollback-preview' ? 'rollback' : 'release',
    )
  return (
    action === 'rollback' ? rollbackDingTalkRepair : releaseDingTalkRepair
  )(input.id, input.actorId, input.digest, input.confirm, input.actorPassword)
}
