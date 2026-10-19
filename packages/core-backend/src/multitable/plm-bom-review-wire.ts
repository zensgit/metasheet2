import { createHash } from 'crypto'
import { z } from 'zod'

export class BomReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}
export function requireBomReview(): void {
  if (process.env.PLM_BOM_REVIEW_ENABLED !== 'true')
    throw new BomReviewError(503, 'PLM_BOM_REVIEW_DISABLED')
}
const id = z.string().min(1).max(128)
const text = z
  .string()
  .max(65536)
  .refine(
    (v) =>
      !v.includes('\0') &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        v,
      ),
  )
const nullableText = text.nullable()
const integer = z.number().int().safe().nullable()
const quantity = z.union([
  nullableText,
  z
    .number()
    .finite()
    .refine((v) => !Number.isInteger(v) || Number.isSafeInteger(v)),
])
const provenance = {
  source_version: integer,
  source_updated_at: nullableText,
  sync_status: z.literal('snapshot'),
}
const part = z.object({
  part_id: id,
  item_number: nullableText,
  name: nullableText,
  state: nullableText,
  generation: integer,
})
const line = part.extend({
  bom_line_id: id,
  quantity,
  uom: nullableText,
  find_num: nullableText,
  refdes: nullableText,
  level: z.number().int().positive().safe(),
  path: z.array(id),
  path_labels: z.array(nullableText),
  ...provenance,
})
const source = z
  .object({
    tenant_id: id,
    org_id: id,
    auth_user_id: z.string().regex(/^[1-9][0-9]*$/),
    part_id: id,
  })
  .strict()
const share = z.object({
  projection_contract: z.literal('bom_review_share.v1'),
  feature_key: z.literal('bom_multitable'),
  entitled: z.literal(true),
  upgrade: z.object({ available: z.literal(false) }),
  source,
  snapshot_at: z.string().datetime(),
  context: z.object({
    part,
    lines: z.array(line),
    ...provenance,
    template_key: z.literal('bom_review'),
  }),
})
export type ShareSnapshot = z.infer<typeof share>
export const previewInput = z
  .object({
    dataSourceId: id,
    partId: id,
    baseId: id,
    name: z.string().trim().min(1).max(255),
  })
  .strict()
export const confirmInput = z
  .object({ previewId: z.string().uuid(), requestId: z.string().uuid() })
  .strict()
export const versionInput = z
  .object({ expectedVersion: z.number().int().positive().safe() })
  .strict()
const recipientStrategy = z.enum(['event_owner', 'current_owner'])
const minutes = z.number().int().safe().nonnegative().refine((value) =>
  Number.isSafeInteger(value * 60000) && Number.isFinite(new Date(Date.now() + value * 60000).getTime()))
