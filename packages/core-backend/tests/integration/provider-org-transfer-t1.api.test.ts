import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { adminDirectoryOrgTransfersRouter } from '../../src/routes/admin-directory-org-transfers'

/**
 * Transfer MVP — T1 (schema + admin API skeleton, no-op adapter), real DB + HTTP route layer.
 * Harness mirrors `local-directory-org-crud-route.db.test.ts` (trivial pass-through auth with
 * `role: 'admin'`; the non-admin app exercises the real RBAC query).
 *
 * What this suite pins, per the T1 row of the MVP sequencing plan:
 *   - platform-admin gating on every route (403 leg per endpoint);
 *   - create validations fail closed with ZERO rows and ZERO audit rows (audit-zero assertions
 *     are scoped to this suite's unique actor id — never global counts);
 *   - the SCHEMA backstops (not just service validation): cross-org and provider-mismatched
 *     transfers are FK-impossible to INSERT even bypassing the service; provider='local' is
 *     CHECK-impossible;
 *   - lifecycle draft → scan → dry-run → apply with one values-free audit row per mutation;
 *   - §12.3 dry-run-required guard, and its SCAN-RELATIVITY (a re-scan invalidates the dry-run);
 *   - the undecided-decisions apply guard (seeded directly — the no-op adapter scans zero);
 *   - at-most-one-ACTIVE-transfer-per-source (both halves: cap while active, free after cancel);
 *   - terminal states reject every further mutation;
 *   - apply/apply concurrency linearizes on the row lock (exactly one 200);
 *   - the T1 no-op apply writes NOTHING to any directory_* table (fingerprint equality).
 *
 * DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
 * skip-green, and wired as a WHOLE FILE into the directory real-DB step in plugin-tests.yml
 * (both points asserted by scripts/ops/t1-org-transfer-ci-wiring.test.mjs).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const ADMIN_ID = `t1-transfer-admin-${STAMP}`

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: ADMIN_ID, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `t1-transfer-nonadmin-${STAMP}` }
  next()
})
nonAdminApp.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())

function uniqueOrg(tag: string): string {
  return `t1-org-${STAMP}-${tag}-${randomUUID().slice(0, 8)}`
}

async function seedIntegration(org: string, provider: string, tag: string): Promise<string> {
  // B1's local_integration_corp_id_shape CHECK pins provider='local' rows to corp_id 'local:<org>'.
  const corpId = provider === 'local' ? `local:${org}` : `t1-corp-${STAMP}-${tag}`
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, $2, $3, 'active', $4, '{}'::jsonb) RETURNING id`,
    [org, provider, `T1 ${provider} ${tag} ${STAMP}`, corpId]
  )
  return result.rows[0].id
}

/**
 * The `directory.org_transfer.%` action namespace is written by NOTHING but the T1 routes, and
 * audit_logs has no text actor column (auditLog only maps numeric actor ids into user_id), so
 * the zero-audit assertions scope on the action prefix — unique to this feature, race-free
 * against every other suite sharing the CI database.
 */
async function orgTransferAuditCount(): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action LIKE 'directory.org_transfer.%'`
  )
  return Number(result.rows[0].n)
}

async function auditRowFor(action: string, transferId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = $1 AND resource_id = $2`,
    [`directory.org_transfer.${action}`, transferId]
  )
  return Number(result.rows[0].n)
}

/** Row-count + latest-updated fingerprint over every table the no-op apply must not touch. */
async function directoryFingerprint(): Promise<string> {
  const result = await query<{ fp: string }>(
    `SELECT concat_ws('|',
        (SELECT concat(count(*), ':', coalesce(max(updated_at)::text, '-')) FROM directory_accounts),
        (SELECT concat(count(*), ':', coalesce(max(updated_at)::text, '-')) FROM directory_departments),
        (SELECT concat(count(*), ':', coalesce(max(created_at)::text, '-')) FROM directory_account_departments),
        (SELECT count(*)::text FROM user_external_identities)
      ) AS fp`
  )
  return result.rows[0].fp
}

