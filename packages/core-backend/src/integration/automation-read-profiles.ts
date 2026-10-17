import { canonicalReadId } from './automation-read-contracts'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

/** HOST PRIVATE: not a client DTO, plugin communication API, or execution permission. */
export type AutomationProfileJson = null | boolean | number | string | readonly AutomationProfileJson[]
  | { readonly [key: string]: AutomationProfileJson }
type JsonObject = { readonly [key: string]: AutomationProfileJson }
export type PreparedAutomationReadProfile = Readonly<{
  tenantId: string; workspaceId: null; projectId: string; actionId: string
  sheetId: string; objectId: string; material: JsonObject
}>
export type AutomationReadProducerIdentity = Readonly<{ generation: string; nonce: string }>
export type LockedAutomationReadProfile = PreparedAutomationReadProfile & Readonly<{
  targetId: string; revision: string; producer: AutomationReadProducerIdentity
}>
export type AutomationReadProfileErrorCode = 'AUTOMATION_PROFILE_INPUT_INVALID'
  | 'AUTOMATION_PROFILE_TRANSACTION_REQUIRED' | 'AUTOMATION_PROFILE_UNAVAILABLE'
  | 'AUTOMATION_PROFILE_PRODUCER_BUSY' | 'AUTOMATION_PROFILE_FENCE_LOST' | 'AUTOMATION_PROFILE_DENIED'
export class AutomationReadProfileError extends Error {
  constructor(readonly code: AutomationReadProfileErrorCode) {
    super(code)
    this.name = 'AutomationReadProfileError'
  }
}
const profileKeys = ['tenantId', 'workspaceId', 'projectId', 'actionId', 'sheetId', 'objectId', 'material']
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
function fail(code: AutomationReadProfileErrorCode): never { throw new AutomationReadProfileError(code) }
function input(): never { return fail('AUTOMATION_PROFILE_INPUT_INVALID') }
function unavailable(): never { return fail('AUTOMATION_PROFILE_UNAVAILABLE') }
function denied(): never { return fail('AUTOMATION_PROFILE_DENIED') }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function data(value: unknown, keys: string[]): Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) return input()
  return Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return input()
    return [key, d.value]
  }))
}
function json(value: unknown, seen = new Set<object>(), depth = 0): AutomationProfileJson {
  if (depth > 64) return input()
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || seen.has(value)) return input()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return input()
      return Object.freeze(Array.from({ length: value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(value, String(i))
        if (!d?.enumerable || !Object.hasOwn(d, 'value')) return input()
        return json(d.value, seen, depth + 1)
      }))
    }
    if (!plain(value)) return input()
    return Object.freeze(Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) return input()
      return [key, json(d.value, seen, depth + 1)]
    })))
  } finally { seen.delete(value) }
}
function identity(value: unknown): AutomationReadProducerIdentity {
  const row = data(value, ['generation', 'nonce'])
  if (typeof row.generation !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.generation)
    || BigInt(row.generation) > 9223372036854775807n
    || typeof row.nonce !== 'string' || !uuid.test(row.nonce)) return input()
  return Object.freeze({ generation: row.generation, nonce: row.nonce })
}
function profiles(value: unknown): readonly PreparedAutomationReadProfile[] {
  const captured = json(value)
  if (!Array.isArray(captured) || captured.length === 0 || captured.length > 32) return input()
  const sheetTenants = new Map<string, string>()
  const actions = new Set<string>()
  return Object.freeze(captured.map(entry => {
    const row = data(entry, profileKeys)
    if (row.workspaceId !== null || ![row.tenantId, row.projectId, row.actionId, row.sheetId, row.objectId].every(canonicalReadId)
      || !plain(row.material)) return input()
    const { tenantId, projectId, actionId, sheetId, objectId } = row as Record<string, string>
    if (sheetTenants.has(sheetId) && sheetTenants.get(sheetId) !== tenantId) return input()
    sheetTenants.set(sheetId, tenantId)
    const key = JSON.stringify([sheetId, actionId])
    if (actions.has(key)) return input()
    actions.add(key)
    if (Buffer.byteLength(JSON.stringify(row.material)) > 1048576) return input()
    return Object.freeze({ tenantId, workspaceId: null, projectId, actionId, sheetId, objectId, material: row.material as JsonObject })
  }))
}
function lease(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120000) return input()
  return value
}
async function transaction(trx: Queryable): Promise<void> {
  try {
    const rows = (await trx.query("SELECT current_setting('transaction_isolation') AS isolation")).rows
    if (rows.length !== 1 || rows[0]?.isolation !== 'read committed') throw new Error('Isolation')
    await assertInTransaction(trx, 'Automation profile')
  } catch { fail('AUTOMATION_PROFILE_TRANSACTION_REQUIRED') }
}
async function boundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    if (error instanceof AutomationReadProfileError) throw error
    return unavailable()
  }
}
async function lockProducer(trx: Queryable, expected: AutomationReadProducerIdentity, write: boolean): Promise<void> {
  if (!write) return lockAutomationReadProducerForRead(trx, expected)
  const rows = (await trx.query(`SELECT generation::text, nonce::text, expires_at > clock_timestamp() AS live
    FROM automation_read_producer_slot WHERE slot_id = 1 FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`)).rows
  if (rows.length !== 1 || rows[0]?.generation !== expected.generation || rows[0]?.nonce !== expected.nonce
    || rows[0]?.live !== true) fail('AUTOMATION_PROFILE_FENCE_LOST')
}

