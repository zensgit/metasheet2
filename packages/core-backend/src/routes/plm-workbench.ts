import type { Request, Response } from 'express'
import { Router } from 'express'
import { Logger } from '../core/logger'
import { db } from '../db/db'
import { query as pgQuery } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { validate } from '../middleware/validation'
import {
  buildPlmTeamFilterPresetDuplicateName,
  buildPlmTeamFilterPresetValues,
  mapPlmTeamFilterPresetRow,
  normalizePlmTeamFilterPresetKind,
  normalizePlmTeamFilterPresetName,
  normalizePlmTeamFilterPresetNameKey,
  type PlmTeamFilterPresetRowLike,
} from '../plm/plmTeamFilterPresets'
import {
  buildPlmWorkbenchTeamViewDuplicateName,
  buildPlmWorkbenchTeamViewValues,
  mapPlmWorkbenchTeamViewRow,
  normalizePlmWorkbenchTeamViewDefaultFlag,
  normalizePlmWorkbenchTeamViewKind,
  normalizePlmWorkbenchTeamViewNameKey,
  normalizePlmWorkbenchTeamViewName,
  type PlmWorkbenchTeamViewRowLike,
} from '../plm/plmWorkbenchTeamViews'
import { loadValidators } from '../types/validator'
import { parsePagination } from '../util/response'

// Typed wrapper for temporary tables not yet in main Database interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any

const { body, param, query } = loadValidators()
const router = Router()
const logger = new Logger('PlmWorkbenchAPI')

interface PlmTeamPresetConflictBuilder {
  columns(columns: string[]): {
    doUpdateSet(values: Record<string, unknown>): unknown
  }
}

interface PlmWorkbenchTeamViewConflictBuilder {
  columns(columns: string[]): {
    doUpdateSet(values: Record<string, unknown>): unknown
  }
}

type PlmTeamPresetBatchAction = 'archive' | 'restore' | 'delete'
type PlmTeamViewBatchAction = 'archive' | 'restore' | 'delete'
type PlmTeamPresetDefaultAuditAction = 'set-default' | 'clear-default'
type PlmTeamViewDefaultAuditAction = 'set-default' | 'clear-default'
type PlmTeamViewLifecycleAuditAction = 'archive' | 'restore' | 'delete'
type PlmTeamPresetLifecycleAuditAction = 'archive' | 'restore' | 'delete'
type PlmCollaborativeAuditResourceType =
  | 'plm-team-preset-batch'
  | 'plm-team-preset-default'
  | 'plm-team-view-batch'
  | 'plm-team-view-default'
const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PLM_COLLABORATIVE_AUDIT_RESOURCE_TYPES: PlmCollaborativeAuditResourceType[] = [
  'plm-team-preset-batch',
  'plm-team-preset-default',
  'plm-team-view-batch',
  'plm-team-view-default',
]

type PlmCollaborativeAuditAction =
  | PlmTeamPresetBatchAction
  | PlmTeamViewBatchAction
  | PlmTeamPresetDefaultAuditAction
  | PlmTeamViewDefaultAuditAction

interface PlmCollaborativeAuditEntry {
  id: string
  actorId: string | null
  actorType: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  requestId: string | null
  ip: string | null
  userAgent: string | null
  occurredAt: string
  meta: Record<string, unknown>
}

interface PlmCollaborativeAuditWhereParams {
  q?: string
  actorId?: string
  action?: PlmCollaborativeAuditAction | null
  resourceType?: PlmCollaborativeAuditResourceType | null
  kind?: string
  from?: string | null
  to?: string | null
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'undefined') return undefined
  return normalizePlmWorkbenchTeamViewDefaultFlag(value)
}

function normalizePlmTeamPresetBatchAction(value: unknown): PlmTeamPresetBatchAction | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'archive' || normalized === 'restore' || normalized === 'delete') {
    return normalized
  }
  return null
}

function normalizePlmTeamPresetBatchIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

function normalizePlmTeamViewBatchAction(value: unknown): PlmTeamViewBatchAction | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'archive' || normalized === 'restore' || normalized === 'delete') {
    return normalized
  }
  return null
}

function normalizePlmCollaborativeBatchIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

function splitQueryableUuidIds(ids: string[]) {
  const queryableIds: string[] = []
  const invalidIds: string[] = []

  ids.forEach((id) => {
    if (UUID_LIKE_PATTERN.test(id)) {
      queryableIds.push(id)
      return
    }
    invalidIds.push(id)
  })

  return {
    queryableIds,
    invalidIds,
  }
}

function splitQueryablePlmTeamPresetIds(ids: string[]) {
  return splitQueryableUuidIds(ids)
}

function splitQueryablePlmTeamViewIds(ids: string[]) {
  return splitQueryableUuidIds(ids)
}

function parsePlmAuditDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function normalizePlmAuditResourceType(value: unknown): PlmCollaborativeAuditResourceType | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'plm-team-preset-batch'
    || normalized === 'plm-team-preset-default'
    || normalized === 'plm-team-view-batch'
    || normalized === 'plm-team-view-default'
  ) {
    return normalized
  }
  return null
}

function normalizePlmCollaborativeAuditAction(value: unknown): PlmCollaborativeAuditAction | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'archive'
    || normalized === 'restore'
    || normalized === 'delete'
    || normalized === 'set-default'
    || normalized === 'clear-default'
  ) {
    return normalized
  }
  return null
}

function mapPlmCollaborativeAuditEntry(row: Record<string, unknown>): PlmCollaborativeAuditEntry {
  const occurredRaw = row.occurred_at ?? row.created_at
  const occurredAt =
    occurredRaw instanceof Date
      ? occurredRaw.toISOString()
      : typeof occurredRaw === 'string' && occurredRaw.trim()
        ? new Date(occurredRaw).toISOString()
        : new Date().toISOString()

  const metaCandidate = row.meta && typeof row.meta === 'object'
    ? row.meta as Record<string, unknown>
    : row.metadata && typeof row.metadata === 'object'
      ? row.metadata as Record<string, unknown>
      : {}

  return {
    id: typeof row.id === 'string' ? row.id : '',
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    actorType: typeof row.actor_type === 'string' ? row.actor_type : null,
    action: typeof row.action === 'string' ? row.action : '',
    resourceType: typeof row.resource_type === 'string' ? row.resource_type : null,
    resourceId: typeof row.resource_id === 'string' ? row.resource_id : null,
    requestId: typeof row.request_id === 'string' ? row.request_id : null,
    ip: typeof row.ip === 'string' ? row.ip : typeof row.ip_address === 'string' ? row.ip_address : null,
    userAgent: typeof row.user_agent === 'string' ? row.user_agent : null,
    occurredAt,
    meta: metaCandidate,
  }
}

