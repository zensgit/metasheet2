/**
 * HOST FENCED WRITES for plugin records (stock-prep batch-refresh phase 0 step 1, PR #6501 Codex review P1-a).
 *
 * A plugin that serializes its own writers with a lease row (plugin-integration-core's sheet write lock,
 * table `integration_stock_prep_project_write_lock`, migration 100) cannot make the host's record write
 * conditional on that lease from the plugin side: its pre-write CAS and the host's INSERT/UPDATE are two
 * transactions, so a holder suspended between them could commit a stale write after a takeover. This module
 * closes that gap INSIDE the host's write transaction:
 *
 *   SELECT 1 FROM <lease table> WHERE scope_key = $1 AND lease_id = $2 AND fencing_epoch = $3
 *     AND generation_token = $4 FOR SHARE
 *
 * runs in the SAME transaction as the record insert / update, before it. Zero rows -> the write is refused
 * (PLUGIN_WRITE_FENCE_REJECTED, nothing written). One row -> the row is share-locked until COMMIT.
 *
 * WHY FOR SHARE IS ENOUGH (PostgreSQL row locks; READ COMMITTED):
 *   * Every statement that can change who may write — takeover, release, abandoned-lease clear, generation
 *     bump — is an UPDATE of non-key columns of that row, which takes FOR NO KEY UPDATE. FOR NO KEY UPDATE
 *     conflicts with FOR SHARE.
 *   * Fenced write first: the takeover/bump UPDATE waits until the write transaction commits, i.e. the
 *     write lands while its run is still the holder; the UPDATE then proceeds.
 *   * Takeover/bump first: the fence SELECT ... FOR SHARE waits for it (or reads the committed row), sees
 *     the new lease_id / token and returns zero rows; the write is refused.
 *   * NOT checked: lease_seq and lease_expires_at. The holder's own heartbeat / pre-write CAS changes seq
 *     on every renewal, and expiry is the plugin's (clock-based) business; ownership is lease_id + epoch,
 *     the plan is generation_token, and the lock ordering above is what makes them exact at COMMIT.
 *   * NO DEADLOCK with the holder's own CAS: the heartbeat / pre-write CAS is a single autocommit UPDATE on
 *     a different connection. It waits behind an in-flight fenced write (FOR SHARE held until that write's
 *     COMMIT) and the write transaction never waits for it — the write transaction's other locks are on
 *     meta_* rows, which that UPDATE never touches. A waits-for cycle needs both sides to wait on the other;
 *     here only the UPDATE ever waits, and only for the duration of one record write.
 *
 * WHAT A PLUGIN MAY NAME: nothing but its own allow-listed lease table. The host never takes a table or a
 * column from the plugin: the fence names the lock by its allow-listed identifier, the SQL is a fixed string
 * keyed by the CALLING plugin's name (supplied by plugin-scope, never by the plugin), and the four values
 * are parameters. Any other plugin, any other lock, any extra or missing key -> PLUGIN_WRITE_FENCE_NOT_ALLOWED.
 * Only fences RESOLVED here (by plugin-scope, for the calling plugin) are honoured by the core write path;
 * an unresolved object handed to the core API directly is refused, never ignored.
 *
 * A FENCE IS NEVER SILENTLY IGNORED (review round 6, S2). Only `createRecord` / `patchRecord` implement the
 * fence. Every other plugin-facing write surface — `deleteRecord`, the stock-preparation overview port, the
 * persist unit of work's create / patch — REFUSES an input that carries `writeFence` (501
 * PLUGIN_WRITE_FENCE_UNSUPPORTED, nothing written) instead of dropping it: a caller that asked for a fenced
 * write must never get an unfenced one. Fencing on those surfaces is a later slice, not this one.
 *
 * NOT BOUND HERE (defence in depth for the next slice): the host does not check that the fence's `scopeKey`
 * names the sheet being written; the plugin binds them (assertProjectWriteGuardScope / chunkWriteScope).
 */

export type PluginWriteFenceInput = {
  lock: string
  scopeKey: string
  leaseId: string
  fencingEpoch: number
  generationToken: string
}

export type ResolvedPluginWriteFence = Readonly<PluginWriteFenceInput & { pluginName: string }>

export type PluginWriteFenceQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

type AllowListEntry = Readonly<{ lock: string; sql: string }>

/** The ONE allow-list. Keyed by the calling plugin's manifest name; values are fixed by the host. */
export const PLUGIN_WRITE_FENCE_ALLOW_LIST: Readonly<Record<string, AllowListEntry>> = Object.freeze({
  'plugin-integration-core': Object.freeze({
    lock: 'integration_stock_prep_project_write_lock',
    sql: 'SELECT 1 FROM integration_stock_prep_project_write_lock'
      + ' WHERE scope_key = $1 AND lease_id = $2 AND fencing_epoch = $3 AND generation_token = $4'
      + ' FOR SHARE',
  }),
})

export const PLUGIN_WRITE_FENCE_CODES = Object.freeze({
  NOT_ALLOWED: 'PLUGIN_WRITE_FENCE_NOT_ALLOWED',
  REJECTED: 'PLUGIN_WRITE_FENCE_REJECTED',
  UNAVAILABLE: 'PLUGIN_WRITE_FENCE_UNAVAILABLE',
  /** A fence handed to a write surface that does not implement fencing (review round 6, S2). */
  UNSUPPORTED: 'PLUGIN_WRITE_FENCE_UNSUPPORTED',
})