/** SHARE still fences every identity/expiry writer. Only this slot read may wait
 * briefly for a renewal; every other profile/binding lock remains NOWAIT.
 * lock_timeout bounds each lock acquisition, not total SQL/network latency.
 * On SQL failure the caller must reject/roll back; do not issue a restoration
 * query in an aborted transaction and overwrite its original error. */
export async function lockAutomationReadProducerForRead(
  trx: Queryable, supplied: AutomationReadProducerIdentity,
): Promise<void> {
  const expected = identity(supplied)
  await transaction(trx)
  return boundary(async () => {
    const settings = (await trx.query(`SELECT pg_catalog.current_setting('lock_timeout') AS previous,
      (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS timeout_ms`)).rows
    const previous = settings[0]?.previous, timeout = Number(settings[0]?.timeout_ms)
    if (settings.length !== 1 || typeof previous !== 'string' || !previous || previous.length > 128
      || (typeof settings[0]?.timeout_ms !== 'string' && typeof settings[0]?.timeout_ms !== 'number')
      || (typeof settings[0]?.timeout_ms === 'string' && !/^\d+$/.test(settings[0].timeout_ms))
      || !Number.isSafeInteger(timeout) || timeout < 0) return unavailable()
    const shortened = timeout === 0 || timeout > 250
    if (shortened) await trx.query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", ['250ms'])
    // Do not evaluate live before an acquisition that may wait. Its receipt is
    // not our wall-clock proof; the retained SHARE lock protects the fresh read.
    const locked = (await trx.query(`SELECT generation::text, nonce::text FROM automation_read_producer_slot
      WHERE slot_id = 1 FOR SHARE`)).rows
    if (shortened) await trx.query("SELECT pg_catalog.set_config('lock_timeout', $1, true)", [previous])
    if (locked.length !== 1 || locked[0]?.generation !== expected.generation || locked[0]?.nonce !== expected.nonce) {
      fail('AUTOMATION_PROFILE_FENCE_LOST')
    }
    const rows = (await trx.query(`SELECT generation::text, nonce::text, expires_at > pg_catalog.clock_timestamp() AS live
      FROM automation_read_producer_slot WHERE slot_id = 1`)).rows
    if (rows.length !== 1 || rows[0]?.generation !== expected.generation || rows[0]?.nonce !== expected.nonce
      || rows[0]?.live !== true) fail('AUTOMATION_PROFILE_FENCE_LOST')
  })
}