function buildPlmCollaborativeAuditWhere(paramsInput: PlmCollaborativeAuditWhereParams) {
  const params: unknown[] = [PLM_COLLABORATIVE_AUDIT_RESOURCE_TYPES]
  const where: string[] = ['resource_type = ANY($1::text[])']
  const push = (condition: string, value: unknown) => {
    params.push(value)
    where.push(condition.replace(/\$n/g, `$${params.length}`))
  }

  if (paramsInput.resourceType) push('resource_type = $n', paramsInput.resourceType)
  if (paramsInput.action) push('action = $n', paramsInput.action)
  if (paramsInput.actorId) push('actor_id = $n', paramsInput.actorId)
  if (paramsInput.q) {
    push(
      '(actor_id ILIKE $n OR action ILIKE $n OR resource_id ILIKE $n OR COALESCE(meta, metadata, \'{}\'::jsonb)::text ILIKE $n)',
      `%${paramsInput.q}%`,
    )
  }
  if (paramsInput.kind) push('COALESCE(meta, metadata, \'{}\'::jsonb)::text ILIKE $n', `%${paramsInput.kind}%`)
  if (paramsInput.from) push('COALESCE(occurred_at, created_at) >= $n', paramsInput.from)
  if (paramsInput.to) push('COALESCE(occurred_at, created_at) <= $n', paramsInput.to)

  return {
    whereSql: `WHERE ${where.join(' AND ')}`,
    params,
  }
}

async function persistPlmCollaborativeAuditEvent(params: {
  route: string
  resourceType: PlmCollaborativeAuditResourceType
  action: PlmCollaborativeAuditAction
  ownerUserId: string
  resourceId: string
  meta: Record<string, unknown>
}) {
  try {
    await pgQuery(
      `INSERT INTO operation_audit_logs (
        actor_id,
        actor_type,
        action,
        resource_type,
        resource_id,
        request_id,
        ip,
        user_agent,
        route,
        status_code,
        latency_ms,
        meta,
        occurred_at,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now(), now())`,
      [
        params.ownerUserId,
        'user',
        params.action,
        params.resourceType,
        params.resourceId,
        null,
        null,
        null,
        params.route,
        200,
        0,
        JSON.stringify(params.meta),
      ],
    )
  } catch (error: unknown) {
    logger.warn(`Failed to persist ${params.resourceType} audit event`, error as Error)
  }
}

async function persistPlmCollaborativeBatchAudit(params: {
  resourceType: PlmCollaborativeAuditResourceType
  action: PlmCollaborativeAuditAction
  tenantId: string
  ownerUserId: string
  requestedIds: string[]
  processedIds: string[]
  skippedIds: string[]
  processedKinds?: string[]
}) {
  const resourceId =
    params.processedIds[0]
    || params.requestedIds[0]
    || `${params.tenantId}:${params.resourceType}:${params.action}`

  const route =
    params.resourceType === 'plm-team-preset-batch'
      ? '/api/plm-workbench/filter-presets/team/batch'
      : '/api/plm-workbench/views/team/batch'
  const meta = {
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    audit: params.resourceType,
    requestedIds: params.requestedIds,
    processedIds: params.processedIds,
    skippedIds: params.skippedIds,
    processedKinds: params.processedKinds ?? [],
    requestedTotal: params.requestedIds.length,
    processedTotal: params.processedIds.length,
    skippedTotal: params.skippedIds.length,
  }

  await persistPlmCollaborativeAuditEvent({
    route,
    resourceType: params.resourceType,
    action: params.action,
    ownerUserId: params.ownerUserId,
    resourceId,
    meta,
  })
}

async function logPlmTeamPresetBatchAudit(params: {
  action: PlmTeamPresetBatchAction
  tenantId: string
  ownerUserId: string
  requestedIds: string[]
  processedIds: string[]
  skippedIds: string[]
  processedKinds: string[]
}) {
  logger.info('Processed PLM team preset batch action', {
    audit: 'plm-team-preset-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    requestedIds: params.requestedIds,
    processedIds: params.processedIds,
    skippedIds: params.skippedIds,
    processedKinds: params.processedKinds,
    processedTotal: params.processedIds.length,
    skippedTotal: params.skippedIds.length,
  })

  await persistPlmCollaborativeBatchAudit({
    resourceType: 'plm-team-preset-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    requestedIds: params.requestedIds,
    processedIds: params.processedIds,
    skippedIds: params.skippedIds,
    processedKinds: params.processedKinds,
  })
}

async function logPlmTeamPresetLifecycleAudit(params: {
  action: PlmTeamPresetLifecycleAuditAction
  tenantId: string
  ownerUserId: string
  presetId: string
  kind: string
  presetName: string
}) {
  logger.info('Processed PLM team preset lifecycle action', {
    audit: 'plm-team-preset-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    presetId: params.presetId,
    kind: params.kind,
    presetName: params.presetName,
    processedKinds: [params.kind],
    processedTotal: 1,
  })

  await persistPlmCollaborativeAuditEvent({
    route: `/api/plm-workbench/filter-presets/team/:id/${params.action === 'delete' ? '' : params.action}`.replace(/\/$/, ''),
    resourceType: 'plm-team-preset-batch',
    action: params.action,
    ownerUserId: params.ownerUserId,
    resourceId: params.presetId,
    meta: {
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      audit: 'plm-team-preset-batch',
      kind: params.kind,
      presetName: params.presetName,
      processedKinds: [params.kind],
      requestedIds: [params.presetId],
      processedIds: [params.presetId],
      skippedIds: [],
      requestedTotal: 1,
      processedTotal: 1,
      skippedTotal: 0,
    },
  })
}

async function logPlmTeamPresetDefaultAudit(params: {
  action: PlmTeamPresetDefaultAuditAction
  tenantId: string
  ownerUserId: string
  presetId: string
  kind: string
  presetName: string
}) {
  logger.info('Processed PLM team preset default action', {
    audit: 'plm-team-preset-default',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    presetId: params.presetId,
    kind: params.kind,
    presetName: params.presetName,
    processedKinds: [params.kind],
    processedTotal: 1,
  })

  await persistPlmCollaborativeAuditEvent({
    route: '/api/plm-workbench/filter-presets/team/:id/default',
    resourceType: 'plm-team-preset-default',
    action: params.action,
    ownerUserId: params.ownerUserId,
    resourceId: params.presetId,
    meta: {
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      audit: 'plm-team-preset-default',
      kind: params.kind,
      viewName: params.presetName,
      processedKinds: [params.kind],
      requestedTotal: 1,
      processedTotal: 1,
      skippedTotal: 0,
    },
  })
}

async function logPlmTeamViewBatchAudit(params: {
  action: PlmTeamViewBatchAction
  tenantId: string
  ownerUserId: string
  requestedIds: string[]
  processedIds: string[]
  skippedIds: string[]
  processedKinds: string[]
}) {
  logger.info('Processed PLM team view batch action', {
    audit: 'plm-team-view-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    requestedIds: params.requestedIds,
    processedIds: params.processedIds,
    skippedIds: params.skippedIds,
    processedKinds: params.processedKinds,
    processedTotal: params.processedIds.length,
    skippedTotal: params.skippedIds.length,
  })

  await persistPlmCollaborativeBatchAudit({
    resourceType: 'plm-team-view-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    requestedIds: params.requestedIds,
    processedIds: params.processedIds,
    skippedIds: params.skippedIds,
    processedKinds: params.processedKinds,
  })
}

