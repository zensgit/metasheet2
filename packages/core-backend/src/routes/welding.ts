import express, { Router, type Request, type RequestHandler } from 'express'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { apiPathEquals, apiPathHasPrefix } from '../auth/api-path-policy'
import { WeldingError, readWeldingProvider, weldingJwks, weldingAvailable, weldingWriteAvailable } from '../integrations/welding/provider'
import { pythonWhitespace, sourceSafeId, weldingAuthority, weldingPlanDownload, weldingPlanRequest, weldingResourceDiagram, weldingResourceImport, WeldingResourceImportDomainError, type WeldingPlanOperation, type WeldingResourceImportOperation } from '../integrations/welding/client'

const PLAN_PREFIX = '/api/welding/plans'
const TEMPLATE_PATH = '/api/welding/render-templates'
const ARTIFACT_PREFIX = '/api/welding/artifacts'
const RESOURCE_PREFIX = '/api/welding/resources'
const RESOURCE_IMPORT_PREFIX = '/api/welding/resources/import'
const REFERENCE_CATALOG_PATH = '/api/welding/process-references/candidate-catalog'
const MAX_PLAN_BODY = 5 * 1024 * 1024
const MAX_RECOVERY_BODY = 13 * 1024 * 1024
const BINARY_TIMEOUT_MS = 5 * 60 * 1000
const IMPORT_MAX_BODY = 5 * 1024 * 1024

function invalid(): never { throw new WeldingError('WELDING_INVALID_REQUEST', 400) }
function safeId(encoded: string): string {
  let value: string
  try { value = decodeURIComponent(encoded) } catch { return invalid() }
  if (!value || Array.from(value).length > 64 || value.trim() !== value || /[\r\n\0/\\%]/.test(value) || value === '.' || value === '..') return invalid()
  return encodeURIComponent(value)
}
function safeGenerationId(encoded: string): string {
  const id = decodeURIComponent(safeId(encoded))
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return invalid()
  return id
}
const domainPath = (path: string) => apiPathHasPrefix(path, PLAN_PREFIX) || apiPathEquals(path, TEMPLATE_PATH) || apiPathHasPrefix(path, ARTIFACT_PREFIX) || apiPathHasPrefix(path, RESOURCE_PREFIX) || apiPathEquals(path, REFERENCE_CATALOG_PATH)