const FENCE_KEYS = Object.freeze(['lock', 'scopeKey', 'leaseId', 'fencingEpoch', 'generationToken'])
const MAX_FENCE_STRING_LENGTH = 200

export class PluginWriteFenceError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PluginWriteFenceError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const resolvedFences = new WeakSet<object>()

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FENCE_STRING_LENGTH
}

function notAllowed(reason: string): PluginWriteFenceError {
  return new PluginWriteFenceError(403, PLUGIN_WRITE_FENCE_CODES.NOT_ALLOWED, 'this write fence is not allowed for this plugin', { reason })
}

/**
 * plugin-scope's half: validate a plugin-supplied fence for the CALLING plugin and return the host-resolved
 * (branded, frozen) form the core write path honours. `undefined` -> `undefined` (an unfenced write).
 */
export function resolvePluginWriteFence(pluginName: string, fence: unknown): ResolvedPluginWriteFence | undefined {
  if (fence === undefined) return undefined
  const entry = Object.prototype.hasOwnProperty.call(PLUGIN_WRITE_FENCE_ALLOW_LIST, pluginName)
    ? PLUGIN_WRITE_FENCE_ALLOW_LIST[pluginName]
    : undefined
  if (!entry) throw notAllowed('plugin_not_allowed')
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) throw notAllowed('fence_shape')
  const record = fence as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== FENCE_KEYS.length || !FENCE_KEYS.every((key) => keys.includes(key))) throw notAllowed('fence_shape')
  // READ ONCE (review round 6, N5; the rule plugin-scope applies to `sheetId`): each field is read exactly
  // once, validated, and that same value is what the resolved fence carries — a getter cannot show the
  // validation one value and the host another.
  const lock = record.lock
  const scopeKey = record.scopeKey
  const leaseId = record.leaseId
  const fencingEpoch = record.fencingEpoch
  const generationToken = record.generationToken
  if (lock !== entry.lock) throw notAllowed('lock_not_allowed')
  if (!boundedString(scopeKey) || !boundedString(leaseId) || !boundedString(generationToken)) {
    throw notAllowed('fence_shape')
  }
  if (!Number.isInteger(fencingEpoch) || (fencingEpoch as number) < 0) throw notAllowed('fence_shape')
  const resolved = Object.freeze({
    pluginName,
    lock: entry.lock,
    scopeKey,
    leaseId,
    fencingEpoch: fencingEpoch as number,
    generationToken,
  })
  resolvedFences.add(resolved)
  return resolved
}

/**
 * The unfenced surfaces' half (review round 6, S2): a write surface that does NOT implement the fence
 * refuses an input that carries one — `writeFence` present with any value but `undefined` — before any
 * scope or host work, so the caller never gets a silently unfenced write. `surface` names the refusing
 * method (values-free). Read once off the raw input.
 */
export function refusePluginWriteFenceOnUnfencedSurface(input: unknown, surface: string): void {
  const fence = input && typeof input === 'object' ? (input as { writeFence?: unknown }).writeFence : undefined
  if (fence === undefined) return
  throw new PluginWriteFenceError(501, PLUGIN_WRITE_FENCE_CODES.UNSUPPORTED, 'this write surface does not implement the host write fence; nothing was written', { surface })
}

/**
 * The core write path's half: inside the write transaction, BEFORE the insert / update. `undefined` ->
 * no fence (an unfenced write, unchanged). Anything not resolved by `resolvePluginWriteFence` is refused.
 */
export async function assertPluginWriteFence(query: PluginWriteFenceQueryFn, fence: unknown): Promise<void> {
  if (fence === undefined) return
  if (!fence || typeof fence !== 'object' || !resolvedFences.has(fence)) throw notAllowed('fence_unresolved')
  const resolved = fence as ResolvedPluginWriteFence
  const entry = Object.prototype.hasOwnProperty.call(PLUGIN_WRITE_FENCE_ALLOW_LIST, resolved.pluginName)
    ? PLUGIN_WRITE_FENCE_ALLOW_LIST[resolved.pluginName]
    : undefined
  if (!entry || entry.lock !== resolved.lock) throw notAllowed('lock_not_allowed')
  let rows: unknown[]
  try {
    const result = await query(entry.sql, [resolved.scopeKey, resolved.leaseId, resolved.fencingEpoch, resolved.generationToken])
    rows = Array.isArray(result?.rows) ? result.rows : []
  } catch (error) {
    const sqlState = typeof (error as { code?: unknown })?.code === 'string' && /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : undefined
    throw new PluginWriteFenceError(503, PLUGIN_WRITE_FENCE_CODES.UNAVAILABLE, 'the write fence could not be checked; nothing was written', sqlState ? { sqlState } : {})
  }
  if (rows.length !== 1) {
    throw new PluginWriteFenceError(409, PLUGIN_WRITE_FENCE_CODES.REJECTED, 'the write fence no longer holds; nothing was written')
  }
}
