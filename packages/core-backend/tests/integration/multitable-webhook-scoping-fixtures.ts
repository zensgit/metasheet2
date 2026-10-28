/**
 * Shared real-DB fixtures for the subscription webhook delivery-rule suites. Synthetic data only; every id
 * carries a per-run suffix and every webhook URL is unique to the run, so assertions only count this run's
 * own rows and requests. Outbound HTTP is a loopback stub; nothing leaves the process.
 */
import { vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { poolManager } from '../../src/integration/db/connection-pool'

export const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

export const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
export const id = (label: string) => `wsf_${label}_${RUN}`

export interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Loopback fetch that records every request and answers with the given status. */
export function createSink(status = 200) {
  const requests: CapturedRequest[] = []
  const state = { status }
  const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    requests.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body: init?.body ?? '' })
    return {
      ok: state.status >= 200 && state.status < 300,
      status: state.status,
      text: async () => (state.status >= 200 && state.status < 300 ? 'ok' : 'unavailable'),
    } as Response
  }) as unknown as typeof fetch
  return {
    fetchFn,
    requests,
    to: (url: string) => requests.filter((r) => r.url === url),
    setStatus: (next: number) => {
      state.status = next
    },
  }
}

/** Collects the enum reasons the delivery rules log on refusal (info level; independent of LOG_LEVEL). */
export function captureRefusals() {
  const spy = vi.spyOn(Logger.prototype, 'info')
  const prefix = 'webhook delivery refused: reason='
  return {
    reasons: () =>
      spy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length)),
    clear: () => spy.mockClear(),
  }
}

/**
 * Remove every row this file's fixtures created (ids start with `wsf_` and end with this run's suffix), so
 * a database shared with other suites is left as it was. Throws when a fixture row is still present
 * afterwards, so a cleanup gap is visible instead of silent.
 */
export async function cleanupFixtureRows(): Promise<void> {
  const mine = (col: string) => `(left(${col}, 4) = 'wsf_' AND right(${col}, ${RUN.length}) = '${RUN}')`
  const run = async (sql: string) => {
    await q(sql).catch(() => undefined)
  }
  await run(`DELETE FROM multitable_webhook_deliveries WHERE ${mine('webhook_id')}`)
  await run(`DELETE FROM multitable_webhooks WHERE ${mine('id')}`)
  // Projection sheets created from a fixture org carry derived ids; remove them through the mapping.
  const projections = ((await q(`SELECT sheet_id, base_id FROM elearning_stats_multitable_sheets WHERE ${mine('org_id')}`).catch(() => ({ rows: [] }))).rows ?? []) as Array<{ sheet_id: string; base_id: string }>
  await run(`DELETE FROM elearning_stats_multitable_sheets WHERE ${mine('org_id')}`)
  for (const { sheet_id: sheetId, base_id: baseId } of projections) {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => undefined)
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => undefined)
    await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => undefined)
    await q('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => undefined)
  }
  await run(`DELETE FROM meta_links WHERE ${mine('id')}`)
  await run(`DELETE FROM formula_dependencies WHERE ${mine('sheet_id')}`)
  await run(`DELETE FROM field_permissions WHERE ${mine('sheet_id')} OR ${mine('subject_id')}`)
  await run(`DELETE FROM record_permissions WHERE ${mine('sheet_id')}`)
  await run(`DELETE FROM spreadsheet_permissions WHERE ${mine('sheet_id')}`)
  await run(`DELETE FROM meta_records WHERE ${mine('sheet_id')}`)
  await run(`DELETE FROM meta_fields WHERE ${mine('sheet_id')}`)
  await run(`DELETE FROM meta_sheets WHERE ${mine('id')}`)
  await run(`DELETE FROM meta_bases WHERE ${mine('id')}`)
  await run(`DELETE FROM user_roles WHERE ${mine('user_id')}`)
  await run(`DELETE FROM user_permissions WHERE ${mine('user_id')}`)
  await run(`DELETE FROM users WHERE ${mine('id')}`)
  if (createdAdminRole) {
    await run(`DELETE FROM roles WHERE id = 'admin' AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role_id = 'admin')`)
  }
  const leftovers: string[] = []
  for (const [table, col] of [
    ['multitable_webhook_deliveries', 'webhook_id'],
    ['multitable_webhooks', 'id'],
    ['meta_records', 'sheet_id'],
    ['meta_fields', 'sheet_id'],
    ['meta_sheets', 'id'],
    ['meta_bases', 'id'],
    ['field_permissions', 'sheet_id'],
    ['record_permissions', 'sheet_id'],
    ['spreadsheet_permissions', 'sheet_id'],
    ['user_roles', 'user_id'],
    ['user_permissions', 'user_id'],
    ['users', 'id'],
  ] as const) {
    const r = await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${mine(col)}`)
    const n = (r.rows[0] as { n: number }).n
    if (n > 0) leftovers.push(`${table}=${n}`)
  }
  if (leftovers.length > 0) throw new Error(`fixture rows left behind: ${leftovers.join(', ')}`)
}

export async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Wait until `count()` reaches `atLeast` (or the timeout), then settle so a stray extra would also land. */
export async function waitFor(count: () => number, atLeast: number, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (count() < atLeast && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  await settle(150)
  return count()
}

export type OwnerOptions = {
  permissions?: string[]
  role?: string
  isActive?: boolean
  activationStatus?: 'activated' | 'pending_activation'
  mustChangePassword?: boolean
  adminRoleRow?: boolean
}

export const DEFAULT_OWNER_PERMISSIONS = ['multitable:read', 'workflow:write']

/**
 * Codes present in the `permissions` catalogue go to `user_permissions`; codes the catalogue does not list
 * (the `workflow:*` family) go to the legacy `users.permissions` list, which the database-fresh access
 * loader also reads.
 */
/** Set when this file created the `admin` role row itself (cleanup removes it again only then). */
let createdAdminRole = false

export async function createOwner(userId: string, options: OwnerOptions = {}): Promise<void> {
  const codes = options.permissions ?? DEFAULT_OWNER_PERMISSIONS
  const catalogue = new Set(
    ((await q('SELECT code FROM permissions WHERE code = ANY($1::text[])', [codes])).rows as Array<{ code: string }>).map((r) => r.code),
  )
  const legacy = codes.filter((code) => !catalogue.has(code))
  await q(
    `INSERT INTO users (id, name, password_hash, role, is_active, activation_status, must_change_password, permissions)
     VALUES ($1, $1, 'x', $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      userId,
      options.role ?? 'user',
      options.isActive ?? true,
      options.activationStatus ?? 'activated',
      options.mustChangePassword ?? false,
      JSON.stringify(legacy),
    ],
  )
  for (const code of codes.filter((c) => catalogue.has(c))) {
    await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, code])
  }
  if (options.adminRoleRow) {
    const inserted = await q(`INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT DO NOTHING RETURNING id`).catch(() => ({ rows: [] }))
    if ((inserted.rows ?? []).length > 0) createdAdminRole = true
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [userId])
  }
}

