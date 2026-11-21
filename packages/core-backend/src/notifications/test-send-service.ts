import { createHash } from 'node:crypto'
import { resolveNotificationAdapter, type NotificationAdapter } from './adapters/notification-adapter'
import { classifyNotificationTestSendOutcome } from './delivery-outcome'
import { NotificationHttpError } from './notification-errors'
import { isExternalNotificationDeliveryEnabled, isUserNotificationPreferencesEnabled } from './notification-flags'
import { mapBusy, USER_LOCK_SQL, type NotificationDbDeps } from './notification-tx'
import type { Db, RecipientResolver, ResolveResult } from './recipient-resolver'

export interface NotificationTestSendInput {
  orgId: string
  userId: string
  endpointId: string
  idempotencyKey: string
}

export interface NotificationTestSendResult {
  /** Internal ledger vocabulary; the HTTP boundary maps refused to failed. */
  outcome: 'accepted' | 'failed' | 'outcome_unknown' | 'refused'
  code: string
  testSendId: string
}

export type ConnectionReadiness = { ok: true; witness: string } | { ok: false; code: string }

export interface NotificationTestSendDeps extends NotificationDbDeps {
  resolver: RecipientResolver
  checkConnection(input: { orgId: string; connectionId: string; provider: string }): Promise<ConnectionReadiness>
  prepareBudgetMs: number
  isPreferencesEnabled?: () => boolean
  isDeliveryEnabled?: () => boolean
  adapter?: (provider: string) => NotificationAdapter
  onOutcome?: (outcome: 'accepted' | 'failed' | 'outcome_unknown' | 'refused' | 'rate_limited') => void
}

type LedgerRow = Record<string, unknown>
const COLUMNS = 'id::text AS id, state, outcome_code'
const OWN_ENDPOINT = `SELECT id::text AS id, connection_id::text AS connection_id, provider, status
  FROM user_notification_endpoints WHERE id = $1::uuid AND org_id = $2 AND user_id = $3`
const REPLAY = `SELECT ${COLUMNS} FROM notification_test_sends
  WHERE org_id = $1 AND user_id = $2 AND idempotency_key = $3`
const EXPIRE = `UPDATE notification_test_sends
  SET state = 'outcome_unknown', outcome_code = 'test_send_interrupted', finished_at = now()
  WHERE org_id = $1 AND user_id = $2 AND state IN ('pending', 'sending')
    AND COALESCE(sending_at, created_at) <= now() - interval '90 seconds' RETURNING id`

// The retry instant is the latest expiry among all limits currently preventing admission.
const LIMITS = `SELECT ceil(extract(epoch FROM (max(retry_at) - now())))::integer AS retry_after FROM (
  SELECT min(created_at) + interval '60 seconds' AS retry_at FROM notification_test_sends
    WHERE endpoint_id = $3::uuid AND created_at > now() - interval '60 seconds' HAVING count(*) >= 1
  UNION ALL
  SELECT min(created_at) + interval '1 hour' FROM notification_test_sends
    WHERE org_id = $1 AND user_id = $2 AND created_at > now() - interval '1 hour' HAVING count(*) >= 5
  UNION ALL
  SELECT min(created_at) + interval '1 hour' FROM notification_test_sends
    WHERE connection_id = $4::uuid AND created_at > now() - interval '1 hour' HAVING count(*) >= 60
  UNION ALL
  SELECT min(COALESCE(sending_at, created_at)) + interval '90 seconds' FROM notification_test_sends
    WHERE org_id = $1 AND user_id = $2 AND state IN ('pending', 'sending')
      AND COALESCE(sending_at, created_at) > now() - interval '90 seconds' HAVING count(*) >= 1
) limits`

function resultOf(row: LedgerRow): NotificationTestSendResult {
  if (row.state === 'pending' || row.state === 'sending') throw new NotificationHttpError(409, 'TEST_SEND_IN_PROGRESS')
  return {
    outcome: row.state as NotificationTestSendResult['outcome'],
    code: String(row.outcome_code),
    testSendId: String(row.id),
  }
}

