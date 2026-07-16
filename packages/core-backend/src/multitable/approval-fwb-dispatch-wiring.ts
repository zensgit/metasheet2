/**
 * FWB-1 slice ④-a — the `write_approval_form_values` dispatch wiring (flag-gated action dispatcher).
 *
 * Binds the FWB executor to the REAL durable seams: `produceAutomationEvent` (atomic outbox enqueue, flag-
 * gated inside) and the caller-supplied record-service binding. The remaining ④-b is a ONE-LINE insertion
 * in automation-service's action switch:
 *
 *     case 'write_approval_form_values':
 *       return fwbDispatcher.dispatch(trx, ruleCtx, action.config)
 *
 * plus adding the action type to ALL_ACTION_TYPES — that hot-file edit ships as its own reviewed PR once
 * the P2/ledger/FWB chain is on main (it is deliberately NOT made here; while the flag is OFF the dispatcher
 * throws on construction, so no dormant path exists either way).
 *
 * Everything about the execution contract lives in the already-reviewed executor (§11 Q6 gates → fail-closed
 * mapping → node-agnostic ledger claim → record+revision+outbox same-txn); this module only performs the
 * BINDING and the action_key derivation from the rule context (the #4196-C4 triple identity).
 */
import { createHash } from 'node:crypto'

import type { Queryable } from './automation-durable-dispatcher'
import { deriveActionKey } from './automation-action-idempotency'
import { produceAutomationEvent } from './automation-durable-activation'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { executeWriteApprovalFormValues, type FwbWriteActionResult } from './approval-fwb-write-action'
import type { FwbFieldMapping } from './approval-form-value-mapping'
import type { FwbGateChecks } from './approval-fwb-permission-gates'

export interface FwbRuleContext {
  instanceId: string
  ruleId: string
  /** structured step path of this action inside the rule (#4196 C4), e.g. 'steps[2].actions[0]'. */
  structuralPath: string
  configurerUserId: string
  sourceTemplateId: string
  /** stable original event id of the approval-completion event being consumed. */
  eventId: string
  automationDepth: number
  formValues: Readonly<Record<string, unknown>>
}

export interface FwbWireDeps {
  gates: FwbGateChecks
  /** real record-service binding: create record + revision on the SAME trx, return the record id. */
  createRecordWithRevision(trx: Queryable, targetSheetId: string, values: Record<string, string | number>): Promise<string>
  env?: NodeJS.ProcessEnv
}

export interface FwbActionConfig {
  targetSheetId: string
  mappings: readonly FwbFieldMapping[]
}

export class FwbActionDispatcher {
  constructor(private readonly deps: FwbWireDeps) {
    if (!isDurableDeliveryEnabled(deps.env ?? process.env)) {
      // Constructed ONLY when the durable chain is on: FWB writes ride the outbox; without it the action
      // must not exist at all (no half-durable mode).
      throw new Error('FwbActionDispatcher requires AUTOMATION_DURABLE_DELIVERY_ENABLED — do not construct while the flag is off')
    }
  }

  /** Execute one write_approval_form_values action INSIDE the rule's transaction. */
  async dispatch(trx: Queryable, ctx: FwbRuleContext, config: FwbActionConfig): Promise<FwbWriteActionResult> {
    const actionKey = deriveActionKey({
      structuralPath: ctx.structuralPath,
      actionType: 'write_approval_form_values',
      canonicalConfig: { targetSheetId: config.targetSheetId, mappings: config.mappings },
    })
    // digest of the FULL action key (slice(-16) alone would collide two actions sharing a config hash).
    const actionDigest = createHash('sha256').update(actionKey).digest('hex').slice(0, 16)
    return executeWriteApprovalFormValues(
      trx,
      {
        claimId: `aa_${ctx.eventId}_${actionDigest}`,
        instanceId: ctx.instanceId,
        ruleId: ctx.ruleId,
        actionKey,
        gateSubject: {
          configurerUserId: ctx.configurerUserId,
          ruleId: ctx.ruleId,
          sourceTemplateId: ctx.sourceTemplateId,
          targetSheetId: config.targetSheetId,
        },
        mappings: config.mappings,
        formValues: ctx.formValues,
        eventId: `${ctx.eventId}::fwb::${actionDigest}`, // derived, stable, unique per action
        automationDepth: ctx.automationDepth + 1, // downstream consumers inherit +1
      },
      this.deps.gates,
      {
        createRecordWithRevision: this.deps.createRecordWithRevision,
        enqueueOutbox: async (t, e) => {
          await produceAutomationEvent(t, { eventType: e.eventType, eventId: e.eventId, payload: e.payload, automationDepth: e.automationDepth }, this.deps.env)
        },
      },
    )
  }
}
