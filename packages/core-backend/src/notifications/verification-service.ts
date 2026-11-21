/** The management wrapper keeps tuple provenance out of the report and persists only its digest. */
import {
  buildDingTalkWorkNotificationVerifyAuditMeta,
  verifyDingTalkWorkNotificationIntegration,
  type DingTalkWorkNotificationVerifyInput,
  type DingTalkWorkNotificationVerifyResult,
} from '../integrations/dingtalk/work-notification-verify'
import {
  readDingTalkIntegrationScopedMessageTuple,
  type DingTalkIntegrationScopedMessageTuple,
} from '../integrations/dingtalk/work-notification-settings'
import { DingTalkMessageConfigError } from '../integrations/dingtalk/config-validation-error'
import { notificationTupleFingerprint } from '../integrations/dingtalk/notification-fingerprint'
import { resolveProviderCapabilityDescriptor, type IntegrationScope } from '../integrations/provider-capability-registry'
import { mapBusy, type NotificationDbDeps } from './notification-tx'
import { NotificationHttpError, isNotificationHttpError } from './notification-errors'
import type { Db } from './recipient-resolver'
import {
  checkNotificationVerification,
  writeNotificationVerification,
  type NotificationVerificationSummary,
} from './verification-evidence'

export interface NotificationVerificationResult {
  result: DingTalkWorkNotificationVerifyResult
  evidence: NotificationVerificationSummary
}

export interface NotificationVerificationService {
  verify(input: DingTalkWorkNotificationVerifyInput & { verifiedBy: string }): Promise<NotificationVerificationResult>
}

/** A completed provider run whose evidence transaction failed; retains safe audit fields only. */
export class NotificationVerificationEvidenceError extends NotificationHttpError {
  readonly auditMeta: Record<string, unknown>

  constructor(result: DingTalkWorkNotificationVerifyResult, error: unknown) {
    const mapped = mapBusy(error)
    const known = isNotificationHttpError(mapped) && (
      (mapped.status === 404 && mapped.code === 'NOT_FOUND')
      || (mapped.status === 503 && ['NOTIFICATION_BUSY', 'NOTIFICATION_SCHEMA_UNAVAILABLE'].includes(mapped.code))
      || (mapped.status === 409 && mapped.code === 'VERIFICATION_TUPLE_UNSUPPORTED')
    )
    super(known ? mapped.status : 500, known ? mapped.code : 'VERIFICATION_EVIDENCE_WRITE_FAILED')
    this.name = 'NotificationVerificationEvidenceError'
    this.auditMeta = {
      ...notificationVerificationAuditMeta(result),
      evidenceRecorded: false,
      evidenceFailureCode: this.code,
    }
  }
}

function tupleIdentity(tuple: DingTalkIntegrationScopedMessageTuple): {
  scope: IntegrationScope | null
  tupleFingerprint: string | null
} {
  const sourceScope = tuple.sourceScope
  const scope = sourceScope
    ? resolveProviderCapabilityDescriptor('dingtalk')!.scopeOf({
      corp_id: sourceScope.corpId, config: { appKey: sourceScope.appKey },
    })
    : null
  const fingerprint = notificationTupleFingerprint(tuple.config)
  return { scope, tupleFingerprint: fingerprint.ok ? fingerprint.value : null }
}

async function assertDefaultOrganization(db: Db, integrationId: string, lock = false): Promise<void> {
  const result = await db.query(`SELECT id FROM directory_integrations
    WHERE id = $1::uuid AND provider = 'dingtalk' AND org_id = 'default'${lock ? ' FOR SHARE' : ''}`, [integrationId])
  if (result.rows.length !== 1) throw new NotificationHttpError(404, 'NOT_FOUND')
}

export function createNotificationVerificationService(
  deps: NotificationDbDeps,
): NotificationVerificationService {
  return {
    async verify(input) {
      await assertDefaultOrganization(deps.db, input.integrationId)
      // Captured before token/send: no later read can substitute credentials or anchor for this run.
      let tested: ReturnType<typeof tupleIdentity> = { scope: null, tupleFingerprint: null }
      const result = await verifyDingTalkWorkNotificationIntegration(input, {
        client: deps.db,
        onResolvedTuple: (tuple) => {
          if (tuple.sourceScope?.orgId !== 'default') throw new NotificationHttpError(404, 'NOT_FOUND')
          tested = tupleIdentity(tuple)
          if (!tested.scope || !tested.tupleFingerprint) {
            throw new NotificationHttpError(409, 'VERIFICATION_TUPLE_UNSUPPORTED')
          }
        },
      })
      const evidence = await deps.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await client.query("SET LOCAL lock_timeout = '5s'")
        await client.query("SET LOCAL statement_timeout = '5s'")
        await assertDefaultOrganization(client, input.integrationId, true)
        await writeNotificationVerification(client, {
          connectionId: input.integrationId, provider: 'dingtalk', verifiedBy: input.verifiedBy,
          report: result, ...tested,
        })
        // Display checks current credentials, while the persisted evidence always binds the tested tuple.
        let current: ReturnType<typeof tupleIdentity> = { scope: null, tupleFingerprint: null }
        try {
          current = tupleIdentity(await readDingTalkIntegrationScopedMessageTuple(input.integrationId, client))
        } catch (error) {
          if (!(error instanceof DingTalkMessageConfigError)) throw error
          // A tuple that no longer resolves cannot produce a valid verification summary.
        }
        return (await checkNotificationVerification(client, {
          connectionId: input.integrationId, provider: 'dingtalk', ...current,
        })).verification
      }).catch((error: unknown) => {
        throw new NotificationVerificationEvidenceError(result, error)
      })
      return { result, evidence }
    },
  }
}

/** Whitelist the existing helper's safe fields; the management exception records only recipient length. */
export function notificationVerificationAuditMeta(result: DingTalkWorkNotificationVerifyResult): Record<string, unknown> {
  const meta = buildDingTalkWorkNotificationVerifyAuditMeta(result, undefined)
  return {
    integrationId: meta.integrationId,
    requestedLevel: meta.requestedLevel,
    reachedLevel: meta.reachedLevel,
    passed: meta.passed,
    failureLevel: meta.failureLevel,
    failureCode: meta.failureCode,
    source: meta.source,
    agentIdLength: meta.agentIdLength,
    agentIdValuePrinted: false,
    accessTokenVerified: meta.accessTokenVerified,
    notificationAttempted: meta.notificationAttempted,
    notificationAccepted: meta.notificationAccepted,
    verificationRunId: meta.verificationRunId,
    recipientUserIdLength: result.notification.recipientUserIdLength,
  }
}
