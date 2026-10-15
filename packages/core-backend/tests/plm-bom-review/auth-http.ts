import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import type { Pool } from 'pg'
import type { BomReviewDependencies } from '../../src/multitable/plm-bom-review-service'
import type { authService as AuthServiceSingleton } from '../../src/auth/AuthService'
import { bootstrapPlmBomReviewAuthTestDb } from './auth-bootstrap'

// No vi.mock, synthetic request user, token-trust shortcut, or private authenticator override.
export function registerBomReviewRealAuthHttpTests(
  pool: Pool,
  deps: BomReviewDependencies,
  providerCalls: () => number,
): void {
  describe('real authenticate HTTP boundary on the BOM review router', () => {
    let app: ReturnType<typeof express>
    let auth: typeof AuthServiceSingleton
    let sessions: typeof import('../../src/auth/session-registry')
    let revocations: typeof import('../../src/auth/session-revocation')
    let ownerToken: string
    let otherToken: string
    let sessionId: string
    const priorEnv = Object.fromEntries(
      ['NODE_ENV', 'JWT_SECRET', 'RBAC_TOKEN_TRUST', 'PRODUCT_MODE'].map(
        (k) => [k, process.env[k]],
      ),
    )
    const secret = 'w20-auth-http-synthetic-signing-key-20261001-not-production'
    const previewBody = {
      dataSourceId: 'ds',
      partId: 'P',
      baseId: 'base',
      name: 'Authenticated collaboration',
    }
    const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` })
    const counts = async () =>
      Promise.all(
        [
          'meta_plm_bom_review_previews',
          'meta_plm_bom_review_bindings',
          'meta_records',
          'meta_record_revisions',
        ].map(async (table) =>
          Number(
            (await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
          ),
        ),
      )
    const owner = async () =>
      (await pool.query("SELECT * FROM users WHERE id='owner'")).rows[0]
    beforeAll(async () => {
      // Strong synthetic key before importing the actual auth singleton; fail if an earlier module
      // captured a different key rather than silently replacing its methods/configuration.
      process.env.JWT_SECRET = secret
      process.env.RBAC_TOKEN_TRUST = 'false'
      process.env.PRODUCT_MODE = 'plm-workbench'
      await bootstrapPlmBomReviewAuthTestDb(pool)
      auth = (await import('../../src/auth/AuthService')).authService
      sessions = await import('../../src/auth/session-registry')
      revocations = await import('../../src/auth/session-revocation')
      // Production identity semantics disable AuthService's development-only nonexistent-user fallback.
      process.env.NODE_ENV = 'production'
      sessionId = randomUUID()
      await sessions.createUserSession('owner', {
        sessionId,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      expect(
        (
          await pool.query('SELECT user_id FROM user_sessions WHERE id=$1', [
            sessionId,
          ])
        ).rows,
      ).toEqual([{ user_id: 'owner' }])
      ownerToken = auth.createToken(await owner(), { sid: sessionId })
      expect((jwt.verify(ownerToken, secret) as jwt.JwtPayload).userId).toBe(
        'owner',
      )
      otherToken = auth.createToken(
        (await pool.query("SELECT * FROM users WHERE id='outsider'")).rows[0],
      )
      const { createPlmBomReviewsRouter } = await import(
        '../../src/routes/plm-bom-reviews'
      )
      app = express()
      app.use(express.json())
      app.use('/api/plm-bom-reviews', createPlmBomReviewsRouter(deps))
    })
    afterAll(async () => {
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    it('valid DB source-owner login JWT reaches actual preview and confirm HTTP handlers', async () => {
      expect(await auth.verifyToken(ownerToken)).toMatchObject({
        id: 'owner',
        name: 'owner',
        role: 'user',
      })
      const before = providerCalls()
      const p = await request(app)
        .post('/api/plm-bom-reviews/preview')
        .set(authHeader(ownerToken))
        .send(previewBody)
      expect(p.status).toBe(200)
      expect(p.body.data.source.authUserId).toBe('9007199254740999')
      const response = await request(app)
        .post('/api/plm-bom-reviews')
        .set(authHeader(ownerToken))
        .send({ previewId: p.body.data.previewId, requestId: randomUUID() })
      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('active')
      expect(providerCalls() - before).toBe(2)
    })
    it.each(['tampered', 'expired', 'missing-user', 'purpose-bound'] as const)(
      '%s login credential is rejected before provider or persistence',
      async (kind) => {
        const before = await counts(),
          calls = providerCalls(),
          now = Math.floor(Date.now() / 1000)
        const token =
          kind === 'tampered'
            ? `${ownerToken.slice(0, ownerToken.lastIndexOf('.') + 1)}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
            : jwt.sign(
                {
                  userId:
                    kind === 'missing-user' ? 'nonexistent-user' : 'owner',
                  iat: now - 60,
                  exp: kind === 'expired' ? now - 1 : now + 3600,
                  ...(kind === 'purpose-bound' ? { type: 'invite' } : {}),
                },
                secret,
              )
        const response = await request(app)
          .post('/api/plm-bom-reviews/preview')
          .set(authHeader(token))
          .send(previewBody)
        expect(response.status).toBe(401)
        expect(response.body.error.code).toBe('UNAUTHORIZED')
        expect(providerCalls()).toBe(calls)
        expect(await counts()).toEqual(before)
      },
    )
    it('a different valid JWT subject cannot borrow body identity or the source owner', async () => {
      await pool.query(
        "INSERT INTO user_permissions(user_id,permission_code) VALUES('outsider','multitable:write')",
      )
      const before = await counts(),
        calls = providerCalls()
      try {
        const denied = await request(app)
          .post('/api/plm-bom-reviews/preview')
          .set(authHeader(otherToken))
          .send(previewBody)
        expect(denied.status).toBe(403)
        expect(denied.body.error.code).toBe('SOURCE_FORBIDDEN')
        const spoof = await request(app)
          .post('/api/plm-bom-reviews/preview')
          .set(authHeader(otherToken))
          .send({ ...previewBody, actorId: 'owner' })
        expect(spoof.status).toBe(400)
        expect(spoof.body.error.code).toBe('INVALID_REQUEST')
        expect(providerCalls()).toBe(calls)
        expect(await counts()).toEqual(before)
      } finally {
        await pool.query(
          "DELETE FROM user_permissions WHERE user_id='outsider'",
        )
      }
    })
    it.each([
      { column: 'is_active', value: false, restore: true },
      {
        column: 'activation_status',
        value: 'pending_activation',
        restore: 'activated',
      },
    ])(
      'rechecks current DB user $column on every HTTP call',
      async (change) => {
        const before = await counts(),
          calls = providerCalls()
        await pool.query(
          `UPDATE users SET ${change.column}=$1 WHERE id='owner'`,
          [change.value],
        )
        try {
          const denied = await request(app)
            .post('/api/plm-bom-reviews/preview')
            .set(authHeader(ownerToken))
            .send(previewBody)
          expect(denied.status).toBe(401)
          expect(denied.body.error.code).toBe('UNAUTHORIZED')
          expect(providerCalls()).toBe(calls)
          expect(await counts()).toEqual(before)
        } finally {
          await pool.query(
            `UPDATE users SET ${change.column}=$1 WHERE id='owner'`,
            [change.restore],
          )
        }
        expect(
          (
            await request(app)
              .get('/api/plm-bom-reviews/bases')
              .set(authHeader(ownerToken))
          ).status,
        ).toBe(200)
      },
    )
    it('real sid revocation rejects the same JWT while an independently active session remains valid', async () => {
      const otherId = randomUUID()
      await sessions.createUserSession('owner', {
        sessionId: otherId,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      const positive = auth.createToken(await owner(), { sid: otherId })
      const revoked = await sessions.revokeUserSession(sessionId, {
        revokedBy: 'owner',
        reason: 'synthetic revoke',
      })
      expect(revoked?.revokedAt).toBeTruthy()
      expect(
        (
          await pool.query('SELECT revoked_at FROM user_sessions WHERE id=$1', [
            sessionId,
          ])
        ).rows[0].revoked_at,
      ).toBeTruthy()
      const before = await counts(),
        calls = providerCalls()
      expect(
        (
          await request(app)
            .post('/api/plm-bom-reviews/preview')
            .set(authHeader(ownerToken))
            .send(previewBody)
        ).status,
      ).toBe(401)
      expect(providerCalls()).toBe(calls)
      expect(await counts()).toEqual(before)
      expect(
        (
          await request(app)
            .get('/api/plm-bom-reviews/bases')
            .set(authHeader(positive))
        ).status,
      ).toBe(200)
      ownerToken = positive
    })
    it('real all-session revocation rejects the previously valid token with a separate-user positive control', async () => {
      expect(
        (
          await request(app)
            .get('/api/plm-bom-reviews/bases')
            .set(authHeader(ownerToken))
        ).status,
      ).toBe(200)
      expect(
        await revocations.revokeUserSessions('owner', {
          updatedBy: 'owner',
          reason: 'synthetic revoke all',
        }),
      ).toBeTruthy()
      expect(
        (
          await pool.query(
            "SELECT revoked_after FROM user_session_revocations WHERE user_id='owner'",
          )
        ).rows[0].revoked_after,
      ).toBeTruthy()
      const before = await counts(),
        calls = providerCalls()
      const denied = await request(app)
        .post('/api/plm-bom-reviews/preview')
        .set(authHeader(ownerToken))
        .send(previewBody)
      expect(denied.status).toBe(401)
      expect(denied.body.error.code).toBe('UNAUTHORIZED')
      expect(providerCalls()).toBe(calls)
      expect(await counts()).toEqual(before)
      expect(
        (
          await request(app)
            .get('/api/plm-bom-reviews/bases')
            .set(authHeader(otherToken))
        ).status,
      ).toBe(200)
    })
  })
}
