/**
 * A TABLE-AWARE in-memory Postgres double for the field retype CONVERT execute / undo path
 * (ADR docs/development/multitable-field-retype-first-batch-adr-20260926.md §3 + addendum B).
 *
 * Why it exists: the unit lane has no database, and the guarantees of this path — every refusal before the first
 * write, pre-image before rewrite, all-or-nothing, the locked order of the undo, authority re-read from the database
 * under the fence — are only provable by RUNNING the transaction. The real-DB cases
 * (tests/integration/multitable-field-retype-convert-realdb.cases.ts) execute in CI only; this double lets the unit
 * lane run the SAME product code and lets the removal of any guard turn a test red.
 *
 * What it is NOT: a SQL engine. Each statement the product issues is matched by SHAPE (substring on the
 * whitespace-normalised text) and evaluated against plain row arrays.
 *   - Inside a transaction an unrecognised statement THROWS (`Unhandled SQL in fake`), so a new statement in the
 *     product cannot pass by accident.
 *   - On the pool an unrecognised statement answers zero rows: those are probes of modules this double does not
 *     model, and "no grant, no mask, no rule" is the plain world.
 * A predicate is evaluated only where the product's SQL writes it: the double never adds a filter the statement did
 * not ask for. A row read REQUIRES the sheet filter in the text AND the sheet id in `params[0]`; without both it
 * answers nothing, so a statement that lost its `WHERE sheet_id = $1` cannot be fed another sheet's rows.
 *
 * jsonb semantics are Postgres's, not JavaScript's: `data ? k` is "a top-level key of an object, an element of an
 * array, or the string scalar itself"; `data -> k` is NULL unless `data` is an object that has the key; `jsonb_set`
 * on anything but an object raises.
 *
 * Two authorities, kept apart on purpose: the permissions a REQUEST carries (the test's `req.user.perms`) and the
 * permissions the DATABASE holds (`dbUsers`). A test revokes in the database and keeps the token.
 *
 * Transactions: `transaction(handler)` snapshots every table, runs the handler, and RESTORES the snapshot when the
 * handler throws — a rollback exactly as strong as the assertion that uses it.
 */

export type FakeRow = Record<string, unknown>
export interface FakeStatement { sql: string; params: unknown[]; inTransaction: boolean }

export interface FakeSheet {
  id: string
  base_id: string
  deleted_at: string | null
  row_level_read_permissions_enabled: boolean
  system_kind: string | null
  description: string | null
  recovery_writer_state: string | null
}
export interface FakeField { id: string; sheet_id: string; name: string; type: string; property: unknown; order: number }
/** `data` is ANY json value: a row whose data is an array or a scalar is a case the product must refuse. */
export interface FakeRecord { id: string; sheet_id: string; version: number; data: unknown }
export interface FakeTrash { record_id: string; sheet_id: string; data: unknown }
export interface FakeTombstone { sheet_id: string; field_id: string; record_id: string; value: unknown; reason: string; config_revision_id: string; operation_id: null }
export interface FakeConversion {
  convert_revision_id: string
  sheet_id: string
  field_id: string
  source_type: string
  source_property: unknown
  target_type: string
  target_property: unknown
  record_count: number
  actor_id: string | null
  undone_at: string | null
  undo_revision_id: string | null
}
/** What the DATABASE says about a user — independent of whatever the request's token claims. */
export interface FakeDbUser { role: string; is_active: boolean; permissions: string[]; roleIds: string[] }
export interface FakeFieldPermission { sheet_id: string; field_id: string; subject_type: 'user' | 'role' | 'member-group'; subject_id: string; visible: boolean; read_only: boolean }

export interface FakeWorld {
  sheets: FakeSheet[]
  fields: FakeField[]
  records: FakeRecord[]
  trash: FakeTrash[]
  tombstones: FakeTombstone[]
  conversions: FakeConversion[]
  recordRevisions: FakeRow[]
  configRevisions: FakeRow[]
  audit: FakeRow[]
  operations: FakeRow[]
  /** managed-sheet union inputs, keyed by sheet id */
  pluginRegistry: Set<string>
  pipelineStaging: Set<string>
  approvalProjection: Set<string>
  /** the conversions table exists (migration applied) */
  conversionsTable: boolean
  /** database-side authority, keyed by user id; a user absent here does not exist in the database */
  dbUsers: Record<string, FakeDbUser>
  fieldPermissions: FakeFieldPermission[]
}