async function logPlmTeamViewDefaultAudit(params: {
  action: PlmTeamViewDefaultAuditAction
  tenantId: string
  ownerUserId: string
  viewId: string
  kind: string
  viewName: string
}) {
  logger.info('Processed PLM team view default action', {
    audit: 'plm-team-view-default',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    viewId: params.viewId,
    kind: params.kind,
    viewName: params.viewName,
    processedKinds: [params.kind],
    processedTotal: 1,
  })

  await persistPlmCollaborativeAuditEvent({
    route: '/api/plm-workbench/views/team/:id/default',
    resourceType: 'plm-team-view-default',
    action: params.action,
    ownerUserId: params.ownerUserId,
    resourceId: params.viewId,
    meta: {
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      audit: 'plm-team-view-default',
      kind: params.kind,
      viewName: params.viewName,
      processedKinds: [params.kind],
      requestedTotal: 1,
      processedTotal: 1,
      skippedTotal: 0,
    },
  })
}

async function logPlmTeamViewLifecycleAudit(params: {
  action: PlmTeamViewLifecycleAuditAction
  tenantId: string
  ownerUserId: string
  viewId: string
  kind: string
  viewName: string
}) {
  logger.info('Processed PLM team view lifecycle action', {
    audit: 'plm-team-view-batch',
    action: params.action,
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    viewId: params.viewId,
    kind: params.kind,
    viewName: params.viewName,
    processedKinds: [params.kind],
    processedTotal: 1,
  })

  await persistPlmCollaborativeAuditEvent({
    route: `/api/plm-workbench/views/team/:id/${params.action === 'delete' ? '' : params.action}`.replace(/\/$/, ''),
    resourceType: 'plm-team-view-batch',
    action: params.action,
    ownerUserId: params.ownerUserId,
    resourceId: params.viewId,
    meta: {
      tenantId: params.tenantId,
      ownerUserId: params.ownerUserId,
      audit: 'plm-team-view-batch',
      kind: params.kind,
      viewName: params.viewName,
      processedKinds: [params.kind],
      requestedIds: [params.viewId],
      processedIds: [params.viewId],
      skippedIds: [],
      requestedTotal: 1,
      processedTotal: 1,
      skippedTotal: 0,
    },
  })
}

async function attachPlmTeamViewDefaultSignals<T extends PlmWorkbenchTeamViewRowLike>(
  rows: T[],
): Promise<T[]> {
  const ids = Array.from(
    new Set(
      rows
        .map((row) => String(row.id || '').trim())
        .filter(Boolean),
    ),
  )

  if (!ids.length) {
    return rows
  }

  try {
    const result = await pgQuery(
      `SELECT resource_id, MAX(COALESCE(occurred_at, created_at)) AS last_default_set_at
       FROM operation_audit_logs
       WHERE resource_type = 'plm-team-view-default'
         AND action = 'set-default'
         AND resource_id = ANY($1::text[])
       GROUP BY resource_id`,
      [ids],
    )

    const lastDefaultById = new Map<string, string>()
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const resourceId = typeof row.resource_id === 'string' ? row.resource_id.trim() : ''
      if (!resourceId) continue
      const occurredAt =
        row.last_default_set_at instanceof Date
          ? row.last_default_set_at.toISOString()
          : typeof row.last_default_set_at === 'string' && row.last_default_set_at.trim()
            ? new Date(row.last_default_set_at).toISOString()
            : ''
      if (occurredAt) {
        lastDefaultById.set(resourceId, occurredAt)
      }
    }

    return rows.map((row) => ({
      ...row,
      last_default_set_at: lastDefaultById.get(String(row.id || '').trim()),
    })) as T[]
  } catch (error: unknown) {
    logger.warn('Failed to load PLM team view default signals', error as Error)
    return rows
  }
}

async function attachPlmTeamPresetDefaultSignals<T extends PlmTeamFilterPresetRowLike>(
  rows: T[],
): Promise<T[]> {
  const ids = Array.from(
    new Set(
      rows
        .map((row) => String(row.id || '').trim())
        .filter(Boolean),
    ),
  )

  if (!ids.length) {
    return rows
  }

  try {
    const result = await pgQuery(
      `SELECT resource_id, MAX(COALESCE(occurred_at, created_at)) AS last_default_set_at
       FROM operation_audit_logs
       WHERE resource_type = 'plm-team-preset-default'
         AND action = 'set-default'
         AND resource_id = ANY($1::text[])
       GROUP BY resource_id`,
      [ids],
    )

    const lastDefaultById = new Map<string, string>()
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const resourceId = typeof row.resource_id === 'string' ? row.resource_id.trim() : ''
      if (!resourceId) continue
      const occurredAt =
        row.last_default_set_at instanceof Date
          ? row.last_default_set_at.toISOString()
          : typeof row.last_default_set_at === 'string' && row.last_default_set_at.trim()
            ? new Date(row.last_default_set_at).toISOString()
            : ''
      if (occurredAt) {
        lastDefaultById.set(resourceId, occurredAt)
      }
    }

    return rows.map((row) => ({
      ...row,
      last_default_set_at: lastDefaultById.get(String(row.id || '').trim()),
    })) as T[]
  } catch (error: unknown) {
    logger.warn('Failed to load PLM team preset default signals', error as Error)
    return rows
  }
}

async function mapHydratedPlmTeamViewRows(
  rows: PlmWorkbenchTeamViewRowLike[],
  currentUserId?: string | null,
) {
  const hydratedRows = await attachPlmTeamViewDefaultSignals(rows)
  return hydratedRows.map((row: PlmWorkbenchTeamViewRowLike) => mapPlmWorkbenchTeamViewRow(row, currentUserId))
}

async function mapHydratedPlmTeamViewRow(
  row: PlmWorkbenchTeamViewRowLike,
  currentUserId?: string | null,
) {
  const [mapped] = await mapHydratedPlmTeamViewRows([row], currentUserId)
  return mapped
}

async function mapHydratedPlmTeamPresetRows(
  rows: PlmTeamFilterPresetRowLike[],
  currentUserId?: string | null,
) {
  const hydratedRows = await attachPlmTeamPresetDefaultSignals(rows)
  return hydratedRows.map((row: PlmTeamFilterPresetRowLike) => mapPlmTeamFilterPresetRow(row, currentUserId))
}

async function mapHydratedPlmTeamPresetRow(
  row: PlmTeamFilterPresetRowLike,
  currentUserId?: string | null,
) {
  const [mapped] = await mapHydratedPlmTeamPresetRows([row], currentUserId)
  return mapped
}

