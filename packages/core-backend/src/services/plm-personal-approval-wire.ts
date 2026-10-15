import { z } from 'zod'

const validText = (v: string) =>
  !v.includes('\u0000') &&
  Array.from(v).every((c) => {
    const n = c.codePointAt(0)!
    return n < 0xd800 || n > 0xdfff
  })
const text = z.string().min(1).max(128).refine(validText)
const uuid = z.string().uuid()
const subject = z.string().regex(/^[1-9][0-9]*$/)
const utc = z.string().datetime()
const scope = { connection_id: text, tenant_id: text, org_id: text, auth_user_id: subject }
export const personalGrantSchema = z
  .object({
    schema: z.literal('yuantus.plm-approval-personal-binding.v1'),
    ...scope,
    grant_id: z.string().regex(/^[0-9a-f]{32}$/),
    expires_at: utc,
  })
  .strict()
export const personalTaskSchema = z
  .object({
    task_id: uuid,
    round_id: uuid,
    eco_id: uuid,
    eco_name: z.string().max(512).refine(validText),
    eco_state: text,
    stage_id: uuid,
    stage_name: z.string().max(512).refine(validText),
    approval_type: text,
    approval_deadline: utc.nullable(),
    assignee_auth_user_id: subject,
    status: text,
  })
  .strict()
const source = z
  .object({
    eco_id: uuid,
    eco_state: text,
    stage_id: uuid.nullable(),
    round_id: uuid.nullable(),
    kanban_state: text,
  })
  .strict()
export const personalTasksSchema = z
  .object({
    schema: z.literal('yuantus.plm-approval-card-tasks.v1'),
    ...scope,
    items: z.array(personalTaskSchema).max(1000),
  })
  .strict()
export const personalTaskDetailSchema = z
  .object({
    schema: z.literal('yuantus.plm-approval-card-task.v1'),
    ...scope,
    task: personalTaskSchema,
    is_current: z.boolean(),
    is_pending: z.boolean(),
    source,
  })
  .strict()
export const personalCommandSchema = z
  .object({
    schema: z.literal('yuantus.plm-approval-card-command.v1'),
    command_id: uuid,
    connection_id: text,
    delivery_id: uuid,
    task_id: uuid,
    round_id: uuid,
    decision: z.enum(['approve', 'reject']),
    comment: z.string().max(2000).refine(validText).nullable(),
  })
  .strict()
  .refine((v) => v.decision !== 'reject' || !!v.comment?.trim())
export const personalReceiptSchema = z
  .object({
    schema: z.literal('yuantus.plm-approval-card-receipt.v1'),
    command_id: uuid,
    delivery_id: uuid,
    connection_id: text,
    task_id: uuid,
    round_id: uuid,
    actor_auth_user_id: subject,
    decision: z.enum(['approve', 'reject']),
    seat_status: z.enum(['approved', 'rejected']),
    stage_complete: z.boolean(),
    source_at_commit: source,
    committed_at: utc,
  })
  .strict()
export type PersonalTask = z.infer<typeof personalTaskSchema>
export type PersonalCommand = z.infer<typeof personalCommandSchema>
export type PersonalReceipt = z.infer<typeof personalReceiptSchema>
export const personalBindingInput = z
  .object({ connectionId: text, grant: z.string().regex(/^yua_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/) })
  .strict()
export function isPlmApprovalCardEnabled(): boolean {
  return process.env.PLM_APPROVAL_CARD_ENABLED === 'true'
}
export class PlmPersonalApprovalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}
export function requirePlmApprovalCard(): string {
  const id = process.env.PLM_APPROVAL_CARD_CONNECTION_ID
  if (!isPlmApprovalCardEnabled() || !id || !text.safeParse(id).success)
    throw new PlmPersonalApprovalError(404, 'PLM_CARD_DISABLED')
  return id
}
export interface PersonalApprovalTransport {
  personalApprovalManagementUrl(): string
  getEffectiveTenantId(): string | undefined
  getEffectiveOrgId(): string | undefined
  personalApprovalRequest(
    operation: 'verify' | 'tasks' | 'task' | 'command' | 'receipt',
    grant: string,
    connectionId: string,
    data?: unknown,
    id?: string,
  ): Promise<unknown>
}
