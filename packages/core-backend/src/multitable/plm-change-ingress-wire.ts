import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalPlmEvent, plmId, plmSourceSchema } from './plm-wire'

const uuid = z.string().uuid().refine((value) => value === value.toLowerCase())
const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bom_line_writeback'), audit_id: uuid, bom_line_id: plmId }).strict(),
  z.object({ kind: z.literal('eco_batch_apply'), eco_id: plmId, target_version_id: plmId }).strict(),
])
const eventSchema = z.object({
  schema: z.literal('yuantus.plm-change-event.v1'),
  event_type: z.literal('bom.plm_change.applied'),
  event_id: uuid,
  binding_id: uuid,
  binding_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source: plmSourceSchema,
  change,
  occurred_at: z.string().datetime({ precision: 6, offset: false }),
}).strict()

export type PlmChangeEvent = z.infer<typeof eventSchema>
// A valid shape does not establish source, binding, token, or user authority.
export function parsePlmChangeEvent(value: unknown): PlmChangeEvent {
  return eventSchema.parse(value)
}
export function hashPlmChangeEvent(event: PlmChangeEvent): string {
  return createHash('sha256').update(canonicalPlmEvent(event), 'utf8').digest('hex')
}

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const plmChangePageRequestSchema = z.object({
  binding_id: uuid,
  binding_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source: plmSourceSchema,
  after_sequence: sequence.optional(),
}).strict()
export type PlmChangePageRequest = z.infer<typeof plmChangePageRequestSchema>
const pageSchema = z.object({
  schema: z.literal('yuantus.plm-change-page.v1'),
  source: plmSourceSchema,
  head_sequence: sequence,
  next_sequence: sequence,
  events: z.array(z.object({ sequence: sequence, event: eventSchema }).strict()).max(50),
}).strict()
export type PlmChangePage = z.infer<typeof pageSchema>
export function parsePlmChangePage(value: unknown, input: PlmChangePageRequest): PlmChangePage {
  const request = plmChangePageRequestSchema.parse(input)
  const page = pageSchema.parse(value)
  const sameSource = (source: PlmChangeEvent['source']) =>
    canonicalPlmEvent(source) === canonicalPlmEvent(request.source)
  if (!sameSource(page.source)) throw new Error('PLM page source mismatch')
  if (request.after_sequence === undefined) {
    if (page.events.length || page.next_sequence !== page.head_sequence) throw new Error('Invalid PLM baseline')
    return page
  }
  let cursor = request.after_sequence
  const ids = new Set<string>()
  for (const { sequence, event } of page.events) {
    if (sequence !== cursor + 1 || sequence > page.head_sequence || ids.has(event.event_id) ||
      !sameSource(event.source) || event.binding_id !== request.binding_id ||
      event.binding_version !== request.binding_version) throw new Error('Invalid PLM page event')
    cursor = sequence
    ids.add(event.event_id)
  }
  if (cursor > page.head_sequence || page.next_sequence !== cursor ||
    (!page.events.length && cursor !== page.head_sequence)) throw new Error('Invalid PLM page cursor')
  return page
}