/**
 * Atomic activation primitive. ONLY the host-injected, reviewed integration
 * activation may call this with captured deployment material and explicit tenant.
 * Never pass request/ALS tenant, registry.updated_by, client mappings or rows here.
 * Prepared material is data, not a brand: the plugin must rebuild its real catalog
 * and branded mapper on load and combine them with live DB materials/permissions.
 * No core bootstrap installs this factory yet; no public caller/source IO exists.
 * automation_read_* avoids createDb's integration_ CRUD namespace, not the raw
 * database capability held by trusted plugin context. Malicious in-process code
 * or a schema owner is outside this contract; table names are not a SQL sandbox.
 *
 * All methods require one caller-owned short RC transaction, slot first then
 * binding/profile. Readers SHARE-lock the slot; writers UPDATE/NOWAIT. A live
 * second activation is refused; there is NO force-steal option. Commit the new
 * identity before using it. Do not publish the identity or profiles in old logs.
 * Expiry/stop/restart makes prior grants require reissue via the composing port.
 * Lifetime is checked again before each new IO and result publication; a lock
 * cannot suspend wall-clock expiry or physically cancel an in-flight source read.
 */
export async function activateAutomationReadProfiles(
  trx: Queryable, prepared: readonly PreparedAutomationReadProfile[], ttlMs = 60000,
): Promise<Readonly<{ producer: AutomationReadProducerIdentity; targets: readonly Readonly<{ targetId: string; tenantId: string; actionId: string }>[] }>> {
  const captured = profiles(prepared)
  const ttl = lease(ttlMs)
  await transaction(trx)
  return boundary(async () => {
    const slots = (await trx.query(`SELECT generation::text, nonce::text, expires_at > clock_timestamp() AS live
      FROM automation_read_producer_slot WHERE slot_id = 1 FOR UPDATE NOWAIT`)).rows
    if (slots.length !== 1) return unavailable()
    if (slots[0].live === true) fail('AUTOMATION_PROFILE_PRODUCER_BUSY')
    const changed = (await trx.query(`UPDATE automation_read_producer_slot
      SET nonce = gen_random_uuid(), expires_at = clock_timestamp() + $1::int * interval '1 millisecond'
      WHERE slot_id = 1 RETURNING generation::text, nonce::text`, [ttl])).rows
    if (changed.length !== 1) return unavailable()
    const producer = identity(changed[0])
    await trx.query('UPDATE automation_read_target_profiles SET enabled = false WHERE enabled = true')
    const targets = []
    for (const profile of captured) {
      await trx.query(`INSERT INTO automation_read_target_bindings(sheet_id,tenant_id) VALUES ($1,$2)
        ON CONFLICT (sheet_id) DO NOTHING`, [profile.sheetId, profile.tenantId])
      const bound = (await trx.query('SELECT tenant_id FROM automation_read_target_bindings WHERE sheet_id=$1 FOR SHARE NOWAIT', [profile.sheetId])).rows
      if (bound.length !== 1 || bound[0].tenant_id !== profile.tenantId) return denied()
      const rows = (await trx.query(`INSERT INTO automation_read_target_profiles
        (sheet_id,tenant_id,action_id,project_id,object_id,material,producer_generation,producer_nonce,enabled)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::bigint,$8::uuid,true)
        ON CONFLICT (sheet_id,action_id) DO UPDATE SET project_id=EXCLUDED.project_id, object_id=EXCLUDED.object_id,
          material=EXCLUDED.material, producer_generation=EXCLUDED.producer_generation,
          producer_nonce=EXCLUDED.producer_nonce, enabled=true
        WHERE automation_read_target_profiles.tenant_id=EXCLUDED.tenant_id
        RETURNING target_id::text`, [profile.sheetId, profile.tenantId, profile.actionId, profile.projectId,
        profile.objectId, JSON.stringify(profile.material), producer.generation, producer.nonce])).rows
      if (rows.length !== 1 || typeof rows[0].target_id !== 'string' || !uuid.test(rows[0].target_id)) return denied()
      targets.push(Object.freeze({ targetId: rows[0].target_id as string, tenantId: profile.tenantId, actionId: profile.actionId }))
    }
    return Object.freeze({ producer, targets: Object.freeze(targets) })
  })
}