router.get(
  '/api/plm-workbench/audit-logs',
  authenticate,
  validate,
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>, {
        defaultPage: 1,
        defaultPageSize: 50,
        maxPageSize: 200,
      })

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      const actorId = typeof req.query.actorId === 'string' ? req.query.actorId.trim() : ''
      const action = normalizePlmCollaborativeAuditAction(req.query.action)
      const resourceType = normalizePlmAuditResourceType(req.query.resourceType)
      const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : ''
      const from = parsePlmAuditDate(req.query.from)
      const to = parsePlmAuditDate(req.query.to)
      const { whereSql, params } = buildPlmCollaborativeAuditWhere({
        q,
        actorId,
        action,
        resourceType,
        kind,
        from,
        to,
      })

      const count = await pgQuery<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM operation_audit_logs
         ${whereSql}`,
        params,
      )
      const total = count.rows[0]?.c ?? 0

      const list = await pgQuery<Record<string, unknown>>(
        `SELECT
           id,
           actor_id,
           actor_type,
           action,
           resource_type,
           resource_id,
           request_id,
           COALESCE(ip, ip_address) AS ip,
           user_agent,
           COALESCE(occurred_at, created_at) AS occurred_at,
           COALESCE(meta, metadata, '{}'::jsonb) AS meta
         FROM operation_audit_logs
         ${whereSql}
         ORDER BY COALESCE(occurred_at, created_at) DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      )

      return res.json({
        success: true,
        data: {
          items: list.rows.map((row) => mapPlmCollaborativeAuditEntry(row)),
          page,
          pageSize,
          total,
        },
        metadata: {
          resourceTypes: PLM_COLLABORATIVE_AUDIT_RESOURCE_TYPES,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to load PLM collaborative audit logs:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to load PLM collaborative audit logs',
      })
    }
  },
)

router.get(
  '/api/plm-workbench/audit-logs/export.csv',
  authenticate,
  validate,
  async (req: Request, res: Response) => {
    try {
      const rawLimit = Number(req.query.limit ?? 0) || 0
      const limit = Math.min(Math.max(rawLimit || 5000, 1), 10000)
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      const actorId = typeof req.query.actorId === 'string' ? req.query.actorId.trim() : ''
      const action = normalizePlmCollaborativeAuditAction(req.query.action)
      const resourceType = normalizePlmAuditResourceType(req.query.resourceType)
      const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : ''
      const from = parsePlmAuditDate(req.query.from)
      const to = parsePlmAuditDate(req.query.to)
      const { whereSql, params } = buildPlmCollaborativeAuditWhere({
        q,
        actorId,
        action,
        resourceType,
        kind,
        from,
        to,
      })

      const rows = await pgQuery<Record<string, unknown>>(
        `SELECT
           id,
           actor_id,
           actor_type,
           action,
           resource_type,
           resource_id,
           request_id,
           COALESCE(ip, ip_address) AS ip,
           user_agent,
           route,
           status_code,
           latency_ms,
           COALESCE(occurred_at, created_at) AS occurred_at,
           COALESCE(meta, metadata, '{}'::jsonb) AS meta
         FROM operation_audit_logs
         ${whereSql}
         ORDER BY COALESCE(occurred_at, created_at) DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )

      const filename = `plm-collaborative-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

      const header = [
        'occurredAt',
        'id',
        'actorId',
        'actorType',
        'action',
        'resourceType',
        'resourceId',
        'requestId',
        'ip',
        'userAgent',
        'route',
        'statusCode',
        'latencyMs',
        'processedKinds',
        'requestedTotal',
        'processedTotal',
        'skippedTotal',
        'meta',
      ].join(',')
      const lines: string[] = [header]

      rows.rows.forEach((row) => {
        const meta = row.meta && typeof row.meta === 'object' ? row.meta as Record<string, unknown> : {}
        const processedKinds = Array.isArray(meta.processedKinds)
          ? meta.processedKinds.filter((item): item is string => typeof item === 'string').join('|')
          : ''
        const occurredRaw = row.occurred_at
        const occurredAt = occurredRaw instanceof Date
          ? occurredRaw.toISOString()
          : typeof occurredRaw === 'string' && occurredRaw.trim()
            ? new Date(occurredRaw).toISOString()
            : ''

        lines.push([
          csvCell(occurredAt),
          csvCell(row.id),
          csvCell(row.actor_id),
          csvCell(row.actor_type),
          csvCell(row.action),
          csvCell(row.resource_type),
          csvCell(row.resource_id),
          csvCell(row.request_id),
          csvCell(row.ip),
          csvCell(row.user_agent),
          csvCell(row.route),
          csvCell(row.status_code),
          csvCell(row.latency_ms),
          csvCell(processedKinds),
          csvCell(meta.requestedTotal),
          csvCell(meta.processedTotal),
          csvCell(meta.skippedTotal),
          csvCell(JSON.stringify(meta)),
        ].join(','))
      })

      return res.end(lines.join('\n'))
    } catch (error: unknown) {
      logger.error('Failed to export PLM collaborative audit logs:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to export PLM collaborative audit logs',
      })
    }
  },
)

