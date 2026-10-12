import { apiFetch } from '../../utils/api'

export const K3_B4_PREVIEW_FIELDS = ['FItemID', 'FNumber', 'FName', 'FModel', 'baseUnit'] as const
type PreviewCell = string | number | boolean | null
export interface K3B4Preview {
  rows: Array<Record<typeof K3_B4_PREVIEW_FIELDS[number], PreviewCell>>
  count: number
  capReached: boolean
}
export interface K3B4SyncSummary {
  state: 'off' | 'on_zero' | 'on_written'
  pages: number
  sourceRows: number
  created: number
  patched: number
  skipped: number
  runsCreated: number
  runsPatched: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function invalid(): never { throw new Error('K3_B4_RESPONSE_INVALID') }

// Exact configured-read/B4 runtime codes only; resolver, BOM and contract-route failures stay generic.
const PREVIEW_FAILURE_CODES = [
  'READ_SOURCE_PROBE_FAILED', 'READ_SOURCE_PROBE_AUTH_FAILED', 'READ_SOURCE_PROBE_CAP_REACHED',
  'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND', 'READ_SOURCE_PROBE_NETWORK_FAILED', 'READ_SOURCE_PROBE_REJECTED',
  'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'READ_SOURCE_PROBE_SHAPE_MISMATCH', 'READ_SOURCE_PROBE_TIMEOUT',
] as const
type PreviewFailureCode = typeof PREVIEW_FAILURE_CODES[number]

export class K3B4PreviewError extends Error {
  readonly code: PreviewFailureCode

