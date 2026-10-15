import { createHash } from 'node:crypto'
import { z } from 'zod'

// PostgreSQL text/jsonb cannot store NUL or unpaired UTF-16 surrogates. Never normalize source text.
export function isPlmText(value: string): boolean {
  return !value.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  )
}
export const plmId = z
  .string()
  .refine((v) => v.length > 0 && Array.from(v).length <= 128 && isPlmText(v))
const cell = z
  .string()
  .refine((v) => isPlmText(v) && Buffer.byteLength(v, 'utf8') <= 65536)
  .nullable()
const positiveSafe = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const plmSourceSchema = z
  .object({
    connection_id: plmId,
    tenant_id: plmId,
    org_id: plmId,
    part_id: plmId,
  })
  .strict()
export const plmCellsSchema = z
  .object({ quantity: cell, uom: cell, find_num: cell, refdes: cell })
  .strict()
const eventSchema = z
  .object({
    schema: z.literal('yuantus.bom-record-event.v1'),
    event_id: z.string().uuid(),
    event_type: z.literal('bom.line.updated'),
    binding_id: z.string().uuid(),
    binding_version: positiveSafe,
    source: plmSourceSchema.extend({ bom_line_id: plmId }).strict(),
    source_sequence: positiveSafe,
    occurred_at: z.string().datetime({ offset: false }),
    cells: plmCellsSchema,
  })
  .strict()
export type PlmRecordEvent = z.infer<typeof eventSchema>
export function parsePlmRecordEvent(value: unknown): PlmRecordEvent {
  return eventSchema.parse(value)
}
export function isPlmRecordIngressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLM_RECORD_INGRESS_ENABLED === 'true'
}
export function canonicalPlmEvent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlmEvent).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPlmEvent((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
export function hashPlmEvent(event: PlmRecordEvent): string {
  return createHash('sha256').update(canonicalPlmEvent(event), 'utf8').digest('hex')
}
export class PlmIngressError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}