router.get(
  '/api/plm-workbench/audit-logs/summary',
  authenticate,
  validate,
  async (req: Request, res: Response) => {
    try {
      const windowMinutesRaw = Number(req.query.windowMinutes ?? 0) || 0
      const limitRaw = Number(req.query.limit ?? 0) || 0
      const windowMinutes = Math.min(Math.max(windowMinutesRaw || 60, 5), 7 * 24 * 60)
      const limit = Math.min(Math.max(limitRaw || 8, 1), 20)

      const actionRows = await pgQuery<{ action: string; total: number }>(
        `SELECT action, COUNT(*)::int AS total
         FROM operation_audit_logs
         WHERE resource_type = ANY($1::text[])
           AND COALESCE(occurred_at, created_at) >= now() - ($2::int * interval '1 minute')
         GROUP BY action
         ORDER BY total DESC, action ASC
         LIMIT $3`,
        [PLM_COLLABORATIVE_AUDIT_RESOURCE_TYPES, windowMinutes, limit],
      )

      const resourceRows = await pgQuery<{ resource_type: string; total: number }>(
        `SELECT resource_type, COUNT(*)::int AS total
         FROM operation_audit_logs
         WHERE resource_type = ANY($1::text[])
           AND COALESCE(occurred_at, created_at) >= now() - ($2::int * interval '1 minute')
         GROUP BY resource_type
         ORDER BY total DESC, resource_type ASC
         LIMIT $3`,
        [PLM_COLLABORATIVE_AUDIT_RESOURCE_TYPES, windowMinutes, limit],
      )

      return res.json({
        success: true,
        data: {
          windowMinutes,
          actions: actionRows.rows.map((row) => ({
            action: row.action,
            total: Number(row.total) || 0,
          })),
          resourceTypes: resourceRows.rows.map((row) => ({
            resourceType: row.resource_type,
            total: Number(row.total) || 0,
          })),
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to load PLM collaborative audit summary:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to load PLM collaborative audit summary',
      })
    }
  },
)

router.get(
  '/api/plm-workbench/views/team',
  authenticate,
  query('kind').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString() ?? null
      const tenantId = req.user?.tenantId?.toString() || 'default'
      const kind = normalizePlmWorkbenchTeamViewKind(req.query.kind)

      let queryBuilder = dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')

      if (kind) {
        queryBuilder = queryBuilder.where('kind', '=', kind)
      }

      const rows = await queryBuilder
        .orderBy('is_default', 'desc')
        .orderBy('updated_at', 'desc')
        .execute()
      const items = await mapHydratedPlmTeamViewRows(rows as PlmWorkbenchTeamViewRowLike[], currentUserId)
      const defaultView = items.find((item) => item.isDefault && !item.isArchived) || null
      const activeTotal = items.filter((item) => !item.isArchived).length
      const archivedTotal = items.length - activeTotal

      res.json({
        success: true,
        data: items,
        metadata: {
          total: items.length,
          activeTotal,
          archivedTotal,
          tenantId,
          kind: kind || 'all',
          defaultViewId: defaultView?.id || null,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to list PLM team views:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to list PLM team views',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/batch',
  authenticate,
  body('action').isString().notEmpty(),
  body('ids'),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const action = normalizePlmTeamViewBatchAction(req.body.action)
      const ids = normalizePlmCollaborativeBatchIds(req.body.ids)

      if (!action) {
        return res.status(400).json({
          success: false,
          error: 'Batch action is invalid',
        })
      }

      if (!ids.length) {
        return res.status(400).json({
          success: false,
          error: 'View IDs are required',
        })
      }

      const { queryableIds, invalidIds } = splitQueryablePlmTeamViewIds(ids)
      const rows = queryableIds.length
        ? await dbAny
          .selectFrom('plm_workbench_team_views')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', queryableIds)
          .execute()
        : []

      const targetRows = rows.filter((row: PlmWorkbenchTeamViewRowLike) => {
        if (row.owner_user_id !== currentUserId) return false
        const isArchived = Boolean(row.archived_at)
        if (action === 'archive') return !isArchived
        if (action === 'restore') return isArchived
        return true
      })

      const processedIds = targetRows.map((row: PlmWorkbenchTeamViewRowLike) => row.id)
      const processedSet = new Set(processedIds)
      const skippedIds = ids.filter((id) => invalidIds.includes(id) || !processedSet.has(id))
      const processedKinds: string[] = Array.from(
        new Set(
          targetRows
            .map((row: PlmWorkbenchTeamViewRowLike) => String(row.kind || '').trim())
            .filter((kind): kind is string => kind.length > 0),
        ),
      )

      if (!processedIds.length) {
        await logPlmTeamViewBatchAudit({
          action,
          tenantId,
          ownerUserId: currentUserId,
          requestedIds: ids,
          processedIds,
          skippedIds,
          processedKinds,
        })
        return res.json({
          success: true,
          data: {
            action,
            processedIds,
            skippedIds,
            items: [],
          },
          metadata: {
            requestedTotal: ids.length,
            processedTotal: 0,
            skippedTotal: skippedIds.length,
            processedKinds,
          },
        })
      }

      let items: ReturnType<typeof mapPlmWorkbenchTeamViewRow>[] = []

      if (action === 'delete') {
        await dbAny
          .deleteFrom('plm_workbench_team_views')
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .execute()
      } else if (action === 'archive') {
        const savedRows = await dbAny
          .updateTable('plm_workbench_team_views')
          .set({
            is_default: false,
            archived_at: new Date(),
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .returningAll()
          .execute()
        items = await mapHydratedPlmTeamViewRows(savedRows as PlmWorkbenchTeamViewRowLike[], currentUserId)
      } else {
        const savedRows = await dbAny
          .updateTable('plm_workbench_team_views')
          .set({
            archived_at: null,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .returningAll()
          .execute()
        items = await mapHydratedPlmTeamViewRows(savedRows as PlmWorkbenchTeamViewRowLike[], currentUserId)
      }

      await logPlmTeamViewBatchAudit({
        action,
        tenantId,
        ownerUserId: currentUserId,
        requestedIds: ids,
        processedIds,
        skippedIds,
        processedKinds,
      })

      return res.json({
        success: true,
        data: {
          action,
          processedIds,
          skippedIds,
          items,
        },
        metadata: {
          requestedTotal: ids.length,
          processedTotal: processedIds.length,
          skippedTotal: skippedIds.length,
          processedKinds,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to batch process PLM team views:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch process PLM team views',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/:id/default',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can set the default PLM team view',
        })
      }

      if (view.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team views cannot be set as default',
        })
      }

      const saved = await db.transaction().execute(async (trx) => {
        const trxAny = trx as typeof dbAny

        await trxAny
          .updateTable('plm_workbench_team_views')
          .set({
            is_default: false,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', view.scope)
          .where('kind', '=', view.kind)
          .where('is_default', '=', true)
          .execute()

        return await trxAny
          .updateTable('plm_workbench_team_views')
          .set({
            is_default: true,
            updated_at: new Date(),
          })
          .where('id', '=', viewId)
          .returningAll()
          .executeTakeFirstOrThrow()
      })

      await logPlmTeamViewDefaultAudit({
        action: 'set-default',
        tenantId,
        ownerUserId: currentUserId,
        viewId,
        kind: String(view.kind || ''),
        viewName: String(view.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to set default PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to set default PLM team view',
      })
    }
  },
)

router.delete(
  '/api/plm-workbench/views/team/:id/default',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can clear the default PLM team view',
        })
      }

      if (view.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team views cannot clear the default PLM team view',
        })
      }

      const saved = await dbAny
        .updateTable('plm_workbench_team_views')
        .set({
          is_default: false,
          updated_at: new Date(),
        })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamViewDefaultAudit({
        action: 'clear-default',
        tenantId,
        ownerUserId: currentUserId,
        viewId,
        kind: String(view.kind || ''),
        viewName: String(view.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to clear default PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to clear default PLM team view',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team',
  authenticate,
  body('kind').isString().notEmpty(),
  body('name').isString().notEmpty(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const kind = normalizePlmWorkbenchTeamViewKind(req.body.kind)
      const name = typeof req.body.name === 'string' ? normalizePlmWorkbenchTeamViewName(req.body.name) : ''
      const requestedDefault = readOptionalBoolean(req.body.isDefault)

      if (!kind) {
        return res.status(400).json({
          success: false,
          error: 'View kind is required',
        })
      }

      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'View name is required',
        })
      }

      if (typeof req.body.state === 'undefined') {
        return res.status(400).json({
          success: false,
          error: 'View state is required',
        })
      }

      const values = buildPlmWorkbenchTeamViewValues({
        tenantId,
        ownerUserId: currentUserId,
        kind,
        name,
        state: req.body.state,
        isDefault: requestedDefault,
      })

      const upsertView = async (targetDb: typeof dbAny, isDefault: boolean | undefined) => {
        const insertValues: Record<string, unknown> = {
          tenant_id: values.tenant_id,
          owner_user_id: values.owner_user_id,
          scope: values.scope,
          kind: values.kind,
          name: values.name,
          name_key: values.name_key,
          state: values.state,
          updated_at: new Date(),
        }
        if (typeof isDefault === 'boolean') {
          insertValues.is_default = isDefault
        }

        const updateValues: Record<string, unknown> = {
          name: values.name,
          state: values.state,
          archived_at: null,
          updated_at: new Date(),
        }
        if (typeof isDefault === 'boolean') {
          updateValues.is_default = isDefault
        }

        return targetDb
          .insertInto('plm_workbench_team_views')
          .values(insertValues)
          .onConflict((oc: PlmWorkbenchTeamViewConflictBuilder) =>
            oc
              .columns(['tenant_id', 'owner_user_id', 'scope', 'kind', 'name_key'])
              .doUpdateSet(updateValues),
          )
          .returningAll()
          .executeTakeFirstOrThrow()
      }

      const saved =
        requestedDefault === true
          ? await db.transaction().execute(async (trx) => {
              const trxAny = trx as typeof dbAny

              await trxAny
                .updateTable('plm_workbench_team_views')
                .set({
                  is_default: false,
                  updated_at: new Date(),
                })
                .where('tenant_id', '=', tenantId)
                .where('scope', '=', 'team')
                .where('kind', '=', kind)
                .where('is_default', '=', true)
                .execute()

              return upsertView(trxAny, true)
            })
          : await upsertView(dbAny, requestedDefault)

      if (requestedDefault === true) {
        await logPlmTeamViewDefaultAudit({
          action: 'set-default',
          tenantId,
          ownerUserId: currentUserId,
          viewId: String(saved.id || ''),
          kind,
          viewName: name,
        })
      }

      return res.status(201).json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to save PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save PLM team view',
      })
    }
  },
)

