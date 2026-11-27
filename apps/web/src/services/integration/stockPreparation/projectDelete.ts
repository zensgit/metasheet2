import { readAuthSessionSignature } from '../../../composables/authPrincipal'
import { apiFetch, authHeaders } from '../../../utils/api'
import type { IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'
import { invalidateStockPreparationOperatorHomeDirectory } from './operatorHomeDirectory'
import { forgetDeletedStockPrepProject } from './operatorHomeMemory'

const BASE = '/api/integration/stock-preparation'
const INVALID_RESPONSE = 'STOCK_PREPARATION_PROJECT_DELETE_RESPONSE_INVALID'
const projectDeleteEvents = new EventTarget()

interface StockPrepProjectDeleteCommit {
  projectNo: string
  scope: IntegrationScope
}

export function onStockPrepProjectDeleteCommitted(listener: (commit: StockPrepProjectDeleteCommit) => void): () => void {
  const receive = (event: Event) => listener((event as CustomEvent<StockPrepProjectDeleteCommit>).detail)
  projectDeleteEvents.addEventListener('committed', receive)
  return () => projectDeleteEvents.removeEventListener('committed', receive)
}

export function stockPrepProjectDeleteSession(scope: IntegrationScope): string | null {
  const signature = readAuthSessionSignature()
  if (signature === 'invalid') return null
  try {
    const tenant = authHeaders()['x-tenant-id']
    if (tenant && scope.tenantId && tenant !== scope.tenantId) return null
    return JSON.stringify([signature, tenant ?? null, scope.tenantId ?? null])
  } catch {
    return null
  }
}

export interface StockPrepDeleteTable {
  sheetId: string
  name: string
  kind: 'dedicated' | 'shared'
  rowCount: number
}

export interface StockPrepDeletePreview {
  tenantId: string
  projectNo: string
  tables: StockPrepDeleteTable[]
  counts: Record<string, number>
  challengeId: string
  verificationCode: string
  expiresAt: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isCounts(value: unknown): value is Record<string, number> {
  if (!isObject(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([key, count]) => /^[a-z][a-zA-Z]{0,63}$/.test(key) && isCount(count))
}

function isTable(value: unknown): value is StockPrepDeleteTable {
  return isObject(value) && typeof value.sheetId === 'string' && value.sheetId.length > 0
    && typeof value.name === 'string' && (value.kind === 'dedicated' || value.kind === 'shared')
    && isCount(value.rowCount)
}

function isPreview(value: unknown, projectNo: string): value is StockPrepDeletePreview {
  return isObject(value) && value.projectNo === projectNo
    && typeof value.tenantId === 'string' && value.tenantId.length > 0
    && Array.isArray(value.tables) && value.tables.every(isTable)
    && isCounts(value.counts)
    && typeof value.challengeId === 'string' && value.challengeId.length > 0
    && typeof value.verificationCode === 'string' && /^[A-F0-9]{8}$/.test(value.verificationCode)
    && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))
}

async function readDeleteResponse(response: Response): Promise<unknown> {
  if (!response.ok) return parseStockPreparationConfirmResponse<never>(response)
  const payload: unknown = await response.json()
  if (!isObject(payload) || payload.ok !== true) throw new Error(INVALID_RESPONSE)
  return payload.data
}

export async function readStockPrepProjectDeleteAccess(): Promise<boolean> {
  const response = await apiFetch(`${BASE}/project-delete/access`, { cache: 'no-store', suppressUnauthorizedRedirect: true })
  const data = await readDeleteResponse(response)
  return isObject(data) && data.mayDelete === true
}

async function postStockPrepProjectDelete(projectNo: string, action: 'preview' | 'confirm', body: object): Promise<unknown> {
  const response = await apiFetch(`${BASE}/projects/${encodeURIComponent(projectNo)}/delete/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
    cache: 'no-store',
    suppressUnauthorizedRedirect: true,
  })
  return readDeleteResponse(response)
}

export async function previewStockPrepProjectDelete(projectNo: string): Promise<StockPrepDeletePreview> {
  const data = await postStockPrepProjectDelete(projectNo, 'preview', {})
  if (!isPreview(data, projectNo)) throw new Error(INVALID_RESPONSE)
  return data
}

export async function confirmStockPrepProjectDelete(preview: StockPrepDeletePreview, code: string, scope: IntegrationScope): Promise<void> {
  const session = stockPrepProjectDeleteSession(scope)
  if (session === null) throw new Error(INVALID_RESPONSE)
  const data = await postStockPrepProjectDelete(preview.projectNo, 'confirm', { challengeId: preview.challengeId, code })
  if (!isObject(data) || data.projectNo !== preview.projectNo || data.tenantId !== preview.tenantId
    || !isCounts(data.counts) || typeof data.auditId !== 'string' || !data.auditId) {
    throw new Error(INVALID_RESPONSE)
  }
  invalidateStockPreparationOperatorHomeDirectory(scope)
  if (session !== stockPrepProjectDeleteSession(scope)) return
  forgetDeletedStockPrepProject(preview.projectNo, scope)
  // Notify the current workbench even if the confirmation dialog unmounted during the request.
  projectDeleteEvents.dispatchEvent(new CustomEvent<StockPrepProjectDeleteCommit>('committed', {
    detail: { projectNo: preview.projectNo, scope },
  }))
}