function createPlanId(body: Buffer): string {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { return invalid() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const planId = (value as Record<string, unknown>).plan_id
  if (typeof planId !== 'string') return invalid()
  try { safeId(encodeURIComponent(planId)) } catch { return invalid() }
  return planId
}

function validateReuseTargetId(body: Buffer): void {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { return }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const targetPlanId = (value as Record<string, unknown>).target_plan_id
  // Yuantus owns domain validation; only a supplied string target is checked for routeability.
  if (typeof targetPlanId !== 'string') return
  try { safeId(encodeURIComponent(targetPlanId)) } catch { invalid() }
}

function createResourceId(body: Buffer): string {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { return invalid() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const resourceId = (value as Record<string, unknown>).resource_id
  if (typeof resourceId !== 'string') return invalid()
  try { safeId(encodeURIComponent(resourceId)) } catch { return invalid() }
  return resourceId
}

function finiteQuery(req: Request, allowed: readonly string[], required: readonly string[] = [], maxLimit = 100, reuseSourceIds = false): string {
  const mark = req.originalUrl.indexOf('?')
  const raw = mark < 0 ? '' : req.originalUrl.slice(mark + 1)
  if (mark >= 0 && (!raw || raw.length > 2048 || raw.includes('#'))) return invalid()
  const result = new URLSearchParams()
  if (raw) for (const entry of raw.split('&')) {
    if (!entry || !entry.includes('=')) return invalid()
    for (const part of entry.split('=')) try { decodeURIComponent(part.replace(/\+/g, ' ')) } catch { return invalid() }
    const [key, value] = entry.split(/=(.*)/s, 2).map(part => decodeURIComponent(part.replace(/\+/g, ' ')))
    if (!allowed.includes(key) || result.has(key)) return invalid()
    if (key === 'limit' || key === 'offset') {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > (key === 'offset' ? Number.MAX_SAFE_INTEGER : allowed.includes('offset') ? maxLimit : 20) || (key === 'limit' && Number(value) < 1)) return invalid()
    } else if (key === 'query') {
      const chars = Array.from(value)
      if (!value || chars.length > 100 || /[\r\n\0]/.test(value) || (reuseSourceIds ?
        pythonWhitespace.test(chars[0]) || pythonWhitespace.test(chars[chars.length - 1]) : value.trim() !== value)) return invalid()
    } else if (key === 'purpose') {
      if (value !== 'review' && value !== 'final') return invalid()
    } else if (reuseSourceIds) {
      if (!sourceSafeId(value)) return invalid()
    } else {
      safeId(encodeURIComponent(value))
    }
    result.append(key, value)
  }
  if (required.some(key => !result.has(key))) return invalid()
  if (allowed.includes('product_id') && result.has('product_id') !== result.has('product_version_id')) return invalid()
  return result.size ? `?${result}` : ''
}

function catalogQuery(req: Request, type: 'resources' | 'versions' | 'documents'): { suffix: string; limit: number } {
  const mark = req.originalUrl.indexOf('?'), raw = mark < 0 ? '' : req.originalUrl.slice(mark + 1)
  if (mark >= 0 && (!raw || raw.length > 32768 || raw.includes('#'))) return invalid()
  const filters = ['kind', 'method', 'material_a', 'material_b', 'filler', 'joint_type',
    'thickness_a_value', 'thickness_a_unit', 'thickness_b_value', 'thickness_b_unit']
  const allowed = type === 'resources' ? [...filters, 'limit', 'cursor'] : type === 'versions' ? ['limit', 'cursor'] : ['query', 'cursor']
  const result = new URLSearchParams()
  if (raw) for (const entry of raw.split('&')) {
    if (!entry || !entry.includes('=')) return invalid()
    let key: string, value: string
    try { [key, value] = entry.split(/=(.*)/s, 2).map(part => decodeURIComponent(part.replace(/\+/g, ' '))) } catch { return invalid() }
    if (!allowed.includes(key) || result.has(key)) return invalid()
    if (key === 'cursor') {
      if (value.length > 4096 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(value)) return invalid()
      const prefix = value.slice(0, value.indexOf('.'))
      if (Buffer.from(prefix, 'base64url').toString('base64url') !== prefix) return invalid()
    } else if (key === 'limit') {
      if (!/^(?:[1-9]|1[0-9]|20)$/.test(value)) return invalid()
    } else if (key === 'kind') {
      if (!['wps', 'pqr', 'parameter_reference', 'requirements', 'material', 'filler', 'joint_diagram'].includes(value)) return invalid()
    } else if (key.endsWith('_value')) {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0) return invalid()
    } else if (key.endsWith('_unit')) {
      if (value !== 'mm' && value !== 'in') return invalid()
    } else if (key === 'query') {
      const chars = Array.from(value)
      if (!chars.length || chars.length > 100 || /[\r\n\0]/.test(value) || pythonWhitespace.test(chars[0]) || pythonWhitespace.test(chars.at(-1)!)) return invalid()
    } else if (Array.from(value).length > 256 || value.includes('\0')) return invalid()
    result.append(key, value)
  }
  if (type === 'documents' && !result.has('query')) return invalid()
  for (const side of ['a', 'b']) if (result.has(`thickness_${side}_value`) !== result.has(`thickness_${side}_unit`)) return invalid()
  return { suffix: result.size ? `?${result}` : '', limit: Number(result.get('limit') ?? 20) }
}

function importOperation(req: Request): WeldingResourceImportOperation | null {
  if (!apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) return null
  const template = /^\/api\/welding\/resources\/import\/templates\/(csv|xlsx)$/.exec(req.path)
  const preview = req.path === `${RESOURCE_IMPORT_PREFIX}/preview`
  const commit = req.path === `${RESOURCE_IMPORT_PREFIX}/commit`
  if (template && req.method === 'GET') {
    if (req.originalUrl.includes('?')) invalid()
    return { kind: 'template', format: template[1] as 'csv' | 'xlsx' }
  }
  if ((!preview && !commit) || req.method !== 'POST') return null
  const queryMark = req.originalUrl.indexOf('?')
  const raw = queryMark < 0 ? '' : req.originalUrl.slice(queryMark + 1)
  if (!raw || raw.length > 2048 || raw.includes('#')) invalid()
  const values = new Map<string, string>()
  for (const entry of raw.split('&')) {
    const parts = entry.split('=')
    if (parts.length !== 2 || !parts[0] || values.has(parts[0])) invalid()
    let value: string
    try { value = decodeURIComponent(parts[1].replace(/\+/g, ' ')) } catch { return invalid() }
    values.set(parts[0], value)
  }
  const keys = commit ? ['format', 'import_id', 'preview_digest'] : ['format']
  if (values.size !== keys.length || [...values.keys()].some(key => !keys.includes(key))) invalid()
  const format = values.get('format')
  if (format !== 'csv' && format !== 'xlsx') invalid()
  if (preview) return { kind: 'preview', format }
  const importId = values.get('import_id'), previewDigest = values.get('preview_digest')
  if (!sourceSafeId(importId) || !/^[0-9a-f]{64}$/.test(previewDigest || '')) invalid()
  return { kind: 'commit', format, importId, previewDigest }
}