router.patch(
  '/api/plm-workbench/views/team/:id',
  authenticate,
  param('id').isString(),
  body('name').isString().notEmpty(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const name = typeof req.body.name === 'string' ? normalizePlmWorkbenchTeamViewName(req.body.name) : ''

      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'View name is required',
        })
      }

      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can rename this PLM team view',
        })
      }

      if (view.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team views cannot be renamed',
        })
      }

      if (normalizePlmWorkbenchTeamViewName(view.name) === name) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamViewRow(view as PlmWorkbenchTeamViewRowLike, currentUserId),
        })
      }

      const duplicate = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', currentUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', view.kind)
        .where('name_key', '=', normalizePlmWorkbenchTeamViewNameKey(name))
        .where('id', '!=', viewId)
        .executeTakeFirst()

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'PLM team view name already exists',
        })
      }

      const saved = await dbAny
        .updateTable('plm_workbench_team_views')
        .set({
          name,
          name_key: normalizePlmWorkbenchTeamViewNameKey(name),
          updated_at: new Date(),
        })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to rename PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename PLM team view',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/:id/duplicate',
  authenticate,
  param('id').isString(),
  body('name').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const source = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      const existing = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', currentUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', source.kind)
        .execute()

      const requestedName = typeof req.body.name === 'string' ? normalizePlmWorkbenchTeamViewName(req.body.name) : ''
      let nextName = requestedName

      if (!nextName) {
        nextName = buildPlmWorkbenchTeamViewDuplicateName(
          source.name,
          existing.map((row: PlmWorkbenchTeamViewRowLike) => row.name),
        )
      }

      const duplicate = existing.find(
        (row: PlmWorkbenchTeamViewRowLike) =>
          normalizePlmWorkbenchTeamViewNameKey(row.name) === normalizePlmWorkbenchTeamViewNameKey(nextName),
      )

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'PLM team view name already exists',
        })
      }

      const kind = normalizePlmWorkbenchTeamViewKind(source.kind)
      if (!kind) {
        return res.status(400).json({
          success: false,
          error: 'PLM team view kind is invalid',
        })
      }

      const values = buildPlmWorkbenchTeamViewValues({
        tenantId,
        ownerUserId: currentUserId,
        kind,
        name: nextName,
        state: source.state,
        isDefault: false,
      })

      const saved = await dbAny
        .insertInto('plm_workbench_team_views')
        .values({
          tenant_id: values.tenant_id,
          owner_user_id: values.owner_user_id,
          scope: values.scope,
          kind: values.kind,
          name: values.name,
          name_key: values.name_key,
          is_default: false,
          archived_at: null,
          state: values.state,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.status(201).json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to duplicate PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate PLM team view',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/:id/transfer',
  authenticate,
  param('id').isString(),
  body('ownerUserId').isString().notEmpty(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const targetOwnerUserId =
        typeof req.body.ownerUserId === 'string' ? req.body.ownerUserId.trim() : ''

      if (!targetOwnerUserId) {
        return res.status(400).json({
          success: false,
          error: 'Target owner user ID is required',
        })
      }

      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can transfer this PLM team view',
        })
      }

      if (view.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team views cannot be transferred',
        })
      }

      if (targetOwnerUserId === currentUserId) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamViewRow(view as PlmWorkbenchTeamViewRowLike, currentUserId),
        })
      }

      const targetUser = await dbAny
        .selectFrom('users')
        .selectAll()
        .where('id', '=', targetOwnerUserId)
        .where('is_active', '=', true)
        .executeTakeFirst()

      if (!targetUser) {
        return res.status(404).json({
          success: false,
          error: 'Target owner user not found',
        })
      }

      const duplicate = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', targetOwnerUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', view.kind)
        .where('name_key', '=', view.name_key)
        .where('id', '!=', viewId)
        .executeTakeFirst()

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'Target owner already has a PLM team view with this name',
        })
      }

      const saved = await dbAny
        .updateTable('plm_workbench_team_views')
        .set({
          owner_user_id: targetOwnerUserId,
          updated_at: new Date(),
        })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to transfer PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to transfer PLM team view',
      })
    }
  },
)

router.delete(
  '/api/plm-workbench/views/team/:id',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can delete this PLM team view',
        })
      }

      await dbAny
        .deleteFrom('plm_workbench_team_views')
        .where('id', '=', viewId)
        .execute()

      await logPlmTeamViewLifecycleAudit({
        action: 'delete',
        tenantId,
        ownerUserId: currentUserId,
        viewId,
        kind: String(view.kind || ''),
        viewName: String(view.name || ''),
      })

      return res.json({
        success: true,
        data: {
          id: viewId,
          message: 'PLM team view deleted successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to delete PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to delete PLM team view',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/:id/archive',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can archive this PLM team view',
        })
      }

      if (view.archived_at) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamViewRow(view as PlmWorkbenchTeamViewRowLike, currentUserId),
        })
      }

      const saved = await dbAny
        .updateTable('plm_workbench_team_views')
        .set({
          is_default: false,
          archived_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamViewLifecycleAudit({
        action: 'archive',
        tenantId,
        ownerUserId: currentUserId,
        viewId,
        kind: String(view.kind || ''),
        viewName: String(view.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to archive PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive PLM team view',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/views/team/:id/restore',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const viewId = req.params.id
      const view = await dbAny
        .selectFrom('plm_workbench_team_views')
        .selectAll()
        .where('id', '=', viewId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!view) {
        return res.status(404).json({
          success: false,
          error: 'PLM team view not found',
        })
      }

      if (view.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the view owner can restore this PLM team view',
        })
      }

      if (!view.archived_at) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamViewRow(view as PlmWorkbenchTeamViewRowLike, currentUserId),
        })
      }

      const saved = await dbAny
        .updateTable('plm_workbench_team_views')
        .set({
          archived_at: null,
          updated_at: new Date(),
        })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamViewLifecycleAudit({
        action: 'restore',
        tenantId,
        ownerUserId: currentUserId,
        viewId,
        kind: String(view.kind || ''),
        viewName: String(view.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamViewRow(saved as PlmWorkbenchTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to restore PLM team view:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore PLM team view',
      })
    }
  },
)

