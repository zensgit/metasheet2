import {
  fenceWriterEntriesInOrder,
  isWriterFenceEnabled,
  type FenceQuery,
} from './canonical-sheet-fence'
import { isFieldAlwaysReadOnly } from './permission-derivation'

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

  constructor(message = 'Link field configuration changed concurrently; retry the write') {
    super(message)
    this.name = 'LinkWriterFencePlanChangedError'
  }
}

export class RecordLinkFencePlanChangedError extends LinkWriterFencePlanChangedError {
  constructor() {
    super('Link relation participants changed concurrently; retry the write')
    this.name = 'RecordLinkFencePlanChangedError'
  }
}

function isLockNotAvailable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '55P03')
}

export type RecordLinkDeleteFencePlan = {
  owningSheetId: string
  recordId: string
  participantSheetIds: string[]
}

export type RecordLinkRestoreTargetInput = {
  fieldId: string
  recordIds: readonly string[]
}

type RecordLinkRestoreTargetGroup = {
  fieldId: string
  targetSheetId: string
  recordIds: string[]
}

export type RecordLinkRestoreFencePlan = {
  sourceSheetId: string
  deleteRevisionId: string | null
  candidateFieldIds: string[]
  fieldStates: LinkFieldFenceState[]
  writableLinkFieldIds: string[]
  outboundTargetGroups: RecordLinkRestoreTargetGroup[]
  inboundParticipantSheetIds: string[]
  participantSheetIds: string[]
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
): { fieldStates: LinkFieldFenceState[]; targetSheetIds: string[]; writableLinkFieldIds: string[] } {
  const rowById = new Map<string, Record<string, unknown>>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.id === 'string') rowById.set(row.id, row)
  }

  const targets = new Set<string>()
  const writableLinkFieldIds: string[] = []
  const fieldStates = candidateFieldIds.map((fieldId): LinkFieldFenceState => {
    const row = rowById.get(fieldId)
    if (!row) return 'missing'
    if (row.type !== 'link') return 'non-link'
    if (!isFieldAlwaysReadOnly({ type: 'link', property: normalizeProperty(row.property) })) {
      writableLinkFieldIds.push(fieldId)
    }
    const foreign = resolveForeignSheetId(row.property)
    if (foreign.kind === 'ambiguous') throw new LinkWriterFencePlanChangedError()
    if (foreign.kind === 'unconfigured') return 'link-unconfigured'
    targets.add(foreign.sheetId)
    return `link:${foreign.sheetId}`
  })

  return { fieldStates, targetSheetIds: [...targets].sort(), writableLinkFieldIds }
}

async function loadCandidateFieldStates(
  query: FenceQuery,
  sourceSheetId: string,
  candidateFieldIds: readonly string[],
  lockRows: boolean,
): Promise<{ fieldStates: LinkFieldFenceState[]; targetSheetIds: string[]; writableLinkFieldIds: string[] }> {
  if (candidateFieldIds.length === 0) {
    return { fieldStates: [], targetSheetIds: [], writableLinkFieldIds: [] }
  }
  const result = await query(
    `SELECT id, type, property
       FROM meta_fields
      WHERE sheet_id = $1 AND id = ANY($2::text[])
      ${lockRows ? 'FOR SHARE' : ''}`,
    [sourceSheetId, candidateFieldIds],
  )
  return buildFieldStates(candidateFieldIds, result.rows)
}

function fieldStatesMatch(
  expected: readonly LinkFieldFenceState[],
  current: readonly LinkFieldFenceState[],
): boolean {
  return expected.length === current.length && expected.every((state, index) => state === current[index])
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
  if (!fieldStatesMatch(plan.fieldStates, current.fieldStates)) {
    throw new LinkWriterFencePlanChangedError()
  }
}