function planOperation(req: Request): (WeldingPlanOperation & { maxBody: number }) | null {
  const path = req.path
  const method = req.method
  const operation = (suffix: string, result: WeldingPlanOperation['result'], write = false, maxBody = 0,
    ids: Pick<WeldingPlanOperation, 'planId' | 'versionId' | 'productId' | 'productVersionId' | 'changeId' | 'side' | 'contextId' | 'generationId' | 'purpose' | 'command' | 'fromVersionId' | 'toVersionId' | 'format' | 'resourceId' | 'resourceVersionId' | 'catalogLimit'> = {}): WeldingPlanOperation & { maxBody: number } =>
    ({ method: method as WeldingPlanOperation['method'], path: suffix, result, write, maxBody, ...ids })
  if (apiPathEquals(path, RESOURCE_PREFIX)) {
    if (method === 'POST') { finiteQuery(req, []); return operation('/resources', 'resource-record', true, MAX_PLAN_BODY) }
    return null
  }
  if (apiPathHasPrefix(path, RESOURCE_PREFIX)) {
    const relative = path.slice(RESOURCE_PREFIX.length)
    if (relative === '/catalog' || relative === '/catalog/') {
      if (method !== 'GET') return null
      const query = catalogQuery(req, 'resources')
      return operation('/resources/catalog' + query.suffix, 'resource-catalog', false, 0, { catalogLimit: query.limit })
    }
    const history = /^\/([^/]+)\/version-catalog\/?$/.exec(relative)
    if (history && method === 'GET') {
      const resourceId = safeId(history[1]), query = catalogQuery(req, 'versions')
      return operation(`/resources/${resourceId}/version-catalog` + query.suffix, 'resource-version-catalog', false, 0,
        { resourceId: decodeURIComponent(resourceId), catalogLimit: query.limit })
    }
    const diagram = /^\/([^/]+)\/versions\/([^/]+)\/diagram$/.exec(relative)
    if (diagram && method === 'GET') {
      finiteQuery(req, [])
      const resourceId = safeId(diagram[1]), resourceVersionId = safeId(diagram[2])
      return operation(`/resources/${resourceId}/versions/${resourceVersionId}/diagram`, 'resource-diagram', false, 0,
        { resourceId: decodeURIComponent(resourceId), resourceVersionId: decodeURIComponent(resourceVersionId) })
    }
    const detail = /^\/([^/]+)\/versions\/([^/]+)\/?$/.exec(relative)
    const revision = /^\/([^/]+)\/revisions\/?$/.exec(relative)
    if (detail && method === 'GET') {
      finiteQuery(req, [])
      const resourceId = safeId(detail[1]), resourceVersionId = safeId(detail[2])
      return operation(`/resources/${resourceId}/versions/${resourceVersionId}`, 'resource-record', false, 0,
        { resourceId: decodeURIComponent(resourceId), resourceVersionId: decodeURIComponent(resourceVersionId) })
    }
    if (revision && method === 'POST') {
      finiteQuery(req, [])
      const resourceId = safeId(revision[1])
      return operation(`/resources/${resourceId}/revisions`, 'resource-record', true, MAX_PLAN_BODY,
        { resourceId: decodeURIComponent(resourceId) })
    }
    return null
  }
  if (apiPathEquals(path, REFERENCE_CATALOG_PATH)) {
    if (method !== 'GET') return null
    const query = catalogQuery(req, 'documents')
    return operation('/process-references/candidate-catalog' + query.suffix, 'reference-catalog', false, 0, { catalogLimit: 20 })
  }
  if (apiPathEquals(path, TEMPLATE_PATH)) {
    if (method === 'GET') return operation('/render-templates' + finiteQuery(req, []), 'templates')
    return null
  }
  if (apiPathHasPrefix(path, ARTIFACT_PREFIX)) {
    const relative = path.slice(ARTIFACT_PREFIX.length)
    const file = /^\/([^/]+)\/files\/(pdf|docx)\/?$/.exec(relative)
    if (file) {
      const generationId = safeGenerationId(file[1]), format = file[2].toLowerCase() as 'pdf' | 'docx'
      if (method !== 'GET') return null
      finiteQuery(req, [])
      return operation(`/artifacts/${generationId}/files/${format}`, 'generation-file', false, 0, { generationId, format })
    }
    const artifact = /^\/([^/]+)(\/retry)?\/?$/i.exec(relative)
    if (!artifact) return null
    const generationId = safeGenerationId(artifact[1])
    const target = `/artifacts/${generationId}`
    if (!artifact[2] && method === 'GET') return operation(target + finiteQuery(req, []), 'generation-status', false, 0, { generationId })
    if (artifact[2] && method === 'POST') { finiteQuery(req, []); return operation(target + '/retry', 'generation-retry', true, MAX_PLAN_BODY, { generationId }) }
    return null
  }
  if (apiPathEquals(path, PLAN_PREFIX)) {
    if (method === 'GET') return operation('/plans' + finiteQuery(req, ['limit', 'offset', 'product_id', 'product_version_id']), 'list')
    if (method === 'POST') { finiteQuery(req, []); return operation('/plans', 'record', true, MAX_PLAN_BODY) }
    return null
  }
  if (!apiPathHasPrefix(path, PLAN_PREFIX)) return null
  const relative = path.slice(PLAN_PREFIX.length)
  const publicationFile = /^\/([^/]+)\/versions\/([^/]+)\/publication\/files\/(pdf|docx)\/?$/.exec(relative)
  if (publicationFile) {
    const safePlanId = safeId(publicationFile[1]), safeVersionId = safeId(publicationFile[2])
    const format = publicationFile[3].toLowerCase() as 'pdf' | 'docx'
    if (method !== 'GET') return null
    finiteQuery(req, [])
    return operation(`/plans/${safePlanId}/versions/${safeVersionId}/publication/files/${format}`, 'publication-file', false, 0,
      { planId: decodeURIComponent(safePlanId), versionId: decodeURIComponent(safeVersionId), format })
  }
  const official = /^\/([^/]+)\/(publications|publication-comparison)\/?$/i.exec(relative)
  if (official) {
    const safePlanId = safeId(official[1]), planId = decodeURIComponent(safePlanId)
    const name = official[2].toLowerCase()
    if (method !== 'GET') return null
    if (name === 'publications') return operation(`/plans/${safePlanId}/publications${finiteQuery(req, ['limit', 'offset'], [], 50)}`,
      'publication-directory', false, 0, { planId })
    const query = finiteQuery(req, ['from_version_id', 'to_version_id'], ['from_version_id', 'to_version_id'])
    const params = new URLSearchParams(query.slice(1))
    return operation(`/plans/${safePlanId}/publication-comparison${query}`, 'publication-comparison', false, 0,
      { planId, fromVersionId: params.get('from_version_id')!, toVersionId: params.get('to_version_id')! })
  }
  const reuse = /^\/([^/]+)\/versions\/([^/]+)\/(reuse|reuse-receipts\/resolve|reuse-provenance)\/?$/.exec(relative)
  if (reuse) {
    const safePlanId = safeId(reuse[1]), safeVersionId = safeId(reuse[2]), name = reuse[3]
    finiteQuery(req, [])
    const ids = { planId: decodeURIComponent(safePlanId), versionId: decodeURIComponent(safeVersionId) }
    const target = `/plans/${safePlanId}/versions/${safeVersionId}/${name}`
    if (name === 'reuse-provenance') return method === 'GET' ? operation(target, 'reuse-provenance', false, 0, ids) : null
    if (method !== 'POST') return null
    return operation(target, name === 'reuse' ? 'reuse-ack' : 'reuse-resolution', name === 'reuse', MAX_PLAN_BODY, ids)
  }
  const workflow = /^\/([^/]+)\/versions\/([^/]+)\/(review-state|review-history|publication|submit|review|withdraw|reopen|validate|final-renders|release|revise|workflow-receipts\/resolve)\/?$/i.exec(relative)
  if (workflow) {
    const safePlanId = safeId(workflow[1]), safeVersionId = safeId(workflow[2])
    const planId = decodeURIComponent(safePlanId), versionId = decodeURIComponent(safeVersionId)
    const name = workflow[3].toLowerCase()
    const target = `/plans/${safePlanId}/versions/${safeVersionId}/${name}`
    const ids = { planId, versionId, command: name }
    if (method === 'GET') {
      if (name === 'review-state' || name === 'publication') return operation(target + finiteQuery(req, []), name === 'review-state' ? 'workflow-state' : 'publication', false, 0, ids)
      if (name === 'review-history') return operation(target + finiteQuery(req, ['limit', 'offset']), 'workflow-history', false, 0, ids)
      return null
    }
    if (method !== 'POST' || ['review-state', 'review-history', 'publication'].includes(name)) return null
    finiteQuery(req, [])
    const result = name === 'validate' ? 'workflow-validate' : name === 'workflow-receipts/resolve' ? 'workflow-resolution' :
      name === 'final-renders' ? 'workflow-final' : name === 'revise' ? 'workflow-revision' : 'workflow-ack'
    return operation(target, result, name !== 'validate' && name !== 'workflow-receipts/resolve', MAX_PLAN_BODY, ids)
  }
  const renders = /^\/([^/]+)\/versions\/([^/]+)\/renders\/?$/i.exec(relative)
  if (renders) {
    const safePlanId = safeId(renders[1]), safeVersionId = safeId(renders[2])
    const planId = decodeURIComponent(safePlanId), versionId = decodeURIComponent(safeVersionId)
    const target = `/plans/${safePlanId}/versions/${safeVersionId}/renders`
    if (method === 'GET') {
      const query = finiteQuery(req, ['limit', 'offset', 'purpose'])
      return operation(target + query, 'generation-list', false, 0, { planId, versionId, purpose: new URLSearchParams(query.slice(1)).get('purpose') || 'review' })
    }
    if (method === 'POST') { finiteQuery(req, []); return operation(target, 'generation-create', true, MAX_PLAN_BODY, { planId, versionId }) }
    return null
  }
  const reuseSelection = /^\/(reuse-product-candidates|reuse-product-context|reuse-bom-candidates)$/.exec(relative)
  if (reuseSelection) {
    if (method !== 'GET') return null
    const name = reuseSelection[1] as 'reuse-product-candidates' | 'reuse-product-context' | 'reuse-bom-candidates'
    const fields = name === 'reuse-product-candidates' ? ['query', 'limit'] : ['product_id', 'product_version_id']
    const query = finiteQuery(req, fields, name === 'reuse-product-candidates' ? ['query'] : fields, 100, true)
    const params = new URLSearchParams(query.slice(1))
    const ids = name === 'reuse-product-context' ? { productId: params.get('product_id')!, productVersionId: params.get('product_version_id')! } : {}
    return operation(`/plans/${name}${query}`, name, false, 0, ids)
  }
  const named = /^\/(product-context|product-candidates|drawing-candidates|bom-candidates|recovery-authority)\/?$/i.exec(relative)
  if (named) {
    const name = named[1].toLowerCase()
    if (name === 'recovery-authority' && method === 'POST') { finiteQuery(req, []); return operation('/plans/recovery-authority', 'recovery', false, MAX_RECOVERY_BODY) }
    if (method !== 'GET') return null
    const fields = name === 'product-context' || name === 'bom-candidates' ? ['product_id', 'product_version_id'] : name === 'recovery-authority' ? [] : ['query', 'limit']
    const required = name === 'recovery-authority' ? [] : name === 'product-context' || name === 'bom-candidates' ? fields : ['query']
    const query = finiteQuery(req, fields, required)
    const params = new URLSearchParams(query.slice(1))
    const ids = name === 'product-context' || name === 'bom-candidates' ? { productId: params.get('product_id')!, productVersionId: params.get('product_version_id')! } : {}
    return operation(`/plans/${name}${query}`, name === 'recovery-authority' ? 'recovery' : name === 'product-context' ? 'product-context' : name === 'bom-candidates' ? 'bom-candidates' : 'candidates', false, 0, ids)
  }
  const assembly = /^\/([^/]+)\/versions\/([^/]+)\/(assembly-preview|assembly-apply)$/.exec(relative)
  if (assembly) {
    if (method !== 'POST') return null
    finiteQuery(req, [])
    const planId = safeId(assembly[1]), versionId = safeId(assembly[2])
    const result = assembly[3] as 'assembly-preview' | 'assembly-apply'
    return operation(`/plans/${planId}/versions/${versionId}/${result}`, result, result === 'assembly-apply', MAX_PLAN_BODY,
      { planId: decodeURIComponent(planId), versionId: decodeURIComponent(versionId) })
  }
  const extended = /^\/([^/]+)\/versions\/([^/]+)\/(source-review|source-changes|source-change-preparations|cad-contexts)(?:\/([^/]+))?(?:\/documents\/(before|after))?\/?$/i.exec(relative)
  if (extended) {
    const target = `/plans/${safeId(extended[1])}/versions/${safeId(extended[2])}`
    const ids = { planId: decodeURIComponent(extended[1]), versionId: decodeURIComponent(extended[2]),
      ...(extended[4] ? { changeId: decodeURIComponent(extended[4]), contextId: decodeURIComponent(extended[4]) } : {}),
      ...(extended[5] ? { side: extended[5].toLowerCase() } : {}) }
    const name = extended[3].toLowerCase()
    if (name === 'source-review' && !extended[4] && !extended[5] && method === 'GET')
      return operation(`${target}/source-review${finiteQuery(req, ['limit', 'offset'])}`, 'source-review', false, 0, ids)
    if (name === 'source-changes' && method === 'GET') {
      if (!extended[4] && !extended[5]) return operation(`${target}/source-changes${finiteQuery(req, ['limit', 'offset'])}`, 'source-changes', false, 0, ids)
      if (extended[4]) {
        const change = `${target}/source-changes/${safeId(extended[4])}`
        if (!extended[5]) return operation(change + finiteQuery(req, []), 'source-change', false, 0, ids)
        return operation(`${change}/documents/${extended[5].toLowerCase()}${finiteQuery(req, [])}`, 'source-document', false, 0, ids)
      }
    }
    if (name === 'source-change-preparations' && !extended[4] && !extended[5] && method === 'POST') {
      finiteQuery(req, []); return operation(`${target}/source-change-preparations`, 'source-preparation', true, MAX_PLAN_BODY, ids)
    }
    if (name === 'source-change-preparations' && extended[4] && !extended[5] && method === 'GET') {
      finiteQuery(req, []); return operation(`${target}/source-change-preparations/${safeId(extended[4])}`, 'source-preparation', false, 0, ids)
    }
    if (name === 'cad-contexts' && !extended[5]) {
      if (!extended[4] && method === 'POST') { finiteQuery(req, []); return operation(`${target}/cad-contexts`, 'cad-context', true, MAX_PLAN_BODY, ids) }
      if (extended[4] && (method === 'GET' || method === 'DELETE')) {
        finiteQuery(req, []); return operation(`${target}/cad-contexts/${safeId(extended[4])}`, method === 'DELETE' ? 'empty' : 'cad-context', method === 'DELETE', 0, ids)
      }
    }
    return null
  }
  const detail = /^\/([^/]+)\/versions\/([^/]+)(\/draft)?\/?$/i.exec(relative)
  if (!detail) return null
  const target = `/plans/${safeId(detail[1])}/versions/${safeId(detail[2])}`
  const ids = { planId: decodeURIComponent(detail[1]), versionId: decodeURIComponent(detail[2]) }
  if (!detail[3] && method === 'GET') return operation(target + finiteQuery(req, []), 'record', false, 0, ids)
  if (detail[3] && method === 'PUT') { finiteQuery(req, []); return operation(target + '/draft', 'record', true, MAX_PLAN_BODY, ids) }
  return null
}

