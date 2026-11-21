import type {
  CapabilityTransactionClient,
  EnablePreconditionContext,
  EnablePreconditionResult,
  IntegrationCapability,
} from '../integrations/provider-capability-registry'
import { checkNotificationVerification } from './verification-evidence'

type FingerprintResult = { ok: true; value: string } | { ok: false; code: string }

/**
 * The supplied reader must use this client's ordinary SELECTs and make no external request. The
 * production credential reader accepts the write transaction's client without taking another lock.
 */
export function createNotificationEnablePreconditions(
  readFingerprint: (connectionId: string, client: CapabilityTransactionClient) => Promise<FingerprintResult>,
): (capability: IntegrationCapability, context: EnablePreconditionContext) => Promise<EnablePreconditionResult> {
  return async (capability, context) => {
    if (capability !== 'notification' || context.provider !== 'dingtalk') {
      return { ok: false, code: 'precondition_not_registered' }
    }
    const fingerprint = await readFingerprint(context.integrationId, context.client)
    const result = await checkNotificationVerification(context.client, {
      connectionId: context.integrationId,
      provider: context.provider,
      scope: context.scope,
      tupleFingerprint: fingerprint.ok ? fingerprint.value : null,
    })
    return result.ok === true ? { ok: true } : { ok: false, code: result.code }
  }
}