  constructor(code: PreviewFailureCode) {
    super('K3_B4_READ_FAILED')
    this.name = 'K3B4PreviewError'
    this.code = code
  }
}

export function k3B4PreviewErrorCode(error: unknown): PreviewFailureCode | null {
  return error instanceof K3B4PreviewError && PREVIEW_FAILURE_CODES.some((code) => code === error.code)
    ? error.code : null
}

function previewFailureCode(value: Record<string, unknown>): PreviewFailureCode | null {
  const evidence = value.evidence
  if (value.data !== null || !record(evidence) || evidence.ok !== false
    || evidence.object !== 'material' || evidence.mode !== 'list_page' || evidence.boundedSmoke !== true) return null
  const code = PREVIEW_FAILURE_CODES.find((code) => code === evidence.errorCode)
  // failureOutcome omits success flags; only runtime timeouts add timeoutReached:true.
  // Reject contradictory or malformed flags rather than interpreting a success-shaped response as failure.
  if (!code || (evidence.boundedSmokeExecuted !== undefined && evidence.boundedSmokeExecuted !== false)
    || (evidence.capReached !== undefined && evidence.capReached !== false)
    || (evidence.recordCount !== undefined && evidence.recordCount !== 0)
    || (evidence.timeoutReached !== undefined && evidence.timeoutReached !== (code === 'READ_SOURCE_PROBE_TIMEOUT'))
    || (evidence.containerLocated !== undefined && (typeof evidence.containerLocated !== 'boolean'
      || !['READ_SOURCE_PROBE_CONTAINER_NOT_FOUND', 'READ_SOURCE_PROBE_SHAPE_MISMATCH'].includes(code)
      || evidence.containerLocated !== (code === 'READ_SOURCE_PROBE_SHAPE_MISMATCH')))) return null
  return code
}

async function responseData(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json()
  if (!response.ok || !record(payload) || payload.ok !== true || !record(payload.data)) invalid()
  return payload.data
}

function normalizePreview(value: Record<string, unknown>): K3B4Preview {
  const evidence = value.evidence
  const data = value.data
  if (!record(evidence) || !record(data) || evidence.ok !== true
    || evidence.object !== 'material' || evidence.mode !== 'list_page'
    || evidence.containerLocated !== true || evidence.boundedSmokeExecuted !== true
    || evidence.timeoutReached !== false || evidence.boundedSmoke !== true
    || !record(evidence.containers) || !record(evidence.containers.primary)
    || evidence.containers.primary.type !== 'array'
    || !record(data.containers) || !record(data.containers.primary)
    || !Array.isArray(data.containers.primary.records)) invalid()
  const rows = data.containers.primary.records
  if (rows.length > 10 || evidence.recordCount !== rows.length || data.recordCount !== rows.length
    || evidence.containers.primary.arrayLength !== rows.length
    || evidence.capReached !== (rows.length === 10)) invalid()
  // Session display budget: 4096 UTF-16 code units per cell, 65536 total; never silent truncation.
  let textLength = 0
  return {
    count: rows.length,
    capReached: evidence.capReached,
    rows: rows.map((row) => {
      if (!record(row)) invalid()
      return Object.fromEntries(K3_B4_PREVIEW_FIELDS.map((field) => {
        const cell = row[field] ?? null
        if (typeof cell !== 'string' && typeof cell !== 'boolean' && cell !== null
          && !(typeof cell === 'number' && Number.isFinite(cell))) invalid()
        if (typeof cell === 'string') {
          textLength += cell.length
          if (cell.length > 4096 || textLength > 65536) invalid()
        }
        return [field, cell]
      })) as K3B4Preview['rows'][number]
    }),
  }
}

const FALSE_EVIDENCE_FLAGS = [
  'sourceRowsTruncated', 'rawPayloadReturned', 'externalWriteExecuted', 'productionWrite',
  'k3SaveSubmitAudit', 'plmExternalWrite', 'rawSql', 'sourcePayloadRowsInEvidence',
  'privateConfigIdInEvidence', 'credentialsInEvidence', 'autoApply',
] as const

function normalizeSync(value: Record<string, unknown>): K3B4SyncSummary {
  const evidence = value.evidence
  if (value.sourceRun !== 'erp_material' || value.status !== 'ready' || !record(evidence)
    || evidence.sourceChannel !== 'erp_k3' || evidence.configReferenceUsed !== true
    || evidence.externalReadExecuted !== true || evidence.valuesFree !== true
    || FALSE_EVIDENCE_FLAGS.some((key) => evidence[key] !== false)
    || !count(evidence.pages) || evidence.pages < 1 || evidence.pages > 10
    || !count(evidence.sourceRows) || evidence.sourceRows < 1 || evidence.sourceRows > 100
    || !['short_page', 'declared_total'].includes(String(evidence.completenessProof))
    || typeof evidence.sourceTotalKnown !== 'boolean'
    || evidence.sourcePageSizeRequested !== 10 || !count(evidence.sourcePageSizeEffective)
    || evidence.sourcePageSizeEffective < 1 || evidence.sourcePageSizeEffective > 10
    || evidence.sourceRows > evidence.pages * evidence.sourcePageSizeEffective
    || evidence.sourceRows < (evidence.pages - 1) * evidence.sourcePageSizeEffective
    || (evidence.completenessProof === 'declared_total' && evidence.sourceTotalKnown !== true)
    || (evidence.completenessProof === 'short_page' && evidence.sourceRows === evidence.pages * evidence.sourcePageSizeEffective)
    || !record(evidence.intake) || evidence.intake.valuesFree !== true
    || !record(evidence.intake.result) || evidence.intake.result.erpMaterialRows !== evidence.sourceRows
    || evidence.intake.result.rowErrors !== 0) invalid()
  const summary: K3B4SyncSummary = {
    state: 'off', pages: evidence.pages, sourceRows: evidence.sourceRows,
    created: 0, patched: 0, skipped: 0, runsCreated: 0, runsPatched: 0,
  }
  if (value.mode === 'dry_run') {
    if (evidence.internalWriteExecuted !== false || Object.prototype.hasOwnProperty.call(value, 'autoPersist')) invalid()
    return summary
  }
  const auto = value.autoPersist
  if (value.mode !== 'internal_persist' || evidence.internalWriteExecuted !== true || !record(auto)
    || !record(auto.created) || !record(auto.patched) || !record(auto.skipped) || !record(auto.evidence)
    || typeof auto.persisted !== 'boolean') invalid()
  const proof = auto.evidence
  if (!count(auto.created.materials) || !count(auto.patched.materials) || !count(auto.skipped.materials)
    || !count(auto.created.run) || !count(auto.patched.run) || auto.created.run + auto.patched.run > 1
    || auto.created.materials + auto.patched.materials + auto.skipped.materials !== evidence.sourceRows
    || proof.valuesFree !== true || proof.runIdPresent !== true || proof.runType !== 'erp_material_sync'
    || proof.plannedMaterialCount !== evidence.sourceRows || proof.persisted !== auto.persisted
    || proof.mode !== auto.mode || proof.runStatus !== auto.runStatus
    || !record(proof.created) || !record(proof.patched) || !record(proof.skipped)
    || proof.created.materials !== auto.created.materials || proof.created.run !== auto.created.run
    || proof.patched.materials !== auto.patched.materials || proof.patched.run !== auto.patched.run
    || proof.skipped.materials !== auto.skipped.materials) invalid()
  const persisted = auto.created.materials + auto.patched.materials > 0
  const mode = auto.created.materials > 0 ? 'created' : auto.patched.materials > 0 ? 'refreshed' : 'skipped_empty'
  const runMode = auto.created.run ? 'created' : auto.patched.run ? 'patched' : 'unchanged'
  if (auto.persisted !== persisted || auto.mode !== mode || proof.runSyncMode !== runMode
    || auto.runStatus !== (auto.skipped.materials ? 'partial' : 'succeeded')) invalid()
  return {
    ...summary,
    state: persisted ? 'on_written' : 'on_zero',
    created: auto.created.materials, patched: auto.patched.materials, skipped: auto.skipped.materials,
    runsCreated: auto.created.run, runsPatched: auto.patched.run,
  }
}

export async function readK3B4Page(id: string, workspaceId?: string | null): Promise<K3B4Preview> {
  let value: Record<string, unknown>
  try {
    const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : ''
    const response = await apiFetch(`/api/integration/read-source-configs/${encodeURIComponent(id)}/read${query}`, {
      method: 'POST', omitHeaders: ['x-tenant-id'], suppressUnauthorizedRedirect: true,
      body: JSON.stringify({ inputs: {}, rowSource: 'adapter_records' }),
    })
    value = await responseData(response)
  } catch { throw new Error('K3_B4_READ_FAILED') }
  // Derive diagnostics only after transport and response parsing have settled successfully.
  // Even a constructed K3B4PreviewError thrown by fetch/json is flattened by the catch above.
  const code = previewFailureCode(value)
  if (code) throw new K3B4PreviewError(code)
  try { return normalizePreview(value) } catch { throw new Error('K3_B4_READ_FAILED') }
}

export async function syncK3B4Materials(id: string, syncRunId: string, workspaceId?: string | null): Promise<K3B4SyncSummary> {
  try {
    const response = await apiFetch('/api/integration/stock-preparation/mvp/source-runs/erp-materials', {
      method: 'POST', omitHeaders: ['x-tenant-id'], suppressUnauthorizedRedirect: true,
      body: JSON.stringify({ readSourceConfigId: id, ...(workspaceId ? { workspaceId } : {}), syncRunId, inputs: {} }),
    })
    return normalizeSync(await responseData(response))
  } catch { throw new Error('K3_B4_SYNC_RESULT_UNKNOWN') }
}