describeIfDatabase('Transfer MVP T1 — provider org-transfer schema + admin API skeleton (real DB, HTTP)', () => {
  const createdTransferIds: string[] = []
  const createdIntegrationIds: string[] = []

  afterEach(async () => {
    const transfers = createdTransferIds.splice(0)
    for (const id of transfers) await query(`DELETE FROM provider_org_transfers WHERE id = $1`, [id]) // decisions cascade
    const integrations = createdIntegrationIds.splice(0)
    for (const id of integrations) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
  })

  async function seedPair(tag: string, org = uniqueOrg(tag)): Promise<{ org: string; source: string; target: string }> {
    const source = await seedIntegration(org, 'dingtalk', `${tag}-src`)
    const target = await seedIntegration(org, 'dingtalk', `${tag}-dst`)
    createdIntegrationIds.push(source, target)
    return { org, source, target }
  }

  async function createTransfer(source: string, target: string): Promise<string> {
    const res = await request(adminApp)
      .post('/api/admin/directory/org-transfers')
      .send({ provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: target })
    expect(res.status).toBe(200)
    const id = res.body.data.transfer.id as string
    createdTransferIds.push(id)
    return id
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('rejects every route for a non-platform-admin (403/401 family), writing nothing', async () => {
    const { source, target } = await seedPair('rbac')
    const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM provider_org_transfers WHERE source_integration_id = $1`, [source])

    const create = await request(nonAdminApp)
      .post('/api/admin/directory/org-transfers')
      .send({ provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: target })
    expect(create.status).toBeGreaterThanOrEqual(401)
    expect(create.status).toBeLessThanOrEqual(403)

    const probeId = randomUUID()
    for (const probe of [
      request(nonAdminApp).get(`/api/admin/directory/org-transfers/${probeId}`),
      request(nonAdminApp).post(`/api/admin/directory/org-transfers/${probeId}/scan`),
      request(nonAdminApp).post(`/api/admin/directory/org-transfers/${probeId}/apply?dryRun=true`),
      request(nonAdminApp).post(`/api/admin/directory/org-transfers/${probeId}/apply`),
      request(nonAdminApp).post(`/api/admin/directory/org-transfers/${probeId}/cancel`),
    ]) {
      const res = await probe
      expect(res.status).toBeGreaterThanOrEqual(401)
      expect(res.status).toBeLessThanOrEqual(403)
    }

    const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM provider_org_transfers WHERE source_integration_id = $1`, [source])
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('fails create closed on every invalid input — zero rows, zero audit rows (actor-scoped)', async () => {
    const { org, source, target } = await seedPair('valid')
    const otherOrgIntegration = await seedIntegration(uniqueOrg('valid-other'), 'dingtalk', 'valid-other')
    const wecomIntegration = await seedIntegration(org, 'wecom', 'valid-wecom')
    createdIntegrationIds.push(otherOrgIntegration, wecomIntegration)
    const auditBefore = await orgTransferAuditCount()

    const cases: Array<{ body: Record<string, unknown>; expectStatus: number; expectCode: string }> = [
      // unknown source / target
      { body: { provider: 'dingtalk', sourceIntegrationId: randomUUID(), targetIntegrationId: target }, expectStatus: 404, expectCode: 'ORG_TRANSFER_NOT_FOUND' },
      { body: { provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: randomUUID() }, expectStatus: 404, expectCode: 'ORG_TRANSFER_NOT_FOUND' },
      // source == target
      { body: { provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: source }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
      // provider mismatch (one end is wecom)
      { body: { provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: wecomIntegration }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
      // cross-org
      { body: { provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: otherOrgIntegration }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
      // provider = local is never transferable
      { body: { provider: 'local', sourceIntegrationId: source, targetIntegrationId: target }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
      // smuggled org identity fails the whole request (fail-closed allowlist)
      { body: { provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: target, org_id: 'evil' }, expectStatus: 400, expectCode: 'ORG_TRANSFER_UNKNOWN_FIELDS' },
      // non-UUID ids 400 at the edge (never reach a ::uuid cast 500)
      { body: { provider: 'dingtalk', sourceIntegrationId: 'not-a-uuid', targetIntegrationId: target }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
      // provider empty
      { body: { provider: '   ', sourceIntegrationId: source, targetIntegrationId: target }, expectStatus: 400, expectCode: 'ORG_TRANSFER_INVALID_INPUT' },
    ]

    for (const testCase of cases) {
      const res = await request(adminApp).post('/api/admin/directory/org-transfers').send(testCase.body)
      expect(res.status, JSON.stringify(testCase.body)).toBe(testCase.expectStatus)
      expect(res.body.error.code).toBe(testCase.expectCode)
    }

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM provider_org_transfers WHERE source_integration_id = ANY($1::uuid[])`,
      [[source, wecomIntegration, otherOrgIntegration]]
    )
    expect(rows.rows[0].n).toBe('0')
    expect(await orgTransferAuditCount()).toBe(auditBefore)
  })

  it('schema backstop: cross-org, provider-mismatch, and local-provider transfers are impossible to INSERT directly', async () => {
    const { org, source, target } = await seedPair('schema')
    const otherOrgIntegration = await seedIntegration(uniqueOrg('schema-other'), 'dingtalk', 'schema-other')
    const localIntegration = await seedIntegration(org, 'local', 'schema-local')
    createdIntegrationIds.push(otherOrgIntegration, localIntegration)

    // Positive control first: the well-formed direct INSERT succeeds (the probes below fail for
    // the right reason, not because the INSERT statement itself is malformed).
    const ok = await query<{ id: string }>(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id)
       VALUES ($1, 'dingtalk', $2, $3) RETURNING id`,
      [org, source, target]
    )
    createdTransferIds.push(ok.rows[0].id)

    // A dedicated probe source: the positive control above occupies `source`'s ACTIVE slot, and
    // the partial unique index fires before the FK check — probes must fail on the FK, not 23505.
    const probeSource = await seedIntegration(org, 'dingtalk', 'schema-probe-src')
    createdIntegrationIds.push(probeSource)

    const expectSqlState = async (sql: string, params: unknown[], expectedCode: string) => {
      let caught: { code?: string } | null = null
      try {
        await query(sql, params)
      } catch (error) {
        caught = error as { code?: string }
      }
      expect(caught, 'INSERT unexpectedly succeeded').not.toBeNull()
      expect(caught?.code).toBe(expectedCode)
    }

    // Cross-org: no org_id value satisfies both composite FKs — 23503 foreign_key_violation.
    await expectSqlState(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id)
       VALUES ($1, 'dingtalk', $2, $3)`,
      [org, probeSource, otherOrgIntegration],
      '23503'
    )
    // Provider mismatch: row provider 'wecom' fails both (id, provider) FKs for dingtalk ends.
    await expectSqlState(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id)
       VALUES ($1, 'wecom', $2, $3)`,
      [org, probeSource, target],
      '23503'
    )
    // provider='local' violates pot_provider_not_local_chk — 23514 check_violation (row CHECKs
    // evaluate before the FK triggers, so this fires first regardless of the ends).
    await expectSqlState(
      `INSERT INTO provider_org_transfers (org_id, provider, source_integration_id, target_integration_id)
       VALUES ($1, 'local', $2, $3)`,
      [org, probeSource, localIntegration],
      '23514'
    )
  })

  it('walks the happy lifecycle with one values-free audit row per mutation and an untouched directory fingerprint', async () => {
    const { source, target } = await seedPair('happy')
    const transferId = await createTransfer(source, target)
    expect(await auditRowFor('create', transferId)).toBe(1)

    const read = await request(adminApp).get(`/api/admin/directory/org-transfers/${transferId}`)
    expect(read.status).toBe(200)
    expect(read.body.data.transfer.status).toBe('draft')
    expect(read.body.data.decisionCounts).toEqual({ total: 0, pending: 0 })

    // §12.3: apply before ANY dry-run is refused.
    const premature = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(premature.status).toBe(409)
    expect(premature.body.error.code).toBe('ORG_TRANSFER_INVALID_STATE') // not even scanned yet

    const scan = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`)
    expect(scan.status).toBe(200)
    expect(scan.body.data.transfer.status).toBe('scanned')
    expect(scan.body.data.transfer.scannedAt).not.toBeNull()
    expect(scan.body.data.decisionCounts).toEqual({ total: 0, pending: 0 })
    expect(await auditRowFor('scan', transferId)).toBe(1)

    const applyWithoutDryRun = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(applyWithoutDryRun.status).toBe(409)
    expect(applyWithoutDryRun.body.error.code).toBe('ORG_TRANSFER_DRY_RUN_REQUIRED')

    const dryRun = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply?dryRun=true`)
    expect(dryRun.status).toBe(200)
    expect(dryRun.body.data.stats).toEqual({ bindings: 0, decisions: 0, pending: 0 })
    expect(dryRun.body.data.transfer.dryRunAt).not.toBeNull()
    expect(await auditRowFor('dry_run', transferId)).toBe(1)

    const fingerprintBefore = await directoryFingerprint()
    const apply = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(apply.status).toBe(200)
    expect(apply.body.data.transfer.status).toBe('applied')
    expect(apply.body.data.transfer.appliedAt).not.toBeNull()
    expect(await auditRowFor('apply', transferId)).toBe(1)

    // T1's apply is a no-op by contract: nothing in the directory substrate moved.
    expect(await directoryFingerprint()).toBe(fingerprintBefore)

    // Terminal: every further mutation is refused.
    for (const path of ['scan', 'apply', 'cancel']) {
      const res = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/${path}`)
      expect(res.status, path).toBe(409)
      expect(res.body.error.code).toBe('ORG_TRANSFER_INVALID_STATE')
    }
  })

  it('re-scan invalidates a prior dry-run (the §12.3 guard is scan-relative)', async () => {
    const { source, target } = await seedPair('rescan')
    const transferId = await createTransfer(source, target)

    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`).expect(200)
    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply?dryRun=true`).expect(200)

    const rescan = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`)
    expect(rescan.status).toBe(200)
    expect(rescan.body.data.transfer.dryRunAt).toBeNull()

    const apply = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(apply.status).toBe(409)
    expect(apply.body.error.code).toBe('ORG_TRANSFER_DRY_RUN_REQUIRED')
  })

  it('caps ACTIVE transfers per source integration — and frees the slot after cancel (both halves of the partial index)', async () => {
    const { org, source, target } = await seedPair('cap')
    const secondTarget = await seedIntegration(org, 'dingtalk', 'cap-dst2')
    createdIntegrationIds.push(secondTarget)

    const firstId = await createTransfer(source, target)

    const duplicate = await request(adminApp)
      .post('/api/admin/directory/org-transfers')
      .send({ provider: 'dingtalk', sourceIntegrationId: source, targetIntegrationId: secondTarget })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error.code).toBe('ORG_TRANSFER_ACTIVE_EXISTS')

    const cancel = await request(adminApp).post(`/api/admin/directory/org-transfers/${firstId}/cancel`)
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.transfer.status).toBe('cancelled')
    expect(await auditRowFor('cancel', firstId)).toBe(1)

    // Terminal cancelled row no longer occupies the ACTIVE slot.
    await createTransfer(source, secondTarget)
  })

  it('blocks apply while any scanned decision is undecided (guard seeded directly — the no-op adapter scans zero)', async () => {
    const { source, target } = await seedPair('undecided')
    const transferId = await createTransfer(source, target)
    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`).expect(200)
    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply?dryRun=true`).expect(200)

    await query(
      `INSERT INTO provider_org_transfer_decisions (transfer_id, binding_kind, source_anchor_type, source_anchor_id)
       VALUES ($1, 'user_identity', 'user', $2)`,
      [transferId, `t1-user-${STAMP}`]
    )

    const apply = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(apply.status).toBe(409)
    expect(apply.body.error.code).toBe('ORG_TRANSFER_DECISIONS_PENDING')

    // Positive control: deciding the row (skip) unblocks the same apply.
    await query(`UPDATE provider_org_transfer_decisions SET decision = 'skip', updated_at = now() WHERE transfer_id = $1`, [transferId])
    const applyAfter = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`)
    expect(applyAfter.status).toBe(200)
    expect(applyAfter.body.data.transfer.status).toBe('applied')
  })

  it('linearizes concurrent applies on the row lock — exactly one 200, one clean 409, one applied_at', async () => {
    const { source, target } = await seedPair('race')
    const transferId = await createTransfer(source, target)
    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`).expect(200)
    await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply?dryRun=true`).expect(200)

    const [first, second] = await Promise.all([
      request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`),
      request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply`),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = first.status === 409 ? first : second
    expect(loser.body.error.code).toBe('ORG_TRANSFER_INVALID_STATE')

    const row = await query<{ status: string; applied_at: string | null }>(
      `SELECT status, applied_at::text FROM provider_org_transfers WHERE id = $1`,
      [transferId]
    )
    expect(row.rows[0].status).toBe('applied')
    expect(row.rows[0].applied_at).not.toBeNull()
    // Exactly one apply audit row — the 409 loser never audits.
    expect(await auditRowFor('apply', transferId)).toBe(1)
  })

  it("recovery edges (gate P3): 'failed' is NON-absorbing (failed→scan recovers) and 'applying' is cancellable", async () => {
    // No T1 producer reaches 'failed' or leaves 'applying' observable (the no-op apply commits
    // scanned→applied in one txn) — both are future real-adapter states, seeded directly so the
    // recovery claims in the service header are load-bearing NOW: dropping 'failed' from
    // SCANNABLE_STATUSES or 'applying' from NON_TERMINAL_STATUSES reds this test.
    const { source, target } = await seedPair('recover')
    const transferId = await createTransfer(source, target)

    await query(`UPDATE provider_org_transfers SET status = 'failed', last_error = 'seeded', updated_at = now() WHERE id = $1`, [
      transferId,
    ])
    const rescued = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/scan`)
    expect(rescued.status).toBe(200)
    expect(rescued.body.data.transfer.status).toBe('scanned')
    expect(rescued.body.data.transfer.lastError).toBeNull() // scan clears the failure

    await query(`UPDATE provider_org_transfers SET status = 'applying', updated_at = now() WHERE id = $1`, [transferId])
    const cancelled = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data.transfer.status).toBe('cancelled')
  })

  it('rejects a dryRun query value other than exactly "true" instead of coercing it into a REAL apply', async () => {
    const { source, target } = await seedPair('dryrun-strict')
    const transferId = await createTransfer(source, target)

    for (const value of ['false', '1', 'yes', 'TRUE']) {
      const res = await request(adminApp).post(`/api/admin/directory/org-transfers/${transferId}/apply?dryRun=${value}`)
      expect(res.status, value).toBe(400)
      expect(res.body.error.code).toBe('ORG_TRANSFER_INVALID_INPUT')
    }
  })

  it('404s an unknown transfer and 400s a non-UUID transfer id on read', async () => {
    const missing = await request(adminApp).get(`/api/admin/directory/org-transfers/${randomUUID()}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('ORG_TRANSFER_NOT_FOUND')

    const malformed = await request(adminApp).get('/api/admin/directory/org-transfers/not-a-uuid')
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('ORG_TRANSFER_INVALID_INPUT')
  })
})