export async function renewAutomationReadProducer(trx: Queryable, supplied: AutomationReadProducerIdentity, ttlMs = 60000): Promise<void> {
  const expected = identity(supplied); const ttl = lease(ttlMs)
  await transaction(trx)
  return boundary(async () => {
    await lockProducer(trx, expected, true)
    const changed = await trx.query(`UPDATE automation_read_producer_slot
      SET expires_at=clock_timestamp() + $3::int * interval '1 millisecond'
      WHERE slot_id=1 AND generation=$1::bigint AND nonce=$2::uuid AND expires_at>clock_timestamp()
      RETURNING generation::text, nonce::text`, [expected.generation, expected.nonce, ttl])
    if (changed.rows.length !== 1 || changed.rows[0].generation !== expected.generation || changed.rows[0].nonce !== expected.nonce) {
      fail('AUTOMATION_PROFILE_FENCE_LOST')
    }
  })
}

export async function deactivateAutomationReadProducer(trx: Queryable, supplied: AutomationReadProducerIdentity): Promise<void> {
  const expected = identity(supplied)
  await transaction(trx)
  return boundary(async () => {
    // An expired old process may retire ONLY itself, never the replacement.
    const rows = (await trx.query(`SELECT generation::text, nonce::text FROM automation_read_producer_slot
      WHERE slot_id=1 FOR UPDATE NOWAIT`)).rows
    if (rows.length !== 1 || rows[0].generation !== expected.generation || rows[0].nonce !== expected.nonce) fail('AUTOMATION_PROFILE_FENCE_LOST')
    const stopped = await trx.query(`UPDATE automation_read_producer_slot SET nonce=NULL, expires_at=NULL
      WHERE slot_id=1 AND generation=$1::bigint AND nonce=$2::uuid RETURNING slot_id`, [expected.generation, expected.nonce])
    if (stopped.rows.length !== 1) fail('AUTOMATION_PROFILE_FENCE_LOST')
    await trx.query(`UPDATE automation_read_target_profiles SET enabled=false
      WHERE producer_generation=$1::bigint AND producer_nonce=$2::uuid AND enabled=true`, [expected.generation, expected.nonce])
  })
}

export async function lockAutomationReadProfile(
  trx: Queryable, supplied: AutomationReadProducerIdentity, scope: { tenantId: string; targetId: string },
): Promise<LockedAutomationReadProfile> {
  const expected = identity(supplied)
  const captured = data(scope, ['tenantId', 'targetId'])
  if (!canonicalReadId(captured.tenantId) || typeof captured.targetId !== 'string' || !uuid.test(captured.targetId)) return input()
  const { tenantId, targetId } = captured
  await transaction(trx)
  return boundary(async () => {
    await lockProducer(trx, expected, false)
    const rows = (await trx.query(`SELECT p.target_id::text, p.tenant_id, p.sheet_id, p.action_id, p.project_id,
      p.object_id, p.material, p.revision::text, p.producer_generation::text, p.producer_nonce::text, p.enabled,
      b.tenant_id AS binding_tenant_id FROM automation_read_target_profiles p
      JOIN automation_read_target_bindings b ON b.sheet_id=p.sheet_id
      WHERE p.target_id=$1::uuid AND p.tenant_id=$2 FOR SHARE OF p,b NOWAIT`, [targetId, tenantId])).rows
    if (rows.length !== 1) return denied()
    const row = rows[0]
    if (row.target_id !== targetId || row.tenant_id !== tenantId || row.binding_tenant_id !== tenantId || row.enabled !== true
      || row.producer_generation !== expected.generation || row.producer_nonce !== expected.nonce
      || typeof row.revision !== 'string' || !uuid.test(row.revision)) return denied()
    const [profile] = profiles([{ tenantId, workspaceId: null, sheetId: row.sheet_id, actionId: row.action_id,
      projectId: row.project_id, objectId: row.object_id, material: row.material }])
    // Query time may have crossed expiry while capturing/validating a large profile.
    await lockProducer(trx, expected, false)
    return Object.freeze({ ...profile, targetId, revision: row.revision, producer: expected })
  })
}
