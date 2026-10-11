/**
 * Shared fixtures for the M4 task real-DB files (design task-m4-pr3a-backend-design-20260930.md
 * §10.1). Not a `task-*.db.test.ts` file, so it is not part of the three-set enumeration.
 *
 * - seedTaskActor: permissions (ON CONFLICT DO NOTHING), roles, role_permissions, users,
 *   user_roles, user_orgs, optional namespace admission and direct grants, and a signed JWT.
 * - seedOrgMembers: users + user_orgs only.
 * - orgMemberSeeds: seedOrgMembers with a per-file record and its own cleanup, for the M2/M3 files
 *   (S9, [N2]).
 * - dropTaskM4Fixtures: org-prefix cleanup of task rows (FK cascades take list items, group
 *   items, events and comments), lists (cascade members, list-scope groups, list events),
 *   user-scope groups, settings, outbox rows, directory integrations (M4 PR-3b), then the
 *   identity rows.
 * - seedOrgDingTalkIntegration (M4 PR-3b): one `directory_integrations` row in the given org, with
 *   the org written explicitly (the column's default org is never used).
 * - seedOutboxRow (M4 PR-3b): one `task_notification_deliveries` row with chosen columns (S4 adds
 *   the scheduling and claim columns and a raw payload).
 * - seedDirectoryBinding (M4 PR-3b S6): a DingTalk identity of a local user in an org — an
 *   integration row (new, or one given), a directory account and the link to the user.
 * - deferred, steppedClock, FakeTaskDeliveryChannel (M4 PR-3b S4): a promise resolved by the test,
 *   a clock moved by hand, and a delivery channel that records every prepare / send with the
 *   delivery id and its own label (one fake per worker: the terminal write clears
 *   `claim_worker_id`, so which worker sent a row is read from these records).
 * - runSourceMutant: rewrites one source file in place, runs a tsx child, restores the file and
 *   asserts it is byte-identical. Only for a throwaway checkout (CI or the implementer's own
 *   worktree), never a worktree another agent is using.
 * - whileStructureLockHeld: holds an org's structure lock on its own connection while one request
 *   (or `waiters` requests) queue on it, and returns the holder's `clock_timestamp()` reading taken
 *   just before commit.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { acquireTaskStructureLock } from '../../src/db/task-advisory-locks'
import { poolManager } from '../../src/integration/db/connection-pool'
import type {
  TaskDeliveryChannel,
  TaskDeliveryChannelResult,
  TaskDeliveryPrepared,
  TaskDeliveryPrepareTarget,
} from '../../src/services/task-notification-delivery-worker'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import type { TaskDeliveryMessage } from '../../src/tasks/task-notification-text'

export const TASK_PERMISSION_CODES = ['tasks:read', 'tasks:write', 'tasks:admin'] as const

export interface SeededTaskActor {
  userId: string
  roleId: string
  bearer: string
}

export interface SeedTaskActorOptions {
  /** Short label, unique within one `stamp`. */
  label: string
  /** Shared per-file suffix; every seeded id ends with `_${stamp}` so cleanup can match it. */
  stamp: string
  orgId: string
  /** Codes granted through a role (role_permissions). */
  codes: string[]
  /** Insert `user_namespace_admissions(user_id, 'tasks', enabled = true)`. */
  admission: boolean
  /** Codes granted directly (user_permissions). */
  direct?: string[]
  /** `user_orgs.is_active`; defaults to true. */
  activeInOrg?: boolean
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('task-m4-fixtures requires JWT_SECRET (>= 32 chars)')
  }
  return secret
}

export function signTaskToken(userId: string, roleId: string, orgId: string): string {
  return jwt.sign({
    userId,
    sub: userId,
    email: `${userId}@tasks-m4.test`,
    role: 'user',
    roles: [roleId],
    tenantId: orgId,
  }, jwtSecret(), { expiresIn: '1h' })
}

