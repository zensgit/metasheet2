import { randomUUID, createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  encryptStoredSecretValue,
  decryptStoredSecretValue,
  isEncryptedSecretValue,
} from '../security/encrypted-secrets'
import { enqueueApprovalEventIfDurable } from '../multitable/automation-producer-emit'
import { isDurableDeliveryEnabled } from '../multitable/automation-durable-delivery'
import type {
  ApprovalCardDeliverySummary,
  ApprovalCardActionOutcome,
} from './ApprovalCardDeliveryAction'
import type { DingTalkApprovalCardDeliveryRow } from '../integrations/dingtalk/approval-card-deliveries'
import {
  personalBindingInput,
  personalGrantSchema,
  personalTasksSchema,
  personalTaskDetailSchema,
  personalReceiptSchema,
  personalCommandSchema,
  requirePlmApprovalCard,
  PlmPersonalApprovalError as Failure,
  type PersonalApprovalTransport,
  type PersonalCommand,
  type PersonalReceipt,
} from './plm-personal-approval-wire'

interface Binding {
  id: string
  owner_id: string
  connection_id: string
  subject_id: string
  tenant_id: string
  org_id: string
  grant_id: string
  expires_at: Date
  encrypted_grant: string | null
  generation: number
  reconcile_cursor?: string | null
}
interface Task {
  id: string
  binding_id: string
  source_task_id: string
  source_round_id: string
  source_eco_id: string
  source_stage_id: string
  entry_epoch: number
  active: boolean
  seat_status: string
  task: { eco_name: string }
}
interface Intent {
  id: string
  delivery_id: string
  task_id: string
  binding_id: string
  subject_id: string
  connection_id: string
  tenant_id: string
  org_id: string
  command: PersonalCommand
  request_hash: string
  receipt: PersonalReceipt | null
  state: string
}
export class PlmPersonalApprovalBindingService {
  constructor(
    readonly pool: Pick<Pool, 'connect' | 'query'>,
    readonly provider: () => PersonalApprovalTransport,
  ) {}
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      const result = await fn(c)
      await c.query('COMMIT')
      return result
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  }
  private async activeOwner(c: PoolClient, owner: string): Promise<void> {
    const r = await c.query('SELECT id FROM users WHERE id=$1 AND is_active=true FOR SHARE', [
      owner,
    ])
    if (!r.rowCount) throw new Failure(401, 'PLM_CARD_UNAUTHORIZED')
  }
  private metadata(b: Binding, count = 0) {
    return {
      id: b.id,
      connectionId: b.connection_id,
      subjectId: b.subject_id,
      tenantId: b.tenant_id,
      orgId: b.org_id,
      grantId: b.grant_id,
      expiresAt: new Date(b.expires_at).toISOString(),
      bound: !!b.encrypted_grant,
      unresolvedCount: count,
    }
  }
  private checkScope(
    b: Binding,
    wire: { connection_id?: string; tenant_id?: string; org_id?: string; auth_user_id?: string },
  ) {
    const p = this.provider()
    if (
      b.connection_id !== requirePlmApprovalCard() ||
      wire.connection_id !== b.connection_id ||
      wire.tenant_id !== b.tenant_id ||
      wire.org_id !== b.org_id ||
      wire.auth_user_id !== b.subject_id ||
      p.getEffectiveTenantId() !== b.tenant_id ||
      p.getEffectiveOrgId() !== b.org_id
    )
      throw new Failure(403, 'PLM_PROVIDER_FORBIDDEN')
  }
  private async ownedBinding(c: PoolClient, id: string, owner: string): Promise<Binding> {
    requirePlmApprovalCard()
    await this.activeOwner(c, owner)
    const b = (
      await c.query<Binding>(
        'SELECT * FROM plm_personal_approval_bindings WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      )
    ).rows[0]
    if (!b) throw new Failure(404, 'PLM_BINDING_REQUIRED')
    return b
  }
  private async bound(c: PoolClient, id: string, owner: string): Promise<Binding> {
    const b = await this.ownedBinding(c, id, owner)
    this.checkScope(b, {
      connection_id: b.connection_id,
      tenant_id: b.tenant_id,
      org_id: b.org_id,
      auth_user_id: b.subject_id,
    })
    if (!b.encrypted_grant || new Date(b.expires_at).getTime() <= Date.now())
      throw new Failure(409, 'PLM_BINDING_REQUIRED')
    return b
  }
  private secret(b: Binding): string {
    if (!b.encrypted_grant || !isEncryptedSecretValue(b.encrypted_grant))
      throw new Failure(409, 'PLM_BINDING_REQUIRED')
    try {
      return decryptStoredSecretValue(b.encrypted_grant)
    } catch {
      throw new Failure(409, 'PLM_BINDING_REQUIRED')
    }
  }
  async list(owner: string) {
    requirePlmApprovalCard()
    return this.tx(async (c) => {
      await this.activeOwner(c, owner)
      const r = await c.query<Binding & { unresolved: string }>(
        `SELECT b.*,(SELECT count(*) FROM plm_personal_approval_commands x WHERE x.binding_id=b.id AND x.state='pending') AS unresolved FROM plm_personal_approval_bindings b WHERE b.owner_id=$1 ORDER BY id`,
        [owner],
      )
      const connectionId = requirePlmApprovalCard()
      let grantManagementUrl: string | null = null
      let tenantId: string | undefined
      let orgId: string | undefined
      try {
        const transport = this.provider()
        const managementUrl = transport.personalApprovalManagementUrl()
        const effectiveTenantId = transport.getEffectiveTenantId()
        const effectiveOrgId = transport.getEffectiveOrgId()
        if (
          typeof managementUrl === 'string' &&
          managementUrl &&
          typeof effectiveTenantId === 'string' &&
          effectiveTenantId &&
          typeof effectiveOrgId === 'string' &&
          effectiveOrgId
        ) {
          grantManagementUrl = managementUrl
          tenantId = effectiveTenantId
          orgId = effectiveOrgId
        }
      } catch {
        grantManagementUrl = null
        tenantId = undefined
        orgId = undefined
      }
      return {
        connection: {
          id: connectionId,
          label: 'Yuantus',
          grantManagementUrl,
        },
        bindings: r.rows.map((b) => ({
          ...this.metadata(b, Number(b.unresolved)),
          // Advisory local eligibility only. Operation guards stay authoritative.
          canUse: !!(
            grantManagementUrl &&
            tenantId &&
            orgId &&
            b.connection_id === connectionId &&
            b.tenant_id === tenantId &&
            b.org_id === orgId &&
            b.encrypted_grant &&
            new Date(b.expires_at).getTime() > Date.now()
          ),
        })),
      }
    })
  }
  async bind(owner: string, input: unknown) {
    const body = personalBindingInput.parse(input)
    if (body.connectionId !== requirePlmApprovalCard())
      throw new Failure(403, 'PLM_PROVIDER_FORBIDDEN')
    return this.tx(async (c) => {
      await this.activeOwner(c, owner)
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `plm-personal-binding:${owner}:${body.connectionId}`,
      ])
      const verified = personalGrantSchema.parse(
        await this.provider().personalApprovalRequest('verify', body.grant, body.connectionId),
      )
      const candidate: Binding = {
        id: randomUUID(),
        owner_id: owner,
        connection_id: verified.connection_id,
        subject_id: verified.auth_user_id,
        tenant_id: verified.tenant_id,
        org_id: verified.org_id,
        grant_id: verified.grant_id,
        expires_at: new Date(verified.expires_at),
        encrypted_grant: null,
        generation: 1,
      }
      this.checkScope(candidate, verified)
      if (candidate.expires_at.getTime() <= Date.now())
        throw new Failure(401, 'PLM_CARD_UNAUTHORIZED')
      const old = (
        await c.query<Binding>(
          'SELECT * FROM plm_personal_approval_bindings WHERE owner_id=$1 AND connection_id=$2 FOR UPDATE',
          [owner, body.connectionId],
        )
      ).rows[0]
      if (
        old &&
        (old.subject_id !== candidate.subject_id ||
          old.tenant_id !== candidate.tenant_id ||
          old.org_id !== candidate.org_id)
      )
        throw new Failure(409, 'PLM_BINDING_CONFLICT')
      const encrypted = encryptStoredSecretValue(body.grant)
      try {
        const b = (
          await c.query<Binding>(
            `INSERT INTO plm_personal_approval_bindings(id,owner_id,connection_id,subject_id,tenant_id,org_id,grant_id,expires_at,encrypted_grant) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,connection_id) DO UPDATE SET grant_id=EXCLUDED.grant_id,expires_at=EXCLUDED.expires_at,encrypted_grant=EXCLUDED.encrypted_grant,generation=plm_personal_approval_bindings.generation+1,updated_at=now() RETURNING *`,
            [
              candidate.id,
              owner,
              candidate.connection_id,
              candidate.subject_id,
              candidate.tenant_id,
              candidate.org_id,
              candidate.grant_id,
              candidate.expires_at,
              encrypted,
            ],
          )
        ).rows[0]
        const count = (
          await c.query(
            "SELECT count(*)::int n FROM plm_personal_approval_commands WHERE binding_id=$1 AND state='pending'",
            [b.id],
          )
        ).rows[0].n
        return this.metadata(b, count)
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new Failure(409, 'PLM_BINDING_CONFLICT')
        throw e
      }
    })
  }
  async unbind(owner: string, id: string) {
    return this.tx(async (c) => {
      const b = await this.ownedBinding(c, id, owner)
      await c.query(
        'UPDATE plm_personal_approval_bindings SET encrypted_grant=NULL,generation=generation+1,updated_at=now() WHERE id=$1',
        [b.id],
      )
      await c.query(
        'UPDATE plm_personal_approval_tasks SET active=false,updated_at=now() WHERE binding_id=$1',
        [b.id],
      )
      await c.query(
        `UPDATE dingtalk_approval_card_deliveries SET card_state='revoked',updated_at=now() WHERE plm_task_id IN(SELECT id FROM plm_personal_approval_tasks WHERE binding_id=$1) AND card_state='sent'`,
        [b.id],
      )
    })
  }
  async sync(owner: string, id: string) {
    return this.tx(async (c) => {
      if (!isDurableDeliveryEnabled()) throw new Failure(503, 'PLM_PROVIDER_UNAVAILABLE')
      const b = await this.bound(c, id, owner),
        response = personalTasksSchema.parse(
          await this.provider().personalApprovalRequest('tasks', this.secret(b), b.connection_id),
        )
      this.checkScope(b, response)
      const unique = new Set<string>()
      for (const t of response.items) {
        if (
          t.assignee_auth_user_id !== b.subject_id ||
          t.status !== 'pending' ||
          unique.has(t.task_id)
        )
          throw new Failure(503, 'PLM_PROVIDER_UNAVAILABLE')
        unique.add(t.task_id)
      }
      const ids: string[] = []
      for (const t of response.items) {
        const old = (
          await c.query<Task>(
            'SELECT * FROM plm_personal_approval_tasks WHERE binding_id=$1 AND source_task_id=$2 AND source_round_id=$3 FOR UPDATE',
            [b.id, t.task_id, t.round_id],
          )
        ).rows[0]
        let current: Task
        if (!old) {
          current = (
            await c.query<Task>(
              'INSERT INTO plm_personal_approval_tasks(id,binding_id,source_task_id,source_round_id,source_eco_id,source_stage_id,task) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [randomUUID(), b.id, t.task_id, t.round_id, t.eco_id, t.stage_id, t],
            )
          ).rows[0]
        } else {
          if (old.source_eco_id !== t.eco_id || old.source_stage_id !== t.stage_id)
            throw new Failure(503, 'PLM_PROVIDER_UNAVAILABLE')
          current = (
            await c.query<Task>(
              `UPDATE plm_personal_approval_tasks SET task=$2,active=true,seat_status='pending',entry_epoch=CASE WHEN active THEN entry_epoch ELSE nextval('plm_personal_task_epoch') END,updated_at=now() WHERE id=$1 RETURNING *`,
              [old.id, t],
            )
          ).rows[0]
        }
        ids.push(current.id)
        if (!old || !old.active) {
          const ev = {
            version: 1,
            eventType: 'approval.task_created',
            eventId: `plm-personal-task:${current.id}:${current.entry_epoch}`,
            source: 'plm-personal',
            occurredAt: new Date().toISOString(),
            approval: { instanceId: current.id, templateId: null },
            task: {
              plmTaskId: current.id,
              nodeKey: t.stage_id,
              entryEpoch: current.entry_epoch,
              assigneeUserId: owner,
              sourceStep: 1,
            },
            requester: { id: null },
          }
          if (
            !(await enqueueApprovalEventIfDurable(
              { query: c.query.bind(c), isTransaction: true },
              ev,
            ))
          )
            throw new Failure(503, 'PLM_PROVIDER_UNAVAILABLE')
        }
      }
      const retired = await c.query(
        'UPDATE plm_personal_approval_tasks SET active=false,updated_at=now() WHERE binding_id=$1 AND active AND NOT(id=ANY($2::uuid[])) RETURNING id',
        [b.id, ids],
      )
      await c.query(
        `UPDATE dingtalk_approval_card_deliveries d SET card_state='superseded',updated_at=now() FROM plm_personal_approval_tasks t WHERE d.plm_task_id=t.id AND t.binding_id=$1 AND d.card_state='sent' AND (NOT t.active OR d.entry_epoch<>t.entry_epoch)`,
        [b.id],
      )
      return { taskCount: ids.length, retiredCount: retired.rowCount ?? 0 }
    })
  }
  async withSendAdmission<T>(
    taskId: string,
    epoch: number,
    owner: string,
    send: () => Promise<T>,
  ): Promise<T> {
    return this.tx(async (c) => {
      const t = (
        await c.query<Task>('SELECT * FROM plm_personal_approval_tasks WHERE id=$1', [taskId])
      ).rows[0]
      if (!t) throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
      const b = await this.bound(c, t.binding_id, owner)
      const current = (
        await c.query<Task>('SELECT * FROM plm_personal_approval_tasks WHERE id=$1', [taskId])
      ).rows[0]
      if (!current.active || current.entry_epoch !== epoch || current.seat_status !== 'pending')
        throw new Failure(409, 'PLM_SOURCE_CONFLICT')
      await this.inspect(b, current)
      // Binding lock also serializes unbind/sync. No platform instance or old actorless bridge is used.
      return send()
    })
  }
  private async inspect(b: Binding, t: Task) {
    const detail = personalTaskDetailSchema.parse(
      await this.provider().personalApprovalRequest(
        'task',
        this.secret(b),
        b.connection_id,
        undefined,
        t.source_task_id,
      ),
    )
    this.checkScope(b, detail)
    if (
      !detail.is_current ||
      !detail.is_pending ||
      detail.task.task_id !== t.source_task_id ||
      detail.task.round_id !== t.source_round_id ||
      detail.task.assignee_auth_user_id !== b.subject_id ||
      detail.task.status !== 'pending' ||
      detail.source.round_id !== t.source_round_id ||
      detail.source.stage_id !== t.source_stage_id
    )
      throw new Failure(409, 'PLM_SOURCE_CONFLICT')
    return detail
  }
  private async taskForDelivery(c: PoolClient, deliveryId: string, owner: string) {
    const d = (
      await c.query<DingTalkApprovalCardDeliveryRow>(
        'SELECT * FROM dingtalk_approval_card_deliveries WHERE id=$1 FOR UPDATE',
        [deliveryId],
      )
    ).rows[0]
    if (!d?.plm_task_id || d.instance_id || d.recipient_user_id !== owner)
      throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
    const t = (
      await c.query<Task>('SELECT * FROM plm_personal_approval_tasks WHERE id=$1 FOR UPDATE', [
        d.plm_task_id,
      ])
    ).rows[0]
    if (!t) throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
    return { d, t }
  }
  private live(d: DingTalkApprovalCardDeliveryRow, t: Task) {
    return (
      d.card_state === 'sent' &&
      ['sent', 'outcome_unknown'].includes(d.send_status) &&
      t.active &&
      t.seat_status === 'pending' &&
      d.entry_epoch === t.entry_epoch &&
      d.node_key === t.source_stage_id
    )
  }
  async summary(
    d: DingTalkApprovalCardDeliveryRow,
    owner: string,
  ): Promise<ApprovalCardDeliverySummary | null> {
    if (!d.plm_task_id || d.instance_id || d.recipient_user_id !== owner) return null
    const t = (
      await this.pool.query<Task>('SELECT * FROM plm_personal_approval_tasks WHERE id=$1', [
        d.plm_task_id,
      ])
    ).rows[0]
    if (!t) return null
    let actionable = false
    if (this.live(d, t))
      try {
        await this.tx(async (c) => {
          const b = await this.bound(c, t.binding_id, owner)
          await this.inspect(b, t)
          actionable = true
        })
      } catch {
        actionable = false
      }
    return {
      deliveryId: d.id,
      cardState: d.card_state,
      sendStatus: d.send_status,
      nodeKey: d.node_key,
      recipientUserId: d.recipient_user_id,
      viewerIsRecipient: true,
      actionable,
      approval: {
        instanceId: t.id,
        title: t.task.eco_name,
        requestNo: null,
        status: t.seat_status,
        currentNodeKey: t.source_stage_id,
        rejectCommentRequired: true,
        commentRequired: 'reject_only',
      },
      actedAction: d.acted_action,
      actedAt: d.acted_at ? new Date(d.acted_at).toISOString() : null,
    }
  }
  async execute(
    deliveryId: string,
    owner: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): Promise<ApprovalCardActionOutcome> {
    // Phase A commits immutable intent before any decision request can leave this process.
    const intent = await this.tx(async (c) => {
      const lookup = (
        await c.query<{ binding_id: string }>(
          `SELECT t.binding_id FROM plm_personal_approval_tasks t JOIN dingtalk_approval_card_deliveries d ON d.plm_task_id=t.id WHERE d.id=$1 AND d.recipient_user_id=$2`,
          [deliveryId, owner],
        )
      ).rows[0]
      if (!lookup) throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
      const b = await this.bound(c, lookup.binding_id, owner)
      const { d, t } = await this.taskForDelivery(c, deliveryId, owner)
      const prior = (
        await c.query<Intent>(
          'SELECT * FROM plm_personal_approval_commands WHERE delivery_id=$1 FOR UPDATE',
          [deliveryId],
        )
      ).rows[0]
      if (prior) {
        if (prior.command.decision !== decision || prior.command.comment !== (comment ?? null))
          throw new Failure(409, 'PLM_SOURCE_CONFLICT')
        return prior
      }
      if (!this.live(d, t)) throw new Failure(409, 'PLM_SOURCE_CONFLICT')
      await this.inspect(b, t)
      const command = personalCommandSchema.parse({
        schema: 'yuantus.plm-approval-card-command.v1',
        command_id: randomUUID(),
        connection_id: b.connection_id,
        delivery_id: d.id,
        task_id: t.source_task_id,
        round_id: t.source_round_id,
        decision,
        comment: comment ?? null,
      })
      return (
        await c.query<Intent>(
          `INSERT INTO plm_personal_approval_commands(id,delivery_id,task_id,binding_id,subject_id,connection_id,tenant_id,org_id,original_grant_id,command,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            command.command_id,
            d.id,
            t.id,
            b.id,
            b.subject_id,
            b.connection_id,
            b.tenant_id,
            b.org_id,
            b.grant_id,
            command,
            createHash('sha256').update(JSON.stringify(command)).digest('hex'),
          ],
        )
      ).rows[0]
    })
    await this.resolveIntent(owner, intent.id, true)
    const d = (
      await this.pool.query<DingTalkApprovalCardDeliveryRow>(
        'SELECT * FROM dingtalk_approval_card_deliveries WHERE id=$1',
        [deliveryId],
      )
    ).rows[0]
    const summary = await this.summary(d, owner)
    if (!summary) throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
    return { status: 'ok', summary }
  }
  private async resolveIntent(
    owner: string,
    id: string,
    admission: boolean,
  ): Promise<'settled' | 'admissionRequired'> {
    return this.tx(async (c) => {
      const found = (
        await c.query<Intent>('SELECT * FROM plm_personal_approval_commands WHERE id=$1', [id])
      ).rows[0]
      if (!found) throw new Failure(404, 'PLM_SOURCE_NOT_FOUND')
      const b = await this.bound(c, found.binding_id, owner)
      const i = (
        await c.query<Intent>(
          'SELECT * FROM plm_personal_approval_commands WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (
        b.subject_id !== i.subject_id ||
        b.tenant_id !== i.tenant_id ||
        b.org_id !== i.org_id ||
        b.connection_id !== i.connection_id
      )
        throw new Failure(403, 'PLM_PROVIDER_FORBIDDEN')
      const { d, t } = await this.taskForDelivery(c, i.delivery_id, owner)
      let raw: unknown
      try {
        raw = await this.provider().personalApprovalRequest(
          'receipt',
          this.secret(b),
          b.connection_id,
          undefined,
          i.id,
        )
      } catch (e) {
        if (!(e instanceof Failure) || e.status !== 404) throw e
        if (!admission) return 'admissionRequired'
        if (!this.live(d, t)) throw new Failure(409, 'PLM_SOURCE_CONFLICT')
        await this.inspect(b, t)
        raw = await this.provider().personalApprovalRequest(
          'command',
          this.secret(b),
          b.connection_id,
          i.command,
        )
      }
      const receipt = personalReceiptSchema.parse(raw),
        cmd = i.command
      if (
        receipt.command_id !== i.id ||
        receipt.delivery_id !== i.delivery_id ||
        receipt.connection_id !== i.connection_id ||
        receipt.task_id !== cmd.task_id ||
        receipt.round_id !== cmd.round_id ||
        receipt.actor_auth_user_id !== i.subject_id ||
        receipt.decision !== cmd.decision ||
        receipt.seat_status !== (cmd.decision === 'approve' ? 'approved' : 'rejected') ||
        receipt.source_at_commit.eco_id !== t.source_eco_id
      )
        throw new Failure(503, 'PLM_PROVIDER_UNAVAILABLE')
      if (i.state === 'settled') return 'settled'
      await c.query(
        "UPDATE plm_personal_approval_commands SET receipt=$2,state='settled',settled_at=now() WHERE id=$1",
        [i.id, receipt],
      )
      await c.query(
        'UPDATE plm_personal_approval_tasks SET active=false,seat_status=$2,updated_at=now() WHERE id=$1',
        [t.id, receipt.seat_status],
      )
      await c.query(
        "UPDATE dingtalk_approval_card_deliveries SET card_state='acted',acted_action=$2,acted_by=$3,acted_at=now(),updated_at=now() WHERE id=$1",
        [d.id, cmd.decision, owner],
      )
      return 'settled'
    })
  }
  async reconcile(owner: string, id: string, mayContinue: () => boolean = () => true) {
    const rows = await this.tx(async (c) => {
      const binding = await this.bound(c, id, owner)
      // Rotate a finite page durably: absent receipts must not starve later commands.
      // Claim under the binding lock; every actual lookup rechecks the binding again.
      const page = (await c.query<{ id: string }>(
        "SELECT id FROM plm_personal_approval_commands WHERE binding_id=$1 AND state='pending' ORDER BY CASE WHEN $2::uuid IS NULL OR id>$2::uuid THEN 0 ELSE 1 END,id LIMIT 100",
        [id, binding.reconcile_cursor ?? null],
      )).rows
      if (page.length) await c.query('UPDATE plm_personal_approval_bindings SET reconcile_cursor=$2 WHERE id=$1', [id, page[page.length - 1].id])
      return page
    })
    const result = { settled: 0, pending: 0, admissionRequired: 0 }
    for (const row of rows) {
      if (!mayContinue()) break
      try {
        result[await this.resolveIntent(owner, row.id, false)]++
      } catch {
        result.pending++
      }
    }
    return result
  }
}