async function loadInboundRestoreParticipantSheetIds(
  query: FenceQuery,
  deleteRevisionId: string,
): Promise<string[]> {
  const fieldOwners = await query(
    `SELECT f.sheet_id
       FROM meta_link_tombstones t
       JOIN meta_fields f ON f.id = t.field_id
      WHERE t.source_revision_id = $1 AND t.reason = 'record_delete'`,
    [deleteRevisionId],
  )
  const recordOwners = await query(
    `SELECT n.sheet_id
       FROM meta_link_tombstones t
       JOIN meta_records n ON n.id = t.record_id
      WHERE t.source_revision_id = $1 AND t.reason = 'record_delete'`,
    [deleteRevisionId],
  )
  const sheetIds = new Set<string>()
  for (const raw of [...fieldOwners.rows, ...recordOwners.rows]) {
    if (!raw || typeof raw !== 'object') continue
    const sheetId = (raw as Record<string, unknown>).sheet_id
    if (typeof sheetId === 'string' && sheetId.length > 0) sheetIds.add(sheetId)
  }
  return [...sheetIds].sort()
}

async function lockInboundRestoreParticipantRows(
  query: FenceQuery,
  deleteRevisionId: string,
  participantSheetIds: readonly string[],
): Promise<void> {
  try {
    await query(
      `SELECT 1
         FROM meta_link_tombstones t
         JOIN meta_fields f ON f.id = t.field_id
        WHERE t.source_revision_id = $1 AND t.reason = 'record_delete'
          AND f.sheet_id = ANY($2::text[])
        FOR SHARE OF f NOWAIT`,
      [deleteRevisionId, participantSheetIds],
    )
    await query(
      `SELECT 1
         FROM meta_link_tombstones t
         JOIN meta_records n ON n.id = t.record_id
        WHERE t.source_revision_id = $1 AND t.reason = 'record_delete'
          AND n.sheet_id = ANY($2::text[])
        FOR SHARE OF n NOWAIT`,
      [deleteRevisionId, participantSheetIds],
    )
  } catch (error) {
    if (isLockNotAvailable(error)) throw new RecordLinkFencePlanChangedError()
    throw error
  }
}

function canonicalRestoreTargets(
  targets: readonly RecordLinkRestoreTargetInput[],
): Array<{ fieldId: string; recordIds: string[] }> {
  const idsByField = new Map<string, Set<string>>()
  for (const target of targets) {
    if (typeof target.fieldId !== 'string' || target.fieldId.length === 0) continue
    const ids = idsByField.get(target.fieldId) ?? new Set<string>()
    for (const recordId of target.recordIds) {
      if (typeof recordId === 'string' && recordId.length > 0) ids.add(recordId)
    }
    if (ids.size > 0) idsByField.set(target.fieldId, ids)
  }
  return [...idsByField.entries()]
    .map(([fieldId, recordIds]) => ({ fieldId, recordIds: [...recordIds].sort() }))
    .sort((a, b) => a.fieldId.localeCompare(b.fieldId))
}

/**
 * Flag-on preflight for trash restore. Outbound targets come from the locked trash snapshot candidate,
 * while inbound participants come from the deletion's causal tombstone anchor. No query is issued when
 * the writer-fence flag is off.
 */
export async function prepareRecordLinkRestoreFencePlan(
  query: FenceQuery,
  input: {
    sourceSheetId: string
    deleteRevisionId: string | null
    candidateFieldIds: readonly string[]
    outboundTargets: readonly RecordLinkRestoreTargetInput[]
  },
): Promise<RecordLinkRestoreFencePlan | null> {
  if (!isWriterFenceEnabled()) return null
  const outboundTargets = canonicalRestoreTargets(input.outboundTargets)
  const candidateFieldIds = [...new Set([
    ...input.candidateFieldIds,
    ...outboundTargets.map(({ fieldId }) => fieldId),
  ])].filter((fieldId) => typeof fieldId === 'string' && fieldId.length > 0).sort()
  const loaded = await loadCandidateFieldStates(query, input.sourceSheetId, candidateFieldIds, false)
  const stateByFieldId = new Map(candidateFieldIds.map((fieldId, index) => [fieldId, loaded.fieldStates[index]]))
  const writableFieldIds = new Set(loaded.writableLinkFieldIds)
  const outboundTargetGroups = outboundTargets.map(({ fieldId, recordIds }) => {
    const state = stateByFieldId.get(fieldId)
    if (!state?.startsWith('link:') || !writableFieldIds.has(fieldId)) {
      throw new RecordLinkFencePlanChangedError()
    }
    return { fieldId, recordIds, targetSheetId: state.slice('link:'.length) }
  })
  const inboundParticipantSheetIds = input.deleteRevisionId
    ? await loadInboundRestoreParticipantSheetIds(query, input.deleteRevisionId)
    : []
  const participantSheetIds = [...new Set([
    input.sourceSheetId,
    ...loaded.targetSheetIds,
    ...inboundParticipantSheetIds,
  ])].sort()
  return {
    sourceSheetId: input.sourceSheetId,
    deleteRevisionId: input.deleteRevisionId,
    candidateFieldIds,
    fieldStates: loaded.fieldStates,
    writableLinkFieldIds: loaded.writableLinkFieldIds,
    outboundTargetGroups,
    inboundParticipantSheetIds,
    participantSheetIds,
  }
}