export interface FakePgOptions {
  /** Run before every statement; may mutate the world (a concurrent writer) or throw (an injected failure). */
  beforeStatement?: (statement: FakeStatement, world: FakeWorld) => void
  /** Let unrecognised statements inside a transaction answer zero rows instead of throwing. */
  permissiveTransaction?: boolean
}

export function emptyWorld(): FakeWorld {
  return {
    sheets: [], fields: [], records: [], trash: [], tombstones: [], conversions: [],
    recordRevisions: [], configRevisions: [], audit: [], operations: [],
    pluginRegistry: new Set(), pipelineStaging: new Set(), approvalProjection: new Set(),
    conversionsTable: true,
    dbUsers: {},
    fieldPermissions: [],
  }
}

/** A database user holding `permissions` directly (user_permissions rows), active, no role. */
export function dbUser(permissions: string[], over: Partial<FakeDbUser> = {}): FakeDbUser {
  return { role: 'user', is_active: true, permissions: [...permissions], roleIds: [], ...over }
}

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim()
const hasOwn = (data: object, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key)

const isJsonObject = (data: unknown): data is Record<string, unknown> => data !== null && typeof data === 'object' && !Array.isArray(data)
/** jsonb `data ? key` */
const jsonbExists = (data: unknown, key: string): boolean =>
  isJsonObject(data) ? hasOwn(data, key) : Array.isArray(data) ? data.includes(key) : data === key
/** jsonb `data -> key` with a text key; `undefined` stands for SQL NULL */
const jsonbGet = (data: unknown, key: string): unknown => (isJsonObject(data) && hasOwn(data, key) ? data[key] : undefined)

