/**
 * A TABLE-AWARE in-memory Postgres double for the copy-sheet path (ADR #6094 S1).
 *
 * Why this exists: the copy transaction (multitable/copy-sheet-service.ts) is ~60 distinct statements deep —
 * advisory locks, dedupe ledger, row lock + liveness re-read, fences, tripwire baselines, DB-fresh capability
 * resolution, structure/permission INSERTs, `RecordService.createRecord` per row, deny-set parity, audit — and
 * its guarantees (all-or-nothing, parity, tripwire, event suppression, plugin-scope deny) are only provable by
 * RUNNING it. No local Postgres is available on the machines this branch is built on, so the real-DB lane
 * (tests/integration/multitable-copy-sheet-realdb.test.ts) executes only in CI; this double lets the unit lane
 * execute the SAME code end to end and lets a mutation of any guard turn a local test red.
 *
 * What it is NOT: a SQL engine. Each statement the copy path issues is matched by SHAPE (regex on the
 * whitespace-normalised text) and evaluated against plain row arrays. A statement it does not recognise
 * THROWS (`Unhandled SQL in fake`) — never silently returns rows — so a new statement in the product cannot
 * pass by accident (the dedupe suite's discipline). Predicates are evaluated ONLY where the product's SQL
 * really writes them (`deleted_at IS NULL`, `access_level = 'none'`, …); the fake never adds a filter the
 * statement did not ask for, so removing a predicate from the product turns the relevant test red.
 *
 * Transactions: `transaction(handler)` snapshots every table (structured clone), runs the handler on a
 * per-transaction query, and RESTORES the snapshot when the handler throws — a rollback that is exactly as
 * strong as the assertion that uses it (a row count that stays at zero). Transaction-scoped advisory locks
 * (`pg_try_advisory_xact_lock` / `pg_advisory_xact_lock`) are keyed per transaction and released when it
 * ends, with the try-lock's real "another transaction holds it → false" answer.
 *
 * Time: the fake owns a clock (`now()` in the statements) so `created_at` ordering and the dedupe window are
 * deterministic. Ordinal `created_at` (`$6::timestamptz + ($7::int * interval '1 microsecond')`) is computed
 * into a microsecond ISO string so `ORDER BY created_at ASC, id ASC` sorts the way Postgres would.
 */

import type { QueryFn } from '../../src/multitable/record-service'

export type FakeRow = Record<string, unknown>
export type FakeQueryResult = { rows: FakeRow[]; rowCount: number }
export type FakeStatement = { sql: string; params: unknown[]; tx: number | null }