function failure(res: Parameters<RequestHandler>[1], error: unknown) {
  const failure = error instanceof WeldingError ? error : new WeldingError('WELDING_UNAVAILABLE', 503)
  return res.status(failure.status).json({ error: { code: failure.code,
    ...(failure instanceof WeldingResourceImportDomainError && failure.safeMessage !== undefined ? { message: failure.safeMessage, issues: failure.issues } : {}) } })
}

// Before the global session gate: OFF does no auth IO and even gate failures are no-store.
export const weldingPreflight: RequestHandler = (req, res, next) => {
  const identity = ['/api/welding/jwks', '/api/welding/authority'].some(path => apiPathEquals(req.path, path))
  const plans = domainPath(req.path)
  if (!identity && !plans) return next()
  res.setHeader('Cache-Control', 'no-store')
  if (apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    weldingAvailable()
    if (identity) {
      if (req.method !== 'GET' || req.originalUrl.includes('?') || (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) invalid()
    } else {
      if (apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) {
        const operation = importOperation(req)
        if (!operation) invalid()
        if (operation.kind === 'commit') weldingWriteAvailable()
        if (operation.kind === 'template') {
          if (req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0') invalid()
        } else {
          if (req.headers['content-encoding'] || !/^application\/octet-stream(?:\s*;.*)?$/i.test(req.headers['content-type'] || '') ||
            req.headers['content-length'] && !/^(0|[1-9]\d*)$/.test(req.headers['content-length'])) invalid()
          if (req.headers['content-length'] && Number(req.headers['content-length']) > IMPORT_MAX_BODY)
            throw new WeldingError('WELDING_INVALID_REQUEST', 413)
        }
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort()
          if (!res.locals.weldingImportDispatching && !res.headersSent && !res.destroyed)
            failure(res, new WeldingError('WELDING_UPSTREAM_REJECTED', 502))
        }, BINARY_TIMEOUT_MS)
        res.locals.weldingImportSignal = controller.signal
        res.once('close', () => { clearTimeout(timer); controller.abort() })
        next()
        return
      }
      const operation = planOperation(req)
      if (!operation) invalid()
      if (operation.write) weldingWriteAvailable()
      if (operation.maxBody) {
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity' ||
          req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
          req.headers['content-length'] && !/^\d+$/.test(req.headers['content-length'])) invalid()
        if (req.headers['content-length'] && Number(req.headers['content-length']) > operation.maxBody) throw new WeldingError('WELDING_INVALID_REQUEST', 413)
      } else if (req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0') invalid()
    }
    next()
  } catch (error) {
    failure(res, error)
  }
}

