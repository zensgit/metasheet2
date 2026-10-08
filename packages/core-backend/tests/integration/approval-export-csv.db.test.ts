import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ensureApprovalSchemaReady,
  grantApprovalOrgMembership,
} from '../helpers/approval-schema-bootstrap'
import { RECORD_LINK_INACCESSIBLE_VALUE } from '../../src/services/approval-record-link-read-projection'
import { canReadApprovalInstance } from '../../src/services/approval-instance-readability'
import { ApprovalBridgeService } from '../../src/services/ApprovalBridgeService'
import type { UnifiedApprovalDTO } from '../../src/services/approval-bridge-types'

// Fix round (P3-2, gate finding) — wraps `canReadApprovalInstance` (the SAME function the export's
// admission loop calls, `routes/approvals.ts`) so ONE test below can force it to reject for a
// single call, proving the response never ships CSV headers when the loop throws. Default
// behaviour (`vi.fn(actual.canReadApprovalInstance)`) calls straight through to the REAL
// implementation, so every OTHER test in this file keeps observing real admission decisions —
// same shape as `approval-instance-readability-s1-consumers.db.test.ts`'s own spy wrapper. `vi.mock`
// is hoisted by vitest regardless of declaration order, so it applies to the `MetaSheetServer`
// import above too.
vi.mock('../../src/services/approval-instance-readability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/approval-instance-readability')>()
  return {
    ...actual,
    canReadApprovalInstance: vi.fn(actual.canReadApprovalInstance),
  }
})

/**
 * P3-1 — `GET /api/approvals?format=csv` (contract:
 * `p31-approval-export-contract-20260911.md`, base `origin/main @ f8cdc2ca1`).
 *
 * WHAT THIS SUITE GATES, mapped to the contract's five owner-named acceptance rows (§2):
 *   (A) export rides the SAME permission predicate as read — proven here by CONSTRUCTION (the
 *       route calls `canReadApprovalInstance`, the SAME function `GET /api/approvals/:id` calls)
 *       plus a real-DB witness: a row the WIDER list scope admits but the canonical per-instance
 *       predicate refuses (a `source_queue` seat; a `plm:` mirror — §1.5) must be ABSENT from the
 *       export, with a positive control (a genuine seat on the very same row) proving the filter
 *       is not simply "everything the actor is unrelated to".
 *   (B) tenant — PARITY, not a new check (§1.7): flag OFF is the shipped no-op (both rows visible);
 *       flag ON narrows the export to the same org set the read path narrows to, with a positive
 *       control (switching to the caller's own org must still yield a non-empty result).
 *   (C) row-deny / export ⊆ read(detail) — same witness as (A).
 *   (D) field redaction — the record-link mask (`RECORD_LINK_INACCESSIBLE_VALUE`) must survive
 *       into the CSV for a denied viewer, with a positive control (the same field, a record the
 *       viewer CAN read) showing the real `{ recordId }`.
 *   (E) CSV formula injection — gated by the dedicated `tests/unit/csv-cell.test.ts` suite; this
 *       file adds ONE end-to-end wiring proof that the route actually calls the sanitizer on a
 *       real user-controlled field (title), not just that the sanitizer works in isolation.
 *
 * PLUS contract §4 (empty vs refused must be mechanically distinguishable) and §5 (bounded, never
 * silently truncated).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel (matches `approval-list-scope-server-side.db.test.ts`'s own): the
// evidence lane sets EXPECT_DB=1, so a missing/broken DATABASE_URL there REDS the run instead of
// this whole file silently reporting skipped-green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListen(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** Minimal RFC-4180 parser for TEST assertions only (production never parses its own output). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 2
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** `[{header: value, ...}]` keyed by the CSV's own header row, for by-id lookups in assertions. */
function csvRecordsById(text: string): Map<string, Record<string, string>> {
  const rows = parseCsv(text)
  const header = rows[0] ?? []
  const byId = new Map<string, Record<string, string>>()
  for (const row of rows.slice(1)) {
    const rec: Record<string, string> = {}
    header.forEach((col, idx) => { rec[col] = row[idx] ?? '' })
    if (rec.id) byId.set(rec.id, rec)
  }
  return byId
}

