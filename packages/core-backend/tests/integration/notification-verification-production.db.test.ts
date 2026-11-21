/** Real-database only: actual tuple reader, verifier wrapper, transaction and migrated evidence table; no network. */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
const transport = vi.hoisted(() => ({ token: vi.fn(), send: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: vi.fn(() => { throw new Error('wrapper must use supplied executor') }), pool: null }))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<typeof import('../../src/integrations/dingtalk/client')>()),
  fetchDingTalkAppAccessTokenFresh: transport.token,
  sendDingTalkWorkNotification: transport.send,
}))
import { up as upUsers } from '../../src/db/migrations/zzzz20260119100000_create_users_table'
import { up as upDirectory } from '../../src/db/migrations/zzzz20260324150000_create_directory_sync_tables'
import { up as upDirectoryParentKeys } from '../../src/db/migrations/zzzz20260717120000_create_provider_org_transfers'
import { up as upEndpoints } from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'
import { up as upEvidence } from '../../src/db/migrations/zzzz20261121130000_create_notification_verifications_test_sends'
import { createNotificationVerificationService, type NotificationVerificationService } from '../../src/notifications/verification-service'
import { notificationTupleFingerprint } from '../../src/integrations/dingtalk/notification-fingerprint'
import { DingTalkBusinessError } from '../../src/integrations/dingtalk/transport'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
const SCHEMA = `n78_verify_${randomUUID().replaceAll('-', '')}`
const config = { appKey: 'SyntheticApp', appSecret: 'SyntheticSecret', workNotificationAgentId: '12345', baseUrl: 'https://oapi.dingtalk.com' }
const input = { level: 'send', recipientUserId: 'SyntheticRecipient', verifiedBy: 'synthetic-admin' }
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB requires DATABASE_URL', () => expect(process.env.DATABASE_URL).toBeTruthy())

