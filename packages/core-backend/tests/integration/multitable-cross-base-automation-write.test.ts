/**
 * ②b automation slice — governed cross-base automation WRITES (real DB).
 *
 * Closes a live pre-existing hole AND opens the governed path. Today `executeCreateRecord` does a bare
 * INSERT to `config.sheetId ?? context.sheetId` with ZERO permission check (design §1.3), so an
 * automation can create a record in ANOTHER base's sheet ungated. The write-gate added here demands an
 * explicit, consistent `targetBaseId` (claim == truth) AND that the TRIGGER ACTOR (`context.actorId`,
 * NOT the rule owner) holds base-WRITE on the target base. Cross-base `update_record` additionally
 * requires full explicit addressing (`targetBaseId + targetSheetId + targetRecordId`) and retargets the
 * lock-check + write to the TARGET record.
 *
 * RATIFIED contract:
 *  - effective actor = TRIGGER actor (`context.actorId`); null actor (scheduled trigger) → fail-closed.
 *  - base-write = `BASE_ADMIN_PERMISSION_CODES` ∪ base-owner (`resolveBaseWritable(userId, query, baseId)`).
 *  - claim == truth: `targetBaseId === target sheet's actual base_id` (mirrors the link wall).
 *  - fail-closed: any rejection → step `failed` in the execution log, NO write.
 *
 * Drives the REAL AutomationExecutor with a real-DB queryFn (the executor is the write chokepoint — this
 * proves the gate stands alone even if rule-save validation were bypassed). XW-2d (rule-save 400) and
 * XW-5 (wire round-trip) live in `multitable-cross-base-automation-write-rule.test.ts` (rule API altitude).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()

// Actors.
const OWNER = `u_xw_owner_${TS}` // owns BASE_A (trigger) AND BASE_B (target) → base-write on both (owner)
const ADMIN_CODE = `u_xw_admincode_${TS}` // holds multitable:base:admin grant → base-write on any base
const NO_WRITE = `u_xw_nowrite_${TS}` // owns nothing, no codes → NO base-write on BASE_B

// Bases.
const BASE_A = `base_xw_a_${TS}` // trigger base (source)
const BASE_B = `base_xw_b_${TS}` // target base (cross-base write sink)

// Sheets.
const SHEET_A = `sheet_xw_a_${TS}` // trigger sheet (BASE_A)
const SHEET_B = `sheet_xw_b_${TS}` // cross-base target sheet (BASE_B)

// NIT-1 soft-delete canary fixtures (dedicated — never mutate the shared BASE_B/SHEET_B which
// sibling tests reuse live). The soft-deleted state is UNREACHABLE through any runtime path today
// (sheets are hard-deleted, bases are never deleted), so these seed `deleted_at` directly via SQL.
const DEL_BASE = `base_xw_del_${TS}` // a SOFT-DELETED base (deleted_at set), owned by OWNER
const LIVE_SHEET_IN_DEL_BASE = `sheet_xw_indelbase_${TS}` // a LIVE sheet pointing at DEL_BASE
const DEL_SHEET_IN_LIVE_BASE = `sheet_xw_del_${TS}` // a SOFT-DELETED sheet in the LIVE BASE_B

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function makeExecutor(): { executor: AutomationExecutor; eventBus: EventBus } {
  const eventBus = new EventBus()
  const deps: AutomationDeps = {
    eventBus,
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
  }
  return { executor: new AutomationExecutor(deps), eventBus }
}

// Build a minimal executor-shaped rule with a single action and run it against a synthetic trigger event.
function ruleWith(action: { type: string; config: Record<string, unknown> }, createdBy: string): AutomationRule {
  return {
    id: `axr_xw_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'XW rule',
    sheetId: SHEET_A,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

const countRecords = async (sheetId: string): Promise<number> => {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
  return (r.rows as Array<{ n: number }>)[0]?.n ?? 0
}
const recordData = async (recordId: string): Promise<Record<string, unknown> | undefined> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  const d = (r.rows as Array<{ data: unknown }>)[0]?.data
  if (d == null) return undefined
  return (typeof d === 'string' ? JSON.parse(d) : d) as Record<string, unknown>
}

describeIfDatabase('②b automation — governed cross-base writes + close §1.3 hole (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'XW Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'XW Base B', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Trigger A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Target B'])

    // ADMIN_CODE holds the base-admin grant (exercises listRbacPermissionCodes + namespace admission).
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:admin', 'Base Admin', 'cross-base automation write tests')
       ON CONFLICT (code) DO NOTHING`,
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [ADMIN_CODE, `${ADMIN_CODE}@example.test`],
    )
    await q(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:admin') ON CONFLICT DO NOTHING`,
      [ADMIN_CODE],
    )

    // NIT-1 soft-delete canary fixtures — seed `deleted_at` directly (no runtime path produces it).
    await q('INSERT INTO meta_bases (id, name, owner_id, deleted_at) VALUES ($1, $2, $3, NOW())', [DEL_BASE, 'XW Soft-Deleted Base', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [LIVE_SHEET_IN_DEL_BASE, DEL_BASE, 'Live sheet in soft-deleted base'])
    await q('INSERT INTO meta_sheets (id, base_id, name, deleted_at) VALUES ($1, $2, $3, NOW())', [DEL_SHEET_IN_LIVE_BASE, BASE_B, 'Soft-deleted sheet in live base'])
  })

  afterAll(async () => {
    const sheets = [SHEET_A, SHEET_B, LIVE_SHEET_IN_DEL_BASE, DEL_SHEET_IN_LIVE_BASE]
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B, DEL_BASE]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[ADMIN_CODE]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── XW-1: cross-base create + base-write (owner) → success ──────────────────
  test('XW-1: cross-base create_record with correct targetBaseId + trigger-actor base-write → record created in target base', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'xw1' } } },
      OWNER,
    )
    // trigger actor = OWNER, who owns BASE_B → base-write granted via ownership.
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.status).toBe('success')
    expect(exec.steps[0]?.status).toBe('success')
    expect(await countRecords(SHEET_B)).toBe(before + 1)
  })

  // ── XW-1 (admin-code path): cross-base create with base:admin grant → success ─
  test('XW-1 (admin-code): cross-base create with trigger-actor holding multitable:base:admin → success', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'xw1admin' } } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: ADMIN_CODE, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    expect(await countRecords(SHEET_B)).toBe(before + 1)
  })

  // ── XW-1b: cross-base create, NO base-write → step failed, NO write ─────────
  test('XW-1b: cross-base create_record where trigger actor lacks target base-write → step failed, NO record written', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'xw1b' } } },
      OWNER, // rule owner DOES have write — but ratified actor is the TRIGGER actor, not the owner
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before) // fail-closed: no write
  })

  // ── XW-1c: claim ≠ truth → step failed (consistency gate, mirrors the wall) ──
  test('XW-1c: cross-base create where targetBaseId does NOT match target sheet base → step failed, NO write', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      // SHEET_B is in BASE_B, but the rule CLAIMS BASE_A → claim != truth.
      { type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_A, data: { v: 'xw1c' } } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before)
  })

  // ── XW-2: cross-base update (full addressing) + base-write → success ─────────
  test('XW-2: cross-base update_record with full addressing + trigger-actor base-write → target record updated', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_xw2_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recId, SHEET_B, JSON.stringify({ v: 'old' })])
    try {
      const rule = ruleWith(
        {
          type: 'update_record',
          config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId, fields: { v: 'new' } },
        },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect((await recordData(recId))?.v).toBe('new')
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── XW-2b: cross-base update, NO base-write → step failed, NO write ──────────
  test('XW-2b: cross-base update_record where trigger actor lacks target base-write → step failed, target unchanged', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_xw2b_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recId, SHEET_B, JSON.stringify({ v: 'old' })])
    try {
      const rule = ruleWith(
        { type: 'update_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId, fields: { v: 'new' } } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect((await recordData(recId))?.v).toBe('old') // unchanged
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── XW-2c: target record LOCKED → blocked via TARGET ensureRecordNotLocked ───
  // Even WITH base-write, a locked target record blocks the write (lock priority + lock-redirect:
  // the lock-check must SELECT the TARGET record, not the trigger record).
  test('XW-2c: cross-base update of a LOCKED target record is blocked (step failed) even with base-write', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_xw2c_${TS}`
    // Locked by someone else; OWNER is not the locker nor the record creator → cannot edit while locked.
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version, locked, locked_by, created_by) VALUES ($1,$2,$3::jsonb,1,true,$4,$5)',
      [recId, SHEET_B, JSON.stringify({ v: 'old' }), `someone_else_${TS}`, `someone_else_${TS}`],
    )
    try {
      const rule = ruleWith(
        { type: 'update_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId, fields: { v: 'new' } } },
        OWNER,
      )
      // OWNER has base-write on BASE_B — but the TARGET record is locked → blocked.
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect((await recordData(recId))?.v).toBe('old') // unchanged: lock priority
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── XW-2e: claim==truth for the record — targetRecordId ∉ targetSheetId → failed ──
  // A cross-base update naming a targetRecordId that does NOT exist in targetSheetId must FAIL
  // explicitly (decision 4: never a silent no-op success), even with base-write held.
  test('XW-2e: cross-base update where targetRecordId is not in targetSheetId → step failed (claim==truth)', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      {
        type: 'update_record',
        config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: `rec_xw2e_missing_${TS}`, fields: { v: 'new' } },
      },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before) // no row created/changed
  })

  // ── XW-3: same-base create/update → unaffected (zero regression, no gate) ────
  test('XW-3a: same-base create_record (no targetBaseId) is unaffected', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_A)
    // NO_WRITE has no base-write anywhere — but same-base must NOT hit the gate at all.
    const rule = ruleWith({ type: 'create_record', config: { sheetId: SHEET_A, data: { v: 'same' } } }, OWNER)
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    expect(await countRecords(SHEET_A)).toBe(before + 1)
  })

  test('XW-3b: same-base create with targetBaseId == trigger base is unaffected (no gate)', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_A)
    const rule = ruleWith({ type: 'create_record', config: { sheetId: SHEET_A, targetBaseId: BASE_A, data: { v: 'same2' } } }, OWNER)
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    expect(await countRecords(SHEET_A)).toBe(before + 1)
  })

  test('XW-3c: same-base update_record (no target addressing) updates the trigger record', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_xw3c_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recId, SHEET_A, JSON.stringify({ v: 'old' })])
    try {
      const rule = ruleWith({ type: 'update_record', config: { fields: { v: 'new' } } }, OWNER)
      const exec = await executor.execute(rule, { recordId: recId, sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect((await recordData(recId))?.v).toBe('new')
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── XW-4: null actorId (scheduled trigger) + cross-base → fail-closed ────────
  // The ratified TRIGGER-ACTOR decision: a scheduled trigger has no actorId → no identity to authorize
  // a cross-base write → fail-closed (step failed, NO write). NO fallback to the rule owner.
  test('XW-4: cross-base create with null actorId (scheduled trigger) → fail-closed, NO write', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'xw4' } } },
      OWNER, // rule owner has write — but actorId is null and there is NO owner fallback
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: null, data: {}, _triggeredBy: 'schedule' } as never)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before) // fail-closed: no write
  })

  // ── XW-6: NIT-1 — soft-deleted / missing target base or sheet → fail-closed ──
  // The soft-deleted state is UNREACHABLE through any runtime path today (sheets are hard-deleted,
  // bases are never deleted), so each fixture seeds `deleted_at` directly. The gate must STILL reject
  // a cross-base write into a logically-deleted target, for an ADMIN *and* a base-OWNER actor, so a
  // future soft-delete feature cannot silently re-arm a zombie/resurrection write. RED on pre-fix HEAD
  // (the admin short-circuit / the unfiltered sheet lookup lets the write land); GREEN after.

  test('XW-6a: cross-base create into a LIVE sheet in a SOFT-DELETED base, by an ADMIN actor → step failed, NO write', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(LIVE_SHEET_IN_DEL_BASE)
    const rule = ruleWith(
      // claim == truth (DEL_BASE is the live sheet's actual base) — the only thing that should reject
      // is base existence. ADMIN holds multitable:base:admin, which today short-circuits BEFORE the
      // deleted_at check → zombie INSERT into a soft-deleted base.
      { type: 'create_record', config: { sheetId: LIVE_SHEET_IN_DEL_BASE, targetBaseId: DEL_BASE, data: { v: 'xw6a' } } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: ADMIN_CODE, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(LIVE_SHEET_IN_DEL_BASE)).toBe(before) // fail-closed: no write into a soft-deleted base
  })

  test('XW-6b: cross-base create into a LIVE sheet in a SOFT-DELETED base, by the base OWNER → step failed, NO write', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(LIVE_SHEET_IN_DEL_BASE)
    // OWNER owns DEL_BASE — the owner path is already deleted_at-guarded, so this should ALSO reject
    // (mirrors how the owner SELECT requires existence). Locks in symmetry: admin and owner alike.
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: LIVE_SHEET_IN_DEL_BASE, targetBaseId: DEL_BASE, data: { v: 'xw6b' } } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(LIVE_SHEET_IN_DEL_BASE)).toBe(before)
  })

  test('XW-6c: cross-base create into a SOFT-DELETED sheet (in a live base), by the base OWNER → step failed, NO write', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(DEL_SHEET_IN_LIVE_BASE)
    // The target sheet is soft-deleted but its base (BASE_B) is LIVE and owned by OWNER. Pre-fix the
    // sheet→base lookup has no deleted_at filter, so claim==truth passes and the owner is writable on
    // the live base → an OWNER (non-admin) row lands in a soft-deleted sheet. Post-fix the soft-deleted
    // sheet resolves to "no row" → target base unresolvable → fail-closed.
    const rule = ruleWith(
      { type: 'create_record', config: { sheetId: DEL_SHEET_IN_LIVE_BASE, targetBaseId: BASE_B, data: { v: 'xw6c' } } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(DEL_SHEET_IN_LIVE_BASE)).toBe(before)
  })

  test('XW-6d: cross-base UPDATE into a LIVE sheet in a SOFT-DELETED base, by an ADMIN actor → step failed, target unchanged', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_xw6d_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recId, LIVE_SHEET_IN_DEL_BASE, JSON.stringify({ v: 'old' })])
    try {
      const rule = ruleWith(
        { type: 'update_record', config: { targetBaseId: DEL_BASE, targetSheetId: LIVE_SHEET_IN_DEL_BASE, targetRecordId: recId, fields: { v: 'mutated' } } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: ADMIN_CODE, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect((await recordData(recId))?.v).toBe('old') // unchanged: no write into a soft-deleted base
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })
})