export async function revokePermission(userId: string, code: string): Promise<void> {
  await q('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = $2', [userId, code])
  await q(
    `UPDATE users SET permissions = COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements_text(permissions) p WHERE p <> $2), '[]'::jsonb)
      WHERE id = $1`,
    [userId, code],
  )
}

export async function createBase(baseId: string): Promise<void> {
  await q('INSERT INTO meta_bases (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [baseId])
}

export async function createSheet(
  sheetId: string,
  baseId: string,
  options: { rowLevelDeny?: boolean; description?: string | null; systemKind?: string | null } = {},
): Promise<void> {
  await q(
    `INSERT INTO meta_sheets (id, base_id, name, description, row_level_read_permissions_enabled, system_kind)
     VALUES ($1, $2, $1, $3, $4, $5)`,
    [sheetId, baseId, options.description ?? null, options.rowLevelDeny ?? false, options.systemKind ?? null],
  )
}

export async function createField(
  fieldId: string,
  sheetId: string,
  type: string,
  property: Record<string, unknown> = {},
  order = 1,
): Promise<void> {
  await q(
    'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1, $2, $1, $3, $4::jsonb, $5)',
    [fieldId, sheetId, type, JSON.stringify(property), order],
  )
}

export async function createRecord(recordId: string, sheetId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [
    recordId,
    sheetId,
    JSON.stringify(data),
  ])
}

export async function insertWebhook(
  webhookId: string,
  ownerId: string,
  sheetId: string | null,
  url: string,
  options: { events?: string[]; secret?: string | null; maxRetries?: number; failureCount?: number; active?: boolean } = {},
): Promise<void> {
  await q(
    `INSERT INTO multitable_webhooks
       (id, name, url, secret, events, active, created_by, created_at, failure_count, max_retries, sheet_id)
     VALUES ($1, $1, $2, $3, $4::jsonb, $5, $6, now(), $7, $8, $9)`,
    [
      webhookId,
      url,
      options.secret ?? null,
      JSON.stringify(options.events ?? ['record.created', 'record.updated', 'record.deleted']),
      options.active ?? true,
      ownerId,
      options.failureCount ?? 0,
      options.maxRetries ?? 3,
      sheetId,
    ],
  )
}

/** A due, never-sent pending row (status pending, next_retry_at in the past, attempt_count 0). */
export async function insertDuePending(
  deliveryId: string,
  webhookId: string,
  event: string,
  payload: Record<string, unknown>,
  eventId: string | null,
): Promise<void> {
  await q(
    `INSERT INTO multitable_webhook_deliveries
       (id, webhook_id, event, payload, status, attempt_count, created_at, next_retry_at, event_id)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, now(), now() - interval '1 minute', $5)`,
    [deliveryId, webhookId, event, JSON.stringify(payload), eventId],
  )
}

export async function deliveryRows(webhookId: string): Promise<Array<Record<string, any>>> {
  const r = await q('SELECT * FROM multitable_webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at, id', [webhookId])
  return r.rows as Array<Record<string, any>>
}

export async function deliveryRow(deliveryId: string): Promise<Record<string, any> | undefined> {
  const r = await q('SELECT * FROM multitable_webhook_deliveries WHERE id = $1', [deliveryId])
  return r.rows[0] as Record<string, any> | undefined
}

export async function webhookRow(webhookId: string): Promise<Record<string, any> | undefined> {
  const r = await q('SELECT * FROM multitable_webhooks WHERE id = $1', [webhookId])
  return r.rows[0] as Record<string, any> | undefined
}

export function parseBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>
}

/** Paths a delivery-type case runs on: legacy (no event id) and durable (with an event id). */
export const ENTRY_PATHS = ['L', 'D'] as const
export type EntryPath = (typeof ENTRY_PATHS)[number]
export const eventIdFor = (path: EntryPath, label: string) => (path === 'D' ? id(`evt_${label}`) : undefined)

/** Shapes a directly inserted pending row takes: legacy (event_id NULL) and durable (event_id set). */
export const TICK_SHAPES = ['tick:null', 'tick:evt'] as const
export type TickShape = (typeof TICK_SHAPES)[number]
export const pendingEventIdFor = (shape: TickShape, label: string) => (shape === 'tick:evt' ? id(`pevt_${label}`) : null)