const planBody = express.raw({ type: () => true, inflate: false, limit: MAX_PLAN_BODY })
const recoveryBody = express.raw({ type: () => true, inflate: false, limit: MAX_RECOVERY_BODY })
const importBody = express.raw({ type: () => true, inflate: false, limit: IMPORT_MAX_BODY })
export const weldingPlanRawBody: RequestHandler = (req, res, next) => {
  if (!domainPath(req.path)) return next()
  if (apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) {
    let operation: WeldingResourceImportOperation | null
    try { operation = importOperation(req) } catch (error) { failure(res, error); return }
    if (!operation || operation.kind === 'template') return next()
    importBody(req, res, error => {
      if (res.locals.weldingImportSignal?.aborted || res.headersSent) return
      if (error) { failure(res, new WeldingError('WELDING_INVALID_REQUEST', error.type === 'entity.too.large' ? 413 : 400)); return }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > IMPORT_MAX_BODY) {
        failure(res, new WeldingError('WELDING_INVALID_REQUEST', 400)); return
      }
      next()
    })
    return
  }
  let operation: ReturnType<typeof planOperation>
  try { operation = planOperation(req) } catch (error) { failure(res, error); return }
  if (!operation?.maxBody) return next()
  const parser = operation.maxBody === MAX_RECOVERY_BODY ? recoveryBody : planBody
  parser(req, res, error => {
    if (error) { failure(res, new WeldingError('WELDING_INVALID_REQUEST', error.type === 'entity.too.large' ? 413 : 400)); return }
    if (operation.method === 'POST' && operation.path === '/plans') {
      try { res.locals.weldingCreatePlanId = createPlanId(req.body) } catch (error) { failure(res, error); return }
    }
    if (operation.method === 'POST' && operation.path === '/resources') {
      try { res.locals.weldingCreateResourceId = createResourceId(req.body) } catch (error) { failure(res, error); return }
    }
    if (operation.result === 'reuse-ack') {
      try { validateReuseTargetId(req.body) } catch (error) { failure(res, error); return }
    }
    next()
  })
}