export async function ensureTaskPermissions(): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO permissions (code, name, description) VALUES
       ('tasks:read', 'Tasks Read', 'read'),
       ('tasks:write', 'Tasks Write', 'write'),
       ('tasks:admin', 'Tasks Admin', 'admin')
     ON CONFLICT (code) DO NOTHING`,
  )
}

async function insertUser(userId: string, name: string): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
     )`,
    [userId, `${userId}@tasks-m4.test`, name],
  )
}

export async function seedTaskActor(opts: SeedTaskActorOptions): Promise<SeededTaskActor> {
  const userId = `usr_${opts.label}_${opts.stamp}`
  const roleId = `role_${opts.label}_${opts.stamp}`
  const db = poolManager.get()
  await ensureTaskPermissions()
  await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
  for (const code of opts.codes) {
    await db.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, code])
  }
  await insertUser(userId, opts.label)
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
  await db.query(
    'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)',
    [userId, opts.orgId, opts.activeInOrg ?? true],
  )
  if (opts.admission) {
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [userId],
    )
  }
  for (const code of opts.direct ?? []) {
    await db.query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [userId, code])
  }
  return { userId, roleId, bearer: signTaskToken(userId, roleId, opts.orgId) }
}

/** Seeds `users` + `user_orgs` only (no role, no admission). `active` defaults to true. */
export async function seedOrgMembers(
  orgId: string,
  userIds: string[],
  opts: { active?: boolean } = {},
): Promise<void> {
  const db = poolManager.get()
  for (const userId of userIds) {
    await insertUser(userId, userId)
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)',
      [userId, orgId, opts.active ?? true],
    )
  }
}

/**
 * seedOrgMembers with a per-file record, for the M2/M3 real-DB files and the auth gate, whose own
 * cleanup deletes task rows only (design §4.6, [N2]: an assignee or follower someone else writes
 * must be an active member of the org). `seed` runs seedOrgMembers for ids this record has not
 * seen; an id it already seeded (the same user in a second org) gets only the `user_orgs` row.
 * `drop` deletes exactly the recorded ids' `user_orgs` and `users` rows and forgets them, so a file
 * with several `afterAll` hooks can call it in each.
 */
export function orgMemberSeeds(): {
  seed: (orgId: string, userIds: string[]) => Promise<void>
  drop: () => Promise<void>
} {
  const seeded = new Set<string>()
  return {
    async seed(orgId, userIds) {
      const fresh = userIds.filter((userId) => !seeded.has(userId))
      const known = userIds.filter((userId) => seeded.has(userId))
      await seedOrgMembers(orgId, fresh)
      for (const userId of fresh) seeded.add(userId)
      for (const userId of known) {
        await poolManager.get().query(
          'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
          [userId, orgId],
        )
      }
    },
    async drop() {
      const userIds = [...seeded]
      if (userIds.length === 0) return
      const db = poolManager.get()
      await db.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      seeded.clear()
    },
  }
}

/**
 * Removes everything an M4 file seeded. `orgPrefix` is matched literally against the start of
 * `org_id` (no LIKE wildcards: `_` and `%` in the prefix are plain characters); `userIds` /
 * `roleIds` are exact ids (callers usually collect them from seedTaskActor / seedOrgMembers).
 */
export async function dropTaskM4Fixtures(opts: {
  orgPrefix: string
  userIds?: string[]
  roleIds?: string[]
}): Promise<void> {
  if (!opts.orgPrefix || opts.orgPrefix.length < 6) {
    throw new Error('dropTaskM4Fixtures: refusing a short org prefix')
  }
  const db = poolManager.get()
  const prefix = opts.orgPrefix
  const users = opts.userIds ?? []
  const roles = opts.roleIds ?? []
  for (const table of [
    'tasks', 'task_lists', 'task_groups', 'task_user_settings', 'task_notification_deliveries', 'directory_integrations',
  ]) {
    await db.query(`DELETE FROM ${table} WHERE left(org_id, length($1)) = $1`, [prefix])
  }
  if (users.length > 0) {
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [users])
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [users])
  }
  if (roles.length > 0) {
    await db.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roles])
    await db.query('DELETE FROM roles WHERE id = ANY($1::text[])', [roles])
  }
}

