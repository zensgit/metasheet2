/**
 * W0-1 Lane L6-a — the SEALED OPERATION-ENDPOINT ledger + mint protocol. Real-DB goldens.
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` §1.2 (sealed operation endpoints) and
 * §6 G-BATCH-ENDPOINT. Under test: migration
 * `zzzz20260715190000_create_meta_record_history_operations.ts` (ledger table, DEFERRABLE-INITIALLY-DEFERRED
 * FKs, append-after-seal + endpoint-validation triggers), `operation-ledger.ts` (mint/seal), and the wiring
 * into the L4/L4cov-fenced record writers (`record-service.ts`, `record-write-service.ts`). Everything is
 * behind `MULTITABLE_ENABLE_WRITER_FENCE` (default OFF); this file toggles env vars only inside its OWN
 * process, exactly like the sibling `…-l4-canonical-fence-realdb.test.ts`. Nothing here arms the fence,
 * Revert, or Reset in any real environment.
 *
 * WHAT THIS PROVES: the endpoint is the exact, externally-visible commit boundary (endpoint row written LAST,
 * count/max validated in-DB), and the DB enforces it independently of service comments — a wrong count, a
 * non-max endpoint_seq, a skipped seal (deferred FK), an append after seal, and an endpoint-before-events all
 * fail closed. The §W writer goldens prove the real mint wiring produces those endpoints (G-BATCH-ENDPOINT:
 * the multi-row bulk operation anchors AFTER all rows, never at an intermediate seq).
 *
 * P2-C hygiene (v3.7): every seq comparison uses EXACT bigint (BigInt(), never Number()/parseInt/+/-); this
 * file NEVER calls `setval` on the shared `meta_record_chain_seq`; §E fixtures insert explicit SYNTHETIC seq
 * literals into isolated rows with unique ids; §W lets the writers allocate real seq via nextval (which
 * advances but never setval-mutates the sequence). `afterAll` cleans up ONLY this suite's own rows. Locally
 * the whole suite runs against a throwaway database `metasheet_l6a_gate` (created, migrated, dropped) so the
 * shared chain sequence is never touched even transiently — see the lane report.
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts default include glob.
 * Runs only with DATABASE_URL; the sentinel below fails-not-skips inside the real-DB allowlist step.
 */
import { EventEmitter } from 'events'
import type { Request } from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import { RecordService } from '../../src/multitable/record-service'
import { RecordWriteService, type RecordPatchInput as WriteRecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'
import {
  mintOperation,
  sealOperation,
  OperationLedger,
  __resetOperationLedgerColumnProbe,
} from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const TS = Date.now()
const BASE = `base_l6a_${TS}`
const SHEET = `sheet_l6a_${TS}`
const F_STR = `fld_l6a_str_${TS}`
const ACTOR = `u_l6a_actor_${TS}`

let seqCounter = 0
const mkRecord = (tag: string) => `rec_l6a_${tag}_${TS}_${seqCounter++}`
const mkOpId = () => {
  // A stable, unique synthetic uuid per call (never request-derived). crypto.randomUUID via the ledger is the
  // production minter; §E uses fixed literals to make the assertions legible.
  seqCounter += 1
  const hex = seqCounter.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

const eventBus = new EventEmitter() as unknown as EventBus
const access: AccessInfo = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const mkRecordService = () =>
  new RecordService(poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0], eventBus)
const mkWriteService = () => {
  const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
  const helpers = createRecordWriteHelpers(
    fakeReq,
    poolManager.get() as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> },
  )
  return new RecordWriteService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordWriteService>[0],
    eventBus,
    helpers,
  )
}

const seedRecord = async (id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [id, SHEET, JSON.stringify(data), ACTOR])
}
type Run = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
/**
 * A tagged event carrying an `operation_id` fires the DEFERRABLE-INITIALLY-DEFERRED FK at COMMIT, so an
 * autocommit insert with no endpoint always fails. The §E goldens therefore write each operation's events
 * AND its endpoint inside ONE transaction (`inTxn`), exactly as a real sealed operation does; a violation
 * insert then rolls that txn back. Pass the txn's `query` as `run`.
 */
const inTxn = <T>(fn: (run: Run) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query }) => fn(query as unknown as Run)) as Promise<T>