export function weldingRouter(): Router {
  const router = Router()
  router.get('/api/welding/jwks', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(await weldingJwks(readWeldingProvider())) } catch (error) { failure(res, error) }
  })
  router.get('/api/welding/authority', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const header = req.headers.authorization || ''
      if (!header.startsWith('Bearer ') || header.length > 16391) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
      res.json(await weldingAuthority(readWeldingProvider(), header.slice(7), req.authenticatedTenantId))
    } catch (error) { failure(res, error) }
  })
  router.use(async (req, res, next) => {
    if (!domainPath(req.path)) return next()
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) {
        res.setHeader('X-Content-Type-Options', 'nosniff')
        const operation = importOperation(req)
        if (!operation) invalid()
        if (operation.kind === 'commit') weldingWriteAvailable()
        if (operation.kind !== 'template') {
          if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > IMPORT_MAX_BODY) invalid()
          operation.body = req.body
        }
        const header = req.headers.authorization || ''
        if (!header.startsWith('Bearer ') || header.length > 16391) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
        const signal = res.locals.weldingImportSignal as AbortSignal
        if (signal.aborted || res.destroyed) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
        res.locals.weldingImportDispatching = true
        const result = await weldingResourceImport(readWeldingProvider(), header.slice(7), req.authenticatedTenantId, operation, signal)
        if (signal.aborted || res.destroyed) throw new WeldingError(operation.kind === 'commit' ? 'WELDING_RESULT_UNKNOWN' : 'WELDING_UPSTREAM_REJECTED', 502)
        res.status(result.status).setHeader('Content-Type', result.mime)
        res.setHeader('Content-Length', String(result.body.length))
        if (result.disposition) res.setHeader('Content-Disposition', result.disposition)
        res.end(result.body)
        return
      }
      const operation = planOperation(req)
      if (!operation) invalid()
      if (operation.write) weldingWriteAvailable()
      const header = req.headers.authorization || ''
      if (!header.startsWith('Bearer ') || header.length > 16391) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
      if (operation.maxBody) {
        if (!Buffer.isBuffer(req.body) || req.body.length > operation.maxBody) invalid()
        operation.body = req.body
      }
      if (operation.method === 'POST' && operation.path === '/plans') {
        if (typeof res.locals.weldingCreatePlanId !== 'string') invalid()
        operation.planId = res.locals.weldingCreatePlanId
      }
      if (operation.method === 'POST' && operation.path === '/resources') {
        if (typeof res.locals.weldingCreateResourceId !== 'string') invalid()
        operation.resourceId = res.locals.weldingCreateResourceId
      }
      if (operation.result === 'resource-diagram') {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), BINARY_TIMEOUT_MS)
        const onClose = () => { if (!res.writableFinished) controller.abort() }
        res.once('close', onClose)
        try {
          const diagram = await weldingResourceDiagram(readWeldingProvider(), header.slice(7), req.authenticatedTenantId, operation, controller.signal)
          if (controller.signal.aborted || res.destroyed) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
          res.status(200)
          res.setHeader('Content-Type', diagram.mime)
          res.setHeader('Content-Length', String(diagram.body.length))
          res.setHeader('X-Content-SHA256', diagram.sha256)
          res.setHeader('Content-Disposition', 'inline')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.end(diagram.body)
        } finally { clearTimeout(timer); res.off('close', onClose) }
        return
      }
      if (operation.result === 'generation-file' || operation.result === 'publication-file') {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), BINARY_TIMEOUT_MS)
        const onClose = () => { if (!res.writableFinished) controller.abort() }
        res.once('close', onClose)
        try {
          const download = await weldingPlanDownload(readWeldingProvider(), header.slice(7), req.authenticatedTenantId, operation, controller.signal)
          try {
            if (controller.signal.aborted) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
            res.status(200)
            res.setHeader('Content-Type', download.mime)
            res.setHeader('Content-Length', String(download.byteSize))
            res.setHeader('X-Artifact-SHA256', download.sha256)
            res.setHeader('Content-Disposition', `attachment; filename="welding-${operation.result === 'generation-file' ? 'artifact' : 'publication'}.${download.format}"`)
            res.setHeader('X-Content-Type-Options', 'nosniff')
            await pipeline(createReadStream(download.path), res, { signal: controller.signal })
          } finally { await download.cleanup() }
        } finally { clearTimeout(timer); res.off('close', onClose) }
        return
      }
      const result = await weldingPlanRequest(readWeldingProvider(), header.slice(7), req.authenticatedTenantId, operation)
      if (result.status === 204) res.status(204).end()
      else res.status(result.status).type('application/json').send(result.body)
    } catch (error) {
      if (!res.destroyed && !res.headersSent) failure(res, error)
      else if (!res.destroyed) res.destroy()
    }
  })
  return router
}