/**
 * Holds `orgId`'s structure lock on a connection of its own and starts `start()`, a request that
 * must queue on that lock (or several: `start` may return `Promise.all` of them, and `waiters` says
 * how many must be queued). Once this database shows that many ungranted advisory locks (locks of
 * other databases on the same server are not counted), runs `beforeCommit` on the holder (a write
 * that commits while the request waits), reads `clock_timestamp()` on the holder, commits, and
 * returns the request's result with that reading as text (microseconds kept). A write of the
 * request that is stamped after the lock is held is later than `holderAt`; one stamped at its
 * transaction start is earlier.
 */
export async function whileStructureLockHeld<T>(
  orgId: string,
  start: () => Promise<T>,
  beforeCommit?: (holder: pg.Client) => Promise<void>,
  waiters = 1,
): Promise<{ result: T; holderAt: string }> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let committed = false
  try {
    await holder.query('BEGIN')
    await acquireTaskStructureLock((sql, params) => holder.query(sql, params), orgId)
    const pending = start()
    pending.catch(() => undefined)
    const deadline = Date.now() + 15000
    for (;;) {
      const waiting = await holder.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
      if (waiting.rows[0].n >= waiters) break
      if (Date.now() > deadline) throw new Error(`fewer than ${waiters} request(s) queued on the structure lock`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (beforeCommit) await beforeCommit(holder)
    const holderAt = String((await holder.query('SELECT clock_timestamp()::text AS at')).rows[0].at)
    await holder.query('COMMIT')
    committed = true
    return { result: await pending, holderAt }
  } finally {
    if (!committed) await holder.query('ROLLBACK').catch(() => undefined)
    await holder.end()
  }
}

/**
 * Asserts `file` contains `needle` (exactly once when `unique` is set), backs it up, writes the
 * mutant, runs `script` (an .mts body) under tsx with `env`, then restores the file and asserts
 * it is byte-identical to the original. Rethrows the child's failure after restoring.
 * `all` rewrites every occurrence instead of the first; `count` asserts how many there are.
 */
export function runSourceMutant(
  file: string,
  needle: string,
  replacement: string,
  script: string,
  env: Record<string, string> = {},
  opts: { unique?: boolean; timeoutMs?: number; all?: boolean; count?: number } = {},
): void {
  const original = readFileSync(file)
  const text = original.toString('utf8')
  const occurrences = text.split(needle).length - 1
  if (occurrences < 1) throw new Error(`runSourceMutant: needle not found in ${file}`)
  if (opts.unique && occurrences !== 1) {
    throw new Error(`runSourceMutant: needle occurs ${occurrences} times in ${file}`)
  }
  if (opts.count !== undefined && occurrences !== opts.count) {
    throw new Error(`runSourceMutant: needle occurs ${occurrences} times in ${file}, expected ${opts.count}`)
  }
  const backup = join(tmpdir(), `task-m4-mutant-${randomUUID()}.bak`)
  const probe = join(tmpdir(), `task-m4-probe-${randomUUID()}.mts`)
  copyFileSync(file, backup)
  let failed: unknown
  try {
    writeFileSync(file, opts.all ? text.split(needle).join(replacement) : text.replace(needle, replacement))
    writeFileSync(probe, script)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    const at = file.lastIndexOf('/src/')
    execFileSync(process.execPath, [tsx, probe], {
      cwd: at >= 0 ? file.slice(0, at) : process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'inherit',
      timeout: opts.timeoutMs ?? 120000,
    })
  } catch (err) {
    failed = err
  } finally {
    copyFileSync(backup, file)
    for (const path of [probe, backup]) {
      try { unlinkSync(path) } catch { /* already removed */ }
    }
  }
  if (!readFileSync(file).equals(original)) {
    throw new Error(`runSourceMutant: ${file} was not restored byte-identically`)
  }
  if (failed) throw failed
}

/**
 * M4 PR-3b: one DingTalk `directory_integrations` row in `orgId` (written explicitly; the column
 * default would put it in another org). `status` defaults to 'active'. The name and the corp id are
 * unique per call. Returns the row id. `dropTaskM4Fixtures` removes it by org prefix.
 */
export async function seedOrgDingTalkIntegration(
  orgId: string,
  opts: { status?: string; config?: Record<string, unknown> } = {},
): Promise<string> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const result = await poolManager.get().query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [orgId, `tasks-m4-${suffix}`, opts.status ?? 'active', `corp_tasks_m4_${suffix}`, JSON.stringify(opts.config ?? {})],
  )
  return result.rows[0].id
}