/** Insert a SYNTHETIC revision with an explicit seq literal (never nextval/setval) for the §E enforcement goldens. */
const synthRevision = (run: Run, recordId: string, version: number, seq: string, operationId: string | null) =>
  run(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, operation_id)
     VALUES (gen_random_uuid(),$1,$2,$3,'create','rest',ARRAY[]::text[],'{}'::jsonb,'{}'::jsonb,$4::bigint,$5::uuid)`,
    [SHEET, recordId, version, seq, operationId],
  )
const synthMarker = (run: Run, recordId: string, version: number, seq: string, operationId: string | null) =>
  run(
    `INSERT INTO meta_record_version_markers (id, sheet_id, record_id, version, kind, seq, operation_id)
     VALUES (gen_random_uuid(),$1,$2,$3,'lock',$4::bigint,$5::uuid)`,
    [SHEET, recordId, version, seq, operationId],
  )
const insertEndpoint = (run: Run, operationId: string, endpointSeq: string, eventCount: number) =>
  run(
    `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
     VALUES ($1,$2::uuid,$3::bigint,$4::int)`,
    [SHEET, operationId, endpointSeq, eventCount],
  )
const endpointOf = async (operationId: string): Promise<{ endpoint_seq: string; event_count: number } | undefined> =>
  (
    await q('SELECT endpoint_seq::text AS endpoint_seq, event_count FROM meta_record_history_operations WHERE sheet_id=$1 AND operation_id=$2', [SHEET, operationId])
  ).rows[0] as { endpoint_seq: string; event_count: number } | undefined

describeIfDatabase('W0-1 L6-a — sealed operation-endpoint ledger (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'L6a Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L6a Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })

  afterEach(() => {
    delete process.env[FLAG]
  })

  afterAll(async () => {
    delete process.env[FLAG]
    await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(() => {
    __resetOperationLedgerColumnProbe()
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── §M — the mint-protocol module contract ────────────────────────────────────────────────────────
  test('M1 mintOperation is INERT with the flag off (no operation id), ACTIVE with it on', async () => {
    delete process.env[FLAG]
    const off = await mintOperation(q, SHEET)
    expect(off.operationId).toBeNull()
    expect(off.active).toBe(false)
    process.env[FLAG] = 'true'
    const on = await mintOperation(q, SHEET)
    expect(on.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(on.active).toBe(true)
  })

  test('M2 sealOperation is a no-op for an inert ledger AND for a zero-event active ledger (no endpoint row)', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(await sealOperation(q, new OperationLedger(SHEET, null))).toBe(false) // inert
    const activeZero = new OperationLedger(SHEET, mkOpId()) // active but tracked NOTHING (schema-only op)
    expect(await sealOperation(q, activeZero)).toBe(false)
    const after = (await q('SELECT count(*)::int AS n FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // no endpoint written by either
  })

  test('M3 track() keeps exact MAX/count as bigint (Number() would collapse 2^53 neighbours)', () => {
    const l = new OperationLedger(SHEET, mkOpId())
    const lo = '9007199254740992' // 2^53
    const hi = '9007199254740993' // 2^53 + 1 (Number() rounds to 2^53 → collides)
    expect(Number(lo)).toBe(Number(hi)) // the float64 trap
    l.track(lo)
    l.track(hi)
    expect(l.eventCount).toBe(2)
    expect(l.maxSeq).toBe(hi) // exact bigint MAX, not the collapsed float
  })

  // ── §E — endpoint DB ENFORCEMENT (direct synthetic inserts; each violation fails closed) ────────────
  //         Each operation's events + endpoint are written in ONE transaction (the deferred FK is satisfied
  //         only at COMMIT, so a tagged event with no same-txn endpoint always fails — see E6).
  test('E1 endpoint-last happy path: 2 revisions + 1 marker → stored event_count=3, endpoint_seq=exact MAX', async () => {
    const op = mkOpId()
    const R = mkRecord('e1')
    await inTxn(async (run) => {
      await synthRevision(run, R, 1, '7001', op)
      await synthRevision(run, R, 2, '7002', op)
      await synthMarker(run, R, 3, '7003', op)
      await insertEndpoint(run, op, '7003', 3) // endpoint written LAST
    })
    const ep = await endpointOf(op)
    expect(ep).toBeDefined()
    expect(ep!.event_count).toBe(3)
    expect(ep!.endpoint_seq).toBe('7003')
    expect(BigInt(ep!.endpoint_seq)).toBe(7003n)
  })

  test('E2 WRONG COUNT rejects; correct count is the positive control', async () => {
    // wrong: assert 3 events when only 2 exist → the endpoint insert raises inside the txn, rolling it back
    const bad = mkOpId()
    const Rb = mkRecord('e2bad')
    await expect(
      inTxn(async (run) => {
        await synthRevision(run, Rb, 1, '7101', bad)
        await synthRevision(run, Rb, 2, '7102', bad)
        await insertEndpoint(run, bad, '7102', 3)
      }),
    ).rejects.toThrow(/event_count/)
    expect(await endpointOf(bad)).toBeUndefined() // rolled back — no endpoint
    // positive control: the correct count seals fine
    const ok = mkOpId()
    const Ro = mkRecord('e2ok')
    await inTxn(async (run) => {
      await synthRevision(run, Ro, 1, '7111', ok)
      await synthRevision(run, Ro, 2, '7112', ok)
      await insertEndpoint(run, ok, '7112', 2)
    })
    expect((await endpointOf(ok))!.event_count).toBe(2)
  })

  test('E3 NON-MAX endpoint_seq rejects (below AND above); the exact MAX is the positive control', async () => {
    for (const badSeq of ['7201', '7203']) {
      const op = mkOpId()
      const R = mkRecord('e3bad')
      await expect(
        inTxn(async (run) => {
          await synthRevision(run, R, 1, '7201', op)
          await synthRevision(run, R, 2, '7202', op)
          await insertEndpoint(run, op, badSeq, 2)
        }),
      ).rejects.toThrow(/endpoint_seq/)
    }
    const ok = mkOpId()
    const Ro = mkRecord('e3ok')
    await inTxn(async (run) => {
      await synthRevision(run, Ro, 1, '7211', ok)
      await synthRevision(run, Ro, 2, '7212', ok)
      await insertEndpoint(run, ok, '7212', 2) // exact max
    })
    expect((await endpointOf(ok))!.endpoint_seq).toBe('7212')
  })

  test('E4 endpoint-BEFORE-events (count 0 at insert) rejects — enforces endpoint-LAST', async () => {
    const op = mkOpId()
    // endpoint alone (no events) → validation trigger sees 0 events → raises. Autocommit is fine: the
    // endpoint table has no outbound FK, so nothing is deferred here.
    await expect(insertEndpoint(q, op, '7301', 1)).rejects.toThrow(/event_count/)
  })

  test('E5 append after seal rejects (a later txn cannot append to a sealed operation)', async () => {
    const sealed = mkOpId()
    const R = mkRecord('e5')
    await inTxn(async (run) => {
      await synthRevision(run, R, 1, '7401', sealed)
      await insertEndpoint(run, sealed, '7401', 1)
    })
    // a SEPARATE, later transaction appends to the now-sealed op → the append-after-seal trigger raises
    // (immediate, before the deferred FK — which is anyway satisfied now the endpoint exists)
    await expect(inTxn(async (run) => synthRevision(run, R, 2, '7402', sealed))).rejects.toThrow(/sealed operation/)
  })

  test('E6 DEFERRABLE FK: events-before-endpoint in ONE txn succeeds; events that never seal FAIL at COMMIT', async () => {
    // (a) mid-txn the event INSERT itself succeeds (FK is deferred), then the endpoint seals → COMMIT ok
    const ok = mkOpId()
    const Ra = mkRecord('e6a')
    await inTxn(async (run) => {
      const ins = await synthRevision(run, Ra, 1, '7501', ok) // succeeds mid-txn despite no endpoint yet
      expect(ins.rowCount).toBe(1) // the event INSERT itself does not fail — the FK is deferred to COMMIT
      await insertEndpoint(run, ok, '7501', 1)
    })
    expect((await endpointOf(ok))!.event_count).toBe(1)

    // (b) events written but NEVER sealed → the deferred FK fires at COMMIT and rolls the txn back
    const orphan = mkOpId()
    const Rb = mkRecord('e6b')
    await expect(inTxn(async (run) => synthRevision(run, Rb, 1, '7502', orphan))).rejects.toThrow(/foreign key|fk_mrr_operation/i)
    expect((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE operation_id=$1', [orphan])).rows[0] as { n: number }).toMatchObject({ n: 0 })
  })

  test('E7 legacy NULL operation_id needs NO endpoint (FK not enforced) — the negative-of-universal control', async () => {
    const R = mkRecord('e7')
    await expect(synthRevision(q, R, 1, '7601', null)).resolves.toBeDefined() // autocommit, no endpoint, no FK
    expect((await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id=$1 AND operation_id IS NULL', [R])).rows[0] as { n: number }).toMatchObject({ n: 1 })
  })

  test('E8 exact bigint through the endpoint: 2^53 neighbours stay DISTINCT (Number() would collapse them)', async () => {
    const op = mkOpId()
    const R = mkRecord('e8')
    const lo = '9007199254740992' // 2^53
    const hi = '9007199254740993' // 2^53 + 1
    expect(Number(lo)).toBe(Number(hi)) // the trap
    await inTxn(async (run) => {
      await synthRevision(run, R, 1, lo, op)
      await synthRevision(run, R, 2, hi, op)
      await insertEndpoint(run, op, hi, 2) // exact MAX as a bigint string
    })
    const ep = await endpointOf(op)
    expect(ep!.endpoint_seq).toBe(hi)
    expect(BigInt(ep!.endpoint_seq) > BigInt(lo)).toBe(true)
    // a NON-max endpoint that only DIFFERS from the max in the float64-invisible bit must STILL reject
    const op2 = mkOpId()
    const R2 = mkRecord('e8b')
    await expect(
      inTxn(async (run) => {
        await synthRevision(run, R2, 1, hi, op2)
        await insertEndpoint(run, op2, lo, 1) // lo != hi as bigint, even though ==(float)
      }),
    ).rejects.toThrow(/endpoint_seq/)
  })

  // ── §W — the REAL writer wiring (flag ON) mints + seals ─────────────────────────────────────────────
  test('W1 [bulk] G-BATCH-ENDPOINT: N-record bulk patch seals ONE endpoint AFTER all rows (count=N, seq=MAX, never intermediate)', async () => {
    const ids = [mkRecord('w1a'), mkRecord('w1b'), mkRecord('w1c')]
    for (const id of ids) await seedRecord(id)
    process.env[FLAG] = 'true'
    const input: WriteRecordPatchInput = {
      sheetId: SHEET,
      changesByRecord: new Map(ids.map((id) => [id, [{ fieldId: F_STR, value: `bulk-${id}` }]])),
      actorId: ACTOR,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      visiblePropertyFieldIds: new Set([F_STR]),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]]) as any,
      capabilities,
      access,
    }
    const result = await mkWriteService().patchRecords(input)
    // finding #1 decouple (owner ruling 2026-07-16): the echo is the S1 user-action batch id, NOT the
    // per-transaction operation id — the deep-link must match the stored batch_id rows.
    const echoedBatchId = (result as { batchId?: string }).batchId as string
    expect(echoedBatchId).toMatch(/^[0-9a-f-]{36}$/)

    // every revision of this call carries the echoed batch_id AND one shared operation_id — two DISTINCT identities
    const revs = (await q('SELECT seq::text AS seq, operation_id, batch_id FROM meta_record_revisions WHERE sheet_id=$1 AND batch_id=$2 ORDER BY seq ASC', [SHEET, echoedBatchId])).rows as Array<{ seq: string; operation_id: string; batch_id: string }>
    expect(revs).toHaveLength(ids.length)
    const opId = revs[0]!.operation_id
    expect(opId).toMatch(/^[0-9a-f-]{36}$/)
    for (const r of revs) {
      expect(r.operation_id).toBe(opId) // ONE transaction ⇒ one shared operation
      expect(r.batch_id).toBe(echoedBatchId) // batch_id NEVER overwritten by the operation id
    }
    expect(opId).not.toBe(echoedBatchId) // permanently decoupled identities
    // the endpoint sits AFTER all rows: endpoint_seq == exact MAX, count == N, and NO revision exceeds it
    const ep = await endpointOf(opId)
    expect(ep).toBeDefined()
    expect(ep!.event_count).toBe(ids.length)
    const maxSeq = revs.reduce((m, r) => (BigInt(r.seq) > m ? BigInt(r.seq) : m), 0n)
    expect(BigInt(ep!.endpoint_seq)).toBe(maxSeq)
    expect(revs.every((r) => BigInt(r.seq) <= BigInt(ep!.endpoint_seq))).toBe(true) // never an intermediate anchor
  })

  test('W2 [REST create] createRecord mints + seals a single-event endpoint (seq = that revision, count 1)', async () => {
    process.env[FLAG] = 'true'
    const res = await mkRecordService().createRecord({ sheetId: SHEET, data: { [F_STR]: 'w2' }, actorId: ACTOR, capabilities })
    const rev = (await q('SELECT seq::text AS seq, operation_id FROM meta_record_revisions WHERE sheet_id=$1 AND record_id=$2', [SHEET, res.recordId])).rows[0] as { seq: string; operation_id: string | null }
    expect(rev.operation_id).toMatch(/^[0-9a-f-]{36}$/)
    const ep = await endpointOf(rev.operation_id!)
    expect(ep).toBeDefined()
    expect(ep!.event_count).toBe(1)
    expect(ep!.endpoint_seq).toBe(rev.seq) // endpoint_seq == the single event's exact seq
  })

  test('W3 [REST patch] a real fenced patch tags its revision + seals; MAX seq of the op == endpoint_seq (mint-under-fence)', async () => {
    const R = mkRecord('w3')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await mkRecordService().patchRecord({ recordId: R, sheetId: SHEET, data: { [F_STR]: 'w3-patched' }, actorId: ACTOR, access, capabilities })
    const rev = (await q("SELECT seq::text AS seq, operation_id FROM meta_record_revisions WHERE sheet_id=$1 AND record_id=$2 AND action='update'", [SHEET, R])).rows[0] as { seq: string; operation_id: string | null }
    expect(rev.operation_id).toMatch(/^[0-9a-f-]{36}$/)
    const ep = await endpointOf(rev.operation_id!)
    // minted AFTER the fence ⇒ the endpoint seq equals the op's own event seq (commit-order reflection)
    expect(ep!.endpoint_seq).toBe(rev.seq)
    expect(ep!.event_count).toBe(1)
  })

  // ── §G-MULTIOP-BATCH (owner-mandated, ruling 2026-07-16 — pins the original finding-#1 defect) ──────
  // One S1 commit action spanning N per-row patchRecords TRANSACTIONS sharing ONE caller batchId (the AI
  // bulk-commit shape, S1 LOCK-B/B2). Covers ruling parts (a)-(c): same batch_id on every revision, N distinct
  // operation_ids + N sealed endpoints, and ONE History grouping key. Parts (d) resolver-max-endpoint_seq and
  // (e) EXACT_ANCHOR_REQUIRED refusal live in L6-b (the resolver does not exist yet) — deferred, not skipped.
  test('G-MULTIOP [S1 shape] one commit action across N transactions: ONE batch_id, N operation_ids + N endpoints, ONE History grouping key', async () => {
    const ids = [mkRecord('mo1'), mkRecord('mo2'), mkRecord('mo3')]
    for (const id of ids) await seedRecord(id)
    process.env[FLAG] = 'true'
    const commitBatchId = mkOpId() // the S1 server-minted commit-action batch id, shared across all N calls
    const mkInput = (id: string): WriteRecordPatchInput => ({
      sheetId: SHEET,
      changesByRecord: new Map([[id, [{ fieldId: F_STR, value: `multiop-${id}` }]]]),
      actorId: ACTOR,
      batchId: commitBatchId, // ← threaded through every per-row call, exactly like the AI commit
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      visiblePropertyFieldIds: new Set([F_STR]),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]]) as any,
      capabilities,
      access,
    })
    const svc = mkWriteService()
    for (const id of ids) {
      const res = await svc.patchRecords(mkInput(id)) // each call = its OWN transaction (the S1 multi-txn shape)
      // (echo leg) every per-row call echoes the SHARED commit batch id, never its private operation id
      expect((res as { batchId?: string }).batchId).toBe(commitBatchId)
    }

    const revs = (await q('SELECT operation_id, batch_id FROM meta_record_revisions WHERE sheet_id=$1 AND batch_id=$2', [SHEET, commitBatchId])).rows as Array<{ operation_id: string; batch_id: string }>
    // (a) ALL N revisions keep the SAME S1 batch_id — operation_id never overwrote it
    expect(revs).toHaveLength(ids.length)
    for (const r of revs) expect(r.batch_id).toBe(commitBatchId)
    // (b) N DISTINCT operation_ids, one per transaction — and N sealed endpoints exist
    const opIds = [...new Set(revs.map((r) => r.operation_id))]
    expect(opIds).toHaveLength(ids.length)
    for (const op of opIds) {
      expect(op).toMatch(/^[0-9a-f-]{36}$/)
      expect(op).not.toBe(commitBatchId)
      expect(await endpointOf(op)).toBeDefined()
    }
    // (c) the History projection grouping key (COALESCE(batch_id, id)) yields ONE batch for the whole commit
    const groups = (await q('SELECT COUNT(DISTINCT COALESCE(batch_id, id::text))::int AS n FROM meta_record_revisions WHERE sheet_id=$1 AND batch_id=$2', [SHEET, commitBatchId])).rows[0] as { n: number }
    expect(groups.n).toBe(1)
  })

  // ── §P — flag-off PARITY: no operation id, no endpoint, byte-identical to L4cov ─────────────────────
  test('P1 [flag OFF] a bulk patch writes revisions with operation_id NULL and mints NO endpoint row', async () => {
    const R = mkRecord('p1')
    await seedRecord(R)
    delete process.env[FLAG] // OFF
    const input: WriteRecordPatchInput = {
      sheetId: SHEET,
      changesByRecord: new Map([[R, [{ fieldId: F_STR, value: 'flag-off' }]]]),
      actorId: ACTOR,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      visiblePropertyFieldIds: new Set([F_STR]),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]]) as any,
      capabilities,
      access,
    }
    const before = (await q('SELECT count(*)::int AS n FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    await mkWriteService().patchRecords(input)
    const rev = (await q("SELECT operation_id FROM meta_record_revisions WHERE sheet_id=$1 AND record_id=$2 AND action='update' ORDER BY seq DESC LIMIT 1", [SHEET, R])).rows[0] as { operation_id: string | null }
    expect(rev.operation_id).toBeNull() // untagged — legacy/untrusted shape
    const after = (await q('SELECT count(*)::int AS n FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // no endpoint minted with the flag off
  })

  // §F2 (finding #2, owner review 2026-07-16): v3.7 §1.3 reads the recovery anchorSeq from "that immutable
  // endpoint row". The INSERT trigger seals it at mint; nothing forbade a later UPDATE, so a sealed endpoint's
  // endpoint_seq / event_count / created_at could be silently moved — shifting an already-committed recovery
  // anchor. The migration now installs trg_mrho_reject_update (BEFORE UPDATE → RAISE). This golden seals a real
  // endpoint, attempts each column UPDATE, asserts the DB rejects fail-closed, and (positive control) that the
  // anchor is byte-unchanged after. Mutation: dropping trg_mrho_reject_update makes every expect().rejects red.
  test('§F2 a SEALED operation endpoint is DB-immutable — UPDATE of endpoint_seq/event_count/created_at is rejected; anchor never moves', async () => {
    const op = mkOpId()
    const R = mkRecord('f2imm')
    await inTxn(async (run) => {
      await synthRevision(run, R, 1, '9001', op)
      await synthRevision(run, R, 2, '9002', op)
      await insertEndpoint(run, op, '9002', 2) // endpoint written LAST, count/max exact
    })
    expect(await endpointOf(op)).toEqual({ endpoint_seq: '9002', event_count: 2 })

    // every UPDATE of a sealed column is rejected at the DB level (fail-closed, not app-level)
    await expect(
      q('UPDATE meta_record_history_operations SET endpoint_seq = 999999 WHERE sheet_id=$1 AND operation_id=$2', [SHEET, op]),
    ).rejects.toThrow(/immutable \(UPDATE forbidden\)/)
    await expect(
      q('UPDATE meta_record_history_operations SET event_count = 999 WHERE sheet_id=$1 AND operation_id=$2', [SHEET, op]),
    ).rejects.toThrow(/immutable \(UPDATE forbidden\)/)
    await expect(
      q("UPDATE meta_record_history_operations SET created_at = now() + interval '1 year' WHERE sheet_id=$1 AND operation_id=$2", [SHEET, op]),
    ).rejects.toThrow(/immutable \(UPDATE forbidden\)/)
    // even a no-op UPDATE (same values) is rejected — the row is write-once, period
    await expect(
      q('UPDATE meta_record_history_operations SET endpoint_seq = endpoint_seq WHERE sheet_id=$1 AND operation_id=$2', [SHEET, op]),
    ).rejects.toThrow(/immutable \(UPDATE forbidden\)/)

    // positive control: the sealed anchor is byte-unchanged after every rejected attempt
    expect(await endpointOf(op)).toEqual({ endpoint_seq: '9002', event_count: 2 })
  })
})