/** jsonb `=`: key order irrelevant, arrays ordered, scalars by value. */
export function jsonbEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => jsonbEquals(item, b[i]))
  }
  const ka = Object.keys(a as object).sort()
  const kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => jsonbEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function jsonbTypeof(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function clone<T>(value: T): T {
  if (value instanceof Set) return new Set(value) as unknown as T
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshotWorld(world: FakeWorld): FakeWorld {
  return {
    sheets: clone(world.sheets), fields: clone(world.fields), records: clone(world.records), trash: clone(world.trash),
    tombstones: clone(world.tombstones), conversions: clone(world.conversions), recordRevisions: clone(world.recordRevisions),
    configRevisions: clone(world.configRevisions), audit: clone(world.audit), operations: clone(world.operations),
    pluginRegistry: clone(world.pluginRegistry), pipelineStaging: clone(world.pipelineStaging), approvalProjection: clone(world.approvalProjection),
    conversionsTable: world.conversionsTable,
    dbUsers: clone(world.dbUsers),
    fieldPermissions: clone(world.fieldPermissions),
  }
}

/**
 * Tables the capability resolvers probe and this double does not model: they are EMPTY here (no sheet grant, no view
 * or record permission, no formula dependency, no member group), in a transaction as on the pool.
 */
const EMPTY_AUTHORITY_TABLES = [
  'spreadsheet_permissions', 'view_permissions', 'meta_view_permissions', 'record_permissions',
  'formula_dependencies', 'platform_member_group_members', 'meta_views',
]

const CELL_COLUMNS = "(jsonb_typeof(data) = 'object') AS is_object, (data ? $2::text) AS has_key, data -> $2::text AS cell"

export class FieldRetypeConvertFakePg {
  world: FakeWorld
  /** every statement, in order */
  readonly statements: FakeStatement[] = []
  /** advisory-lock keys taken */
  readonly fences: string[] = []
  transactions = 0
  committed = 0
  rolledBack = 0
  private seq = 1000
  private depth = 0

  constructor(world: FakeWorld, private readonly options: FakePgOptions = {}) {
    this.world = world
  }

  /** the pool's `query` */
  query = async (sql: string, params: unknown[] = []): Promise<{ rows: FakeRow[]; rowCount: number }> => this.run(sql, params)

  /** the pool's `transaction` */
  transaction = async <T>(handler: (client: { query: FieldRetypeConvertFakePg['query'] }) => Promise<T>): Promise<T> => {
    const before = snapshotWorld(this.world)
    this.transactions += 1
    this.depth += 1
    try {
      const out = await handler({ query: this.query })
      this.committed += 1
      return out
    } catch (err) {
      this.world = before
      this.rolledBack += 1
      throw err
    } finally {
      this.depth -= 1
    }
  }

  /** statements issued inside a transaction */
  get transactionStatements(): string[] {
    return this.statements.filter((s) => s.inTransaction).map((s) => normalize(s.sql))
  }

  private async run(sql: string, params: unknown[]): Promise<{ rows: FakeRow[]; rowCount: number }> {
    const inTransaction = this.depth > 0
    const statement: FakeStatement = { sql, params, inTransaction }
    this.options.beforeStatement?.(statement, this.world)
    this.statements.push(statement)
    const rows = this.evaluate(normalize(sql), params, inTransaction)
    return { rows, rowCount: rows.length }
  }

  private cellRow(data: unknown, key: string): FakeRow {
    const value = jsonbGet(data, key)
    return { is_object: isJsonObject(data), has_key: jsonbExists(data, key), cell: value === undefined ? null : clone(value) }
  }

  private evaluate(sql: string, p: unknown[], inTransaction: boolean): FakeRow[] {
    const w = this.world

    // ── fence / ledger probes ──────────────────────────────────────────────────────────────────────────
    if (sql.includes('pg_advisory_xact_lock')) {
      this.fences.push(String(p[0]))
      return [{}]
    }
    if (sql.includes('information_schema.columns')) return [{ '?column?': 1 }]
    if (sql.startsWith('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1')) {
      return w.sheets.filter((s) => s.id === p[0]).map((s) => ({ recovery_writer_state: s.recovery_writer_state }))
    }
    if (sql.includes("to_regclass('meta_field_retype_conversions')")) return [{ present: w.conversionsTable }]

    // ── database-side authority (recovery-authorization-stability.ts loadDatabaseFreshRecoveryAccess) ────
    if (sql.startsWith('SELECT role, permissions, COALESCE(is_active, TRUE) AS is_active') && sql.includes('FROM users WHERE id = $1')) {
      const user = w.dbUsers[String(p[0])]
      if (!user) return []
      return [{ role: user.role, permissions: [], is_active: user.is_active, rbac_admin: user.roleIds.includes('admin') }]
    }
    if (sql.startsWith('SELECT DISTINCT permission_code AS code FROM') && sql.includes('FROM user_permissions WHERE user_id = $1')) {
      const user = w.dbUsers[String(p[0])]
      return user ? [...new Set(user.permissions)].map((code) => ({ code })) : []
    }
    if (sql.includes('FROM field_permissions fp') && sql.includes('WHERE fp.sheet_id = $2')) {
      const user = w.dbUsers[String(p[0])]
      return w.fieldPermissions
        .filter((fp) => fp.sheet_id === p[1])
        .filter((fp) => (fp.subject_type === 'user' && fp.subject_id === p[0]) || (fp.subject_type === 'role' && (user?.roleIds ?? []).includes(fp.subject_id)))
        .map((fp) => ({ field_id: fp.field_id, visible: fp.visible, read_only: fp.read_only }))
    }
    for (const table of EMPTY_AUTHORITY_TABLES) {
      if (new RegExp(`\\bFROM ${table}\\b`).test(sql)) return []
    }
    if (/\bFROM user_roles\b/.test(sql)) {
      const user = w.dbUsers[String(p[0])]
      return (user?.roleIds ?? []).map((role_id) => ({ role_id }))
    }

    // ── managed-sheet union ────────────────────────────────────────────────────────────────────────────
    if (sql.includes('FROM plugin_multitable_object_registry')) return w.pluginRegistry.has(String(p[0])) ? [{ '?column?': 1 }] : []
    if (sql.includes('FROM integration_pipelines')) return w.pipelineStaging.has(String(p[0])) ? [{ '?column?': 1 }] : []
    if (sql.includes('FROM approval_record_projection')) return w.approvalProjection.has(String(p[0])) ? [{ '?column?': 1 }] : []

    // ── conversions (job rows) ─────────────────────────────────────────────────────────────────────────
    if (sql.startsWith('SELECT 1 FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid OR undo_revision_id = $1::uuid')) {
      if (!w.conversionsTable) throw Object.assign(new Error('relation "meta_field_retype_conversions" does not exist'), { code: '42P01' })
      return w.conversions.filter((c) => c.convert_revision_id === p[0] || c.undo_revision_id === p[0]).slice(0, 1).map(() => ({ '?column?': 1 }))
    }
    if (sql.includes('FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid AND field_id = $2 AND sheet_id = $3 FOR UPDATE')) {
      return w.conversions
        .filter((c) => c.convert_revision_id === p[0] && c.field_id === p[1] && c.sheet_id === p[2])
        .map((c) => ({ ...c }))
    }
    if (sql.startsWith('INSERT INTO meta_field_retype_conversions')) {
      w.conversions.push({
        convert_revision_id: String(p[0]), sheet_id: String(p[1]), field_id: String(p[2]), source_type: String(p[3]),
        source_property: JSON.parse(String(p[4])), target_type: String(p[5]), target_property: JSON.parse(String(p[6])),
        record_count: Number(p[7]), actor_id: (p[8] as string | null) ?? null, undone_at: null, undo_revision_id: null,
      })
      return []
    }
    if (sql.startsWith('UPDATE meta_field_retype_conversions SET undone_at = now(), undo_revision_id = $2::uuid WHERE convert_revision_id = $1::uuid AND undone_at IS NULL')) {
      const hit = w.conversions.filter((c) => c.convert_revision_id === p[0] && c.undone_at === null)
      for (const c of hit) {
        c.undone_at = '2026-09-28T00:00:00.000Z'
        c.undo_revision_id = String(p[1])
      }
      return hit.map((c) => ({ convert_revision_id: c.convert_revision_id }))
    }

    // ── pre-images ─────────────────────────────────────────────────────────────────────────────────────
    if (sql.startsWith('INSERT INTO meta_field_value_tombstones') && sql.includes("'retype_convert'") && sql.includes('jsonb_to_recordset($4::jsonb)')) {
      const payload = JSON.parse(String(p[3])) as Array<{ record_id: string; value: unknown }>
      for (const item of payload) {
        w.tombstones.push({ sheet_id: String(p[0]), field_id: String(p[1]), record_id: item.record_id, value: item.value, reason: 'retype_convert', config_revision_id: String(p[2]), operation_id: null })
      }
      return payload.map((item) => ({ record_id: item.record_id }))
    }
    if (sql.startsWith("SELECT record_id, value FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid AND reason = 'retype_convert' AND field_id = $2 AND sheet_id = $3 FOR UPDATE")) {
      return this.preImages(p[0], p[1], p[2]).map((t) => ({ record_id: t.record_id, value: clone(t.value) }))
    }

    // ── fields ─────────────────────────────────────────────────────────────────────────────────────────
    if (sql.startsWith('SELECT id, sheet_id, type, property FROM meta_fields WHERE id = $1')) {
      return w.fields.filter((f) => f.id === p[0]).map((f) => ({ id: f.id, sheet_id: f.sheet_id, type: f.type, property: clone(f.property) }))
    }
    // config-restore's 4c-1 lossy branch locates its field with this shape (with and without FOR UPDATE)
    if (sql.startsWith('SELECT id, sheet_id, type FROM meta_fields WHERE id = $1')) {
      return w.fields.filter((f) => f.id === p[0]).map((f) => ({ id: f.id, sheet_id: f.sheet_id, type: f.type }))
    }
    if (sql.startsWith('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1 FOR UPDATE')) {
      return w.fields.filter((f) => f.id === p[0]).map((f) => clone(f) as unknown as FakeRow)
    }
    if (sql.startsWith('SELECT id, sheet_id, type, property, (type = $2 AND property = $3::jsonb) AS matches_target FROM meta_fields WHERE id = $1 FOR UPDATE')) {
      return w.fields.filter((f) => f.id === p[0]).map((f) => ({
        id: f.id, sheet_id: f.sheet_id, type: f.type, property: clone(f.property),
        matches_target: f.type === p[1] && jsonbEquals(f.property, JSON.parse(String(p[2]))),
      }))
    }
    if (sql.startsWith('UPDATE meta_fields SET type = $2, property = $3::jsonb, updated_at = now() WHERE id = $1 AND sheet_id = $4 RETURNING id')) {
      const hit = w.fields.filter((f) => f.id === p[0] && f.sheet_id === p[3])
      for (const f of hit) {
        f.type = String(p[1])
        f.property = JSON.parse(String(p[2]))
      }
      return hit.map((f) => ({ id: f.id }))
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return w.fields.filter((f) => f.sheet_id === p[0]).map((f) => clone(f) as unknown as FakeRow)
    }

    // ── sheets ─────────────────────────────────────────────────────────────────────────────────────────
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return w.sheets.filter((s) => s.id === p[0]).map((s) => ({
        id: s.id, name: 'Sheet', base_id: s.base_id, description: s.description, deleted_at: s.deleted_at,
        enabled: s.row_level_read_permissions_enabled, row_level_read_permissions_enabled: s.row_level_read_permissions_enabled,
        system_kind: s.system_kind,
      }))
    }
    if (sql.includes('FROM meta_sheets WHERE id = ANY($1::text[])')) {
      const ids = Array.isArray(p[0]) ? p[0].map(String) : []
      return w.sheets
        .filter((s) => ids.includes(s.id))
        .filter((s) => (sql.includes('AND base_id = $2') ? s.base_id === p[1] : true))
        .map((s) => ({ id: s.id, deleted_at: s.deleted_at, base_id: s.base_id }))
    }

    // ── recycle bin — every shape REQUIRES the sheet filter and the sheet id in params[0] ────────────────
    if (sql.includes('FROM meta_records_trash')) {
      if (!sql.includes('FROM meta_records_trash WHERE sheet_id = $1') || typeof p[0] !== 'string') return this.unhandled(sql, inTransaction)
      const rows = w.trash.filter((t) => t.sheet_id === p[0])
      if (sql.startsWith('SELECT count(*)::int AS c FROM meta_records_trash WHERE sheet_id = $1')) return [{ c: rows.length }]
      const key = String(p[1])
      if (sql.includes('AS blocking')) {
        return rows.map((t) => {
          const value = jsonbGet(t.data, key)
          // `data -> key` NULL makes the whole conjunction NULL, which the product reads as "not blocking"
          const blocking = jsonbExists(t.data, key) && value !== undefined && !['string', 'null'].includes(jsonbTypeof(value)) && !jsonbEquals(value, [])
          return { record_id: t.record_id, blocking }
        })
      }
      if (sql.startsWith(`SELECT record_id, ${CELL_COLUMNS} FROM meta_records_trash WHERE sheet_id = $1`)) {
        return rows.map((t) => ({ record_id: t.record_id, ...this.cellRow(t.data, key) }))
      }
      return this.unhandled(sql, inTransaction)
    }

    // ── records ────────────────────────────────────────────────────────────────────────────────────────
    if (sql.startsWith('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1')) {
      return [{ c: w.records.filter((r) => r.sheet_id === p[0]).length }]
    }
    if (sql.startsWith(`SELECT id, version, data, ${CELL_COLUMNS} FROM meta_records WHERE sheet_id = $1 FOR UPDATE`)) {
      const key = String(p[1])
      return w.records.filter((r) => r.sheet_id === p[0]).map((r) => ({ id: r.id, version: r.version, data: clone(r.data), ...this.cellRow(r.data, key) }))
    }
    if (sql.startsWith(`SELECT id, version, ${CELL_COLUMNS} FROM meta_records WHERE sheet_id = $1`)) {
      const key = String(p[1])
      return w.records.filter((r) => r.sheet_id === p[0]).map((r) => ({ id: r.id, version: r.version, ...this.cellRow(r.data, key) }))
    }
    if (sql.startsWith('UPDATE meta_records AS m SET data = jsonb_set(m.data, ARRAY[$2::text], item.post, true)') && sql.includes('jsonb_to_recordset($3::jsonb) AS item(record_id text, post jsonb)')) {
      const key = String(p[1])
      const guarded = sql.includes('AND (m.data -> $2::text) IS DISTINCT FROM item.post')
      const payload = JSON.parse(String(p[2])) as Array<{ record_id: string; post: unknown }>
      const out: FakeRow[] = []
      for (const item of payload) {
        const record = w.records.find((r) => r.sheet_id === p[0] && r.id === item.record_id)
        if (!record) continue
        const current = jsonbGet(record.data, key)
        if (guarded && current !== undefined && jsonbEquals(current, item.post)) continue
        if (!isJsonObject(record.data)) throw Object.assign(new Error('cannot set path in scalar'), { code: '22023' })
        record.data = { ...record.data, [key]: clone(item.post) }
        record.version += 1
        out.push({ id: record.id, version: record.version, data: clone(record.data) })
      }
      return out
    }
    if (sql.startsWith('SELECT m.id FROM meta_records m JOIN meta_field_value_tombstones t ON t.record_id = m.id') && sql.includes("IS DISTINCT FROM (t.value -> 'post')")) {
      const key = String(p[2])
      const out: FakeRow[] = []
      for (const t of this.preImages(p[1], p[2], p[0])) {
        const record = w.records.find((r) => r.sheet_id === p[0] && r.id === t.record_id)
        if (!record) continue
        const current = jsonbGet(record.data, key)
        const post = (t.value as { post?: unknown }).post
        if (!(current !== undefined && jsonbEquals(current, post))) out.push({ id: record.id })
      }
      return out
    }
    if (sql.startsWith("UPDATE meta_records AS m SET data = CASE WHEN (t.value -> 'k') = 'true'::jsonb") && sql.includes('FROM meta_field_value_tombstones t')) {
      const key = String(p[2])
      const guarded = sql.includes("AND NOT ((t.value -> 'k') = 'true'::jsonb AND (t.value -> 'v') = (t.value -> 'post'))")
      const out: FakeRow[] = []
      for (const t of this.preImages(p[1], p[2], p[0])) {
        const envelope = t.value as { k?: unknown; v?: unknown; post?: unknown }
        const hadKey = envelope.k === true
        if (guarded && hadKey && jsonbEquals(envelope.v, envelope.post)) continue
        const record = w.records.find((r) => r.sheet_id === p[0] && r.id === t.record_id)
        if (!record) continue
        if (!isJsonObject(record.data)) throw Object.assign(new Error('cannot set path in scalar'), { code: '22023' })
        const next = { ...record.data }
        if (hadKey) next[key] = clone(envelope.v ?? null)
        else delete next[key]
        record.data = next
        record.version += 1
        out.push({ id: record.id, version: record.version, data: clone(record.data), had_key: hadKey, original: clone(envelope.v ?? null) })
      }
      return out
    }

    // ── history / audit ────────────────────────────────────────────────────────────────────────────────
    if (sql.startsWith('INSERT INTO meta_record_revisions (')) {
      const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim())
      const out: FakeRow[] = []
      for (let i = 0; i < p.length; i += columns.length) {
        const row: FakeRow = {}
        columns.forEach((column, j) => { row[column] = p[i + j] })
        for (const jsonColumn of ['patch', 'snapshot']) {
          if (typeof row[jsonColumn] === 'string') row[jsonColumn] = JSON.parse(String(row[jsonColumn]))
        }
        this.seq += 1
        row.seq = String(this.seq)
        w.recordRevisions.push(row)
        out.push({ seq: row.seq })
      }
      return sql.includes('RETURNING seq') ? out : []
    }
    if (sql.startsWith('INSERT INTO meta_config_revisions')) {
      w.configRevisions.push({
        id: p[0], sheet_id: p[1], entity_type: p[2], entity_id: p[3], action: p[4],
        before: JSON.parse(String(p[5])), after: JSON.parse(String(p[6])), changed_keys: p[7], batch_id: p[8], actor_id: p[9],
        source: p[10], restored_from_id: p[11], operation_id: null,
      })
      return []
    }
    if (sql.includes('FROM meta_config_revisions WHERE id = $1 AND sheet_id = $2')) {
      return w.configRevisions.filter((r) => r.id === p[0] && r.sheet_id === p[1]).map((r) => clone(r))
    }
    if (sql.startsWith('INSERT INTO operation_audit_logs')) {
      w.audit.push({ actor_id: p[0], action: p[1], resource_type: 'meta_field', resource_id: p[2], metadata: JSON.parse(String(p[3])) })
      return []
    }
    if (sql.startsWith('INSERT INTO meta_record_history_operations')) {
      w.operations.push({ sheet_id: p[0], operation_id: p[1], endpoint_seq: p[2], event_count: p[3] })
      return []
    }

    return this.unhandled(sql, inTransaction)
  }

  private unhandled(sql: string, inTransaction: boolean): FakeRow[] {
    if (inTransaction && !this.options.permissiveTransaction) throw new Error(`Unhandled SQL in fake: ${sql}`)
    return []
  }

  private preImages(configRevisionId: unknown, fieldId: unknown, sheetId: unknown): FakeTombstone[] {
    return this.world.tombstones.filter((t) => t.config_revision_id === configRevisionId && t.reason === 'retype_convert' && t.field_id === fieldId && t.sheet_id === sheetId)
  }
}

/**
 * Statements that write or lock. Used to assert "zero writes" and "nothing locked". The write pattern is anchored at
 * the statement start: `SELECT … FOR UPDATE` is a lock, not a write.
 */
export const FAKE_WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i
export const FAKE_LOCK_RE = /\b(FOR\s+UPDATE|FOR\s+SHARE|pg_advisory\w*|LOCK\s+TABLE)\b/i