describeIfDatabase('P3-1 — GET /api/approvals?format=csv', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const orgPinBeforeSuite = process.env.APPROVAL_S1_ORG_PIN_ENABLED

  const suffix = randomUUID().slice(0, 8)
  const participantId = `p31-participant-${suffix}`
  const queueHolderId = `p31-queue-holder-${suffix}`
  const emptyScopeUserId = `p31-empty-scope-${suffix}`
  const otherRequesterId = `p31-other-requester-${suffix}`
  const queuePermission = `p31:queue:${suffix}`

  const orgA = `p31-org-a-${suffix}`
  const orgB = `p31-org-b-${suffix}`

  // (A)/(C) witness: ONE instance, a `source_queue` seat for `queueHolderId` AND a genuine
  // user-typed seat for `participantId`. The WIDER list scope admits it to BOTH viewers (the
  // source_queue disjunct for one, the ordinary seat arm for the other); `canReadApprovalInstance`
  // admits only the latter (its own SEAT arm never matches `source_queue` — OD-S1-5).
  const queueSeatInstanceId = `p31_queue_seat_${suffix}`
  // (A)/(C) second witness, cheaper (no permission wiring): a `plm:` mirror with participant's own
  // ACTIVE seat. The list scope admits it (seat arm does not care about `source_system`);
  // `canReadApprovalInstance` refuses EVERY `plm:` id unconditionally (OD-S1-18) — a structural
  // guard, not a fixture-specific one.
  const plmSeatInstanceId = `plm:p31_plm_seat_${suffix}`

  // (B) org-pin parity witnesses.
  const orgAInstanceId = `p31_org_a_${suffix}`
  const orgBInstanceId = `p31_org_b_${suffix}`

  // (E) wiring witness: a title containing a formula-leading char AND an RFC-4180 special char.
  const injectionTitle = '=1+1,"gotcha"'
  const injectionInstanceId = `p31_injection_${suffix}`

  const seededInstanceIds = [
    queueSeatInstanceId,
    plmSeatInstanceId,
    orgAInstanceId,
    orgBInstanceId,
    injectionInstanceId,
  ]

  async function authToken(userId: string, roles = 'viewer', perms = '*:*'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function exportCsv(token: string | null, qs = 'tab=pending'): Promise<Response> {
    return fetch(`${baseUrl}/api/approvals?format=csv&${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  }

  async function seedInstance(
    id: string,
    requesterId: string,
    status: string,
    orgId: string | null,
    opts: { sourceSystem?: string; title?: string } = {},
  ): Promise<void> {
    await pool().query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, org_id, created_at, updated_at)
       VALUES ($1, $2, 0, $8, $3, $4, $5, $6::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', $7, now(), now())`,
      [
        id,
        status,
        `p31-wf-${suffix}`,
        `p31:${id}`,
        opts.title ?? `P31 ${id}`,
        JSON.stringify({ id: requesterId, name: requesterId }),
        orgId,
        opts.sourceSystem ?? 'platform',
      ],
    )
  }

  async function seedAssignment(
    instanceId: string,
    assigneeId: string,
    options: { assignmentType?: string; isActive?: boolean } = {},
  ): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments
         (id, instance_id, assignment_type, assignee_id, source_step, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, $4, $3, 0, $5, '{}'::jsonb, now(), now())`,
      [randomUUID(), instanceId, assigneeId, options.assignmentType ?? 'user', options.isActive ?? true],
    )
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()

    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', 'viewer', TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [participantId],
    )
    await grantApprovalOrgMembership(participantId, orgA)

    // (A)/(C) — the queue-seat + canonical-seat instance.
    await seedInstance(queueSeatInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(queueSeatInstanceId, queuePermission, { assignmentType: 'source_queue' })
    await seedAssignment(queueSeatInstanceId, participantId)

    // (A)/(C) — the plm: mirror, participant's own active seat.
    await seedInstance(plmSeatInstanceId, otherRequesterId, 'pending', null, { sourceSystem: 'plm' })
    await seedAssignment(plmSeatInstanceId, participantId)

    // (B) — org pin witnesses, both participant's own seat, different orgs.
    await seedInstance(orgAInstanceId, otherRequesterId, 'pending', orgA)
    await seedAssignment(orgAInstanceId, participantId)
    await seedInstance(orgBInstanceId, otherRequesterId, 'pending', orgB)
    await seedAssignment(orgBInstanceId, participantId)

    // (E) — formula-injection wiring witness.
    await seedInstance(injectionInstanceId, otherRequesterId, 'pending', orgA, { title: injectionTitle })
    await seedAssignment(injectionInstanceId, participantId)

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    baseUrl = `http://127.0.0.1:${server.getAddress()!.port}`
  }, 120_000)

  afterAll(async () => {
    try {
      await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[participantId]])
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[participantId]])
    } catch {
      /* best effort */
    }
    if (orgPinBeforeSuite === undefined) delete process.env.APPROVAL_S1_ORG_PIN_ENABLED
    else process.env.APPROVAL_S1_ORG_PIN_ENABLED = orgPinBeforeSuite
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  describe('(A)/(C) export ⊆ read(detail) — source_queue seat', () => {
    it('a source_queue-seat-only viewer does NOT get the row in the export (list scope ⊋ canonical predicate)', async () => {
      const token = await authToken(queueHolderId, 'user', `approvals:read,${queuePermission}`)
      const res = await exportCsv(token)
      expect(res.status, await res.clone().text()).toBe(200)
      const text = await res.text()
      const byId = csvRecordsById(text)
      expect(byId.has(queueSeatInstanceId)).toBe(false)
    })

    it('POSITIVE CONTROL: a genuine seat on the SAME row DOES appear', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token)
      expect(res.status, await res.clone().text()).toBe(200)
      const byId = csvRecordsById(await res.text())
      expect(byId.has(queueSeatInstanceId)).toBe(true)
    })
  })

  describe('(A)/(C) export ⊆ read(detail) — plm: mirror (OD-S1-18, cheapest witness)', () => {
    it('a plm: row admitted by the wider list scope is absent from the export for the SAME viewer', async () => {
      // `sourceSystem=all` is REQUIRED here: plain `tab=pending` (no `sourceSystem`) makes the
      // route bind `effectiveSourceSystem='platform'` (a tab-less-vs-tab-provided rule that is
      // pre-existing route behaviour, unrelated to this slice), which pushes a `source_system =
      // 'platform'` FILTER conjunct that excludes every `plm:` row from `result.data` before the
      // export's admission filter ever runs — that would make this test pass vacuously (green for
      // the wrong reason) rather than actually exercising `canReadApprovalInstance`'s OD-S1-18
      // guard. `sourceSystem=all` keeps the mixed feed so the plm row reaches `result.data`, and
      // the admission filter is what has to drop it. Caught by running this exact test against a
      // `canReadApprovalInstance → true` mutation (see PR body / report) before trusting it.
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending&sourceSystem=all')
      expect(res.status, await res.clone().text()).toBe(200)
      const byId = csvRecordsById(await res.text())
      // Same viewer whose OTHER rows (queueSeatInstanceId, orgAInstanceId, ...) DO appear —
      // proving this is not a global "participant sees nothing" failure.
      expect(byId.has(plmSeatInstanceId)).toBe(false)
      expect(byId.has(queueSeatInstanceId)).toBe(true)
    })
  })

  describe('(B) tenant — parity, not a new check', () => {
    it('org pin OFF (shipped default): both orgs visible to the export — no-op, matching the read path', async () => {
      expect(process.env.APPROVAL_S1_ORG_PIN_ENABLED).toBeFalsy()
      const token = await authToken(participantId, 'user', 'approvals:read')
      const byId = csvRecordsById(await (await exportCsv(token)).text())
      expect(byId.has(orgAInstanceId)).toBe(true)
      expect(byId.has(orgBInstanceId)).toBe(true)
    })

    it('org pin ON: export narrows to the viewer\'s own org, matching the read path (positive control: own org still non-empty)', async () => {
      process.env.APPROVAL_S1_ORG_PIN_ENABLED = 'true'
      try {
        const token = await authToken(participantId, 'user', 'approvals:read')
        const byId = csvRecordsById(await (await exportCsv(token)).text())
        expect(byId.has(orgAInstanceId)).toBe(true) // positive control: own-org row still returned
        expect(byId.has(orgBInstanceId)).toBe(false) // narrowed exactly like the read path
      } finally {
        process.env.APPROVAL_S1_ORG_PIN_ENABLED = orgPinBeforeSuite
      }
    })
  })

  describe('§4 — empty vs refused must be mechanically distinguishable', () => {
    it('a genuinely empty scope is 200 text/csv (header only); an unauthenticated request is 401 application/json', async () => {
      const emptyToken = await authToken(emptyScopeUserId, 'user', 'approvals:read')
      const emptyRes = await exportCsv(emptyToken, 'tab=pending')
      expect(emptyRes.status).toBe(200)
      expect(emptyRes.headers.get('content-type')).toMatch(/^text\/csv/)
      expect(emptyRes.headers.get('x-approval-export-row-count')).toBe('0')
      const emptyText = await emptyRes.text()
      // Header row only — no data rows — but still a legible CSV, not an empty body.
      expect(emptyText.trim().split('\r\n').length).toBe(1)
      expect(emptyText.startsWith('id,')).toBe(true)

      const refusedRes = await exportCsv(null)
      expect(refusedRes.status).toBe(401)
      expect(refusedRes.headers.get('content-type')).toMatch(/^application\/json/)
      const refusedText = await refusedRes.text()

      // Byte-level: different status, different Content-Type, different first byte.
      expect(refusedRes.status).not.toBe(emptyRes.status)
      expect(refusedRes.headers.get('content-type')).not.toBe(emptyRes.headers.get('content-type'))
      expect(refusedText.startsWith('{')).toBe(true)
      expect(emptyText.startsWith('{')).toBe(false)
    })
  })

  describe('§5 — bounded, never silently truncated', () => {
    it('a small ?limit= drives the cap signal true and the row count matches what was actually written', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      // participant's pending scope has >= 3 rows (queueSeatInstanceId, orgAInstanceId,
      // orgBInstanceId; plmSeatInstanceId is admitted to the WIDER scope but denied by the
      // canonical predicate, and injectionInstanceId also qualifies) — capping at 1 must be
      // visibly a CAP, not a silent truncation.
      const res = await exportCsv(token, 'tab=pending&limit=1')
      expect(res.status).toBe(200)
      // `-Row-Limit` is the EFFECTIVE limit this request ran under; `-Row-Cap` is the constant
      // server ceiling — kept as two separate headers so a caller reading "Cap" doesn't mistake a
      // small per-request `?limit=` for the server's actual hard bound.
      expect(res.headers.get('x-approval-export-row-limit')).toBe('1')
      // Fix round (P2-1, gate finding): ROW_CAP lowered from 5000 to 500.
      expect(res.headers.get('x-approval-export-row-cap')).toBe('500')
      expect(res.headers.get('x-approval-export-capped')).toBe('true')
      const count = Number(res.headers.get('x-approval-export-row-count'))
      expect(count).toBe(1)
      const byId = csvRecordsById(await res.text())
      expect(byId.size).toBe(count)
    })

    it('a limit above the scope size is NOT reported as capped', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending&limit=500')
      expect(res.status).toBe(200)
      expect(res.headers.get('x-approval-export-capped')).toBe('false')
    })

    it('?limit= can never exceed the configured hard cap (Row-Limit is clamped; Row-Cap never moves)', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending&limit=999999999')
      expect(res.status).toBe(200)
      // Fix round (P2-1, gate finding): ROW_CAP lowered from 5000 to 500.
      expect(Number(res.headers.get('x-approval-export-row-limit'))).toBe(500)
      expect(Number(res.headers.get('x-approval-export-row-cap'))).toBe(500)
    })
  })

  describe('sourceSystem=plm is refused for CSV export (no unbounded PLM sync via GET)', () => {
    it('rejects ?format=csv&sourceSystem=plm with 400 BEFORE any PLM sync/adapter check', async () => {
      // This must 400 even with NO PLM adapter configured on this harness — proving the guard
      // fires ahead of `bridgeService.hasPlmAdapter()` (which would otherwise 503 first) and,
      // more importantly, ahead of `syncPlmApprovals({ limit, offset })`, which for a CSV request
      // would otherwise run with `limit = APPROVAL_EXPORT_ROW_CAP` (500) instead of the ordinary
      // JSON page size — an unbounded-relative-to-JSON external sync + upsert batch triggerable by
      // any `approvals:read` holder via a plain GET, for a scope `canReadApprovalInstance` (§1.5)
      // guarantees will export zero rows anyway (every `plm:` id is refused, OD-S1-18).
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await fetch(`${baseUrl}/api/approvals?format=csv&sourceSystem=plm&tab=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('APPROVAL_EXPORT_SOURCE_SYSTEM_UNSUPPORTED')
    })

    it('sourceSystem=all (mixed feed) is NOT refused — only the plm-only filter is', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending&sourceSystem=all')
      expect(res.status).toBe(200)
    })
  })

  describe('(E) formula-injection — end-to-end wiring (unit coverage lives in tests/unit/csv-cell.test.ts)', () => {
    it('a real user-controlled title field is run through the sanitizer, not echoed raw', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending')
      const text = await res.text()
      expect(text.includes(injectionTitle)).toBe(false)
      // HARD-CODED, hand-derived expected cell — deliberately NOT computed by calling
      // `sanitizeCsvCell(injectionTitle)` here. Calling the same function under test to build its
      // own expected value makes the assertion vacuous: a mutation that guts the sanitizer changes
      // the route's real output AND this test's "expected" value in lockstep, so the comparison
      // stays green no matter what the function does (caught by running this exact mutation before
      // trusting the test — see PR body / report). Derivation for
      // `injectionTitle = '=1+1,"gotcha"'`: neutralize the leading '=' -> `'=1+1,"gotcha"`; that
      // text contains a comma and two `"` so RFC-4180 quoting wraps it and doubles each `"` ->
      // `"'=1+1,""gotcha"""`.
      const expectedCell = `"'=1+1,""gotcha"""`
      expect(text.includes(expectedCell)).toBe(true)
    })
  })

  describe('P3-4 fix — UTF-8 BOM prefixes the CSV body', () => {
    it('the response bytes start with the UTF-8 BOM (EF BB BF), before the header row', async () => {
      // Read RAW BYTES, not `.text()` — `Response.text()` follows the WHATWG "UTF-8 decode"
      // algorithm, which STRIPS a leading BOM on decode, so a BOM-stripping regression would be
      // invisible to every other assertion in this file that reads `.text()`. Only inspecting the
      // raw `arrayBuffer()` can prove the byte is actually on the wire.
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending')
      expect(res.status).toBe(200)
      // Clone BEFORE consuming either body — a `Response` body can only be read once.
      const cloned = res.clone()
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
      // The header row starts immediately after the 3-byte BOM — 'i' of "id,...".
      expect(bytes[3]).toBe('i'.charCodeAt(0))
      expect(bytes[4]).toBe('d'.charCodeAt(0))
      expect(bytes[5]).toBe(','.charCodeAt(0))

      // POSITIVE CONTROL: `.text()` decoding strips the BOM, so the DECODED string still starts
      // with the header row directly — proves the BOM is a body-prefix concern, not something that
      // corrupts every other string-based assertion in this file.
      const text = await cloned.text()
      expect(text.startsWith('id,')).toBe(true)
      expect(text.charCodeAt(0)).not.toBe(0xfeff)
    })
  })

  describe('response headers', () => {
    it('Content-Disposition filename is a fixed literal', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="approvals-export.csv"')
    })

    it('an unrecognised format value is IGNORED — normal JSON response (P3-3 fix: restores pre-slice behaviour)', async () => {
      // Fix round (P3-3, gate finding): this route pre-dates this slice and NEVER read `format` at
      // all, so `?format=json` (and any other non-`csv` value) was previously accepted-and-ignored
      // — 200 JSON, byte-equivalent to no `format` at all — not rejected. A prior version of this
      // slice 400'd on exactly this, which contract §5 forbids (changing an existing read
      // endpoint's semantics). POSITIVE CONTROL: the no-`format` request is the oracle here, NOT
      // a value computed by calling any function under test.
      const token = await authToken(participantId, 'user', 'approvals:read')

      const baselineRes = await fetch(`${baseUrl}/api/approvals?tab=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(baselineRes.status).toBe(200)
      const baseline = (await baselineRes.json()) as { data: unknown[]; total: number }

      // 'CSV' (uppercase) is included deliberately: the CSV-branch match is an EXACT literal-string
      // comparison (no trim, no case-fold — see the route's own comment), so anything other than
      // the exact lowercase `csv` — including a case variant — is just another non-`csv` value.
      for (const format of ['json', 'whatever', 'CSV']) {
        const res = await fetch(`${baseUrl}/api/approvals?format=${format}&tab=pending`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status, `format=${format} must not 400`).toBe(200)
        expect(res.headers.get('content-type')).toMatch(/^application\/json/)
        const body = (await res.json()) as { data: unknown[]; total: number }
        expect(body.total, `format=${format} total must match the no-format baseline`).toBe(baseline.total)
        expect(body.data.length, `format=${format} data length must match the no-format baseline`).toBe(baseline.data.length)
      }
    })
  })

  describe('P3-2 fix — a throw during CSV serialization never ships CSV headers', () => {
    it('DISCRIMINATING: a throw INSIDE the column-projection loop (after admission, before headers) is a DIFFERENT status + JSON body, with none of the CSV/X-Approval-Export-* headers set', async () => {
      // This is the test that actually gates the fix. The gate's probe 4 injected its throw
      // immediately AFTER the (pre-fix) `setHeader` block and BEFORE the row-serialization loop —
      // i.e. inside the window this fix eliminates by moving every `setHeader` call to AFTER the
      // body is fully built. A throw any EARLIER than that window (e.g. in the admission loop) was
      // ALREADY safe even before this fix, so it would prove nothing about what changed; this test
      // throws from INSIDE the serialization loop itself, which is exactly the window that moved.
      //
      // Mechanism: `ApprovalBridgeService.prototype.listApprovals` is spied to return, for this ONE
      // call, a single DTO whose `id` is `orgAInstanceId` — a REAL seeded row `participantId`
      // genuinely holds a seat on — so the REAL (unmocked) `canReadApprovalInstance` admits it for
      // real, and the throwing getter on `title` is reached only once the serialization loop
      // actually starts projecting columns for that admitted row.
      const listApprovalsSpy = vi.spyOn(ApprovalBridgeService.prototype, 'listApprovals')
      const throwingDto = {
        id: orgAInstanceId,
        sourceSystem: 'platform',
        status: 'pending',
        currentStep: 0,
        totalSteps: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as UnifiedApprovalDTO
      Object.defineProperty(throwingDto, 'title', {
        enumerable: true,
        get() {
          throw new Error('P31-FIX3-SERIALIZATION-THROW (test-only)')
        },
      })
      listApprovalsSpy.mockResolvedValueOnce({ data: [throwingDto], total: 1 })

      try {
        const token = await authToken(participantId, 'user', 'approvals:read')
        const res = await exportCsv(token, 'tab=pending')

        // A DIFFERENT status than the 200 success path this same request otherwise gets.
        expect(res.status).toBe(500)
        // A JSON body, never text/csv.
        expect(res.headers.get('content-type')).toMatch(/^application\/json/)
        // None of the CSV-only headers were ever set — proves `res.setHeader` for the export was
        // never reached, not merely that the body happens to look like JSON. THIS is the assertion
        // that reds under the pre-fix header-then-serialize ordering (verified by hand: moving the
        // `setHeader` block back before the serialization loop turns this response into a 500 that
        // STILL carries `content-type: text/csv` and a real `x-approval-export-row-count`).
        expect(res.headers.get('content-disposition')).toBeNull()
        expect(res.headers.get('x-approval-export-row-count')).toBeNull()
        expect(res.headers.get('x-approval-export-row-limit')).toBeNull()
        expect(res.headers.get('x-approval-export-row-cap')).toBeNull()
        expect(res.headers.get('x-approval-export-capped')).toBeNull()

        const body = (await res.json()) as { ok: boolean; error?: { code?: string } }
        expect(body.ok).toBe(false)
        expect(body.error?.code).toBe('APPROVAL_EXPORT_FAILED')
      } finally {
        listApprovalsSpy.mockRestore()
      }
    })

    it('additional guard: a throw in the EARLIER admission loop also never ships CSV headers (already true before this fix)', async () => {
      // NOT the discriminating test for this fix (an admission-loop throw was always before any
      // header was set, even pre-fix) — kept as a general "any throw on the export path answers in
      // JSON" regression guard, since it exercises a different real failure surface
      // (`canReadApprovalInstance` itself rejecting) than the serialization-loop test above.
      const mockedCanRead = vi.mocked(canReadApprovalInstance)
      mockedCanRead.mockRejectedValueOnce(new Error('P31-FIX3-ADMISSION-THROW (test-only)'))
      try {
        const token = await authToken(participantId, 'user', 'approvals:read')
        const res = await exportCsv(token, 'tab=pending')
        expect(res.status).toBe(500)
        expect(res.headers.get('content-type')).toMatch(/^application\/json/)
        expect(res.headers.get('content-disposition')).toBeNull()
      } finally {
        // `mockRejectedValueOnce` is already consumed after the one call above; this just clears
        // call-history bookkeeping. Do NOT `vi.restoreAllMocks()` — that would tear down the
        // `vi.mock` wrapper itself, which every OTHER test in this file relies on to reach the
        // real `canReadApprovalInstance`.
        mockedCanRead.mockClear()
      }
    })

    it('POSITIVE CONTROL: the SAME request, without any injected failure, is 200 text/csv with the headers present', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
      expect(res.headers.get('x-approval-export-row-count')).not.toBeNull()
    })
  })

  // (P3-1 fix) — hidden-field redaction. Nested INSIDE the outer describe, same reason as (D)
  // below: shares the ONE server/pool lifecycle rather than starting a second server against an
  // already-torn-down pool.
  describe('(P3-1 fix) hidden-field redaction (approval-form-redaction.ts) survives into the export', () => {
    const fSuffix = randomUUID().slice(0, 8)
    const hiddenFieldRequesterId = `p31f-requester-${fSuffix}`
    // ONE runtime graph, TWO nodes: `hiding_node` marks `secret` hidden; `visible_node` has no
    // fieldPermissions at all (so `secret` defaults to `editable`, OD-L7-9) — same graph, so this
    // is a same-template A/B pair, not two independently-configured fixtures.
    const hidingInstanceId = `p31f-hiding-${fSuffix}`
    const visibleInstanceId = `p31f-visible-${fSuffix}`
    let fTemplateId = ''

    beforeAll(async () => {
      const p = pool()
      const template = await p.query<{ id: string }>(
        `INSERT INTO approval_templates (key, name, status) VALUES ($1, $2, 'published') RETURNING id`,
        [`p31f-tpl-${fSuffix}`, 'P31F hidden-field export'],
      )
      fTemplateId = template.rows[0].id

      const version = await p.query<{ id: string }>(
        `INSERT INTO approval_template_versions (template_id, version, form_schema, approval_graph)
         VALUES ($1, 1, $2, '{}'::jsonb) RETURNING id`,
        [
          fTemplateId,
          JSON.stringify({
            fields: [
              { id: 'reason', type: 'text', label: 'Reason' },
              { id: 'secret', type: 'text', label: 'Secret' },
            ],
          }),
        ],
      )

      // Mirrors `approval-bridge-redaction-regression.test.ts`'s own fixture shape for this exact
      // mechanism (`redactHiddenFormFields` keyed on the instance's active node).
      const runtimeGraph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'hiding_node', type: 'approval', config: { fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] } },
          { key: 'visible_node', type: 'approval', config: {} },
          { key: 'end', type: 'end', config: {} },
        ],
      }
      const published = await p.query<{ id: string }>(
        `INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph)
         VALUES ($1, $2, $3) RETURNING id`,
        [fTemplateId, version.rows[0].id, JSON.stringify(runtimeGraph)],
      )
      const publishedDefinitionId = published.rows[0].id
      const snapshot = JSON.stringify({ reason: 'trip', secret: 'classified' })

      // Non-PLM ids, `source_system = 'platform'` explicitly (matches this file's other seeds —
      // plain `tab=pending`, no `sourceSystem`, resolves to the `platform` filter).
      await p.query(
        `INSERT INTO approval_instances
           (id, status, source_system, current_node_key, form_snapshot, published_definition_id, requester_snapshot)
         VALUES ($1, 'pending', 'platform', 'hiding_node', $2::jsonb, $3, $4::jsonb)`,
        [hidingInstanceId, snapshot, publishedDefinitionId, JSON.stringify({ id: hiddenFieldRequesterId })],
      )
      await p.query(
        `INSERT INTO approval_instances
           (id, status, source_system, current_node_key, form_snapshot, published_definition_id, requester_snapshot)
         VALUES ($1, 'pending', 'platform', 'visible_node', $2::jsonb, $3, $4::jsonb)`,
        [visibleInstanceId, snapshot, publishedDefinitionId, JSON.stringify({ id: hiddenFieldRequesterId })],
      )
      // A 'user' seat for `participantId` on BOTH instances — the SAME viewer whose export is
      // asserted on below, so this is a same-viewer A/B comparison, not two different viewers.
      await seedAssignment(hidingInstanceId, participantId)
      await seedAssignment(visibleInstanceId, participantId)
    }, 120_000)

    afterAll(async () => {
      try {
        const p = pool()
        await p.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [[hidingInstanceId, visibleInstanceId]])
        await p.query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [[hidingInstanceId, visibleInstanceId]])
        if (fTemplateId) {
          // template delete cascades version + published_definition (FK ON DELETE CASCADE) — same
          // as `approval-bridge-redaction-regression.test.ts`'s own cleanup.
          await p.query(`DELETE FROM approval_templates WHERE id = $1`, [fTemplateId])
        }
      } catch {
        /* best effort */
      }
    })

    it('a field hidden at the active node is absent from the exported cell; the SAME field on a non-hiding node is present (positive control)', async () => {
      const token = await authToken(participantId, 'user', 'approvals:read')
      const res = await exportCsv(token, 'tab=pending')
      expect(res.status, await res.clone().text()).toBe(200)
      const rows = parseCsv(await res.text())
      const header = rows[0]!
      const idCol = header.indexOf('id')
      const formCol = header.indexOf('formSnapshot')
      expect(idCol).toBeGreaterThanOrEqual(0)
      expect(formCol).toBeGreaterThanOrEqual(0)

      const hidingRow = rows.find((r) => r[idCol] === hidingInstanceId)
      const visibleRow = rows.find((r) => r[idCol] === visibleInstanceId)
      expect(hidingRow, 'the hiding-node instance must be present (the viewer IS a seat on it — only the FIELD is redacted)').toBeTruthy()
      expect(visibleRow, 'the non-hiding-node instance must be present').toBeTruthy()

      const hidingSnapshot = JSON.parse(hidingRow![formCol]!) as Record<string, unknown>
      const visibleSnapshot = JSON.parse(visibleRow![formCol]!) as Record<string, unknown>

      // NEGATIVE: `secret` is hidden at `hiding_node` — stripped entirely from the exported cell,
      // never a redaction sentinel, never an empty string. `reason` (not hidden) survives alongside
      // it, proving this is not a blanket "everything on this row is gone" failure.
      expect(hidingSnapshot).not.toHaveProperty('secret')
      expect(hidingSnapshot).toHaveProperty('reason', 'trip')
      // Row-wide scope check (gate's own named future-regression scenario): 'classified' must not
      // leak into the hiding-node row through ANY column, not just `formSnapshot` — this is what
      // would catch a FUTURE column sourced from the raw `row.form_snapshot` instead of the
      // already-redacted `dto.formSnapshot` (e.g. a hypothetical `{ header: 'rawForm', value: (d)
      // => (d as any).__row?.form_snapshot }` entry), which a formSnapshot-only assertion could not.
      expect(hidingRow!.join(',')).not.toContain('classified')

      // POSITIVE CONTROL: the SAME field (`secret`), on the SAME template, for the SAME viewer, at
      // a node with no `fieldPermissions` at all — comes through untouched.
      expect(visibleSnapshot).toHaveProperty('secret', 'classified')
      expect(visibleSnapshot).toHaveProperty('reason', 'trip')
    })
  })

  // (D) — record-link masking. Nested INSIDE the outer describe so it shares the ONE
  // server/pool lifecycle above (`server.stop()` tears down the shared `poolManager` pool for the
  // whole process — a second independent `beforeAll`/`afterAll` pair in this same file that also
  // starts/stops a server would leave the second suite trying to reconnect through an already-
  // ended pool the moment the first suite's `afterAll` runs).
  describe('(D) record-link masking survives into the export', () => {
  const suffix = randomUUID().slice(0, 8)
  const ADMIN = `p31d-admin-${suffix}`
  const FILLER = `p31d-filler-${suffix}`
  const baseId = `p31d-base-${suffix}`
  const sheetId = `p31d-sheet-${suffix}`
  const readableRecordId = `p31d-rec-ok-${suffix}`
  const deniedRecordId = `p31d-rec-deny-${suffix}`
  let tid = ''
  let okInstanceId = ''
  let denyInstanceId = ''

  async function tok(userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
    const res = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    await grantApprovalOrgMembership(userId)
    return ((await res.json()) as { token: string }).token
  }

  async function req(path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  }

  beforeAll(async () => {
    const adminTok = await tok(ADMIN)

    const p = pool()
    // ADMIN is DB-backed admin (JWT role claim alone is not enough — see approval-record-link
    // fixture precedent this borrows from).
    await p.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN])

    // FILLER owns the base (txn-local base-read via ownership, same shape
    // `approval-record-link.db.test.ts` already proves works).
    await p.query(
      'INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [baseId, `P31D Base ${suffix}`, FILLER],
    )
    await p.query(
      'INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [sheetId, baseId, `P31D Sheet ${suffix}`],
    )
    await p.query('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [sheetId])
    await p.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1, $2, '{}'::jsonb, 1, $3), ($4, $2, '{}'::jsonb, 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [readableRecordId, sheetId, ADMIN, deniedRecordId],
    )
    await p.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read')
       ON CONFLICT DO NOTHING`,
      [FILLER],
    )
    try {
      await p.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
         VALUES ($1, 'user', $2, 'spreadsheet:read')`,
        [sheetId, FILLER],
      )
    } catch {
      await p.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
        [sheetId, FILLER],
      )
    }
    // The negative control: FILLER is explicitly denied read on `deniedRecordId`, on the SAME
    // pinned sheet as `readableRecordId` (not-denied is the positive control).
    await p.query(
      `INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level)
       VALUES ($1, $2, 'user', $3, 'none')`,
      [sheetId, deniedRecordId, FILLER],
    )

    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [FILLER] }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const key = `p31d-tpl-${suffix}`
    const created = await req('/api/approval-templates', adminTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{ id: 'linked', type: 'record-link', label: 'Linked', required: true, props: { baseId, sheetId } }],
        },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    tid = ((await created.json()) as { id: string }).id
    const published = await req(`/api/approval-templates/${tid}/publish`, adminTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)

    // ADMIN submits both — the SUBMIT-time record-read check is scoped to the SUBMITTER (ADMIN,
    // who bypasses via isAdminRole), not the assignee (FILLER, the export viewer under test). The
    // export-time record-link PROJECTION, by contrast, keys on the EXPORTING viewer (`actorId` of
    // the GET request) — a different check entirely, which is exactly what this test exercises.
    const okCreated = await req('/api/approvals', adminTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: readableRecordId } } },
    })
    expect(okCreated.status, await okCreated.clone().text()).toBeLessThan(300)
    okInstanceId = (((await okCreated.json()) as { id?: string; data?: { id: string } }).id
      ?? ((await okCreated.clone().json()) as { data?: { id: string } }).data?.id) as string

    const denyCreated = await req('/api/approvals', adminTok, {
      method: 'POST',
      body: { templateId: tid, formData: { linked: { recordId: deniedRecordId } } },
    })
    expect(denyCreated.status, await denyCreated.clone().text()).toBeLessThan(300)
    denyInstanceId = (((await denyCreated.json()) as { id?: string; data?: { id: string } }).id
      ?? ((await denyCreated.clone().json()) as { data?: { id: string } }).data?.id) as string

    expect(okInstanceId).toBeTruthy()
    expect(denyInstanceId).toBeTruthy()
  }, 120_000)

  afterAll(async () => {
    try {
      const p = pool()
      await p.query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [[okInstanceId, denyInstanceId].filter(Boolean)])
      await p.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [[okInstanceId, denyInstanceId].filter(Boolean)])
      await p.query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [[okInstanceId, denyInstanceId].filter(Boolean)])
      if (tid) {
        await p.query(`DELETE FROM approval_published_definitions WHERE template_id = $1`, [tid])
        await p.query(`DELETE FROM approval_template_versions WHERE template_id = $1`, [tid])
        await p.query(`DELETE FROM approval_templates WHERE id = $1`, [tid])
      }
      await p.query(`DELETE FROM record_permissions WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await p.query(`DELETE FROM spreadsheet_permissions WHERE sheet_id = $1`, [sheetId]).catch(() => {})
      await p.query(`DELETE FROM user_permissions WHERE user_id = $1`, [FILLER]).catch(() => {})
      await p.query(`DELETE FROM user_roles WHERE user_id = $1`, [ADMIN]).catch(() => {})
      await p.query(`DELETE FROM meta_records WHERE id = ANY($1::text[])`, [[readableRecordId, deniedRecordId]]).catch(() => {})
      await p.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
      await p.query(`DELETE FROM meta_bases WHERE id = $1`, [baseId]).catch(() => {})
    } catch {
      /* best effort */
    }
    // NOTE: does NOT stop `server` — it is shared with the outer describe block, which owns its
    // lifecycle (see the comment above this nested describe).
  })

  it('the record-link mask survives into the CSV for a denied viewer, with a positive control', async () => {
    const fillerTok = await tok(FILLER, 'user', 'approvals:read')
    const res = await fetch(`${baseUrl}/api/approvals?format=csv&tab=pending`, {
      headers: { Authorization: `Bearer ${fillerTok}` },
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const text = await res.text()
    const rows = parseCsv(text)
    const header = rows[0]!
    const idCol = header.indexOf('id')
    const formCol = header.indexOf('formSnapshot')
    expect(idCol).toBeGreaterThanOrEqual(0)
    expect(formCol).toBeGreaterThanOrEqual(0)

    const okRow = rows.find((r) => r[idCol] === okInstanceId)
    const denyRow = rows.find((r) => r[idCol] === denyInstanceId)
    expect(okRow, 'the readable-record instance must be present').toBeTruthy()
    expect(denyRow, 'the denied-record instance must be present (viewer IS a seat on it — it is only the FIELD that is masked)').toBeTruthy()

    const okSnapshot = JSON.parse(okRow![formCol]!) as { linked?: unknown }
    const denySnapshot = JSON.parse(denyRow![formCol]!) as { linked?: unknown }

    // POSITIVE CONTROL: a record the viewer CAN read keeps the real recordId.
    expect(okSnapshot.linked).toEqual({ recordId: readableRecordId })
    // NEGATIVE: a record the viewer is denied comes back as the sentinel, never the raw id.
    expect(denySnapshot.linked).toEqual(RECORD_LINK_INACCESSIBLE_VALUE)
    expect(JSON.stringify(denySnapshot.linked)).not.toContain(deniedRecordId)
  })
  })
})
