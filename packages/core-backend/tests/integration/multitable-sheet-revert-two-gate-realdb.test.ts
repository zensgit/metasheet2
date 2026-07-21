/**
 * #4261 follow-up (flag-contract parity) under W0 exact-anchor wiring:
 * revert-preview is UNGATED for SHEET_REVERT (read-only), but exact-anchor undelete is categorically
 * fail-closed (INBOUND_UNPROVABLE) — `undeleteSupported` is always false. The remaining two-gate
 * disclosure is `undeleteBlockedReason` when a resurrect candidate is disclosed:
 *   PIT_UNDELETE off → `UNDELETE_DISABLED`
 *   PIT_UNDELETE on  → `INBOUND_UNPROVABLE`
 * (SHEET_REVERT only gates execute, not this preview disclosure.)
 *
 * Env discipline: SAVES the incoming SHEET_REVERT/PIT_UNDELETE in beforeAll and RESTORES them in afterAll
 * (never a blind delete); each case sets exactly the two flags it needs. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_srtg_${TS}`, SHEET = `sheet_srtg_${TS}`
const NAME = `fld_srtg_name_${TS}`, ACTOR = `user_srtg_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const R = `rec_srtg_r_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let fixture: ExactAnchorHistoryFixture
let priorRevert: string | undefined
let priorUndelete: string | undefined
let priorFence: string | undefined
let priorStrict: string | undefined
const restoreEnv = (key: string, prior: string | undefined) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior }
const revertPreview = () =>
  request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ anchorOperationId: fixture.anchorOperationId() })

async function seed(): Promise<void> {
  // One record present at the exact anchor, deleted after → preview discloses a resurrect candidate so
  // undeleteBlockedReason is present (the gate disclosure under test). Resurrect plans never mint a token.
  await fixture.insertRevision({
    recordId: R,
    version: 1,
    action: 'create',
    snapshot: { [NAME]: 'r-at-anchor' },
    createdAt: T0,
    phase: 'anchor',
    changedFieldIds: [NAME],
  })
  await fixture.insertRevision({
    recordId: R,
    version: 1,
    action: 'delete',
    snapshot: { [NAME]: 'r-at-anchor' },
    createdAt: T2,
    phase: 'after',
    changedFieldIds: [NAME],
  })
}

describeIfDatabase('multitable #4261 revert-preview undelete gate disclosure (exact-anchor, real DB)', () => {
  beforeAll(async () => {
    priorRevert = process.env.MULTITABLE_ENABLE_SHEET_REVERT
    priorUndelete = process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    priorFence = process.env.MULTITABLE_ENABLE_WRITER_FENCE
    priorStrict = process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'SRTG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'SRTG Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_recovery_token_burns', 'meta_record_revisions', 'meta_records', 'meta_fields']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    }
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    restoreEnv('MULTITABLE_ENABLE_SHEET_REVERT', priorRevert)
    restoreEnv('MULTITABLE_ENABLE_PIT_UNDELETE', priorUndelete)
    restoreEnv('MULTITABLE_ENABLE_WRITER_FENCE', priorFence)
    restoreEnv('MULTITABLE_HISTORY_CONTIGUITY_STRICT', priorStrict)
  })
  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    fixture = await prepareExactAnchorHistoryFixture(SHEET)
    await seed()
  })

  test('undeleteSupported is always false; blocked-reason tracks PIT_UNDELETE; doomed plan mints no token', async () => {
    const cases = [
      { revert: false, undelete: false, blocked: 'UNDELETE_DISABLED' },
      { revert: true, undelete: false, blocked: 'UNDELETE_DISABLED' },
      // discriminator: flipping PIT_UNDELETE on must change blocked reason (not undeleteSupported)
      { revert: false, undelete: true, blocked: 'INBOUND_UNPROVABLE' },
      { revert: true, undelete: true, blocked: 'INBOUND_UNPROVABLE' },
    ]
    for (const c of cases) {
      if (c.revert) process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
      else delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
      if (c.undelete) process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
      else delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
      const res = await revertPreview()
      expect(res.status).toBe(200)
      expect(res.body?.data?.undeleteSupported).toBe(false)
      expect(res.body?.data?.undeleteRecordIds).toEqual([R])
      expect(res.body?.data?.undeleteBlockedReason).toBe(c.blocked)
      // Exact-anchor kernel: any resurrection plan is non-executable and never mints a destructive token.
      expect(res.body?.data?.executable).toBe(false)
      expect(res.body?.data?.previewIdentity).toBeNull()
    }
  })
})