describeDb('production notification verification evidence (real database)', () => {
  let adminPool: Pool
  let pool: Pool
  let migrationDb: Kysely<unknown>
  let service: NotificationVerificationService
  let connectionId: string
  const evidence = async () => (await pool.query('SELECT * FROM notification_connection_verifications WHERE connection_id=$1', [connectionId])).rows[0]

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl, max: 1 })
    expect((await adminPool.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS installed")).rows[0].installed).toBe(true)
    await adminPool.query(`CREATE SCHEMA "${SCHEMA}"`)
    const options = `-c search_path=${SCHEMA},pg_catalog`
    pool = new Pool({ connectionString: dbUrl, options, max: 3 })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl, options, max: 1 }) }) })
    await migrationDb.transaction().execute(async (trx) => {
      await upUsers(trx)
      await upDirectory(trx)
      await upDirectoryParentKeys(trx)
      await upEndpoints(trx)
      await upEvidence(trx)
    })
    service = createNotificationVerificationService({
      db: pool,
      transaction: async (fn) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await fn(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
      },
    })
  })

  beforeEach(async () => {
    vi.unstubAllEnvs()
    transport.token.mockReset().mockResolvedValue('SyntheticToken')
    transport.send.mockReset().mockResolvedValue({ taskId: 'SyntheticTask', raw: { errcode: 0, task_id: 'SyntheticTask' } })
    connectionId = (await pool.query(`INSERT INTO directory_integrations (org_id,provider,name,status,corp_id,config)
      VALUES ($1,'dingtalk','Synthetic Integration','active','SyntheticCorp',$2::jsonb) RETURNING id`,
    ['default', JSON.stringify(config)])).rows[0].id
  })

  afterEach(async () => {
    await pool.query('DELETE FROM notification_connection_verifications WHERE connection_id=$1', [connectionId])
    await pool.query('DELETE FROM directory_integrations WHERE id=$1', [connectionId])
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await migrationDb?.destroy()
    await pool?.end()
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      await adminPool.end()
    }
  })

  it('rejects other organizations before network or evidence writes', async () => {
    await pool.query("UPDATE directory_integrations SET org_id='OtherOrg' WHERE id=$1", [connectionId])
    await expect(service.verify({ ...input, integrationId: connectionId })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(transport.token).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
    expect(await evidence()).toBeUndefined()
  })

  it('rejects an organization transfer during verification before writing evidence', async () => {
    transport.token.mockImplementationOnce(async () => {
      await pool.query("UPDATE directory_integrations SET org_id='OtherOrg' WHERE id=$1", [connectionId])
      return 'SyntheticToken'
    })
    await expect(service.verify({ integrationId: connectionId, level: 'token', verifiedBy: input.verifiedBy })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await evidence()).toBeUndefined()
  })

  it('persists real send evidence, downgrades to token on send rejection, then invalidates on token failure', async () => {
    const first = await service.verify({ ...input, integrationId: connectionId })
    expect(first.evidence).toMatchObject({ level: 'send', valid: true })
    const stored = await evidence()
    expect(stored).toMatchObject({ reached_level: 'send', bound_tenant: 'SyntheticCorp', bound_app_scope: 'SyntheticApp', invalidated_at: null })
    expect(Number(stored.revision)).toBe(1)
    transport.send.mockRejectedValueOnce(new DingTalkBusinessError('Synthetic rejection', { errcode: 40001 }))
    const second = await service.verify({ ...input, integrationId: connectionId })
    expect(second.result.failure?.level).toBe('send')
    expect(second.evidence).toMatchObject({ level: 'token', valid: true })
    expect(Number((await evidence()).revision)).toBe(2)
    transport.token.mockRejectedValueOnce(new DingTalkBusinessError('Synthetic rejection', { errcode: 40001 }))
    const third = await service.verify({ ...input, integrationId: connectionId })
    expect(third.result.failure?.level).toBe('token')
    expect(third.evidence).toMatchObject({ level: 'token', valid: false })
    expect((await evidence()).invalidated_at).not.toBeNull()
    expect(Number((await evidence()).revision)).toBe(3)
  })

  it('persists the tested tuple and anchor when both rotate during the token request, with invalid current summary', async () => {
    transport.token.mockImplementationOnce(async () => {
      await pool.query("UPDATE directory_integrations SET corp_id='RotatedCorp', config=jsonb_set(config,'{appSecret}',to_jsonb('RotatedSecret'::text)) WHERE id=$1", [connectionId])
      return 'SyntheticToken'
    })
    const response = await service.verify({ integrationId: connectionId, level: 'token', verifiedBy: input.verifiedBy })
    const digest = notificationTupleFingerprint({ appKey: config.appKey, appSecret: config.appSecret, agentId: '12345', baseUrl: config.baseUrl })
    expect(digest.ok).toBe(true)
    expect(await evidence()).toMatchObject({ bound_tenant: 'SyntheticCorp', tuple_fingerprint: digest.ok ? digest.value : '' })
    expect(response.evidence).toMatchObject({ level: 'token', valid: false })
    expect(JSON.stringify(response)).not.toContain(digest.ok ? digest.value : 'private-fingerprint')
    expect(JSON.stringify(response)).not.toContain('SyntheticSecret')
  })

  it('a successful config run preserves evidence; config failure invalidates even a requested send', async () => {
    await service.verify({ ...input, integrationId: connectionId })
    const before = await evidence()
    await service.verify({ integrationId: connectionId, level: 'config', verifiedBy: input.verifiedBy })
    expect(await evidence()).toEqual(before)
    await pool.query("UPDATE directory_integrations SET status='inactive' WHERE id=$1", [connectionId])
    const failed = await service.verify({ ...input, integrationId: connectionId })
    expect(failed.result.failure?.level).toBe('config')
    expect(failed.evidence).toMatchObject({ level: 'send', valid: false })
    expect((await evidence()).invalidated_at).not.toBeNull()
  })
})