/**
 * M4 PR-3b S6: a DingTalk identity of `userId` in `orgId`: the integration row (`integrationId`, or
 * a new one with `integrationStatus` and `config`), an account with `externalUserId`, and the link
 * from that account to the local user (`linkStatus`, default 'linked'). Returns the three ids.
 * `dropTaskM4Fixtures` removes them with the integration row (the account and the link cascade).
 */
export async function seedDirectoryBinding(input: {
  orgId: string
  userId: string
  externalUserId: string
  integrationId?: string
  integrationStatus?: string
  config?: Record<string, unknown>
  accountActive?: boolean
  linkStatus?: string
}): Promise<{ integrationId: string; accountId: string; linkId: string }> {
  const db = poolManager.get()
  const integrationId = input.integrationId
    ?? await seedOrgDingTalkIntegration(input.orgId, { status: input.integrationStatus, config: input.config })
  const key = `tasks-m4-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, 'dingtalk', $2, $3, $3, $4)
     RETURNING id::text AS id`,
    [integrationId, input.externalUserId, key, input.accountActive ?? true],
  )
  const link = await db.query<{ id: string }>(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, $3)
     RETURNING id::text AS id`,
    [account.rows[0].id, input.userId, input.linkStatus ?? 'linked'],
  )
  return { integrationId, accountId: account.rows[0].id, linkId: link.rows[0].id }
}

export interface SeedOutboxRowInput {
  orgId: string
  sourceType: string
  sourceId: string | null
  sourceKey: string
  recipientUserId: string
  recipientRole: string
  channel: string
  status?: string
  attemptCount?: number
  payload?: Record<string, unknown>
  lastError?: string | null
  deliveredAt?: Date | null
  /** S4: `next_attempt_at`; the column default (`now()`) when absent. */
  nextAttemptAt?: Date
  /** S4: `created_at`; the column default (`now()`) when absent. */
  createdAt?: Date
  /** S4: the claim columns, for rows that are already claimed or fenced. */
  claimExpiresAt?: Date | null
  claimWorkerId?: string | null
  /** S4: the payload as raw JSON text (e.g. a JSON value that is not an object); wins over `payload`. */
  payloadJson?: string
}

/** M4 PR-3b: one outbox row written directly (status `pending` unless given). Returns its id. */
export async function seedOutboxRow(input: SeedOutboxRowInput): Promise<string> {
  const result = await poolManager.get().query<{ id: string }>(
    `INSERT INTO task_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
        status, attempt_count, payload, last_error, delivered_at,
        next_attempt_at, created_at, claim_expires_at, claim_worker_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
             COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, now()), $15, $16)
     RETURNING id::text AS id`,
    [
      input.orgId, input.sourceType, input.sourceId, input.sourceKey, input.recipientUserId, input.recipientRole,
      input.channel, input.status ?? 'pending', input.attemptCount ?? 0, input.payloadJson ?? JSON.stringify(input.payload ?? {}),
      input.lastError ?? null, input.deliveredAt ?? null,
      input.nextAttemptAt ?? null, input.createdAt ?? null, input.claimExpiresAt ?? null, input.claimWorkerId ?? null,
    ],
  )
  return result.rows[0].id
}

// ── M4 PR-3b S4: delivery worker fixtures (design task-m4-pr3b-backend-design-20261001.md §11.1) ──

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** A promise the test settles by hand. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface SteppedClock {
  /** The current instant (a fresh Date each call). */
  now: () => Date
  /** Moves the clock forward by `ms`. */
  advance: (ms: number) => void
  /** Puts the clock at `at`. */
  set: (at: Date) => void
}

/** A clock that only moves when the test (or a fake channel) moves it. */
export function steppedClock(start: Date): SteppedClock {
  let at = start.getTime()
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms
    },
    set: (next: Date) => {
      at = next.getTime()
    },
  }
}

/** One recorded channel call. `atMs` is the channel clock's reading when the call began. */
export interface FakeDeliveryCall {
  phase: 'prepare' | 'send'
  label: string
  deliveryId: string
  orgId: string
  recipientUserId: string
  title?: string
  content?: string
  atMs: number
}

export interface FakeTaskDeliveryChannelOptions {
  /** Which worker this fake serves (one fake per worker). */
  label: string
  /** Shared record of every call; a fresh array when absent. */
  calls?: FakeDeliveryCall[]
  /** Clock read for `atMs` and moved by `advanceMsPerSend`. */
  clock?: SteppedClock
  /** Each send moves the clock this far before it answers (a slow but successful send). */
  advanceMsPerSend?: number
  /** Answer of the n-th prepare of this fake: `null` (or nothing) = ready to send; a result = the row ends before the fence. */
  onPrepare?: (target: TaskDeliveryPrepareTarget, index: number) => Promise<TaskDeliveryChannelResult | null | void> | TaskDeliveryChannelResult | null | void
  /** Answer of the n-th send of this fake; `{ ok: true }` when absent. May throw. */
  onSend?: (call: FakeDeliveryCall, index: number) => Promise<TaskDeliveryChannelResult> | TaskDeliveryChannelResult
}

/** A programmable delivery channel under the task channel name, with a spy (design §11.1). */
export class FakeTaskDeliveryChannel implements TaskDeliveryChannel {
  readonly name = TASK_NOTIFICATION_CHANNEL_DINGTALK
  readonly calls: FakeDeliveryCall[]
  private prepares = 0
  private sends = 0

  constructor(private readonly options: FakeTaskDeliveryChannelOptions) {
    this.calls = options.calls ?? []
  }

  private at(): number {
    return this.options.clock ? this.options.clock.now().getTime() : Date.now()
  }

  async prepare(target: TaskDeliveryPrepareTarget): Promise<TaskDeliveryPrepared> {
    const index = this.prepares++
    this.calls.push({ phase: 'prepare', label: this.options.label, ...target, atMs: this.at() })
    const answer = this.options.onPrepare ? await this.options.onPrepare(target, index) : null
    if (answer) return { ok: false, result: answer }
    return {
      ok: true,
      send: async (message: TaskDeliveryMessage) => {
        const sendIndex = this.sends++
        const call: FakeDeliveryCall = {
          phase: 'send', label: this.options.label, ...target, title: message.title, content: message.content, atMs: this.at(),
        }
        this.calls.push(call)
        if (this.options.clock && this.options.advanceMsPerSend) this.options.clock.advance(this.options.advanceMsPerSend)
        return this.options.onSend ? await this.options.onSend(call, sendIndex) : { ok: true }
      },
    }
  }

  /** Delivery ids this fake sent, in call order. */
  sentIds(): string[] {
    return this.calls.filter((call) => call.phase === 'send' && call.label === this.options.label).map((call) => call.deliveryId)
  }

  /** Delivery ids this fake prepared, in call order. */
  preparedIds(): string[] {
    return this.calls.filter((call) => call.phase === 'prepare' && call.label === this.options.label).map((call) => call.deliveryId)
  }
}
