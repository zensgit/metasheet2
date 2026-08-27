import {
  fenceWriterEntriesInOrder,
  isWriterFenceEnabled,
  type FenceQuery,
} from './canonical-sheet-fence'

type LinkFieldFenceState = 'missing' | 'non-link' | 'link-unconfigured' | `link:${string}`

export type LinkWriterFencePlan = {
  sourceSheetId: string
  candidateFieldIds: string[]
  fieldStates: LinkFieldFenceState[]
  targetSheetIds: string[]
}

export class LinkWriterFencePlanChangedError extends Error {
  readonly code = 'LINK_WRITER_FENCE_PLAN_CHANGED'
  readonly statusCode = 409

  constructor() {
    super('Link field configuration changed concurrently; retry the write')
    this.name = 'LinkWriterFencePlanChangedError'
  }
}

export type LinkWriterFenceFieldGuard = {
  type?: unknown
  link?: { foreignSheetId?: unknown } | null
}

function normalizeProperty(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function resolveForeignSheetId(
  raw: unknown,
): { kind: 'resolved'; sheetId: string } | { kind: 'unconfigured' } | { kind: 'ambiguous' } {
  const property = normalizeProperty(raw)
  const aliases = [property.foreignSheetId, property.foreignDatasheetId, property.datasheetId]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const distinct = [...new Set(aliases)]
  if (distinct.length === 0) return { kind: 'unconfigured' }
  if (distinct.length > 1) return { kind: 'ambiguous' }
  return { kind: 'resolved', sheetId: distinct[0] }
}

function buildFieldStates(
  candidateFieldIds: readonly string[],
  rows: unknown[],
): { fieldStates: LinkFieldFenceState[]; targetSheetIds: string[] } {
  const rowById = new Map<string, Record<string, unknown>>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.id === 'string') rowById.set(row.id, row)
  }

  const targets = new Set<string>()
  const fieldStates = candidateFieldIds.map((fieldId): LinkFieldFenceState => {
    const row = rowById.get(fieldId)
    if (!row) return 'missing'
    if (row.type !== 'link') return 'non-link'
    const foreign = resolveForeignSheetId(row.property)
    if (foreign.kind === 'ambiguous') throw new LinkWriterFencePlanChangedError()
    if (foreign.kind === 'unconfigured') return 'link-unconfigured'
    targets.add(foreign.sheetId)
    return `link:${foreign.sheetId}`
  })

  return { fieldStates, targetSheetIds: [...targets].sort() }
}

async function loadCandidateFieldStates(
  query: FenceQuery,
  sourceSheetId: string,
  candidateFieldIds: readonly string[],
  lockRows: boolean,
): Promise<{ fieldStates: LinkFieldFenceState[]; targetSheetIds: string[] }> {
  if (candidateFieldIds.length === 0) return { fieldStates: [], targetSheetIds: [] }
  const result = await query(
    `SELECT id, type, property
       FROM meta_fields
      WHERE sheet_id = $1 AND id = ANY($2::text[])
      ${lockRows ? 'FOR SHARE' : ''}`,
    [sourceSheetId, candidateFieldIds],
  )
  return buildFieldStates(candidateFieldIds, result.rows)
}

/**
 * Flag-on preflight only. The candidate set comes from the write payload; target sheets come exclusively
 * from the current database field definitions. Flag off returns null without issuing a query.
 */
export async function prepareLinkWriterFencePlan(
  query: FenceQuery,
  sourceSheetId: string,
  candidateFieldIds: readonly string[],
): Promise<LinkWriterFencePlan | null> {
  if (!isWriterFenceEnabled()) return null
  const candidates = [...new Set(candidateFieldIds)]
    .filter((fieldId) => typeof fieldId === 'string' && fieldId.length > 0)
    .sort()
  const loaded = await loadCandidateFieldStates(query, sourceSheetId, candidates, false)
  return {
    sourceSheetId,
    candidateFieldIds: candidates,
    fieldStates: loaded.fieldStates,
    targetSheetIds: loaded.targetSheetIds,
  }
}

/**
 * RecordWriteService receives a caller-loaded field guard map. Prove that the exact field kind and target
 * it will execute still match the database-derived plan; otherwise a stale guard could fence sheet A while
 * materialising an edge whose target is sheet B.
 */
export function assertLinkWriterFencePlanMatchesFieldGuards(
  plan: LinkWriterFencePlan,
  fieldById: ReadonlyMap<string, LinkWriterFenceFieldGuard>,
): void {
  const expected = plan.candidateFieldIds.map((fieldId): LinkFieldFenceState => {
    const field = fieldById.get(fieldId)
    if (!field) return 'missing'
    if (field.type !== 'link') return 'non-link'
    const target = typeof field.link?.foreignSheetId === 'string'
      ? field.link.foreignSheetId.trim()
      : ''
    return target ? `link:${target}` : 'link-unconfigured'
  })
  if (
    expected.length !== plan.fieldStates.length ||
    expected.some((state, index) => state !== plan.fieldStates[index])
  ) {
    throw new LinkWriterFencePlanChangedError()
  }
}

/**
 * Enter the write transaction by fencing source and target sheets in one global order, checking every
 * durable block, then locking and re-reading the candidate field definitions. A changed plan aborts before
 * operation minting or any record/link write.
 */
export async function enterLinkWriterFencePlan(
  query: FenceQuery,
  plan: LinkWriterFencePlan,
  opts?: { bypassBlockCheck?: boolean },
): Promise<void> {
  await fenceWriterEntriesInOrder(
    query,
    [plan.sourceSheetId, ...plan.targetSheetIds],
    opts,
  )
  const current = await loadCandidateFieldStates(
    query,
    plan.sourceSheetId,
    plan.candidateFieldIds,
    true,
  )
  if (
    current.fieldStates.length !== plan.fieldStates.length ||
    current.fieldStates.some((state, index) => state !== plan.fieldStates[index])
  ) {
    throw new LinkWriterFencePlanChangedError()
  }
}
