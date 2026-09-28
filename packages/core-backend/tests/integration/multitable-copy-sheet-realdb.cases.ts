/**
 * 「复制数据表（含数据）」S1 — real-Postgres end-to-end cases (design-lock ADR
 * docs/development/multitable-copy-sheet-with-data-adr-20260926.md §9 "S1 真库测试"; PR #6112 review round A4).
 *
 * This is a CASES MODULE, not a test file: `defineCopySheetRealDbCases()` registers one `describe` block and is called
 * from an already-wired real-DB host (tests/integration/multitable-conditional-rule-enforce-realdb.test.ts), so the cases
 * execute in the existing "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml WITHOUT a new
 * lane file (the pushing token has no `workflow` OAuth scope; the previous standalone file was never executed — PR #6112
 * review DATA-11). Do NOT also list a standalone file for these cases in that step, or they run twice.
 *
 * Fixture shape follows multitable-record-approval-realdb.test.ts: raw pool seeding, an express app with an always-on
 * session middleware in front of the REAL router (`createMultitableCopySheetRoutes`), so every gate resolves the actor
 * from the DATABASE (user_permissions / sheet grants), never from a token claim. `request(app)` is allowed under
 * tests/integration (the #4154 tripwire covers tests/unit only).
 *
 * WHAT IS PROVEN HERE (each needs real Postgres — the unit lane's in-memory double cannot answer these):
 *   G1  non-admin writer on a sheet whose row-level read switch is ON → 403 COPY_SOURCE_NOT_FULLY_READABLE, body carries
 *       no count, ONE refusal audit row per attempt; dry-run answers the same 403 (axis 1 of hasFullTableReadAccess).
 *   G1b a writer with a field_permissions mask on ONE column → the same 403 (axis 2), copy AND dry-run.
 *   G2  a TABLE-LEVEL reader (global multitable:write + a sheet-scoped spreadsheet:read grant, so his own
 *       canCreateRecord on the copy would be FALSE) copies successfully — the server constant capabilities (§4.4).
 *   G3  admin copy of the row-level sheet: provenance columns; spreadsheet_/field_/view permissions equal (id remap, no
 *       row for the copier); row-level switch + rule copied; record_permissions incl. every 'none' row remapped; DENY
 *       PARITY against the REAL loadDeniedRecordIds for three denied subjects; source ORDER kept (created_at ordinal);
 *       created_by preserved; blanked attachment values absent; the ADMIN copier holds canManageFields on the source so
 *       the property-hidden values ARE copied (§4.1 second layer); '' select kept (DATA-5); out-of-set select kept;
 *       auto-number 1..N; formula values written by the post-commit recompute; ONE meta_record_revisions batch with
 *       source 'copy-sheet'; config revisions per field / view / permission sharing that batch; button → record_click
 *       w/o actionConfig; two audit rows; ledger row intent_kind 'copy-sheet'; NO registry row.
 *   G4  events: zero `multitable.record.created` on the real bus; zero meta_automation_outbox rows for the new sheet
 *       with AUTOMATION_DURABLE_DELIVERY_ENABLED on AND off; exactly one `multitable.sheet.copied`.
 *   G5  all-or-nothing: a source row whose link target is missing → 422 { rowIndex, fieldId, code }, and NO meta_sheets
 *       row carries copied_from_sheet_id = that source, no ledger row, one refusal audit row; the response bytes carry
 *       no cell value / link id.
 *   G6  managed source: copied_from_kind='plugin-managed', no registry row for the copy, and the plugin-scope deny
 *       refuses another plugin on the copy while leaving the source to its registry row.
 *   G7  idempotency: same intent ×3 → one sheet, replays carry Idempotent-Replayed; a changed `withData` → a new sheet.
 *   G8  CONCURRENCY (§9 r3-2): two connections send the same intent at once → both 201, exactly one Idempotent-Replayed,
 *       exactly one new sheet, no 40001 anywhere.
 *   G9  a deny rule on an auto-number column whose numbering would change → 422 COPY_SOURCE_RULE_ON_RENUMBERED_FIELD.
 *   G10 MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS below the row count → copy 413 COPY_TOO_LARGE { rowCount, limit };
 *       dry-run 200 with summary.overLimit=true (FE-2).
 *   G11 dry-run: every content table has the SAME rowcount before and after.
 *   G12 LOCK ORDER (§9 r3-3 / review TX-2): another session holds the SOURCE sheet's canonical fence and, while the
 *       copy is parked on that fence, INSERTs a record into the source (FK KEY SHARE on meta_sheets(source)). Both
 *       commit, the copy answers 201, no 40P01 anywhere — with the writer-fence flag OFF and ON. Under the old order
 *       (row FOR UPDATE → fence) this exact orchestration is a deadlock.
 *   G13 TAINT axis (§1.9 axis 3): a writer masked on a FOREIGN field that a lookup (and a formula over it) reads → the
 *       same 403 on copy and dry-run; the admin copy of that sheet materialises the formula-over-lookup value from the
 *       HYDRATED lookup (DATA-7: 7 + 1 = 8, not 0 + 1).
 *   G14 CONCURRENT REVOKE (§9 r3-1): another session holds the source row FOR UPDATE (the lock every authorization PUT
 *       takes), the copy passes the out-of-transaction gate and parks on the row lock; the holder revokes the copier's
 *       sheet grant and commits → the in-transaction DB-fresh gate answers 403 FORBIDDEN and nothing is written.
 *   G15 TRIPWIRE (§7.2 step 6, flag off): a source record's updated_at bumped by another connection AFTER the copy took
 *       its baseline (between structure writes) → 409 COPY_SOURCE_CHANGED, zero rows for the copy, no ledger row.
 *
 * Fail-not-skip: in the real-DB step (METASHEET_REAL_DB_TEST_STEP=1) a missing DATABASE_URL throws from a top-level
 * test OUTSIDE the DB-gated describe, so a mis-spelled env can never skip-green the whole block.
 */
import { randomUUID } from 'node:crypto'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus } from '../../src/integration/events/event-bus'
import { db } from '../../src/db/db'
import { up as addProvenance } from '../../src/db/migrations/zzzz20260927120500_add_meta_sheets_copy_provenance'
import { up as addIntentKind } from '../../src/db/migrations/zzzz20260927121000_add_multitable_install_ledger_intent_kind'
import { createMultitableCopySheetRoutes } from '../../src/routes/multitable-copy-sheet'
import { acquireCanonicalSheetFence } from '../../src/multitable/canonical-sheet-fence'
import { assertSheetNotCopiedFromPluginManaged } from '../../src/multitable/copied-sheet-plugin-scope'
import { MultitableSheetScopeError } from '../../src/multitable/plugin-scope'
import { loadDeniedRecordIds } from '../../src/multitable/permission-service'
import { invalidateUserPerms } from '../../src/rbac/service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

