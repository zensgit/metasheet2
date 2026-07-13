/**
 * GHSA — SafetyGuard double-confirm flow + token binding.
 *
 * Fixes the deadlock where a double-confirm operation (RESTORE_SNAPSHOT, DROP_TABLE, TRUNCATE_TABLE,
 * SHUTDOWN_SERVICE, RELOAD_ALL_PLUGINS) could NEVER complete over HTTP: the route retry carries only the
 * token, but verifyConfirmation re-checked the typed phrase unconditionally, so a confirmed token still
 * 403'd forever. And it hardens the token: a confirmation is now bound to the operation, initiator, and
 * resource of the request that minted it, so a confirmed token cannot be replayed cross-operation,
 * cross-user, or cross-resource, and is one-time-use.
 *
 * These tests use the REAL SafetyGuard (nothing mocked) against a minimal app that wires requireSafetyCheck
 * + the /safety/confirm handler exactly as production does — this is the 403→confirm→retry→200 proof the
 * gate found missing, plus a failure-mode matrix, each row a mutation target.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import {
  initSafetyGuard,
  getSafetyGuard,
  requireSafetyCheck,
  createSafetyConfirmEndpoint,
  OperationType,
} from '../../src/guards'

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  // Identity is taken from x-test-user so a single app can act as different admins.
  app.use((req, _res, next) => {
    const u = req.headers['x-test-user']
    if (u) (req as express.Request & { user?: { id: string } }).user = { id: String(u) }
    next()
  })
  app.post(
    '/op/restore/:id',
    requireSafetyCheck({ operation: OperationType.RESTORE_SNAPSHOT, getDetails: (req) => ({ snapshotId: req.params.id }) }),
    (_req, res) => res.json({ ok: true, did: 'restore' }),
  )
  app.post(
    '/op/delete/:id',
    requireSafetyCheck({ operation: OperationType.DELETE_SNAPSHOT, getDetails: (req) => ({ snapshotId: req.params.id }) }),
    (_req, res) => res.json({ ok: true, did: 'delete' }),
  )
  app.post(
    '/op/cleanup',
    requireSafetyCheck({ operation: OperationType.CLEANUP_SNAPSHOTS }),
    (_req, res) => res.json({ ok: true, did: 'cleanup' }),
  )
  // A route whose resource details are NESTED (like the admin bulk-data routes' filters/updates), used
  // to exercise resourceKey's recursive canonicalization. MEDIUM op so a single token-retry completes.
  app.post(
    '/op/bulk/:id',
    requireSafetyCheck({
      operation: OperationType.DELETE_SNAPSHOT,
      getDetails: (req) => ({ id: req.params.id, filters: req.body.filters }),
    }),
    (_req, res) => res.json({ ok: true, did: 'bulk' }),
  )
  // The confirm handler derives the initiator from req.user (mirrors the admin-routes mount, which also
  // adds requireAdminRole — that gate is proven separately in admin-safety-confirm-authz.test.ts).
  app.post('/safety/confirm', createSafetyConfirmEndpoint())
  return app
}

const M = 'admin-M'
const N = 'admin-N'

describe('SafetyGuard double-confirm flow + token binding (GHSA)', () => {
  let app: Express

  beforeEach(() => {
    initSafetyGuard() // fresh guard: empty pending map, default 300s expiry
    app = buildApp()
  })
  afterEach(() => {
    getSafetyGuard().destroy() // clear the cleanup interval + pending map
  })

  async function mintToken(path: string, user = M): Promise<string> {
    const res = await request(app).post(path).set('x-test-user', user).send({}).expect(403)
    expect(res.body.code).toBe('SAFETY_CHECK_REQUIRED')
    const token = res.body.confirmation?.token
    expect(token).toBeTruthy()
    return token as string
  }

  it('RESTORE (double-confirm CRITICAL): 403 → confirm(typed+ack) → retry(token) → 200 COMPLETES', async () => {
    const token = await mintToken('/op/restore/s1')
    // Confirm with the typed phrase + acknowledgment.
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(200)
    // Retry the operation with ONLY the token — this is the path that was permanently 403 before.
    const done = await request(app).post('/op/restore/s1').set('x-test-user', M).set('x-safety-token', token).expect(200)
    expect(done.body).toEqual({ ok: true, did: 'restore' })
  })

  it('DELETE (MEDIUM): 403 → single retry with token → 200 (no double-confirm, no ack needed)', async () => {
    const token = await mintToken('/op/delete/s1')
    const done = await request(app).post('/op/delete/s1').set('x-test-user', M).set('x-safety-token', token).expect(200)
    expect(done.body.did).toBe('delete')
  })

  it('CLEANUP (HIGH): retry-without-ack 403; confirm(ack) → retry → 200', async () => {
    const token = await mintToken('/op/cleanup')
    // A HIGH op needs acknowledgment; the token-only retry cannot supply it → still 403.
    await request(app).post('/op/cleanup').set('x-test-user', M).set('x-safety-token', token).expect(403)
    await request(app).post('/safety/confirm').set('x-test-user', M).send({ token, acknowledged: true }).expect(200)
    const done = await request(app).post('/op/cleanup').set('x-test-user', M).set('x-safety-token', token).expect(200)
    expect(done.body.did).toBe('cleanup')
  })

  // ---- failure-mode matrix (each row is a mutation target) ----

  it('UNCONFIRMED: retry with a token that was never confirmed → 403, operation NOT performed', async () => {
    const token = await mintToken('/op/restore/s1')
    const res = await request(app).post('/op/restore/s1').set('x-test-user', M).set('x-safety-token', token).expect(403)
    expect(res.body.code).toBe('SAFETY_CHECK_REQUIRED')
  })

  it('EXPIRED: an expired token cannot be confirmed', async () => {
    initSafetyGuard({ tokenExpirationSeconds: -1 }) // tokens are born expired → deterministic, no sleep
    app = buildApp()
    const token = await mintToken('/op/restore/s1')
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(400) // "Confirmation token has expired"
  })

  it('WRONG USER: token confirmed by M cannot be consumed by N → 403', async () => {
    const token = await mintToken('/op/restore/s1', M)
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(200)
    await request(app).post('/op/restore/s1').set('x-test-user', N).set('x-safety-token', token).expect(403)
  })

  it('WRONG OPERATION: a confirmed RESTORE token presented on the DELETE route → 403', async () => {
    const token = await mintToken('/op/restore/s1', M)
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(200)
    await request(app).post('/op/delete/s1').set('x-test-user', M).set('x-safety-token', token).expect(403)
  })

  it('WRONG RESOURCE: a confirmed token for s1 presented against s2 → 403', async () => {
    const token = await mintToken('/op/restore/s1', M)
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(200)
    await request(app).post('/op/restore/s2').set('x-test-user', M).set('x-safety-token', token).expect(403)
  })

  it('DOUBLE USE: a token is one-time — the second retry with the same token → 403', async () => {
    const token = await mintToken('/op/restore/s1', M)
    await request(app)
      .post('/safety/confirm')
      .set('x-test-user', M)
      .send({ token, typedConfirmation: 'restore_snapshot', acknowledged: true })
      .expect(200)
    await request(app).post('/op/restore/s1').set('x-test-user', M).set('x-safety-token', token).expect(200)
    await request(app).post('/op/restore/s1').set('x-test-user', M).set('x-safety-token', token).expect(403)
  })

  it('WRONG TYPED PHRASE: confirm with an incorrect typed phrase → 400, and the op stays blocked', async () => {
    const token = await mintToken('/op/restore/s1', M)
    await request(app).post('/safety/confirm').set('x-test-user', M).send({ token, typedConfirmation: 'nope', acknowledged: true }).expect(400)
    await request(app).post('/op/restore/s1').set('x-test-user', M).set('x-safety-token', token).expect(403)
  })

  // ---- resourceKey recursive canonicalization (nested details) ----

  async function mintBulk(filters: unknown): Promise<string> {
    const res = await request(app).post('/op/bulk/x1').set('x-test-user', M).send({ filters }).expect(403)
    return res.body.confirmation.token as string
  }

  it('NESTED KEY REORDER: a token minted for {filters:{a,b}} is accepted on a retry sending {filters:{b,a}} → 200', async () => {
    const token = await mintBulk({ a: 1, b: 2 })
    const done = await request(app)
      .post('/op/bulk/x1')
      .set('x-test-user', M)
      .set('x-safety-token', token)
      .send({ filters: { b: 2, a: 1 } }) // same resource, keys reordered
      .expect(200)
    expect(done.body.did).toBe('bulk')
  })

  it('NESTED VALUE CHANGE: a changed nested value is a different resource → 403', async () => {
    const token = await mintBulk({ a: 1, b: 2 })
    await request(app)
      .post('/op/bulk/x1')
      .set('x-test-user', M)
      .set('x-safety-token', token)
      .send({ filters: { a: 9, b: 2 } }) // value changed
      .expect(403)
  })

  it('ARRAY REORDER: array order is significant — [1,2] vs [2,1] is a different resource → 403', async () => {
    const token = await mintBulk({ items: [1, 2] })
    await request(app)
      .post('/op/bulk/x1')
      .set('x-test-user', M)
      .set('x-safety-token', token)
      .send({ filters: { items: [2, 1] } }) // array reordered
      .expect(403)
  })

  // ---- response contract: the 403 confirmation.instructions describe the ACTUAL flow ----

  it('INSTRUCTIONS (double-confirm): the 403 tells the client to POST /api/admin/safety/confirm then retry with X-Safety-Token', async () => {
    const res = await request(app).post('/op/restore/s1').set('x-test-user', M).send({}).expect(403)
    const instructions = res.body.confirmation.instructions as string
    expect(instructions).toContain('/api/admin/safety/confirm')
    expect(instructions).toContain('X-Safety-Token')
    expect(instructions).toContain('restore_snapshot') // the typed phrase for a double-confirm op
  })

  it('INSTRUCTIONS (single-confirm MEDIUM): a single token retry, no /safety/confirm step', async () => {
    const res = await request(app).post('/op/delete/s1').set('x-test-user', M).send({}).expect(403)
    const instructions = res.body.confirmation.instructions as string
    expect(instructions).toContain('X-Safety-Token')
    expect(instructions).not.toContain('/api/admin/safety/confirm')
  })
})