export const notificationInput = z.object({
  expectedVersion: z.number().int().safe().nonnegative(),
  notifications: z.object({
    issue: z.object({ enabled: z.boolean(), recipientStrategy: recipientStrategy.nullable() })
      .strict().refine((value) => !value.enabled || value.recipientStrategy !== null),
    reminder: z.object({ enabled: z.boolean(), recipientStrategy: recipientStrategy.nullable(), leadMinutes: minutes.nullable() })
      .strict().refine((value) => !value.enabled || (value.leadMinutes !== null && value.recipientStrategy !== null)),
    escalation: z.object({
      enabled: z.boolean(), slaMinutes: minutes.refine((value) => value > 0).nullable(),
      recipientUserIds: z.array(id).refine((value) => new Set(value).size === value.length),
    }).strict().refine((value) => !value.enabled || (value.slaMinutes !== null && value.recipientUserIds.length > 0)),
  }).strict(),
}).strict()
export const BOM_COMPLETION_EVENT_TYPES = {
  reviewCompleted: 'bom.review.completed',
  plmChangeApplied: 'bom.plm_change.applied',
} as const
const reviewCompletionRule = z.object({
  enabled: z.boolean(), webhookId: id.nullable(),
  granularity: z.enum(['bom', 'row']).nullable().default(null),
}).strict().refine((v) => !v.enabled || (v.webhookId !== null && v.granularity !== null))
const plmCompletionRule = z.object({
  enabled: z.boolean(), webhookId: id.nullable(),
  source: z.enum(['bom_line_writeback', 'eco_batch_apply']).nullable().default(null),
}).strict().refine((v) => !v.enabled || (v.webhookId !== null && v.source !== null))
export const completionWebhookInput = z.object({
  expectedVersion: z.number().int().nonnegative().safe(),
  webhooks: z.object({ reviewCompleted: reviewCompletionRule, plmChangeApplied: plmCompletionRule }).strict(),
}).strict()
export function parseShareSnapshot(
  value: unknown,
  partId: string,
): ShareSnapshot {
  if (
    value &&
    typeof value === 'object' &&
    (value as { entitled?: unknown }).entitled === false
  )
    throw new BomReviewError(403, 'SOURCE_UNENTITLED')
  const result = share.safeParse(value)
  if (
    !result.success ||
    result.data.source.part_id !== partId ||
    result.data.context.part.part_id !== partId
  )
    throw new BomReviewError(502, 'SOURCE_UNAVAILABLE')
  return result.data
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function snapshotHash(value: ShareSnapshot): string {
  return hash({ source: value.source, context: value.context })
}
export const SOURCE_FIELDS = [
  'bom_line_id',
  'part_id',
  'item_number',
  'name',
  'state',
  'generation',
  'quantity',
  'uom',
  'find_num',
  'refdes',
  'source_version',
  'source_updated_at',
  'sync_status',
  'occurrences',
] as const
export const LOCAL_FIELDS = [
  { id: 'owner', name: '负责人', type: 'person' },
  {
    id: 'status',
    name: '评审状态',
    type: 'select',
    property: {
      options: [
        { value: '待评审' },
        { value: '评审中' },
        { value: '有问题' },
        { value: '已完成' },
      ],
    },
  },
  { id: 'tags', name: '标签', type: 'multiSelect', property: { options: [] } },
  { id: 'note', name: '备注', type: 'longText' },
  { id: 'due_date', name: '截止时间', type: 'dateTime' },
  { id: 'review_opinion', name: '评审意见', type: 'longText' },
  { id: 'issue_type', name: '问题类型', type: 'string' },
  { id: 'conclusion', name: '结论', type: 'longText' },
] as const
export type ProjectedBomRow = {
  cells: Record<string, string | null>
  occurrences: {
    relations: string[]
    path: string[]
    pathLabels: (string | null)[]
    level: number
  }[]
}
export function projectBomRows(
  snapshot: ShareSnapshot,
): Map<string, ProjectedBomRow> {
  const rows = new Map<string, ProjectedBomRow>(),
    ancestry: string[] = []
  for (const line of snapshot.context.lines) {
    if (line.level > ancestry.length + 1)
      throw new BomReviewError(502, 'SOURCE_UNAVAILABLE')
    ancestry.splice(line.level - 1)
    ancestry.push(line.bom_line_id)
    const cells = Object.fromEntries(
      SOURCE_FIELDS.filter((key) => key !== 'occurrences').map((key) => [
        key,
        line[key] === null ? null : String(line[key]),
      ]),
    )
    const occurrence = {
      relations: [...ancestry],
      path: line.path,
      pathLabels: line.path_labels,
      level: line.level,
    }
    const old = rows.get(line.bom_line_id)
    if (old) {
      if (
        canonical(old.cells) !== canonical(cells) ||
        old.occurrences.some(
          (o) => canonical(o.relations) === canonical(occurrence.relations),
        )
      )
        throw new BomReviewError(502, 'SOURCE_UNAVAILABLE')
      old.occurrences.push(occurrence)
    } else rows.set(line.bom_line_id, { cells, occurrences: [occurrence] })
  }
  for (const row of rows.values())
    row.cells.occurrences = canonical(row.occurrences)
  return rows
}