export function defineCopySheetRealDbCases(): void {
  test('copy-sheet real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the copy-sheet real-DB cases would skip-green')
    }
  })

  // unique per module evaluation so two hosts in one process can never collide on ids
  const TS = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const ADMIN = `u_cps_admin_${TS}`
  const WRITER = `u_cps_writer_${TS}`
  const WRITER_MASKED = `u_cps_masked_${TS}`
  const SCOPED_READER = `u_cps_scoped_${TS}`
  const WRITE_OWN = `u_cps_writeown_${TS}`
  const DENIED_A = `u_cps_denied_a_${TS}`
  const DENIED_B = `u_cps_denied_b_${TS}`
  const DENIED_C = `u_cps_denied_c_${TS}`
  const TAINTED = `u_cps_tainted_${TS}` // G13: masked on a FOREIGN field
  const REVOKED = `u_cps_revoked_${TS}` // G14: sheet grant revoked mid-copy
  const ALL_USERS = [ADMIN, WRITER, WRITER_MASKED, SCOPED_READER, WRITE_OWN, DENIED_A, DENIED_B, DENIED_C, TAINTED, REVOKED]

  const BASE = `base_cps_${TS}`
  const FOREIGN = `sheet_cps_foreign_${TS}`
  const SRC = `sheet_cps_src_${TS}` // row-level ON, rule, all field types
  const SRC_B = `sheet_cps_broken_${TS}` // broken link → rollback; field mask for WRITER_MASKED
  const SRC_C = `sheet_cps_managed_${TS}` // registry row → plugin-managed snapshot
  const SRC_D = `sheet_cps_plain_${TS}` // plain: scoped reader / idempotency / concurrency
  const SRC_E = `sheet_cps_autorule_${TS}` // auto-number rule + renumbering
  const SRC_T = `sheet_cps_taint_${TS}` // G13: lookup + formula over a FOREIGN field
  const SRC_R = `sheet_cps_race_${TS}` // G12: fence holder race
  const SRC_V = `sheet_cps_revoke_${TS}` // G14: concurrent revoke
  const SRC_W = `sheet_cps_tripwire_${TS}` // G15: tripwire

  const F = {
    title: `fld_cps_title_${TS}`,
    status: `fld_cps_status_${TS}`,
    num: `fld_cps_num_${TS}`,
    link: `fld_cps_link_${TS}`,
    auto: `fld_cps_auto_${TS}`,
    formula: `fld_cps_formula_${TS}`,
    att: `fld_cps_att_${TS}`,
    btn: `fld_cps_btn_${TS}`,
    hidden: `fld_cps_hidden_${TS}`,
  }
  const FNAME = `fld_cps_fname_${TS}`
  const FNUM = `fld_cps_fnum_${TS}`
  const T = { link: `fld_cps_t_link_${TS}`, lookup: `fld_cps_t_lookup_${TS}`, formula: `fld_cps_t_formula_${TS}` }
  const REC = (i: number) => `rec_cps_${i}_${TS}`
  const VIEW_1 = `view_cps_1_${TS}`
  const VIEW_2 = `view_cps_2_${TS}`

  const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

  let app: Express
  let currentUserId = ADMIN
  let currentRoles: string[] = ['admin']
  const spyOnEmit = () => vi.spyOn(eventBus, 'emit')
  let emitSpy: ReturnType<typeof spyOnEmit>

  const as = (userId: string, roles: string[] = []) => { currentUserId = userId; currentRoles = roles }
  const copy = (sheetId: string, body: Record<string, unknown> = { withData: true, permissionMode: 'inherit' }) =>
    request(app).post(`/api/multitable/sheets/${sheetId}/copy`).send(body)
  const dryRun = (sheetId: string, body: Record<string, unknown> = { withData: true, permissionMode: 'inherit' }) =>
    request(app).post(`/api/multitable/sheets/${sheetId}/copy/dry-run`).send(body)

  const copiesOf = async (sourceId: string) =>
    (await q('SELECT id, name, copied_from_kind, copied_at, row_level_read_permissions_enabled, conditional_read_rules FROM meta_sheets WHERE copied_from_sheet_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC', [sourceId])).rows as Array<Record<string, unknown>>

  const CONTENT_TABLES = ['meta_sheets', 'meta_fields', 'meta_views', 'meta_records', 'meta_links', 'spreadsheet_permissions', 'field_permissions', 'meta_view_permissions', 'record_permissions', 'meta_record_revisions', 'meta_config_revisions', 'operation_audit_logs', 'meta_multitable_template_installs']
  async function rowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const t of CONTENT_TABLES) out[t] = Number(((await q(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n)
    return out
  }

  async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const copyParkedOnFence = () => waitUntil(async () => (await q(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows.length > 0, 'the copy to park on the canonical fence')
  const copyParkedOnRowLock = () => waitUntil(async () => (await q(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM meta_sheets WHERE id = $1 FOR UPDATE%'`)).rows.length > 0, 'the copy to park on the source row lock')

  async function seedSheet(id: string, name: string, opts: { rowLevel?: boolean; rules?: unknown[] } = {}) {
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, row_level_read_permissions_enabled, conditional_read_rules) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, BASE, name, opts.rowLevel === true, JSON.stringify(opts.rules ?? [])],
    )
  }
  async function seedField(sheetId: string, id: string, type: string, property: Record<string, unknown> = {}, order = 0) {
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, sheetId, id.replace(`_${TS}`, ''), type, JSON.stringify(property), order])
  }
  async function seedRecord(sheetId: string, id: string, data: Record<string, unknown>, createdBy: string | null, createdAtIso: string) {
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, created_at) VALUES ($1,$2,$3::jsonb,1,$4,$4,$5::timestamptz)', [id, sheetId, JSON.stringify(data), createdBy, createdAtIso])
  }
  async function grantGlobal(userId: string, codes: string[]) {
    for (const code of codes) await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, code])
  }

  describeIfDatabase('copy-sheet S1 (real DB)', () => {
    beforeAll(async () => {
      // The feature's own migrations, applied idempotently — proves the DDL runs on a real server, not just reads well.
      await addProvenance(db as never)
      await addIntentKind(db as never)
      emitSpy = spyOnEmit()

      app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { user?: unknown }).user = { id: currentUserId, roles: currentRoles, perms: [] }
        next()
      })
      app.use('/api/multitable', createMultitableCopySheetRoutes())

      for (const code of ['multitable:read', 'multitable:write', 'multitable:base:write']) {
        await q(`INSERT INTO permissions (code, name, description) VALUES ($1, $1, 'CPS test') ON CONFLICT (code) DO NOTHING`, [code])
      }
      for (const id of ALL_USERS) {
        await q(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
           ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = FALSE, role = 'user'`,
          [id, `${id}@example.test`],
        )
        await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`, [id])
      }
      for (const id of [ADMIN, WRITER, WRITER_MASKED, SCOPED_READER, WRITE_OWN, TAINTED, REVOKED]) await grantGlobal(id, ['multitable:read', 'multitable:write'])
      for (const id of [DENIED_A, DENIED_B, DENIED_C]) await grantGlobal(id, ['multitable:read'])
      // The target gate is resolveCopyTargetWritable (CS-3 / §4.2, amended 2026-09-28): platform admin ROLE OR
      // resolveBaseWritable (`multitable:base:write` OR base ownership). ADMIN owns the base here (so this fixture does
      // not exercise the role arm — that is pinned on the fake by routes H11 / service E19); the non-admin copiers need
      // the code (plain `multitable:write` is NOT a base-write code). WRITER and WRITER_MASKED deliberately do NOT get
      // it — their cases are refused by the SOURCE gate first (G1/G1b), which is what pins the gate ORDER: source 403
      // before target 403.
      await grantGlobal(SCOPED_READER, ['multitable:base:write'])
      await grantGlobal(TAINTED, ['multitable:base:write'])
      await grantGlobal(REVOKED, ['multitable:base:write'])
      for (const id of ALL_USERS) invalidateUserPerms(id)

      await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE, 'CPS Base', ADMIN])
      await seedSheet(FOREIGN, 'Foreign')
      await seedField(FOREIGN, FNAME, 'string', {}, 0)
      await seedField(FOREIGN, FNUM, 'number', {}, 1)
      await seedRecord(FOREIGN, `rec_cps_f1_${TS}`, { [FNAME]: 'F1', [FNUM]: 7 }, ADMIN, '2026-09-01T00:00:00Z')
      await seedRecord(FOREIGN, `rec_cps_f2_${TS}`, { [FNAME]: 'F2', [FNUM]: 11 }, ADMIN, '2026-09-01T00:00:01Z')

      // SRC — the full fixture
      await seedSheet(SRC, '备料主表', { rowLevel: true, rules: [{ id: 'rule_num', fieldId: F.num, operator: 'gt', value: 100, effect: 'deny_read' }] })
      await seedField(SRC, F.title, 'string', { validation: [{ type: 'required' }] }, 0)
      await seedField(SRC, F.status, 'select', { options: [{ value: 'open' }, { value: 'done' }] }, 1)
      await seedField(SRC, F.num, 'number', {}, 2)
      await seedField(SRC, F.link, 'link', { foreignSheetId: FOREIGN, limitSingleRecord: false }, 3)
      await seedField(SRC, F.auto, 'autoNumber', { start: 1 }, 4)
      await seedField(SRC, F.formula, 'formula', { expression: `={${F.num}} * 2` }, 5)
      await seedField(SRC, F.att, 'attachment', {}, 6)
      await seedField(SRC, F.btn, 'button', { label: 'Ship', actionType: 'send_webhook', actionConfig: { url: 'https://hook.invalid/x', secret: 'hmac-secret-cps' } }, 7)
      await seedField(SRC, F.hidden, 'string', { hidden: true }, 8)
      await q(`INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config) VALUES ($1,$2,$3,'grid',$4::jsonb,'{}','{}','[]',$5::jsonb)`, [
        VIEW_1, SRC, '默认视图',
        JSON.stringify({ conjunction: 'and', conditions: [{ fieldId: F.title, operator: 'contains', value: 'a' }, { fieldId: F.att, operator: 'is_not_empty' }] }),
        JSON.stringify({ publicForm: { enabled: true, publicToken: 'tok_cps_secret' }, kanban: { groupFieldId: F.status }, frozenLeftColumnIds: [F.title], columnWidths: { [F.title]: 240, [F.att]: 90 }, aggregations: { [F.num]: 'sum' } }),
      ])
      await q(`INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config) VALUES ($1,$2,$3,'grid','{}','{}','{}',$4::jsonb,'{}')`, [VIEW_2, SRC, '第二视图', JSON.stringify([F.hidden])])
      // rows seeded in REVERSE order with ASCENDING created_at so "source order" means created_at order
      const rows: Array<{ data: Record<string, unknown>; by: string | null }> = [
        { data: { [F.title]: 'cell-alpha', [F.status]: 'open', [F.num]: 1, [F.auto]: 1, [F.att]: ['att_cps_1'], [F.hidden]: 'hidden-1' }, by: WRITE_OWN },
        { data: { [F.title]: 'cell-beta', [F.status]: 'archived', [F.num]: null, [F.auto]: 2, [F.hidden]: 'hidden-2' }, by: ADMIN },
        { data: { [F.title]: 'cell-gamma', [F.status]: '', [F.num]: 3, [F.auto]: 3 }, by: WRITE_OWN },
        { data: { [F.title]: 'cell-delta', [F.num]: 4, [F.auto]: 4 }, by: null },
        { data: { [F.title]: 'cell-epsilon', [F.num]: 5, [F.auto]: 5 }, by: SCOPED_READER },
        { data: { [F.title]: 'cell-zeta', [F.num]: 200, [F.auto]: 6 }, by: ADMIN },
      ]
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        await seedRecord(SRC, REC(i + 1), rows[i]!.data, rows[i]!.by, `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`)
      }
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_cps_1_${TS}`, F.link, REC(1), `rec_cps_f1_${TS}`])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_cps_2_${TS}`, F.link, REC(2), `rec_cps_f2_${TS}`])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_cps_3_${TS}`, F.link, REC(2), `rec_cps_f1_${TS}`])
      for (const [uid, code] of [[SCOPED_READER, 'spreadsheet:read'], [WRITE_OWN, 'spreadsheet:write-own'], [DENIED_A, 'spreadsheet:read'], [DENIED_B, 'spreadsheet:read'], [DENIED_C, 'spreadsheet:read']] as const) {
        await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SRC, uid, 'user', uid, code])
      }
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SRC, F.hidden, 'user', SCOPED_READER, false, true])
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SRC, F.num, 'user', DENIED_A, true, true])
      await q('INSERT INTO meta_view_permissions (view_id, subject_type, subject_id, permission) VALUES ($1,$2,$3,$4)', [VIEW_2, 'user', SCOPED_READER, 'read'])
      for (const [rec, uid] of [[REC(2), DENIED_A], [REC(3), DENIED_A], [REC(4), DENIED_B], [REC(5), DENIED_C]] as const) {
        await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level, created_by) VALUES ($1,$2,'user',$3,'none',$4)`, [SRC, rec, uid, ADMIN])
      }
      await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level, created_by) VALUES ($1,$2,'user',$3,'write',$4)`, [SRC, REC(1), SCOPED_READER, ADMIN])

      // SRC_B — broken link (rollback) + a field mask for WRITER_MASKED (axis 2)
      await seedSheet(SRC_B, 'Broken')
      await seedField(SRC_B, `fld_cps_b_title_${TS}`, 'string', {}, 0)
      await seedField(SRC_B, `fld_cps_b_link_${TS}`, 'link', { foreignSheetId: FOREIGN, limitSingleRecord: true }, 1)
      await seedRecord(SRC_B, `rec_cps_b1_${TS}`, { [`fld_cps_b_title_${TS}`]: 'b-alpha' }, ADMIN, '2026-09-02T00:00:00Z')
      await seedRecord(SRC_B, `rec_cps_b2_${TS}`, { [`fld_cps_b_title_${TS}`]: 'b-beta' }, ADMIN, '2026-09-02T00:01:00Z')
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_cps_b_${TS}`, `fld_cps_b_link_${TS}`, `rec_cps_b2_${TS}`, `rec_cps_missing_${TS}`])
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SRC_B, `fld_cps_b_title_${TS}`, 'user', WRITER_MASKED, false, true])

      // SRC_C — managed
      await seedSheet(SRC_C, 'Managed')
      await seedField(SRC_C, `fld_cps_c_title_${TS}`, 'string', {}, 0)
      await seedRecord(SRC_C, `rec_cps_c1_${TS}`, { [`fld_cps_c_title_${TS}`]: 'c-alpha' }, ADMIN, '2026-09-03T00:00:00Z')
      await q('INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name) VALUES ($1,$2,$3,$4)', [SRC_C, `tenant_cps_${TS}:integration-core`, `obj_cps_${TS}`, 'plugin-integration-core'])

      // SRC_D — plain
      await seedSheet(SRC_D, 'Plain')
      await seedField(SRC_D, `fld_cps_d_title_${TS}`, 'string', {}, 0)
      await seedRecord(SRC_D, `rec_cps_d1_${TS}`, { [`fld_cps_d_title_${TS}`]: 'd-alpha' }, ADMIN, '2026-09-04T00:00:00Z')
      await seedRecord(SRC_D, `rec_cps_d2_${TS}`, { [`fld_cps_d_title_${TS}`]: 'd-beta' }, WRITE_OWN, '2026-09-04T00:01:00Z')
      await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SRC_D, SCOPED_READER, 'user', SCOPED_READER, 'spreadsheet:read'])

      // SRC_E — auto-number rule + renumbering (values 10..12 vs a fresh 1..3)
      await seedSheet(SRC_E, 'AutoRule', { rowLevel: true, rules: [{ id: 'rule_auto', fieldId: `fld_cps_e_auto_${TS}`, operator: 'gt', value: 11, effect: 'deny_read' }] })
      await seedField(SRC_E, `fld_cps_e_auto_${TS}`, 'autoNumber', { start: 1 }, 0)
      for (let i = 0; i < 3; i += 1) {
        await seedRecord(SRC_E, `rec_cps_e${i}_${TS}`, { [`fld_cps_e_auto_${TS}`]: 10 + i }, ADMIN, `2026-09-05T00:0${i}:00Z`)
      }

      // SRC_T — lookup over FOREIGN.fnum + formula over the lookup; TAINTED is masked on FOREIGN.fnum (axis 3)
      await seedSheet(SRC_T, 'Taint')
      await seedField(SRC_T, T.link, 'link', { foreignSheetId: FOREIGN, limitSingleRecord: true }, 0)
      await seedField(SRC_T, T.lookup, 'lookup', { linkFieldId: T.link, targetFieldId: FNUM, foreignSheetId: FOREIGN }, 1)
      await seedField(SRC_T, T.formula, 'formula', { expression: `={${T.lookup}} + 1` }, 2)
      await seedRecord(SRC_T, `rec_cps_t1_${TS}`, {}, ADMIN, '2026-09-06T00:00:00Z')
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_cps_t1_${TS}`, T.link, `rec_cps_t1_${TS}`, `rec_cps_f1_${TS}`])
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FOREIGN, FNUM, 'user', TAINTED, false, true])

      // SRC_R / SRC_V / SRC_W — one plain sheet per concurrency case so their row counts stay independent
      for (const [id, name] of [[SRC_R, 'Race'], [SRC_V, 'Revoke'], [SRC_W, 'Tripwire']] as const) {
        await seedSheet(id, name)
        await seedField(id, `fld_cps_${name.toLowerCase()}_title_${TS}`, 'string', {}, 0)
        await seedRecord(id, `rec_cps_${name.toLowerCase()}1_${TS}`, { [`fld_cps_${name.toLowerCase()}_title_${TS}`]: `${name}-alpha` }, ADMIN, '2026-09-07T00:00:00Z')
        await seedRecord(id, `rec_cps_${name.toLowerCase()}2_${TS}`, { [`fld_cps_${name.toLowerCase()}_title_${TS}`]: `${name}-beta` }, ADMIN, '2026-09-07T00:01:00Z')
      }
      await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SRC_V, REVOKED, 'user', REVOKED, 'spreadsheet:read'])
    })

    afterAll(async () => {
      const ids = ((await q('SELECT id FROM meta_sheets WHERE base_id = $1', [BASE])).rows as Array<{ id: string }>).map((r) => r.id)
      const viewIds = ((await q('SELECT id FROM meta_views WHERE sheet_id = ANY($1::text[])', [ids])).rows as Array<{ id: string }>).map((r) => r.id)
      for (const [table, col, values] of [
        ['record_permissions', 'sheet_id', ids], ['field_permissions', 'sheet_id', ids], ['spreadsheet_permissions', 'sheet_id', ids],
        ['meta_view_permissions', 'view_id', viewIds], ['meta_record_revisions', 'sheet_id', ids], ['meta_config_revisions', 'sheet_id', ids],
        ['operation_audit_logs', 'resource_id', ids], ['plugin_multitable_object_registry', 'sheet_id', ids],
        ['formula_dependencies', 'sheet_id', ids], ['meta_field_auto_number_sequences', 'sheet_id', ids],
      ] as const) {
        await q(`DELETE FROM ${table} WHERE ${col} = ANY($1::text[])`, [values]).catch(() => {})
      }
      await q('DELETE FROM meta_multitable_template_installs WHERE actor_id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE base_id = $1', [BASE]).catch(() => {}) // cascades fields / records / links / views
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
      await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
      await q('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
      await q('DELETE FROM users WHERE id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
      emitSpy?.mockRestore()
    })

    test('G1 non-admin writer on a row-level sheet → 403 COPY_SOURCE_NOT_FULLY_READABLE, no count, one refusal audit row (copy + dry-run)', async () => {
      as(WRITER)
      const before = Number(((await q(`SELECT COUNT(*)::int AS n FROM operation_audit_logs WHERE resource_id = $1 AND action = 'multitable.sheet.copy'`, [SRC])).rows[0] as { n: number }).n)
      for (const send of [dryRun, copy]) {
        const res = await send(SRC)
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body.error.code).toBe('COPY_SOURCE_NOT_FULLY_READABLE')
        expect(res.body.error).not.toHaveProperty('details')
        expect(JSON.stringify(res.body)).not.toMatch(/count|hidden|rows/i)
      }
      const after = Number(((await q(`SELECT COUNT(*)::int AS n FROM operation_audit_logs WHERE resource_id = $1 AND action = 'multitable.sheet.copy'`, [SRC])).rows[0] as { n: number }).n)
      expect(after - before).toBe(2)
      expect(await copiesOf(SRC)).toHaveLength(0)
    })

    test('G1b a writer masked on ONE column by field_permissions → the same 403 (axis 2)', async () => {
      as(WRITER_MASKED)
      for (const send of [dryRun, copy]) {
        const res = await send(SRC_B)
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body.error.code).toBe('COPY_SOURCE_NOT_FULLY_READABLE')
      }
      expect(await copiesOf(SRC_B)).toHaveLength(0)
    })

    test('G2 a table-level reader (global write + sheet read grant) copies successfully — server constant capabilities', async () => {
      as(SCOPED_READER)
      const res = await copy(SRC_D, { withData: true, permissionMode: 'inherit', name: `Plain-scoped-${TS}` })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const newId = res.body.data.sheet.id as string
      const records = (await q('SELECT created_by FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC', [newId])).rows as Array<{ created_by: string | null }>
      expect(records.map((r) => r.created_by)).toEqual([ADMIN, WRITE_OWN])
      // the copier's OWN sheet grant is copied as-is — no extra row minted for him
      const grants = (await q('SELECT subject_id, perm_code FROM spreadsheet_permissions WHERE sheet_id = $1', [newId])).rows
      expect(grants).toEqual([{ subject_id: SCOPED_READER, perm_code: 'spreadsheet:read' }])
    })

    test('G3 admin copy of the row-level sheet: structure, permissions, deny parity, order, values, revisions, audit, ledger', async () => {
      as(ADMIN, ['admin'])
      emitSpy.mockClear()
      const res = await copy(SRC)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const data = res.body.data
      const NEW = data.sheet.id as string
      expect(data.sheet).toEqual({ id: NEW, baseId: BASE, name: '备料主表 副本', copiedFrom: { kind: 'user', at: null, sheetId: SRC } })
      expect(JSON.stringify(res.body)).not.toMatch(/cell-|hidden-1|hmac-secret|tok_cps/)
      expect(data.summary.overLimit).toBe(false)
      expect(data.formulaRecompute).toMatchObject({ attempted: 6, recomputed: 6, failed: false })

      // provenance + sheet-level config
      const [sheet] = await copiesOf(SRC)
      expect(sheet).toMatchObject({ id: NEW, copied_from_kind: 'user', row_level_read_permissions_enabled: true })
      expect(sheet!.copied_at).toBeTruthy()
      const fieldRows = (await q('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC', [NEW])).rows as Array<{ id: string; name: string; type: string; property: Record<string, unknown> }>
      expect(fieldRows).toHaveLength(9)
      const byName = new Map(fieldRows.map((f) => [f.name, f]))
      const nf = (key: keyof typeof F) => byName.get(F[key].replace(`_${TS}`, ''))!
      expect((sheet!.conditional_read_rules as Array<{ fieldId: string }>)[0]!.fieldId).toBe(nf('num').id)
      expect(nf('btn').property.actionType).toBe('record_click')
      expect(nf('btn').property).not.toHaveProperty('actionConfig')
      expect(nf('hidden').property.hidden).toBe(true)
      expect(nf('formula').property.expression).toBe(`={${nf('num').id}} * 2`)

      // views: filter leaf on the attachment dropped, publicForm stripped, hidden remapped, FE-1 keys remapped
      const views = (await q('SELECT id, name, filter_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC', [NEW])).rows as Array<Record<string, unknown>>
      expect(views.map((v) => v.name)).toEqual(['默认视图', '第二视图'])
      expect((views[0]!.filter_info as { conditions: unknown[] }).conditions).toEqual([{ fieldId: nf('title').id, operator: 'contains', value: 'a' }])
      expect(views[0]!.config).toEqual({
        kanban: { groupFieldId: nf('status').id },
        frozenLeftColumnIds: [nf('title').id],
        columnWidths: { [nf('title').id]: 240, [nf('att').id]: 90 },
        aggregations: { [nf('num').id]: 'sum' },
      })
      expect(views[1]!.hidden_field_ids).toEqual([nf('hidden').id])
      expect(data.summary.droppedViewFilterLeaves).toEqual([{ viewId: VIEW_1, count: 1 }])

      // records: source order, created_by, values (the admin holds canManageFields → hidden values copied; '' kept)
      const records = (await q('SELECT id, data, created_by, modified_by FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC', [NEW])).rows as Array<{ id: string; data: Record<string, unknown>; created_by: string | null; modified_by: string | null }>
      expect(records).toHaveLength(6)
      expect(records.map((r) => r.created_by)).toEqual([WRITE_OWN, ADMIN, WRITE_OWN, null, SCOPED_READER, ADMIN])
      expect(records.every((r) => r.modified_by === ADMIN)).toBe(true)
      const t = nf('title').id, st = nf('status').id, nm = nf('num').id, ln = nf('link').id, au = nf('auto').id, hd = nf('hidden').id, fm = nf('formula').id
      const sansFormula = records.map((r) => { const { [fm]: _formula, ...rest } = r.data; return rest })
      expect(sansFormula).toEqual([
        { [t]: 'cell-alpha', [st]: 'open', [nm]: 1, [ln]: [`rec_cps_f1_${TS}`], [au]: 1, [hd]: 'hidden-1' },
        { [t]: 'cell-beta', [st]: 'archived', [ln]: [`rec_cps_f2_${TS}`, `rec_cps_f1_${TS}`], [au]: 2, [hd]: 'hidden-2' },
        { [t]: 'cell-gamma', [st]: '', [nm]: 3, [au]: 3 },
        { [t]: 'cell-delta', [nm]: 4, [au]: 4 },
        { [t]: 'cell-epsilon', [nm]: 5, [au]: 5 },
        { [t]: 'cell-zeta', [nm]: 200, [au]: 6 },
      ])
      // the post-commit recompute materialised the formula on every row (num * 2)
      expect(Number(records[0]!.data[fm])).toBe(2)
      expect(Number(records[5]!.data[fm])).toBe(400)
      expect(JSON.stringify(records)).not.toContain('att_cps_1')
      const linkRows = (await q('SELECT record_id, foreign_record_id FROM meta_links WHERE field_id = $1', [ln])).rows as Array<{ record_id: string; foreign_record_id: string }>
      expect(linkRows.map((l) => [l.record_id, l.foreign_record_id]).sort()).toEqual([
        [records[0]!.id, `rec_cps_f1_${TS}`], [records[1]!.id, `rec_cps_f1_${TS}`], [records[1]!.id, `rec_cps_f2_${TS}`],
      ].sort())

      // permissions 1:1 with remap; no row for the copier
      const sp = (await q('SELECT subject_type, subject_id, perm_code, user_id FROM spreadsheet_permissions WHERE sheet_id = $1 ORDER BY subject_id, perm_code', [NEW])).rows
      const spSrc = (await q('SELECT subject_type, subject_id, perm_code, user_id FROM spreadsheet_permissions WHERE sheet_id = $1 ORDER BY subject_id, perm_code', [SRC])).rows
      expect(sp).toEqual(spSrc)
      expect((sp as Array<{ subject_id: string }>).some((r) => r.subject_id === ADMIN)).toBe(false)
      const fp = (await q('SELECT field_id, subject_id, visible, read_only, created_by FROM field_permissions WHERE sheet_id = $1 ORDER BY field_id', [NEW])).rows as Array<Record<string, unknown>>
      expect(fp.map((r) => [r.field_id, r.subject_id, r.visible, r.read_only]).sort()).toEqual([[nf('hidden').id, SCOPED_READER, false, true], [nf('num').id, DENIED_A, true, true]].sort())
      expect(fp.every((r) => typeof r.created_by === 'string')).toBe(true)
      const vp = (await q('SELECT subject_id, permission FROM meta_view_permissions WHERE view_id = $1', [views[1]!.id])).rows
      expect(vp).toEqual([{ subject_id: SCOPED_READER, permission: 'read' }])
      const rp = (await q('SELECT record_id, subject_id, access_level FROM record_permissions WHERE sheet_id = $1', [NEW])).rows as Array<{ record_id: string; subject_id: string; access_level: string }>
      const newIdOf = (i: number) => records[i - 1]!.id
      expect(rp.map((r) => [r.record_id, r.subject_id, r.access_level]).sort()).toEqual([
        [newIdOf(1), SCOPED_READER, 'write'], [newIdOf(2), DENIED_A, 'none'], [newIdOf(3), DENIED_A, 'none'], [newIdOf(4), DENIED_B, 'none'], [newIdOf(5), DENIED_C, 'none'],
      ].sort())
      // DENY PARITY against the real read-side loader (grant-deny ∪ rule-deny): map(src) == new, per subject
      const map = new Map<string, string>([1, 2, 3, 4, 5, 6].map((i) => [REC(i), newIdOf(i)]))
      for (const uid of [DENIED_A, DENIED_B, DENIED_C, SCOPED_READER]) {
        const src = await loadDeniedRecordIds(q as never, SRC, uid)
        const copyDenied = await loadDeniedRecordIds(q as never, NEW, uid)
        expect([...copyDenied].sort()).toEqual([...src].map((id) => map.get(id)!).sort())
      }
      // the rule arm really denies the same row (num = 200 > 100) on both sides
      expect((await loadDeniedRecordIds(q as never, NEW, DENIED_B))).toContain(newIdOf(6))

      // revisions: ONE batch, source copy-sheet; config revisions share it
      const revs = (await q('SELECT batch_id, source, action FROM meta_record_revisions WHERE sheet_id = $1', [NEW])).rows as Array<{ batch_id: string; source: string; action: string }>
      expect(revs.filter((r) => r.action === 'create')).toHaveLength(6)
      expect(new Set(revs.filter((r) => r.action === 'create').map((r) => r.batch_id))).toEqual(new Set([data.batchId]))
      expect(revs.filter((r) => r.action === 'create').every((r) => r.source === 'copy-sheet')).toBe(true)
      const config = (await q('SELECT entity_type, batch_id::text AS batch_id FROM meta_config_revisions WHERE sheet_id = $1', [NEW])).rows as Array<{ entity_type: string; batch_id: string }>
      expect(config.filter((c) => c.entity_type === 'field')).toHaveLength(9)
      expect(config.filter((c) => c.entity_type === 'view')).toHaveLength(2)
      expect(config.filter((c) => c.entity_type === 'permission')).toHaveLength(5 + 2 + 1)
      expect(new Set(config.map((c) => c.batch_id))).toEqual(new Set([data.batchId]))

      // audit (two rows) + ledger + no registry row
      const audit = (await q(`SELECT action, resource_id FROM operation_audit_logs WHERE (metadata ->> 'targetSheetId') = $1 ORDER BY action`, [NEW])).rows
      expect(audit).toEqual([{ action: 'multitable.sheet.copy', resource_id: NEW }, { action: 'multitable.sheet.copy-source', resource_id: SRC }])
      const ledger = (await q(`SELECT intent_kind, sheet_ids FROM meta_multitable_template_installs WHERE actor_id = $1 AND $2 = ANY(sheet_ids)`, [ADMIN, NEW])).rows
      expect(ledger).toEqual([{ intent_kind: 'copy-sheet', sheet_ids: [NEW] }])
      expect((await q('SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1', [NEW])).rows).toHaveLength(0)

      // G4 (bus leg, flag off): no per-row event, exactly one sheet-level event
      const events = emitSpy.mock.calls.map((c) => c[0])
      expect(events.filter((e) => e === 'multitable.record.created')).toHaveLength(0)
      expect(events.filter((e) => e === 'multitable.sheet.copied')).toHaveLength(1)
      expect((await q(`SELECT COUNT(*)::int AS n FROM meta_automation_outbox WHERE payload ->> 'sheetId' = $1`, [NEW])).rows[0]).toEqual({ n: 0 })
    })

    test('G4 durable leg: with AUTOMATION_DURABLE_DELIVERY_ENABLED=true the copy still enqueues nothing', async () => {
      const prev = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
      process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
      try {
        as(ADMIN, ['admin'])
        emitSpy.mockClear()
        const res = await copy(SRC_D, { withData: true, permissionMode: 'inherit', name: `Plain-durable-${TS}` })
        expect(res.status, JSON.stringify(res.body)).toBe(201)
        const NEW = res.body.data.sheet.id as string
        expect((await q(`SELECT COUNT(*)::int AS n FROM meta_automation_outbox WHERE payload ->> 'sheetId' = $1`, [NEW])).rows[0]).toEqual({ n: 0 })
        expect(emitSpy.mock.calls.filter((c) => c[0] === 'multitable.record.created')).toHaveLength(0)
      } finally {
        if (prev === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
        else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = prev
      }
    })

    test('G5 all-or-nothing: a missing link target → 422 { rowIndex, fieldId, code }, zero rows for the copy, one refusal audit', async () => {
      as(ADMIN, ['admin'])
      const ledgerBefore = Number(((await q(`SELECT COUNT(*)::int AS n FROM meta_multitable_template_installs WHERE actor_id = $1`, [ADMIN])).rows[0] as { n: number }).n)
      const res = await copy(SRC_B)
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('COPY_ROW_VALIDATION_FAILED')
      expect(res.body.error.details).toEqual({ rowIndex: 1, fieldId: `fld_cps_b_link_${TS}`, code: 'LINK_TARGET_NOT_FOUND' })
      expect(JSON.stringify(res.body)).not.toMatch(/b-alpha|b-beta|rec_cps_missing/)
      expect(await copiesOf(SRC_B)).toHaveLength(0)
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_sheets WHERE copied_from_sheet_id = $1', [SRC_B])).rows[0]).toEqual({ n: 0 })
      expect(Number(((await q(`SELECT COUNT(*)::int AS n FROM meta_multitable_template_installs WHERE actor_id = $1`, [ADMIN])).rows[0] as { n: number }).n)).toBe(ledgerBefore)
      const audit = (await q(`SELECT metadata FROM operation_audit_logs WHERE resource_id = $1 AND action = 'multitable.sheet.copy'`, [SRC_B])).rows as Array<{ metadata: Record<string, unknown> }>
      expect(audit.filter((a) => a.metadata.errorCode === 'COPY_ROW_VALIDATION_FAILED')).toHaveLength(1)
    })

    test('G6 managed source: plugin-managed snapshot, no registry row, plugin-scope deny for another plugin; a copy OF the snapshot stays plugin-managed (SEC-1)', async () => {
      as(ADMIN, ['admin'])
      const res = await copy(SRC_C)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const NEW = res.body.data.sheet.id as string
      expect(res.body.data.sheet.copiedFrom.kind).toBe('plugin-managed')
      expect((await q('SELECT copied_from_kind FROM meta_sheets WHERE id = $1', [NEW])).rows[0]).toEqual({ copied_from_kind: 'plugin-managed' })
      expect((await q('SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1', [NEW])).rows).toHaveLength(0)
      await expect(assertSheetNotCopiedFromPluginManaged(q as never, { pluginName: 'plugin-attendance', sheetId: NEW })).rejects.toBeInstanceOf(MultitableSheetScopeError)
      await expect(assertSheetNotCopiedFromPluginManaged(q as never, { pluginName: 'plugin-integration-core', sheetId: NEW })).rejects.toBeInstanceOf(MultitableSheetScopeError)
      await expect(assertSheetNotCopiedFromPluginManaged(q as never, { pluginName: 'plugin-attendance', sheetId: SRC_C })).resolves.toBeUndefined()
      // second generation: the snapshot has no registry row, only the provenance column says what it is
      const grand = await copy(NEW, { withData: true, permissionMode: 'inherit', name: `Managed-grandchild-${TS}` })
      expect(grand.status, JSON.stringify(grand.body)).toBe(201)
      expect(grand.body.data.sheet.copiedFrom.kind).toBe('plugin-managed')
      await expect(assertSheetNotCopiedFromPluginManaged(q as never, { pluginName: 'plugin-attendance', sheetId: grand.body.data.sheet.id })).rejects.toBeInstanceOf(MultitableSheetScopeError)
    })

    test('G7 idempotency: same intent ×3 → one sheet + replays; a changed withData → a new sheet', async () => {
      as(ADMIN, ['admin'])
      const name = `Plain-idem-${TS}`
      const first = await copy(SRC_D, { withData: true, permissionMode: 'inherit', name })
      expect(first.status).toBe(201)
      expect(first.headers['idempotent-replayed']).toBeUndefined()
      for (let i = 0; i < 2; i += 1) {
        const again = await copy(SRC_D, { withData: true, permissionMode: 'inherit', name })
        expect(again.status).toBe(201)
        expect(again.headers['idempotent-replayed']).toBe('true')
        const { formulaRecompute: _omit, ...firstData } = first.body.data
        expect(again.body).toEqual({ ok: true, data: firstData })
      }
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_sheets WHERE copied_from_sheet_id = $1 AND name = $2', [SRC_D, name])).rows[0]).toEqual({ n: 1 })
      const other = await copy(SRC_D, { withData: false, permissionMode: 'inherit', name })
      expect(other.status).toBe(201)
      expect(other.headers['idempotent-replayed']).toBeUndefined()
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_sheets WHERE copied_from_sheet_id = $1 AND name = $2', [SRC_D, name])).rows[0]).toEqual({ n: 2 })
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [other.body.data.sheet.id])).rows[0]).toEqual({ n: 0 })
    })

    test('G8 concurrency: two simultaneous identical intents → both 201, exactly one replayed, exactly one sheet, no 40001', async () => {
      as(ADMIN, ['admin'])
      const name = `Plain-race-${TS}`
      const [a, b] = await Promise.all([
        copy(SRC_D, { withData: true, permissionMode: 'inherit', name }),
        copy(SRC_D, { withData: true, permissionMode: 'inherit', name }),
      ])
      expect([a.status, b.status]).toEqual([201, 201])
      const replayed = [a, b].filter((r) => r.headers['idempotent-replayed'] === 'true')
      expect(replayed).toHaveLength(1)
      expect(a.body.data.sheet.id).toBe(b.body.data.sheet.id)
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_sheets WHERE copied_from_sheet_id = $1 AND name = $2', [SRC_D, name])).rows[0]).toEqual({ n: 1 })
    })

    test('G9 a deny rule on an auto-number column that would renumber → 422 COPY_SOURCE_RULE_ON_RENUMBERED_FIELD', async () => {
      as(ADMIN, ['admin'])
      const res = await copy(SRC_E)
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('COPY_SOURCE_RULE_ON_RENUMBERED_FIELD')
      expect(res.body.error.details).toEqual({ fieldId: `fld_cps_e_auto_${TS}` })
      expect(await copiesOf(SRC_E)).toHaveLength(0)
      const dry = await dryRun(SRC_E)
      expect(dry.status).toBe(422)
    })

    test('G10 row cap from MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS → copy 413 COPY_TOO_LARGE { rowCount, limit }; dry-run 200 + summary.overLimit', async () => {
      const prev = process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
      process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS = '2'
      try {
        as(ADMIN, ['admin'])
        const before = await copiesOf(SRC)
        const res = await copy(SRC, { withData: true, permissionMode: 'inherit', name: `cap-${TS}` })
        expect(res.status).toBe(413)
        expect(res.body.error.code).toBe('COPY_TOO_LARGE')
        expect(res.body.error.details).toEqual({ rowCount: 6, limit: 2 })
        expect(await copiesOf(SRC)).toHaveLength(before.length)
        const dry = await dryRun(SRC)
        expect(dry.status, JSON.stringify(dry.body)).toBe(200)
        expect(dry.body.data.summary).toMatchObject({ overLimit: true, rowCount: 6, fieldCount: 9, limits: { maxRows: 2, maxFields: 500 } })
        expect(dry.body.data.summary.disclosures).toEqual(expect.arrayContaining([{ fieldId: F.att, code: 'ATTACHMENT_BLANKED' }, { fieldId: F.btn, code: 'BUTTON_DISABLED' }]))
      } finally {
        if (prev === undefined) delete process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
        else process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS = prev
      }
    })

    test('G11 dry-run leaves every content table at the same rowcount', async () => {
      as(ADMIN, ['admin'])
      const before = await rowCounts()
      const res = await dryRun(SRC)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data.summary).toMatchObject({ rowCount: 6, fieldCount: 9, viewCount: 2, recordPermissionRowCount: 5, rowLevelReadEnabled: true, conditionalRuleCount: 1, overLimit: false })
      expect(res.body.data.summary.disclosures).toEqual(expect.arrayContaining([
        { fieldId: F.att, code: 'ATTACHMENT_BLANKED' }, { fieldId: F.btn, code: 'BUTTON_DISABLED' },
      ]))
      expect(await rowCounts()).toEqual(before)
    })

    for (const flag of ['off', 'on'] as const) {
      test(`G12 lock order (writer fence flag ${flag}): a session holding the SOURCE fence inserts into the source while the copy is parked on that fence → both commit, copy 201, no 40P01`, async () => {
        const prev = process.env.MULTITABLE_ENABLE_WRITER_FENCE
        if (flag === 'on') process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
        else delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
        try {
          as(ADMIN, ['admin'])
          const pool = poolManager.get()
          let fenceTaken!: () => void
          const fenced = new Promise<void>((resolve) => { fenceTaken = resolve })
          let release!: () => void
          const released = new Promise<void>((resolve) => { release = resolve })
          const holderRecord = `rec_cps_holder_${flag}_${TS}`
          // T1 = a fenced source writer (createRecord's shape): fence(SRC_R) → INSERT meta_records(sheet_id = SRC_R),
          // whose FK takes FOR KEY SHARE on meta_sheets(SRC_R). It inserts only AFTER the copy is parked on the fence.
          const holder = pool.transaction(async ({ query }) => {
            await acquireCanonicalSheetFence(query as never, SRC_R)
            fenceTaken()
            await released
            await query('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [holderRecord, SRC_R, '{}'])
          })
          await fenced
          try {
            // supertest's Test is lazy — `.then` is what actually sends the request; without it the copy never starts.
            const copying = copy(SRC_R, { withData: true, permissionMode: 'inherit', name: `race-fence-${flag}-${TS}` }).then((r) => r)
            await copyParkedOnFence()
            // under row-lock-first ordering the copy would now hold meta_sheets(SRC_R) FOR UPDATE and this INSERT would
            // wait on it while the copy waits on the fence → 40P01. With fence-first the INSERT proceeds.
            release()
            await expect(holder).resolves.toBeUndefined()
            const res = await copying
            expect(res.status, JSON.stringify(res.body)).toBe(201)
            expect(res.headers['idempotent-replayed']).toBeUndefined()
            // the copy took its baseline AFTER the holder committed → the holder's row is part of the snapshot
            expect((await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [res.body.data.sheet.id])).rows[0]).toEqual({ n: flag === 'off' ? 3 : 4 })
          } finally {
            release() // never leave the holder parked (a leaked fence would hang every later case and the cleanup hook)
            await holder.catch(() => {})
          }
        } finally {
          if (prev === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
          else process.env.MULTITABLE_ENABLE_WRITER_FENCE = prev
        }
      })
    }

    test('G13 taint axis: a writer masked on a FOREIGN field read by a lookup → 403 on copy + dry-run; the admin copy materialises the formula-over-lookup from the HYDRATED value', async () => {
      as(TAINTED)
      for (const send of [dryRun, copy]) {
        const res = await send(SRC_T)
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body.error.code).toBe('COPY_SOURCE_NOT_FULLY_READABLE')
        expect(res.body.error).not.toHaveProperty('details')
      }
      expect(await copiesOf(SRC_T)).toHaveLength(0)
      // positive control + DATA-7: the admin (no mask) copies; lookup(fnum) = 7 on the linked row → formula 7 + 1 = 8
      as(ADMIN, ['admin'])
      const res = await copy(SRC_T)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.data.formulaRecompute).toMatchObject({ attempted: 1, recomputed: 1, failed: false })
      const NEW = res.body.data.sheet.id as string
      const formulaField = (await q(`SELECT id FROM meta_fields WHERE sheet_id = $1 AND type = 'formula'`, [NEW])).rows[0] as { id: string }
      const [row] = (await q('SELECT data FROM meta_records WHERE sheet_id = $1', [NEW])).rows as Array<{ data: Record<string, unknown> }>
      expect(Number(row!.data[formulaField.id])).toBe(8)
    })

    test('G14 concurrent revoke (r3-1): the copier\'s sheet grant is revoked by a session holding the source row lock while the copy is parked on it → in-transaction DB-fresh gate 403 FORBIDDEN, nothing written', async () => {
      as(REVOKED)
      // control: the grant is live, the out-of-transaction gate passes (dry-run 200)
      const probe = await dryRun(SRC_V)
      expect(probe.status, JSON.stringify(probe.body)).toBe(200)
      const pool = poolManager.get()
      let locked!: () => void
      const rowLocked = new Promise<void>((resolve) => { locked = resolve })
      let proceed!: () => void
      const mayRevoke = new Promise<void>((resolve) => { proceed = resolve })
      // T1 = an authorization PUT's shape: the SAME row lock (sheet-liveness.ts assertSheetLiveForUpdate) → revoke → COMMIT
      const revoker = pool.transaction(async ({ query }) => {
        await query('SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE', [SRC_V])
        locked()
        await mayRevoke
        await query('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = $2 AND subject_id = $3', [SRC_V, 'user', REVOKED])
      })
      await rowLocked
      let res: Awaited<ReturnType<typeof copy>>
      try {
        // supertest's Test is lazy — `.then` is what actually sends the request; without it the copy never starts.
        const copying = copy(SRC_V, { withData: true, permissionMode: 'inherit', name: `revoked-${TS}` }).then((r) => r)
        await copyParkedOnRowLock() // the fast gate passed (grant still live); the copy waits on the row lock
        proceed()
        await expect(revoker).resolves.toBeUndefined()
        res = await copying
      } finally {
        proceed() // never leave the revoker parked on a failed wait
        await revoker.catch(() => {})
      }
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
      expect(await copiesOf(SRC_V)).toHaveLength(0)
      expect((await q(`SELECT COUNT(*)::int AS n FROM meta_multitable_template_installs WHERE actor_id = $1`, [REVOKED])).rows[0]).toEqual({ n: 0 })
    })

    test('G15 tripwire (flag off): a source record bumped by another connection AFTER the baseline → 409 COPY_SOURCE_CHANGED, zero rows for the copy, no ledger row', async () => {
      delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      as(ADMIN, ['admin'])
      const pool = poolManager.get()
      const original = pool.transaction.bind(pool)
      let fired = 0
      // Park-free orchestration: the copy transaction is intercepted at its FIRST structure write (well after the
      // baseline) and a SECOND connection commits an unfenced, unlocked source write there — exactly what a
      // patchRecords with the fence flag off does. Only the query boundary is instrumented; the copy code is the real one.
      const spy = vi.spyOn(pool, 'transaction').mockImplementation(((handler: (client: { query: unknown; __rawClient: unknown }) => Promise<unknown>) =>
        original(async (client) => handler({
          ...client,
          query: async (sql: unknown, params?: unknown[], options?: unknown) => {
            if (fired === 0 && typeof sql === 'string' && /INSERT INTO meta_fields/.test(sql)) {
              fired += 1
              await pool.query('UPDATE meta_records SET updated_at = now() WHERE id = $1 AND sheet_id = $2', [`rec_cps_tripwire1_${TS}`, SRC_W])
            }
            return (client.query as (s: unknown, p?: unknown[], o?: unknown) => Promise<unknown>)(sql, params, options)
          },
        }))) as never)
      try {
        const res = await copy(SRC_W, { withData: true, permissionMode: 'inherit', name: `tripped-${TS}` })
        expect(fired).toBe(1)
        expect(res.status, JSON.stringify(res.body)).toBe(409)
        expect(res.body.error.code).toBe('COPY_SOURCE_CHANGED')
      } finally {
        spy.mockRestore()
      }
      expect(await copiesOf(SRC_W)).toHaveLength(0)
      expect((await q('SELECT COUNT(*)::int AS n FROM meta_sheets WHERE copied_from_sheet_id = $1', [SRC_W])).rows[0]).toEqual({ n: 0 })
      expect((await q(`SELECT COUNT(*)::int AS n FROM meta_multitable_template_installs WHERE actor_id = $1 AND template_id LIKE $2`, [ADMIN, `%${SRC_W}%`])).rows[0]).toEqual({ n: 0 })
      // control: with no interference the same intent copies
      const ok = await copy(SRC_W, { withData: true, permissionMode: 'inherit', name: `tripped-${TS}` })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    })
  })
}