router.get(
  '/api/plm-workbench/filter-presets/team',
  authenticate,
  query('kind').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString() ?? null
      const tenantId = req.user?.tenantId?.toString() || 'default'
      const kind = normalizePlmTeamFilterPresetKind(req.query.kind)

      let queryBuilder = dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')

      if (kind) {
        queryBuilder = queryBuilder.where('kind', '=', kind)
      }

      const rows = await queryBuilder
        .orderBy('is_default', 'desc')
        .orderBy('updated_at', 'desc')
        .execute()
      const items = await mapHydratedPlmTeamPresetRows(rows as PlmTeamFilterPresetRowLike[], currentUserId)
      const defaultPreset = items.find((item) => item.isDefault && !item.isArchived) || null
      const activeTotal = items.filter((item) => !item.isArchived).length
      const archivedTotal = items.length - activeTotal

      res.json({
        success: true,
        data: items,
        metadata: {
          total: items.length,
          activeTotal,
          archivedTotal,
          tenantId,
          kind: kind || 'all',
          defaultPresetId: defaultPreset?.id || null,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to list PLM team presets:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to list PLM team presets',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/batch',
  authenticate,
  body('action').isString().notEmpty(),
  body('ids'),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const action = normalizePlmTeamPresetBatchAction(req.body.action)
      const ids = normalizePlmTeamPresetBatchIds(req.body.ids)

      if (!action) {
        return res.status(400).json({
          success: false,
          error: 'Batch action is invalid',
        })
      }

      if (!ids.length) {
        return res.status(400).json({
          success: false,
          error: 'Preset IDs are required',
        })
      }

      const { queryableIds, invalidIds } = splitQueryablePlmTeamPresetIds(ids)
      const rows = queryableIds.length
        ? await dbAny
          .selectFrom('plm_filter_team_presets')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', queryableIds)
          .execute()
        : []

      const targetRows = rows.filter((row: PlmTeamFilterPresetRowLike) => {
        if (row.owner_user_id !== currentUserId) return false
        const isArchived = Boolean(row.archived_at)
        if (action === 'archive') return !isArchived
        if (action === 'restore') return isArchived
        return true
      })

      const processedIds = targetRows.map((row: PlmTeamFilterPresetRowLike) => row.id)
      const processedSet = new Set(processedIds)
      const skippedIds = ids.filter((id) => invalidIds.includes(id) || !processedSet.has(id))
      const processedKinds: string[] = Array.from(
        new Set(
          targetRows
            .map((row: PlmTeamFilterPresetRowLike) => String(row.kind || '').trim())
            .filter((kind): kind is string => kind.length > 0),
        ),
      )

      if (!processedIds.length) {
        await logPlmTeamPresetBatchAudit({
          action,
          tenantId,
          ownerUserId: currentUserId,
          requestedIds: ids,
          processedIds,
          skippedIds,
          processedKinds,
        })
        return res.json({
          success: true,
          data: {
            action,
            processedIds,
            skippedIds,
            items: [],
          },
          metadata: {
            requestedTotal: ids.length,
            processedTotal: 0,
            skippedTotal: skippedIds.length,
            processedKinds,
          },
        })
      }

      let items: ReturnType<typeof mapPlmTeamFilterPresetRow>[] = []

      if (action === 'delete') {
        await dbAny
          .deleteFrom('plm_filter_team_presets')
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .execute()
      } else if (action === 'archive') {
        const saved = await dbAny
          .updateTable('plm_filter_team_presets')
          .set({
            is_default: false,
            archived_at: new Date(),
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .returningAll()
          .execute()
        items = await mapHydratedPlmTeamPresetRows(saved as PlmTeamFilterPresetRowLike[], currentUserId)
      } else {
        const saved = await dbAny
          .updateTable('plm_filter_team_presets')
          .set({
            archived_at: null,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', 'team')
          .where('id', 'in', processedIds)
          .returningAll()
          .execute()
        items = await mapHydratedPlmTeamPresetRows(saved as PlmTeamFilterPresetRowLike[], currentUserId)
      }

      await logPlmTeamPresetBatchAudit({
        action,
        tenantId,
        ownerUserId: currentUserId,
        requestedIds: ids,
        processedIds,
        skippedIds,
        processedKinds,
      })

      return res.json({
        success: true,
        data: {
          action,
          processedIds,
          skippedIds,
          items,
        },
        metadata: {
          requestedTotal: ids.length,
          processedTotal: processedIds.length,
          skippedTotal: skippedIds.length,
          processedKinds,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to batch process PLM team presets:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch process PLM team presets',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/:id/default',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can set the default PLM team preset',
        })
      }

      if (preset.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team presets cannot be set as default',
        })
      }

      const saved = await db.transaction().execute(async (trx) => {
        const trxAny = trx as typeof dbAny

        await trxAny
          .updateTable('plm_filter_team_presets')
          .set({
            is_default: false,
            updated_at: new Date(),
          })
          .where('tenant_id', '=', preset.tenant_id)
          .where('scope', '=', preset.scope)
          .where('kind', '=', preset.kind)
          .where('is_default', '=', true)
          .execute()

        return await trxAny
          .updateTable('plm_filter_team_presets')
          .set({
            is_default: true,
            updated_at: new Date(),
          })
          .where('id', '=', presetId)
          .returningAll()
          .executeTakeFirstOrThrow()
      })

      await logPlmTeamPresetDefaultAudit({
        action: 'set-default',
        tenantId,
        ownerUserId: currentUserId,
        presetId,
        kind: String(saved.kind || ''),
        presetName: String(saved.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to set default PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to set default PLM team preset',
      })
    }
  },
)

router.delete(
  '/api/plm-workbench/filter-presets/team/:id/default',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can clear the default PLM team preset',
        })
      }

      if (preset.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team presets cannot clear the default PLM team preset',
        })
      }

      const saved = await dbAny
        .updateTable('plm_filter_team_presets')
        .set({
          is_default: false,
          updated_at: new Date(),
        })
        .where('id', '=', presetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamPresetDefaultAudit({
        action: 'clear-default',
        tenantId,
        ownerUserId: currentUserId,
        presetId,
        kind: String(saved.kind || ''),
        presetName: String(saved.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to clear default PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to clear default PLM team preset',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team',
  authenticate,
  body('kind').isString().notEmpty(),
  body('name').isString().notEmpty(),
  body('state').isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const kind = normalizePlmTeamFilterPresetKind(req.body.kind)
      const name = typeof req.body.name === 'string' ? normalizePlmTeamFilterPresetName(req.body.name) : ''

      if (!kind) {
        return res.status(400).json({
          success: false,
          error: 'Preset kind is required',
        })
      }

      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Preset name is required',
        })
      }

      const values = buildPlmTeamFilterPresetValues({
        tenantId,
        ownerUserId: currentUserId,
        kind,
        name,
        state: req.body.state,
      })

      const saved = await dbAny
        .insertInto('plm_filter_team_presets')
        .values({
          ...values,
          archived_at: null,
          updated_at: new Date(),
        })
        .onConflict((oc: PlmTeamPresetConflictBuilder) =>
          oc
            .columns(['tenant_id', 'owner_user_id', 'scope', 'kind', 'name_key'])
            .doUpdateSet({
              name: values.name,
              state: values.state,
              archived_at: null,
              updated_at: new Date(),
            }),
        )
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.status(201).json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to save PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save PLM team preset',
      })
    }
  },
)