/** The trash row is locked after the participant fences. Its causal anchor and outbound IDs must still
 * match the preflight; otherwise the caller would restore a snapshot whose participants were never fenced. */
export function assertRecordLinkRestoreTrashStateCurrent(
  plan: RecordLinkRestoreFencePlan,
  input: {
    deleteRevisionId: string | null
    outboundTargets: readonly RecordLinkRestoreTargetInput[]
  },
): void {
  const current = canonicalRestoreTargets(input.outboundTargets)
  if (input.deleteRevisionId !== plan.deleteRevisionId || current.length !== plan.outboundTargetGroups.length) {
    throw new RecordLinkFencePlanChangedError()
  }
  for (let index = 0; index < current.length; index += 1) {
    const expected = plan.outboundTargetGroups[index]
    const actual = current[index]
    if (
      !expected || !actual || expected.fieldId !== actual.fieldId ||
      expected.recordIds.length !== actual.recordIds.length ||
      expected.recordIds.some((recordId, recordIndex) => recordId !== actual.recordIds[recordIndex])
    ) {
      throw new RecordLinkFencePlanChangedError()
    }
  }
}

/** Acquire every restore participant fence in one global order, then lock/re-read the definitions. Inbound
 * shrink is allowed because replay deliberately tolerates a missing neighbour/field; growth is unsafe because
 * the newly discovered sheet was not fenced. */
export async function enterRecordLinkRestoreFencePlan(
  query: FenceQuery,
  plan: RecordLinkRestoreFencePlan,
): Promise<void> {
  await fenceWriterEntriesInOrder(query, plan.participantSheetIds)
  const currentFields = await loadCandidateFieldStates(
    query,
    plan.sourceSheetId,
    plan.candidateFieldIds,
    true,
  )
  if (!fieldStatesMatch(plan.fieldStates, currentFields.fieldStates)) {
    throw new RecordLinkFencePlanChangedError()
  }
  if (
    plan.writableLinkFieldIds.length !== currentFields.writableLinkFieldIds.length ||
    plan.writableLinkFieldIds.some((fieldId, index) => fieldId !== currentFields.writableLinkFieldIds[index])
  ) {
    throw new RecordLinkFencePlanChangedError()
  }
  if (plan.deleteRevisionId) {
    const currentInbound = await loadInboundRestoreParticipantSheetIds(query, plan.deleteRevisionId)
    const fencedParticipants = new Set(plan.participantSheetIds)
    if (currentInbound.some((sheetId) => !fencedParticipants.has(sheetId))) {
      throw new RecordLinkFencePlanChangedError()
    }
    await lockInboundRestoreParticipantRows(query, plan.deleteRevisionId, plan.participantSheetIds)
  }
}

/** Run after the restored row INSERT so self-links are live. Target rows are locked until COMMIT and every
 * target must still belong to the sheet whose field definition supplied the fenced participant. */
