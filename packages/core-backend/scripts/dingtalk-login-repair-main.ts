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
  requestDingTalkRepairReanchor,
  previewDingTalkRepairReanchor,
  reanchorDingTalkRepair,
} from '../src/auth/dingtalk-identity-repair'
import { poolManager } from '../src/integration/db/connection-pool'

/**
 * The exact input field sets of every verb (one table, so a new verb never falls into another verb's
 * branch). A verb with two sets accepts exactly one of them.
 */
const FIELDS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  verify: [['userId', 'password', 'code', 'actorId', 'actorPassword']],
  preview: [['proof']],
  apply: [['proof', 'digest', 'confirm']],
  'rollback-preview': [['id', 'actorId', 'actorPassword']],
  'release-preview': [['id', 'actorId', 'actorPassword']],
  rollback: [['id', 'actorId', 'actorPassword', 'digest', 'confirm']],
  release: [['id', 'actorId', 'actorPassword', 'digest', 'confirm']],
  'reanchor-request': [
    ['id', 'actorId', 'actorPassword', 'approverId'],
    ['id', 'actorId', 'actorPassword', 'approverId', 'code'],
  ],
  'reanchor-preview': [['request', 'actorId', 'actorPassword']],
  reanchor: [['request', 'actorId', 'actorPassword', 'digest', 'confirm']],
}
/** Verbs that take a second path: a new private output file (0600, never overwritten). */
const WRITES_FILE: ReadonlySet<string> = new Set(['verify', 'reanchor-request'])

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
    !Object.prototype.hasOwnProperty.call(FIELDS, action) ||
    (WRITES_FILE.has(action) ? !out : !!out)
  )
    throw new Error('REPAIR_INPUT_INVALID')
  const input = await local(async () => {
    const stat = await lstat(file)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536)
      throw new Error('private input required')
    return JSON.parse(await readFile(file, 'utf8'))
  })
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !FIELDS[action].some(
      (set) =>
        set.length === Object.keys(input).length &&
        set.every((k) => typeof input[k] === 'string' && input[k]),
    )
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
  if (action === 'reanchor-request') {
    const { request, summary } = await requestDingTalkRepairReanchor(
      input.id,
      input.actorId,
      input.actorPassword,
      input.approverId,
      input.code,
    )
    await local(() =>
      writeFile(out, JSON.stringify({ request }), {
        mode: 0o600,
        flag: 'wx',
      }),
    )
    return summary
  }
  if (action === 'reanchor-preview')
    return previewDingTalkRepairReanchor(
      input.request,
      input.actorId,
      input.actorPassword,
    )
  if (action === 'reanchor')
    return reanchorDingTalkRepair(
      input.request,
      input.actorId,
      input.actorPassword,
      input.digest,
      input.confirm,
    )
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