export interface FakePgOptions {
  /** Emulate a database whose dedupe ledger is NOT migrated (every ledger statement throws SQLSTATE 42P01). */
  ledgerUnavailable?: boolean
  /**
   * Emulate a ledger table that PREDATES migration zzzz20260927121000 (table present, `intent_kind` column absent):
   * every ledger statement that NAMES `intent_kind` throws SQLSTATE 42703, exactly as Postgres does; ledger
   * statements that do not name it (the DELETEs) run normally.
   */
  ledgerIntentKindMissing?: boolean
  /** Emulate a database WITHOUT the provenance columns (the copy INSERT that names them throws 42703). */
  provenanceColumnsMissing?: boolean
  /** Hook run before every statement inside a transaction — lets a test mutate the store mid-copy (tripwire). */
  beforeStatement?: (statement: FakeStatement, pg: FakePg) => Promise<void> | void
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function isoMicro(ms: number, micro = 0): string {
  const base = new Date(ms).toISOString() // 2026-09-27T08:00:00.000Z
  const frac = String(micro).padStart(3, '0')
  return `${base.slice(0, -1)}${frac}Z`
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

const PROVENANCE_COLUMNS = ['copied_from_sheet_id', 'copied_from_kind', 'copied_at']

export class FakePg {
  readonly tables: Record<string, FakeRow[]> = {
    meta_bases: [],
    meta_sheets: [],
    meta_fields: [],
    meta_views: [],
    meta_records: [],
    meta_links: [],
    spreadsheet_permissions: [],
    field_permissions: [],
    meta_view_permissions: [],
    record_permissions: [],
    meta_record_revisions: [],
    meta_config_revisions: [],
    operation_audit_logs: [],
    meta_multitable_template_installs: [],
    plugin_multitable_object_registry: [],
    meta_field_auto_number_sequences: [],
    formula_dependencies: [],
    meta_automation_outbox: [],
    multitable_webhook_deliveries: [],
  }

  /** userId → group ids / role ids (for the member-group / role subject predicates). */
  readonly groupMembers = new Map<string, Set<string>>()
  readonly userRoles = new Map<string, Set<string>>()

  readonly statements: FakeStatement[] = []
  clockMs = Date.parse('2026-09-27T08:00:00.000Z')
  private txSeq = 0
  private readonly heldLocks = new Map<string, number>()

  constructor(private readonly opts: FakePgOptions = {}) {}

  /** Advance the fake clock (dedupe window / created_at ordering). */
  tick(ms: number): void {
    this.clockMs += ms
  }

  nowIso(): string {
    return isoMicro(this.clockMs)
  }

  rows(table: string): FakeRow[] {
    const rows = this.tables[table]
    if (!rows) throw new Error(`fake pg: unknown table ${table}`)
    return rows
  }

  // ── seeding helpers (values are the TEST's, never a customer's) ─────────────

  seedBase(id: string, ownerId: string | null = null): void {
    this.rows('meta_bases').push({ id, owner_id: ownerId, deleted_at: null })
  }

  seedSheet(row: { id: string; baseId: string; name: string; description?: string | null; rowLevel?: boolean; rules?: unknown[]; systemKind?: string | null; deletedAt?: string | null; copiedFromKind?: string | null }): void {
    this.rows('meta_sheets').push({
      id: row.id,
      base_id: row.baseId,
      name: row.name,
      description: row.description ?? null,
      deleted_at: row.deletedAt ?? null,
      row_level_read_permissions_enabled: row.rowLevel === true,
      conditional_read_rules: row.rules ?? [],
      system_kind: row.systemKind ?? null,
      copied_from_sheet_id: null,
      copied_from_kind: row.copiedFromKind ?? null,
      copied_at: null,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    })
  }

  seedField(row: { id: string; sheetId: string; name?: string; type: string; property?: Record<string, unknown>; order?: number }): void {
    this.rows('meta_fields').push({
      id: row.id,
      sheet_id: row.sheetId,
      name: row.name ?? row.id,
      type: row.type,
      property: row.property ?? {},
      order: row.order ?? this.rows('meta_fields').filter((f) => f.sheet_id === row.sheetId).length,
      updated_at: this.nowIso(),
    })
  }

  seedView(row: { id: string; sheetId: string; name?: string; type?: string; filterInfo?: unknown; sortInfo?: unknown; groupInfo?: unknown; hiddenFieldIds?: string[]; config?: unknown }): void {
    this.rows('meta_views').push({
      id: row.id,
      sheet_id: row.sheetId,
      name: row.name ?? row.id,
      type: row.type ?? 'grid',
      filter_info: row.filterInfo ?? {},
      sort_info: row.sortInfo ?? {},
      group_info: row.groupInfo ?? {},
      hidden_field_ids: row.hiddenFieldIds ?? [],
      config: row.config ?? {},
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    })
  }

  seedRecord(row: { id: string; sheetId: string; data: Record<string, unknown>; createdBy?: string | null; createdAtMs?: number }): void {
    const at = row.createdAtMs ?? this.clockMs
    this.rows('meta_records').push({
      id: row.id,
      sheet_id: row.sheetId,
      data: row.data,
      version: 1,
      created_by: row.createdBy ?? null,
      modified_by: row.createdBy ?? null,
      created_at: isoMicro(at),
      updated_at: isoMicro(at),
    })
  }

  seedLink(fieldId: string, recordId: string, foreignRecordId: string): void {
    this.rows('meta_links').push({ id: `lnk_${this.rows('meta_links').length + 1}`, field_id: fieldId, record_id: recordId, foreign_record_id: foreignRecordId, created_at: this.nowIso() })
  }

  // ── pool surface ────────────────────────────────────────────────────────────

  /** A pool-level query (autocommit). */
  readonly query: QueryFn = (sql, params) => this.execute(sql, params ?? [], null)

  /** `pool.transaction` shape used by both the route (via poolManager) and the service. */
  async transaction<T>(handler: (client: { query: QueryFn }) => Promise<T>): Promise<T> {
    const tx = ++this.txSeq
    const snapshot = structuredClone(this.tables)
    const snapshotGroups = new Map([...this.groupMembers].map(([k, v]) => [k, new Set(v)]))
    try {
      return await handler({ query: (sql, params) => this.execute(sql, params ?? [], tx) })
    } catch (err) {
      for (const key of Object.keys(this.tables)) this.tables[key] = snapshot[key]!
      this.groupMembers.clear()
      for (const [k, v] of snapshotGroups) this.groupMembers.set(k, v)
      throw err
    } finally {
      for (const [key, owner] of [...this.heldLocks]) if (owner === tx) this.heldLocks.delete(key)
    }
  }

  /** What `poolManager.get()` should return for route tests. */
  asPool(): { query: QueryFn; transaction: FakePg['transaction']; getInternalPool: () => unknown } {
    return { query: this.query, transaction: this.transaction.bind(this), getInternalPool: () => ({}) }
  }

  // ── the statement matcher ───────────────────────────────────────────────────

  private async execute(rawSql: string, params: unknown[], tx: number | null): Promise<FakeQueryResult> {
    const sql = normalize(rawSql)
    const statement: FakeStatement = { sql, params, tx }
    this.statements.push(statement)
    if (tx !== null && this.opts.beforeStatement) await this.opts.beforeStatement(statement, this)
    const p = (i: number) => params[i]
    const s = (i: number) => String(params[i] ?? '')
    const ok = (rows: FakeRow[] = [], rowCount = rows.length): FakeQueryResult => ({ rows, rowCount })

    // ── advisory locks ──
    if (sql.startsWith('SELECT pg_try_advisory_xact_lock(')) {
      if (tx === null) throw new Error('fake pg: pg_try_advisory_xact_lock outside a transaction')
      const key = `try:${s(0)}`
      const owner = this.heldLocks.get(key)
      if (owner !== undefined && owner !== tx) return ok([{ locked: false }])
      this.heldLocks.set(key, tx)
      return ok([{ locked: true }])
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) {
      if (tx === null) throw new Error('fake pg: pg_advisory_xact_lock outside a transaction')
      // Blocking lock: a second transaction would PARK in Postgres; the fake has no second connection, so it
      // records the key and proceeds (the ORDER of acquisition is what the tests pin).
      this.heldLocks.set(`adv:${s(0)}`, tx)
      return ok([])
    }

    // ── dedupe ledger ──
    if (sql.includes('meta_multitable_template_installs')) {
      if (this.opts.ledgerUnavailable) throw pgError('42P01', '关系 "meta_multitable_template_installs" 不存在')
      if (this.opts.ledgerIntentKindMissing && sql.includes('intent_kind')) throw pgError('42703', '字段 "intent_kind" 不存在')
      const ledger = this.rows('meta_multitable_template_installs')
      if (sql.startsWith('INSERT INTO meta_multitable_template_installs')) {
        const digest = s(0)
        const row = {
          scope_digest: digest, tenant_id: p(1) ?? null, actor_id: s(2), template_id: s(3), workspace_id: p(4) ?? null,
          base_id: s(5), sheet_ids: asStringArray(p(6)), response: JSON.parse(String(p(7))), installed_at_ms: this.clockMs, intent_kind: s(8),
        }
        const idx = ledger.findIndex((r) => r.scope_digest === digest)
        if (idx >= 0) ledger[idx] = row
        else ledger.push(row)
        return ok([], 1)
      }
      if (sql.startsWith('DELETE FROM meta_multitable_template_installs WHERE scope_digest = $1')) {
        const before = ledger.length
        this.tables.meta_multitable_template_installs = ledger.filter((r) => r.scope_digest !== s(0))
        return ok([], before - this.tables.meta_multitable_template_installs!.length)
      }
      if (sql.startsWith('DELETE FROM meta_multitable_template_installs WHERE scope_digest IN')) {
        const windowMs = Number(p(0))
        const before = ledger.length
        this.tables.meta_multitable_template_installs = ledger.filter((r) => Number(r.installed_at_ms) >= this.clockMs - windowMs)
        return ok([], before - this.tables.meta_multitable_template_installs!.length)
      }
      if (sql.startsWith('SELECT base_id, sheet_ids, response')) {
        const windowMs = Number(p(1))
        const row = ledger.find((r) => r.scope_digest === s(0))
        if (!row) return ok([])
        if (sql.includes('installed_at >') && Number(row.installed_at_ms) <= this.clockMs - windowMs) return ok([])
        return ok([{ ...row }])
      }
      throw new Error(`Unhandled ledger SQL in fake: ${sql}`)
    }

    // ── meta_bases ──
    if (sql.startsWith('SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
      return ok(this.rows('meta_bases').filter((b) => b.id === s(0) && b.deleted_at === null).map((b) => ({ owner_id: b.owner_id })))
    }
    if (sql.startsWith('SELECT id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
      return ok(this.rows('meta_bases').filter((b) => b.id === s(0) && b.deleted_at === null).map((b) => ({ id: b.id })))
    }

    // ── e-learning projection tables (never present in these fixtures) ──
    if (/FROM \S*elearning\S*/i.test(sql) || sql.includes('org_id, sheet_id') || sql.includes('sheet_id, org_id')) return ok([])

    // ── meta_sheets ──
    const sheets = this.rows('meta_sheets')
    if (sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE' || sql === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') {
      return ok(sheets.filter((r) => r.id === s(0)).map((r) => ({ deleted_at: r.deleted_at })))
    }
    if (sql.startsWith('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND base_id = $2')) {
      const ids = new Set(asStringArray(p(0)))
      return ok(sheets.filter((r) => ids.has(String(r.id)) && r.base_id === s(1)).map((r) => ({ id: r.id })))
    }
    // S3: the stock-preparation overview clamp's kind lookup (stock-preparation-overview-contract.ts),
    // answered from the row's own system_kind like PostgreSQL's column-tolerant `to_jsonb` read.
    if (sql === "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2") {
      const ids = new Set(asStringArray(p(0)))
      return ok(sheets.filter((r) => ids.has(String(r.id)) && (r.system_kind ?? null) === s(1)).map((r) => ({ id: r.id })))
    }
    if (sql.startsWith('SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND deleted_at IS NULL')) {
      const ids = new Set(asStringArray(p(0)))
      return ok(sheets.filter((r) => ids.has(String(r.id)) && r.deleted_at === null).map((r) => ({ id: r.id })))
    }
    if (sql.startsWith('SELECT id, base_id FROM meta_sheets WHERE id = ANY($1::text[]) AND deleted_at IS NULL')) {
      const ids = new Set(asStringArray(p(0)))
      return ok(sheets.filter((r) => ids.has(String(r.id)) && r.deleted_at === null).map((r) => ({ id: r.id, base_id: r.base_id })))
    }
    if (sql === 'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL') {
      return ok(sheets.filter((r) => r.id === s(0) && r.deleted_at === null).map((r) => ({ id: r.id })))
    }
    if (sql.startsWith('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return ok(sheets.filter((r) => r.id === s(0) && r.deleted_at === null).map((r) => ({ id: r.id, base_id: r.base_id, name: r.name, description: r.description })))
    }
    if (sql.startsWith('SELECT id, base_id, name, description, (to_jsonb(meta_sheets) ->> \'row_level_read_permissions_enabled\')')) {
      return ok(sheets.filter((r) => r.id === s(0) && r.deleted_at === null).map((r) => ({
        id: r.id, base_id: r.base_id, name: r.name, description: r.description,
        row_level: r.row_level_read_permissions_enabled ? 'true' : 'false',
        rules: r.conditional_read_rules,
        system_kind: r.system_kind ?? null,
        // `to_jsonb(...) ->> 'copied_from_kind'` is NULL (not 42703) on an unmigrated server, so the fake answers
        // null when the option says the column is missing.
        copied_from_kind: this.opts.provenanceColumnsMissing ? null : (r.copied_from_kind ?? null),
      })))
    }
    if (sql.startsWith('SELECT (to_jsonb(meta_sheets) ->> \'system_kind\') AS system_kind, description FROM meta_sheets WHERE id = $1')) {
      return ok(sheets.filter((r) => r.id === s(0)).map((r) => ({ system_kind: r.system_kind ?? null, description: r.description })))
    }
    if (sql === 'SELECT copied_from_kind FROM meta_sheets WHERE id = $1') {
      if (this.opts.provenanceColumnsMissing) throw pgError('42703', '字段 "copied_from_kind" 不存在')
      return ok(sheets.filter((r) => r.id === s(0)).map((r) => ({ copied_from_kind: r.copied_from_kind ?? null })))
    }
    if (sql.startsWith('SELECT row_level_read_permissions_enabled AS enabled, base_id FROM meta_sheets WHERE id = $1')) {
      return ok(sheets.filter((r) => r.id === s(0)).map((r) => ({ enabled: r.row_level_read_permissions_enabled === true, base_id: r.base_id })))
    }
    if (sql.startsWith('SELECT conditional_read_rules AS rules FROM meta_sheets WHERE id = $1')) {
      return ok(sheets.filter((r) => r.id === s(0)).map((r) => ({ rules: r.conditional_read_rules })))
    }
    if (sql.startsWith('SELECT 1 FROM meta_sheets WHERE id = $1 AND jsonb_array_length(COALESCE(conditional_read_rules')) {
      return ok(sheets.filter((r) => r.id === s(0) && Array.isArray(r.conditional_read_rules) && r.conditional_read_rules.length > 0).map(() => ({ '?column?': 1 })))
    }
    if (sql.startsWith('INSERT INTO meta_sheets')) {
      if (this.opts.provenanceColumnsMissing && PROVENANCE_COLUMNS.some((c) => sql.includes(c))) throw pgError('42703', '字段 "copied_from_sheet_id" 不存在')
      if (sheets.some((r) => r.id === s(0))) return ok([], 0)
      sheets.push({
        id: s(0), base_id: s(1), name: s(2), description: p(3) ?? null, deleted_at: null,
        row_level_read_permissions_enabled: p(4) === true, conditional_read_rules: JSON.parse(String(p(5) ?? '[]')),
        copied_from_sheet_id: p(6) ?? null, copied_from_kind: p(7) ?? null, copied_at: p(8) ?? null, system_kind: null,
        created_at: this.nowIso(), updated_at: this.nowIso(),
      })
      return ok([{ id: s(0) }], 1)
    }

    // ── plugin registry ──
    if (sql.startsWith('SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1')) {
      return ok(this.rows('plugin_multitable_object_registry').filter((r) => r.sheet_id === s(0)).map(() => ({ '?column?': 1 })))
    }
    if (sql.startsWith('SELECT plugin_name FROM plugin_multitable_object_registry WHERE sheet_id = $1')) {
      return ok(this.rows('plugin_multitable_object_registry').filter((r) => r.sheet_id === s(0)).map((r) => ({ plugin_name: r.plugin_name })))
    }

    // ── meta_fields ──
    const fields = this.rows('meta_fields')
    if (sql.startsWith('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
      return ok(fields.filter((f) => f.sheet_id === s(0)).sort((a, b) => Number(a.order) - Number(b.order) || String(a.id).localeCompare(String(b.id))).map((f) => ({ ...f })))
    }
    if (sql === 'SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1') {
      return ok(fields.filter((f) => f.sheet_id === s(0)).map((f) => ({ id: f.id, name: f.name, type: f.type, property: f.property })))
    }
    if (sql === 'SELECT id, type FROM meta_fields WHERE sheet_id = $1') {
      return ok(fields.filter((f) => f.sheet_id === s(0)).map((f) => ({ id: f.id, type: f.type })))
    }
    if (sql === 'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1') {
      return ok(fields.filter((f) => f.sheet_id === s(0)).map((f) => ({ id: f.id, type: f.type, property: f.property })))
    }
    if (sql.startsWith('SELECT id, updated_at FROM meta_fields WHERE sheet_id = $1')) {
      return ok(fields.filter((f) => f.sheet_id === s(0)).sort((a, b) => String(a.id).localeCompare(String(b.id))).map((f) => ({ id: f.id, updated_at: f.updated_at })))
    }
    if (sql.startsWith('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")')) {
      fields.push({ id: s(0), sheet_id: s(1), name: s(2), type: s(3), property: JSON.parse(String(p(4))), order: Number(p(5)), updated_at: this.nowIso() })
      return ok([], 1)
    }
    if (sql.startsWith('INSERT INTO formula_dependencies')) {
      this.rows('formula_dependencies').push({ sheet_id: s(0), field_id: s(1), depends_on_field_id: s(2) })
      return ok([], 1)
    }

    // ── meta_views ──
    const views = this.rows('meta_views')
    if (sql.startsWith('SELECT id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1')) {
      return ok(views.filter((v) => v.sheet_id === s(0)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))).map((v) => ({ ...v })))
    }
    if (sql.startsWith('SELECT id, updated_at FROM meta_views WHERE sheet_id = $1')) {
      return ok(views.filter((v) => v.sheet_id === s(0)).sort((a, b) => String(a.id).localeCompare(String(b.id))).map((v) => ({ id: v.id, updated_at: v.updated_at })))
    }
    if (sql.startsWith('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config, created_at)')) {
      const startedAt = Date.parse(s(9))
      views.push({
        id: s(0), sheet_id: s(1), name: s(2), type: s(3),
        filter_info: JSON.parse(s(4)), sort_info: JSON.parse(s(5)), group_info: JSON.parse(s(6)), hidden_field_ids: JSON.parse(s(7)), config: JSON.parse(s(8)),
        created_at: isoMicro(startedAt, Number(p(10))), updated_at: this.nowIso(),
      })
      return ok([], 1)
    }

    // ── meta_records ──
    const records = this.rows('meta_records')
    if (sql.startsWith('SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS max_updated FROM meta_records WHERE sheet_id = $1')) {
      const mine = records.filter((r) => r.sheet_id === s(0))
      const max = mine.reduce<string | null>((acc, r) => (acc === null || String(r.updated_at) > acc ? String(r.updated_at) : acc), null)
      return ok([{ n: mine.length, max_updated: max }])
    }
    if (sql.startsWith('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1')) {
      return ok([{ n: records.filter((r) => r.sheet_id === s(0)).length }])
    }
    if (sql.startsWith('SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2')) {
      const limit = Number(p(1))
      return ok(records.filter((r) => r.sheet_id === s(0))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit)
        .map((r) => ({ id: r.id, data: r.data, created_by: r.created_by })))
    }
    if (sql.startsWith('SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = new Set(asStringArray(p(1)))
      return ok(records.filter((r) => r.sheet_id === s(0) && ids.has(String(r.id))).map((r) => ({ id: r.id })))
    }
    if (sql.startsWith('SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = new Set(asStringArray(p(1)))
      return ok(records.filter((r) => r.sheet_id === s(0) && ids.has(String(r.id))).map((r) => ({ id: r.id, data: r.data })))
    }
    if (sql === 'SELECT id, data FROM meta_records WHERE sheet_id = $1') {
      return ok(records.filter((r) => r.sheet_id === s(0)).map((r) => ({ id: r.id, data: r.data })))
    }
    // MultitableFormulaEngine.recalculateRecord (the route's post-commit chunked recompute)
    if (sql === 'SELECT id, data FROM meta_records WHERE id = $1 AND sheet_id = $2') {
      return ok(records.filter((r) => r.id === s(0) && r.sheet_id === s(1)).map((r) => ({ id: r.id, data: r.data })))
    }
    if (sql.startsWith('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = new Set(asStringArray(p(1)))
      return ok(records.filter((r) => r.sheet_id === s(0) && ids.has(String(r.id))).map((r) => ({ id: r.id, version: r.version, data: r.data })))
    }
    if (sql.startsWith('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = new Set(asStringArray(p(1)))
      return ok(records.filter((r) => r.sheet_id === s(0) && ids.has(String(r.id))).map((r) => ({ id: r.id, created_by: r.created_by })))
    }
    if (sql.startsWith('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, created_at)')) {
      const startedAt = Date.parse(s(5))
      records.push({
        id: s(0), sheet_id: s(1), data: JSON.parse(s(2)), version: 1, created_by: p(3) ?? null, modified_by: p(4) ?? null,
        created_at: isoMicro(startedAt, Number(p(6))), updated_at: this.nowIso(),
      })
      return ok([{ version: 1 }], 1)
    }
    if (sql.startsWith('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)')) {
      records.push({ id: s(0), sheet_id: s(1), data: JSON.parse(s(2)), version: 1, created_by: p(3) ?? null, modified_by: p(3) ?? null, created_at: this.nowIso(), updated_at: this.nowIso() })
      return ok([{ version: 1 }], 1)
    }
    if (sql.startsWith('UPDATE meta_records SET data = ') || sql.startsWith('UPDATE meta_records mr SET data')) {
      // formula materialisation / auto-number backfill — accepted, values untouched (not under test here)
      return ok([], 0)
    }

    // ── meta_links ──
    const links = this.rows('meta_links')
    if (sql.startsWith('SELECT field_id, record_id, foreign_record_id FROM meta_links WHERE field_id = ANY($1::text[]) AND record_id = ANY($2::text[])')) {
      const f = new Set(asStringArray(p(0)))
      const r = new Set(asStringArray(p(1)))
      return ok(links.filter((l) => f.has(String(l.field_id)) && r.has(String(l.record_id))).map((l) => ({ field_id: l.field_id, record_id: l.record_id, foreign_record_id: l.foreign_record_id })))
    }
    if (sql.startsWith('SELECT COUNT(*)::int AS n FROM meta_links WHERE field_id = ANY($1::text[])')) {
      const f = new Set(asStringArray(p(0)))
      return ok([{ n: links.filter((l) => f.has(String(l.field_id))).length }])
    }
    if (sql.startsWith('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)')) {
      links.push({ id: s(0), field_id: s(1), record_id: s(2), foreign_record_id: s(3), created_at: this.nowIso() })
      return ok([], 1)
    }

    // ── auto-number ──
    if (sql.startsWith('INSERT INTO meta_field_auto_number_sequences')) {
      const seqs = this.rows('meta_field_auto_number_sequences')
      const existing = seqs.find((r) => r.field_id === s(0))
      const batch = Number(p(3))
      if (existing) {
        const start = Number(existing.next_value)
        existing.next_value = start + batch
        return ok([{ start_value: start }], 1)
      }
      const next = Number(p(2))
      seqs.push({ field_id: s(0), sheet_id: s(1), next_value: next })
      return ok([{ start_value: next - batch }], 1)
    }

    // ── permissions ──
    if (sql.startsWith('SELECT sp.sheet_id, sp.perm_code, sp.subject_type FROM spreadsheet_permissions sp WHERE sp.sheet_id = ANY($2::text[])')) {
      const ids = new Set(asStringArray(p(1)))
      const userId = s(0)
      return ok(this.rows('spreadsheet_permissions')
        .filter((r) => ids.has(String(r.sheet_id)) && this.subjectMatches(r, userId))
        .map((r) => ({ sheet_id: r.sheet_id, perm_code: r.perm_code, subject_type: r.subject_type })))
    }
    if (sql.startsWith('SELECT user_id, subject_type, subject_id, perm_code FROM spreadsheet_permissions WHERE sheet_id = $1')) {
      return ok(this.rows('spreadsheet_permissions').filter((r) => r.sheet_id === s(0)).map((r) => ({ ...r })))
    }
    if (sql.startsWith('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)')) {
      const rows = this.rows('spreadsheet_permissions')
      if (rows.some((r) => r.sheet_id === s(0) && r.subject_type === s(2) && r.subject_id === s(3) && r.perm_code === s(4))) return ok([], 0)
      rows.push({ sheet_id: s(0), user_id: p(1) ?? null, subject_type: s(2), subject_id: s(3), perm_code: s(4) })
      return ok([], 1)
    }
    if (sql.startsWith('SELECT fp.field_id, fp.visible, fp.read_only FROM field_permissions fp WHERE fp.sheet_id = $2')) {
      const userId = s(0)
      return ok(this.rows('field_permissions').filter((r) => r.sheet_id === s(1) && this.subjectMatches(r, userId)).map((r) => ({ field_id: r.field_id, visible: r.visible, read_only: r.read_only })))
    }
    if (sql.startsWith('SELECT field_id, subject_type, subject_id, visible, read_only FROM field_permissions WHERE sheet_id = $1')) {
      return ok(this.rows('field_permissions').filter((r) => r.sheet_id === s(0)).map((r) => ({ ...r })))
    }
    if (sql.startsWith('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)')) {
      const rows = this.rows('field_permissions')
      if (rows.some((r) => r.sheet_id === s(0) && r.field_id === s(1) && r.subject_type === s(2) && r.subject_id === s(3))) return ok([], 0)
      rows.push({ sheet_id: s(0), field_id: s(1), subject_type: s(2), subject_id: s(3), visible: p(4) === true, read_only: p(5) === true, created_by: p(6) ?? null })
      return ok([], 1)
    }
    if (sql.startsWith('SELECT view_id, subject_type, subject_id, permission FROM meta_view_permissions WHERE view_id = ANY($1::text[])')) {
      const ids = new Set(asStringArray(p(0)))
      return ok(this.rows('meta_view_permissions').filter((r) => ids.has(String(r.view_id))).map((r) => ({ ...r })))
    }
    if (sql.startsWith('INSERT INTO meta_view_permissions (view_id, subject_type, subject_id, permission)')) {
      this.rows('meta_view_permissions').push({ view_id: s(0), subject_type: s(1), subject_id: s(2), permission: s(3) })
      return ok([], 1)
    }
    if (sql.startsWith('SELECT record_id, subject_type, subject_id, access_level, created_by FROM record_permissions WHERE sheet_id = $1')) {
      return ok(this.rows('record_permissions').filter((r) => r.sheet_id === s(0)).map((r) => ({ ...r })))
    }
    if (sql.startsWith('SELECT DISTINCT subject_type, subject_id FROM record_permissions WHERE sheet_id = $1 AND access_level = \'none\'')) {
      const seen = new Set<string>()
      const out: FakeRow[] = []
      for (const r of this.rows('record_permissions')) {
        if (r.sheet_id !== s(0) || r.access_level !== 'none') continue
        const key = `${r.subject_type}|${r.subject_id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ subject_type: r.subject_type, subject_id: r.subject_id })
      }
      return ok(out)
    }
    if (sql.startsWith('SELECT record_id FROM record_permissions WHERE sheet_id = $1 AND access_level = \'none\' AND subject_type = $2 AND subject_id = $3')) {
      return ok(this.rows('record_permissions').filter((r) => r.sheet_id === s(0) && r.access_level === 'none' && r.subject_type === s(1) && r.subject_id === s(2)).map((r) => ({ record_id: r.record_id })))
    }
    if (sql.startsWith('SELECT DISTINCT rp.record_id FROM record_permissions rp WHERE rp.sheet_id = $2') && sql.includes("rp.access_level = 'none'")) {
      const userId = s(0)
      const bounded = sql.includes('rp.record_id = ANY($3::text[])') ? new Set(asStringArray(p(2))) : null
      const out = new Set<string>()
      for (const r of this.rows('record_permissions')) {
        if (r.sheet_id !== s(1) || r.access_level !== 'none') continue
        if (bounded && !bounded.has(String(r.record_id))) continue
        if (this.subjectMatches(r, userId)) out.add(String(r.record_id))
      }
      return ok([...out].map((record_id) => ({ record_id })))
    }
    if (sql.startsWith('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level, created_by)')) {
      const rows = this.rows('record_permissions')
      const existing = rows.find((r) => r.record_id === s(1) && r.subject_type === s(2) && r.subject_id === s(3))
      if (existing) return ok([], 0)
      rows.push({ id: `rp_${rows.length + 1}`, sheet_id: s(0), record_id: s(1), subject_type: s(2), subject_id: s(3), access_level: s(4), created_by: p(5) ?? null })
      return ok([], 1)
    }
    if (sql.startsWith('SELECT 1 FROM record_permissions WHERE sheet_id = $1 LIMIT 1')) {
      return ok(this.rows('record_permissions').some((r) => r.sheet_id === s(0)) ? [{ '?column?': 1 }] : [])
    }

    // ── revisions / audit ──
    if (sql.startsWith('INSERT INTO meta_record_revisions')) {
      this.rows('meta_record_revisions').push({
        id: s(0), sheet_id: s(1), record_id: s(2), version: p(3), action: s(4), source: s(5), actor_id: p(6) ?? null,
        changed_field_ids: p(7), patch: JSON.parse(s(8)), snapshot: p(9) === null ? null : JSON.parse(s(9)), batch_id: p(10) ?? null,
      })
      return ok([], 1)
    }
    if (sql.startsWith('INSERT INTO meta_config_revisions')) {
      this.rows('meta_config_revisions').push({
        id: s(0), sheet_id: s(1), entity_type: s(2), entity_id: s(3), action: s(4), before: JSON.parse(s(5)), after: JSON.parse(s(6)),
        changed_keys: p(7), batch_id: p(8) ?? null, actor_id: p(9) ?? null, source: s(10),
      })
      return ok([], 1)
    }
    if (sql.startsWith('INSERT INTO operation_audit_logs')) {
      this.rows('operation_audit_logs').push({ actor_id: s(0), resource_id: s(1), metadata: JSON.parse(s(2)), action: /'(multitable\.sheet\.[a-z-]+)'/.exec(sql)?.[1] ?? null })
      return ok([], 1)
    }
    if (sql.includes('information_schema.columns')) return ok([])
    if (sql.includes('pg_current_xact_id')) return ok([{ xid: String(tx ?? 0) }])
    if (sql.startsWith('INSERT INTO meta_automation_outbox')) {
      this.rows('meta_automation_outbox').push({ sql })
      return ok([], 1)
    }
    if (sql.startsWith('SELECT DISTINCT permission_code AS code FROM (')) return ok([]) // no global codes → owner path

    throw new Error(`Unhandled SQL in fake: ${sql}`)
  }

  /** The three-subject predicate the permission tables share (user / member-group / role). */
  private subjectMatches(row: FakeRow, userId: string): boolean {
    if (row.subject_type === 'user') return row.subject_id === userId
    if (row.subject_type === 'member-group') return this.groupMembers.get(userId)?.has(String(row.subject_id)) === true
    if (row.subject_type === 'role') return this.userRoles.get(userId)?.has(String(row.subject_id)) === true
    return false
  }
}