export async function assertRecordLinkRestoreTargetsLive(
  query: FenceQuery,
  plan: RecordLinkRestoreFencePlan,
): Promise<void> {
  const recordIds = [...new Set(plan.outboundTargetGroups.flatMap(({ recordIds: ids }) => ids))].sort()
  if (recordIds.length === 0) return
  const targetSheetIds = [...new Set(plan.outboundTargetGroups.map(({ targetSheetId }) => targetSheetId))].sort()
  let result: Awaited<ReturnType<FenceQuery>>
  try {
    result = await query(
      `SELECT id, sheet_id
         FROM meta_records
        WHERE id = ANY($1::text[])
          AND sheet_id = ANY($2::text[])
        FOR SHARE NOWAIT`,
      [recordIds, targetSheetIds],
    )
  } catch (error) {
    if (isLockNotAvailable(error)) throw new RecordLinkFencePlanChangedError()
    throw error
  }
  const sheetByRecordId = new Map<string, string>()
  for (const raw of result.rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.id === 'string' && typeof row.sheet_id === 'string') {
      sheetByRecordId.set(row.id, row.sheet_id)
    }
  }
  for (const group of plan.outboundTargetGroups) {
    if (group.recordIds.some((recordId) => sheetByRecordId.get(recordId) !== group.targetSheetId)) {
      throw new RecordLinkFencePlanChangedError()
    }
  }
}

async function loadRecordLinkParticipantSheetIds(
  query: FenceQuery,
  owningSheetId: string,
  recordId: string,
): Promise<string[]> {
  const result = await query(
    `SELECT field_owner.sheet_id AS field_sheet_id,
            source_record.sheet_id AS source_sheet_id,
            target_record.sheet_id AS target_sheet_id
       FROM meta_links edge
       LEFT JOIN meta_fields field_owner ON field_owner.id = edge.field_id
       LEFT JOIN meta_records source_record ON source_record.id = edge.record_id
       LEFT JOIN meta_records target_record ON target_record.id = edge.foreign_record_id
      WHERE edge.record_id = $1 OR edge.foreign_record_id = $1`,
    [recordId],
  )
  const sheetIds = new Set<string>([owningSheetId])
  for (const raw of result.rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    for (const key of ['field_sheet_id', 'source_sheet_id', 'target_sheet_id'] as const) {
      const sheetId = row[key]
      if (typeof sheetId === 'string' && sheetId.length > 0) sheetIds.add(sheetId)
    }
  }
  return [...sheetIds].sort()
}

/**
 * Flag-on preflight for a record hard-delete. Every live edge touching the record contributes both its
 * source-owner and target sheet, because the delete removes the authoritative relation for both projections.
 * Flag off returns null before querying.
 */
export async function prepareRecordLinkDeleteFencePlan(
  query: FenceQuery,
  owningSheetId: string,
  recordId: string,
): Promise<RecordLinkDeleteFencePlan | null> {
  if (!isWriterFenceEnabled()) return null
  return {
    owningSheetId,
    recordId,
    participantSheetIds: await loadRecordLinkParticipantSheetIds(query, owningSheetId, recordId),
  }
}

/**
 * Re-read the participant set after every planned sheet fence is held. A newly committed edge from an
 * undiscovered sheet cannot be locked safely after this point without violating the global order, so drift
 * fails closed and the caller retries from a fresh preflight. Correctness also requires every live edge
 * writer to take both its source and target sheet fences before mutation: that shared target fence prevents
 * an edge from appearing after this re-read and before the caller captures/deletes the relation set.
 */
export async function assertRecordLinkDeleteFencePlanCurrent(
  query: FenceQuery,
  plan: RecordLinkDeleteFencePlan,
): Promise<void> {
  const current = await loadRecordLinkParticipantSheetIds(
    query,
    plan.owningSheetId,
    plan.recordId,
  )
  if (
    current.length !== plan.participantSheetIds.length ||
    current.some((sheetId, index) => sheetId !== plan.participantSheetIds[index])
  ) {
    throw new RecordLinkFencePlanChangedError()
  }
}

/** Acquire every participant fence in the canonical order, check every durable block, then prove the plan. */
export async function enterRecordLinkDeleteFencePlan(
  query: FenceQuery,
  plan: RecordLinkDeleteFencePlan,
): Promise<void> {
  await fenceWriterEntriesInOrder(query, plan.participantSheetIds)
  await assertRecordLinkDeleteFencePlanCurrent(query, plan)
}