router.patch(
  '/api/plm-workbench/filter-presets/team/:id',
  authenticate,
  param('id').isString(),
  body('name').isString().notEmpty(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can rename this PLM team preset',
        })
      }

      if (preset.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team presets cannot be renamed',
        })
      }

      const name = typeof req.body.name === 'string' ? normalizePlmTeamFilterPresetName(req.body.name) : ''
      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Preset name is required',
        })
      }

      const duplicate = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', currentUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', preset.kind)
        .where('name_key', '=', normalizePlmTeamFilterPresetNameKey(name))
        .where('id', '!=', presetId)
        .executeTakeFirst()

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'PLM team preset name already exists',
        })
      }

      const saved = await dbAny
        .updateTable('plm_filter_team_presets')
        .set({
          name,
          name_key: normalizePlmTeamFilterPresetNameKey(name),
          updated_at: new Date(),
        })
        .where('id', '=', presetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to rename PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename PLM team preset',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/:id/duplicate',
  authenticate,
  param('id').isString(),
  body('name').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const source = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      const existing = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', currentUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', source.kind)
        .execute()

      const requestedName = typeof req.body.name === 'string' ? normalizePlmTeamFilterPresetName(req.body.name) : ''
      let nextName = requestedName

      if (!nextName) {
        nextName = buildPlmTeamFilterPresetDuplicateName(
          source.name,
          existing.map((row: PlmTeamFilterPresetRowLike) => row.name),
        )
      }

      const duplicate = existing.find(
        (row: PlmTeamFilterPresetRowLike) =>
          normalizePlmTeamFilterPresetNameKey(row.name) === normalizePlmTeamFilterPresetNameKey(nextName),
      )

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'PLM team preset name already exists',
        })
      }

      const kind = normalizePlmTeamFilterPresetKind(source.kind)
      if (!kind) {
        return res.status(400).json({
          success: false,
          error: 'PLM team preset kind is invalid',
        })
      }

      const values = buildPlmTeamFilterPresetValues({
        tenantId,
        ownerUserId: currentUserId,
        kind,
        name: nextName,
        state: source.state,
      })

      const saved = await dbAny
        .insertInto('plm_filter_team_presets')
        .values({
          ...values,
          is_default: false,
          archived_at: null,
          updated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.status(201).json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to duplicate PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate PLM team preset',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/:id/transfer',
  authenticate,
  param('id').isString(),
  body('ownerUserId').isString().notEmpty(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const targetOwnerUserId =
        typeof req.body.ownerUserId === 'string' ? req.body.ownerUserId.trim() : ''

      if (!targetOwnerUserId) {
        return res.status(400).json({
          success: false,
          error: 'Target owner user ID is required',
        })
      }

      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can transfer this PLM team preset',
        })
      }

      if (preset.archived_at) {
        return res.status(409).json({
          success: false,
          error: 'Archived PLM team presets cannot be transferred',
        })
      }

      if (targetOwnerUserId === currentUserId) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamPresetRow(preset as PlmTeamFilterPresetRowLike, currentUserId),
        })
      }

      const targetUser = await dbAny
        .selectFrom('users')
        .selectAll()
        .where('id', '=', targetOwnerUserId)
        .where('is_active', '=', true)
        .executeTakeFirst()

      if (!targetUser) {
        return res.status(404).json({
          success: false,
          error: 'Target owner user not found',
        })
      }

      const duplicate = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('owner_user_id', '=', targetOwnerUserId)
        .where('scope', '=', 'team')
        .where('kind', '=', preset.kind)
        .where('name_key', '=', preset.name_key)
        .where('id', '!=', presetId)
        .executeTakeFirst()

      if (duplicate) {
        return res.status(409).json({
          success: false,
          error: 'Target owner already has a PLM team preset with this name',
        })
      }

      const saved = await dbAny
        .updateTable('plm_filter_team_presets')
        .set({
          owner_user_id: targetOwnerUserId,
          updated_at: new Date(),
        })
        .where('id', '=', presetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to transfer PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to transfer PLM team preset',
      })
    }
  },
)

router.delete(
  '/api/plm-workbench/filter-presets/team/:id',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can delete this PLM team preset',
        })
      }

      await dbAny
        .deleteFrom('plm_filter_team_presets')
        .where('id', '=', presetId)
        .execute()

      await logPlmTeamPresetLifecycleAudit({
        action: 'delete',
        tenantId,
        ownerUserId: currentUserId,
        presetId,
        kind: String(preset.kind || ''),
        presetName: String(preset.name || ''),
      })

      return res.json({
        success: true,
        data: {
          id: presetId,
          message: 'PLM team preset deleted successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to delete PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: 'Failed to delete PLM team preset',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/:id/archive',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can archive this PLM team preset',
        })
      }

      if (preset.archived_at) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamPresetRow(preset as PlmTeamFilterPresetRowLike, currentUserId),
        })
      }

      const saved = await dbAny
        .updateTable('plm_filter_team_presets')
        .set({
          is_default: false,
          archived_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', presetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamPresetLifecycleAudit({
        action: 'archive',
        tenantId,
        ownerUserId: currentUserId,
        presetId,
        kind: String(preset.kind || ''),
        presetName: String(preset.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to archive PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive PLM team preset',
      })
    }
  },
)

router.post(
  '/api/plm-workbench/filter-presets/team/:id/restore',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const presetId = req.params.id
      const preset = await dbAny
        .selectFrom('plm_filter_team_presets')
        .selectAll()
        .where('id', '=', presetId)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!preset) {
        return res.status(404).json({
          success: false,
          error: 'PLM team preset not found',
        })
      }

      if (preset.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Only the preset owner can restore this PLM team preset',
        })
      }

      if (!preset.archived_at) {
        return res.json({
          success: true,
          data: await mapHydratedPlmTeamPresetRow(preset as PlmTeamFilterPresetRowLike, currentUserId),
        })
      }

      const saved = await dbAny
        .updateTable('plm_filter_team_presets')
        .set({
          archived_at: null,
          updated_at: new Date(),
        })
        .where('id', '=', presetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await logPlmTeamPresetLifecycleAudit({
        action: 'restore',
        tenantId,
        ownerUserId: currentUserId,
        presetId,
        kind: String(preset.kind || ''),
        presetName: String(preset.name || ''),
      })

      return res.json({
        success: true,
        data: await mapHydratedPlmTeamPresetRow(saved as PlmTeamFilterPresetRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to restore PLM team preset:', error as Error)
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore PLM team preset',
      })
    }
  },
)

export default router