export function createNotificationTestSendService(deps: NotificationTestSendDeps) {
  const preferencesEnabled = deps.isPreferencesEnabled ?? isUserNotificationPreferencesEnabled
  const deliveryEnabled = deps.isDeliveryEnabled ?? isExternalNotificationDeliveryEnabled
  const adapterFor = deps.adapter ?? resolveNotificationAdapter

  function assertEnabled(): void {
    if (!preferencesEnabled()) throw new NotificationHttpError(404, 'NOT_FOUND')
    if (!deliveryEnabled()) throw new NotificationHttpError(409, 'NOTIFICATION_DELIVERY_DISABLED')
  }

  async function ownTarget(db: Db, input: NotificationTestSendInput): Promise<Extract<ResolveResult, { ok: true }>> {
    const found = await db.query(OWN_ENDPOINT, [input.endpointId, input.orgId, input.userId])
    const row = found.rows[0]
    if (!row) throw new NotificationHttpError(404, 'NOT_FOUND')
    if (row.status !== 'active') throw new NotificationHttpError(409, 'ENDPOINT_NOT_USABLE', { reason: 'endpoint_stale' })
    const result = await deps.resolver.verifyEndpoint(db, input)
    if (result.ok === false) throw new NotificationHttpError(409, 'ENDPOINT_NOT_USABLE', { reason: result.code })
    return result
  }

  async function send(input: NotificationTestSendInput): Promise<NotificationTestSendResult> {
    try {
      assertEnabled()
      const resolved = await ownTarget(deps.db, input)
      const { target } = resolved
      const ready = await deps.checkConnection({ orgId: input.orgId, connectionId: target.connectionId, provider: target.provider })
      if (ready.ok === false) throw new NotificationHttpError(409, 'CONNECTION_NOT_READY', { reason: ready.code })
      let adapter: NotificationAdapter
      try { adapter = adapterFor(target.provider) } catch {
        throw new NotificationHttpError(409, 'CONNECTION_NOT_READY', { reason: 'adapter_unavailable' })
      }
      if (adapter.transport !== target.transport) throw new NotificationHttpError(409, 'CONNECTION_NOT_READY', { reason: 'adapter_unavailable' })

      const admitted = await deps.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await tx.query("SET LOCAL lock_timeout = '5s'")
        await tx.query("SET LOCAL statement_timeout = '5s'")
        await tx.query(USER_LOCK_SQL, [input.orgId, input.userId])
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('notif-test:' || $1::text), hashtext($2::text))", [input.orgId, input.userId])
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('notif-test-conn'), hashtext($1::text))", [target.connectionId])
        assertEnabled()
        await ownTarget(tx, input)
        const expired = await tx.query(EXPIRE, [input.orgId, input.userId])
        const expiredCount = expired.rows.length
        const existing = await tx.query(REPLAY, [input.orgId, input.userId, input.idempotencyKey])
        if (existing.rows[0]) return { fresh: false as const, row: existing.rows[0], expiredCount }
        const limits = await tx.query(LIMITS, [input.orgId, input.userId, input.endpointId, target.connectionId])
        const retryAfter = Number(limits.rows[0]?.retry_after ?? 0)
        // Return refusals so expiration of older attempts commits even when admission is denied.
        if (retryAfter > 0) return { fresh: false as const, retryAfter, expiredCount }
        const inserted = await tx.query(`INSERT INTO notification_test_sends
          (org_id, user_id, endpoint_id, connection_id, idempotency_key)
          VALUES ($1, $2, $3::uuid, $4::uuid, $5) RETURNING ${COLUMNS}`,
        [input.orgId, input.userId, input.endpointId, target.connectionId, input.idempotencyKey])
        return { fresh: true as const, row: inserted.rows[0], expiredCount }
      })
      for (let expired = 0; expired < admitted.expiredCount; expired++) deps.onOutcome?.('outcome_unknown')
      if ('retryAfter' in admitted) {
        deps.onOutcome?.('rate_limited')
        throw new NotificationHttpError(429, 'TEST_SEND_RATE_LIMITED', { retryAfter: admitted.retryAfter })
      }
      if (!admitted.fresh) return resultOf(admitted.row)
      const id = String(admitted.row.id)

      async function finish(state: 'accepted' | 'failed' | 'outcome_unknown' | 'refused', code: string, expected: Array<'pending' | 'sending'>) {
        const written = await deps.db.query(`UPDATE notification_test_sends
          SET state = $2, outcome_code = $3, finished_at = now()
          WHERE id = $1::uuid AND state = ANY($4::text[]) RETURNING ${COLUMNS}`, [id, state, code, expected])
        if (written.rows[0]) {
          deps.onOutcome?.(state)
          return resultOf(written.rows[0])
        }
        const current = await deps.db.query(REPLAY, [input.orgId, input.userId, input.idempotencyKey])
        return resultOf(current.rows[0])
      }

      let prepared
      try {
        prepared = await adapter.prepare({
          connectionId: target.connectionId,
          target,
          budgetMs: deps.prepareBudgetMs,
          dedupeHint: createHash('sha256').update(JSON.stringify([input.orgId, input.userId, input.idempotencyKey])).digest('hex'),
          reverify: async () => {
            const live = await deps.db.query(OWN_ENDPOINT, [input.endpointId, input.orgId, input.userId])
            if (live.rows[0]?.status !== 'active') return { ok: false, code: 'endpoint_not_found' }
            return deps.resolver.verifyEndpoint(deps.db, input)
          },
        })
      } catch { return finish('refused', 'routed_credentials_unavailable', ['pending']) }
      if (prepared.ok === false) return finish('refused', prepared.code, ['pending'])
      let currentReady: ConnectionReadiness
      try {
        currentReady = await deps.checkConnection({ orgId: input.orgId, connectionId: target.connectionId, provider: target.provider })
      } catch { return finish('refused', 'routed_capability_unreadable', ['pending']) }
      if (currentReady.ok === false) return finish('refused', 'routed_target_capability_unavailable', ['pending'])
      if (currentReady.witness !== ready.witness) return finish('refused', 'routed_target_capability_changed', ['pending'])
      if (!preferencesEnabled() || !deliveryEnabled()) return finish('refused', 'routed_cancelled', ['pending'])
      // This one-way transition is the only admission to the transport call.
      let fenced
      try {
        fenced = await deps.db.query(`UPDATE notification_test_sends SET state = 'sending', sending_at = now()
          WHERE id = $1::uuid AND state = 'pending' RETURNING ${COLUMNS}`, [id])
      } catch {
        // The write may still commit after its reply fails; no transport call has occurred.
        return finish('refused', 'routed_send_fence_failed', ['pending', 'sending'])
      }
      if (!fenced.rows[0]) {
        const current = await deps.db.query(REPLAY, [input.orgId, input.userId, input.idempotencyKey])
        return resultOf(current.rows[0])
      }
      let sent
      try {
        sent = await prepared.send({ title: 'MetaSheet 通知测试', content: '这是一条测试通知，用于确认此渠道可用，无需操作。' })
      } catch { return finish('outcome_unknown', 'routed_send_unclassified', ['sending']) }
      const outcome = classifyNotificationTestSendOutcome(sent, 'send')
      const code = sent && typeof sent === 'object' && sent.ok === true ? 'accepted'
        : sent && typeof sent === 'object' && typeof sent.code === 'string' ? sent.code : 'routed_send_unclassified'
      return finish(outcome, code, ['sending'])
    } catch (error) { throw mapBusy(error) }
  }

  return { send }
}

export type NotificationTestSendService = ReturnType<typeof createNotificationTestSendService>
