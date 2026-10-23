import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AdapterOptions, ConnectionConfig, Credentials, DataSourceConfig } from '../data-adapters/BaseAdapter'
import type { DataSourceManager } from '../data-adapters/DataSourceManager'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import {
  decryptStoredSecretValue,
  isEncryptedSecretValue,
} from '../security/encrypted-secrets'
import {
  isAdminOnQuery,
  listUserPermissionsOnQuery,
  lockRecordLinkAuthorityRowsOnQuery,
  resolveSheetCapabilitiesForUserOnQuery,
} from '../services/approval-record-link-txn-auth'
import { deriveCapabilities } from './sheet-capabilities'
import { acquireRecordLinkRowAuthLockOnQuery } from '../services/approval-record-link-row-auth-lock'
import {
  classifyManagedSourceOnQuery,
  ManagedCompanionRefusal,
} from '../services/plm-managed-companion'
import { isElearningProjectionBaseIdCandidate, isElearningProjectionSheetIdCandidate } from './elearning-projection-constants'
import { bomReviewSourceFingerprint } from './plm-bom-source-navigation'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
  EcoCollaborationSourceError,
  ecoCollaborationBusinessHash,
  ecoCollaborationRowKey,
  isEcoCollaborationId,
  parseEcoCollaborationSource,
  parseEcoCollaborationSourceInput,
  type EcoCollaborationSource,
} from './plm-collaboration-snapshot-wire'
import { fenceWriterEntry, isWriterFenceEnabled, SheetWriterBlockedError } from './canonical-sheet-fence'
import { mintOperation, sealOperation, OperationLedgerSchemaError, type OperationLedger } from './operation-ledger'
import { recordConfigRevision } from './config-revision-recorder'
import { recordRecordRevision } from './record-history-service'
import { ensureRecordNotLocked } from './record-lock'
import {
  loadFieldPermissionScopeMap,
  loadRecordPermissionScopeMap,
} from './permission-service'
import { isFieldPermissionHidden } from './permission-derivation'
import {
  createSheet,
  createView,
  ensureFields,
  getObjectFieldId,
  getObjectSheetId,
  getObjectViewId,
} from './provisioning'
import { MultitableEnsureFieldsRefusedError } from './ensureFieldsOverwriteMode'

const NAMESPACE = 'plm-collaboration-eco'
const ADVISORY_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
const SOURCE_COLUMNS = `id, name, type, config, owner_id, is_active, deleted_at, workspace_id, tenant_id, scope_kind`
const STALE_CODES = new Set([
  'ECO_SOURCE_UNLICENSED',
  'ECO_SOURCE_ANCHOR_MISMATCH',
  'ECO_SOURCE_LOGIN_REJECTED',
  'ECO_SOURCE_TOKEN_REJECTED',
])

export class EcoCollaborationSnapshotError extends Error {
  readonly name = 'EcoCollaborationSnapshotError'
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export type EcoQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>

export interface EcoCollaborationSnapshotPool {
  transaction<T>(fn: (tx: { query: EcoQuery }) => Promise<T>): Promise<T>
}

export interface EcoCollaborationSnapshotDependencies {
  pool: EcoCollaborationSnapshotPool
  dataSourceManager: Pick<DataSourceManager, 'getDataSource'>
}

type SourceKind = 'eco'
type LockMode = 'share' | 'update'

interface PreviewRequest {
  sourceKind: SourceKind
  dataSourceId: string
  baseId: string
  itemId: string
  currentVersionId: string | null
  ecoId: string
  name: string
}

interface ConfirmRequest {
  previewId: string
  requestId: string
  expectedVersion: number
  targetBindingId: string | null
}

interface RefreshRequest {
  expectedVersion: number
  rowKey: readonly [string, string, string, string]
}

interface FailureIdentity {
  bindingId: string
  expectedVersion: number
  dataSourceId: string
  sourceKind: string
  tenantId: string
  orgId: string
  itemId: string
  currentVersionId: string | null
  baseId: string
  name: string
  fingerprint: string
}

interface OwnedSource {
  fingerprint: string
  config: DataSourceConfig
}

interface PreviewRow {
  id: string
  actor_id: string
  data_source_id: string
  source_kind: string
  native_tenant_id: string
  native_org_id: string
  item_id: string
  current_version_id: string | null
  base_id: string
  name: string
  row_key: readonly [string, string, string, string]
  source_fingerprint: string
  business_hash: string
  captured_at: string
  request_id: string | null
  binding_id: string | null
  consumed_at: string | null
  expired: boolean
}

interface BindingRow {
  id: string
  creator_id: string
  data_source_id: string
  source_kind: string
  native_tenant_id: string
  native_org_id: string
  item_id: string
  current_version_id: string | null
  source_fingerprint: string
  base_id: string
  sheet_id: string
  view_id: string
  name: string
  source_fields: Record<string, string>
  local_fields: Record<string, string>
  version: number
  status: 'active' | 'stale' | 'disabled'
  last_failure_code: string | null
  last_failure_at: string | null
}

interface StoredRow {
  record_id: string
  row_key: readonly [string, string, string, string]
  business_hash: string
  captured_at: string
}

const textId = z.string().refine((value) => isEcoCollaborationId(value, 128))
const previewRequestSchema = z.object({
  sourceKind: z.literal('eco'),
  dataSourceId: textId,
  baseId: z.string().refine((value) => isEcoCollaborationId(value, 128)),
  itemId: textId,
  currentVersionId: textId.nullable(),
  ecoId: textId,
  name: z.string().refine((value) => value === value.trim() && value.length > 0 && value.length <= 200 && !value.includes('\0')),
}).strict()

const confirmRequestSchema = z.object({
  previewId: z.string().uuid(),
  requestId: z.string().uuid(),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  targetBindingId: z.string().uuid().optional(),
}).strict()

const refreshRequestSchema = z.object({
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rowKey: z.tuple([textId, z.string().refine((value) => isEcoCollaborationId(value, 64)), z.string().refine((value) => isEcoCollaborationId(value, 64)), textId]),
}).strict()

const disableRequestSchema = z.object({
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

function fail(status: number, code: string): never {
  throw new EcoCollaborationSnapshotError(status, code)
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string') fail(422, 'ECO_REQUEST_INVALID')
  return value
}

function requiredVersion(value: unknown): number {
  if (typeof value !== 'number') fail(422, 'ECO_REQUEST_INVALID')
  return value
}

function parsePreviewRequest(body: unknown): PreviewRequest {
  const parsed = previewRequestSchema.safeParse(body)
  if (!parsed.success || parsed.data.sourceKind !== 'eco') fail(422, 'ECO_REQUEST_INVALID')
  const current = parsed.data.currentVersionId
  return {
    sourceKind: 'eco',
    dataSourceId: requiredText(parsed.data.dataSourceId),
    baseId: requiredText(parsed.data.baseId),
    itemId: requiredText(parsed.data.itemId),
    currentVersionId: current == null ? null : requiredText(current),
    ecoId: requiredText(parsed.data.ecoId),
    name: requiredText(parsed.data.name),
  }
}

function parseConfirmRequest(body: unknown): ConfirmRequest {
  const parsed = confirmRequestSchema.safeParse(body)
  if (!parsed.success) fail(422, 'ECO_REQUEST_INVALID')
  const expectedVersion = requiredVersion(parsed.data.expectedVersion)
  const targetBindingId = parsed.data.targetBindingId ?? null
  if (expectedVersion === 0 && targetBindingId) fail(422, 'ECO_REQUEST_INVALID')
  if (expectedVersion > 0 && !targetBindingId) fail(422, 'ECO_REQUEST_INVALID')
  return {
    previewId: requiredText(parsed.data.previewId),
    requestId: requiredText(parsed.data.requestId),
    expectedVersion,
    targetBindingId,
  }
}

function parseRefreshRequest(body: unknown): RefreshRequest {
  const parsed = refreshRequestSchema.safeParse(body)
  if (!parsed.success) fail(422, 'ECO_REQUEST_INVALID')
  const key = parsed.data.rowKey
  if (!Array.isArray(key) || key.length !== 4 || key.some((part) => typeof part !== 'string')) {
    fail(422, 'ECO_REQUEST_INVALID')
  }
  return {
    expectedVersion: requiredVersion(parsed.data.expectedVersion),
    rowKey: [key[0], key[1], key[2], key[3]],
  }
}

function parseDisableRequest(body: unknown): { expectedVersion: number } {
  const parsed = disableRequestSchema.safeParse(body)
  if (!parsed.success) fail(422, 'ECO_REQUEST_INVALID')
  return { expectedVersion: requiredVersion(parsed.data.expectedVersion) }
}

function asVersion(value: unknown): number {
  const version = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(version) || version < 1) fail(409, 'VERSION_CONFLICT')
  return version
}

function asText(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

function asRowKey(value: unknown): readonly [string, string, string, string] {
  const key = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!Array.isArray(key) || key.length !== 4 || key.some((part) => typeof part !== 'string')) {
    fail(409, 'ROW_KEY_MISMATCH')
  }
  return [key[0], key[1], key[2], key[3]]
}

function asMap(value: unknown): Record<string, string> {
  const record = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string' || entry.length < 1) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
    out[key] = entry
  }
  return out
}

function sameKey(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

function headerBag(connection: ConnectionConfig): Record<string, string> | null {
  const headers = connection.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || headers instanceof Date) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function fixedScope(config: DataSourceConfig, headerName: string, optionKey: 'tenantId' | 'orgId'): string {
  const aliases: string[] = []
  const headers = headerBag(config.connection)
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === headerName) aliases.push(value)
    }
  }
  const option = config.options?.[optionKey]
  if (typeof option === 'string') aliases.push(option)
  if (aliases.length === 0 || new Set(aliases).size !== 1) fail(403, 'ECO_SOURCE_SCOPE_AMBIGUOUS')
  const value = aliases[0]
  if (!isEcoCollaborationId(value, 64) || /[\r\n]/.test(value)) fail(403, 'ECO_SOURCE_SCOPE_AMBIGUOUS')
  return value
}

function freshConfig(row: Record<string, unknown>): DataSourceConfig {
  const stored = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : {}
  const connection = stored.connection && typeof stored.connection === 'object' && !Array.isArray(stored.connection)
    ? { ...(stored.connection as ConnectionConfig) }
    : {}
  const credentials = stored.credentials && typeof stored.credentials === 'object' && !Array.isArray(stored.credentials)
    ? { ...(stored.credentials as Credentials) }
    : undefined
  if (credentials) {
    for (const key of ['password', 'apiKey', 'token'] as const) {
      const value = credentials[key]
      if (typeof value === 'string' && isEncryptedSecretValue(value)) credentials[key] = decryptStoredSecretValue(value)
    }
  }
  const options = stored.options && typeof stored.options === 'object' && !Array.isArray(stored.options)
    ? stored.options as AdapterOptions
    : undefined
  return {
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : String(row.id),
    type: String(row.type),
    connection,
    options,
    credentials,
  }
}

function sourceFingerprint(row: Record<string, unknown>): string {
  return bomReviewSourceFingerprint({
    id: String(row.id),
    type: String(row.type),
    config: row.config,
    owner_id: String(row.owner_id),
    is_active: row.is_active === true,
    workspace_id: row.workspace_id,
    tenant_id: row.tenant_id,
    scope_kind: row.scope_kind,
  })
}

function sourceCells(snapshot: EcoCollaborationSource, fields: Record<string, string>): Record<string, string | null> {
  const data: Record<string, string | null> = {}
  for (const key of ECO_COLLABORATION_ECO_FIELDS) data[fields[key]] = snapshot.eco[key]
  return data
}

function previewFrom(row: Record<string, unknown> | undefined): PreviewRow | null {
  if (!row) return null
  return {
    id: String(row.id),
    actor_id: String(row.actor_id),
    data_source_id: String(row.data_source_id),
    source_kind: String(row.source_kind),
    native_tenant_id: String(row.native_tenant_id),
    native_org_id: String(row.native_org_id),
    item_id: String(row.item_id),
    current_version_id: asText(row.current_version_id),
    base_id: String(row.base_id),
    name: String(row.name),
    row_key: asRowKey(row.row_key),
    source_fingerprint: String(row.source_fingerprint),
    business_hash: String(row.business_hash),
    captured_at: asText(row.captured_at) ?? '',
    request_id: asText(row.request_id),
    binding_id: asText(row.binding_id),
    consumed_at: asText(row.consumed_at),
    expired: row.expired === true,
  }
}

function bindingFrom(row: Record<string, unknown> | undefined): BindingRow | null {
  if (!row) return null
  const status = row.status
  if (status !== 'active' && status !== 'stale' && status !== 'disabled') fail(503, 'ECO_RUNTIME_UNAVAILABLE')
  return {
    id: String(row.id),
    creator_id: String(row.creator_id),
    data_source_id: String(row.data_source_id),
    source_kind: String(row.source_kind),
    native_tenant_id: String(row.native_tenant_id),
    native_org_id: String(row.native_org_id),
    item_id: String(row.item_id),
    current_version_id: asText(row.current_version_id),
    source_fingerprint: String(row.source_fingerprint),
    base_id: String(row.base_id),
    sheet_id: String(row.sheet_id),
    view_id: String(row.view_id),
    name: String(row.name),
    source_fields: asMap(row.source_fields),
    local_fields: asMap(row.local_fields),
    version: asVersion(row.version),
    status,
    last_failure_code: asText(row.last_failure_code),
    last_failure_at: asText(row.last_failure_at),
  }
}

function sameFrozen(preview: PreviewRow, binding: BindingRow): boolean {
  return preview.data_source_id === binding.data_source_id
    && preview.source_kind === binding.source_kind
    && preview.native_tenant_id === binding.native_tenant_id
    && preview.native_org_id === binding.native_org_id
    && preview.item_id === binding.item_id
    && preview.current_version_id === binding.current_version_id
    && preview.base_id === binding.base_id
    && preview.name === binding.name
    && preview.source_fingerprint === binding.source_fingerprint
}

function failureIdentity(binding: BindingRow, expectedVersion: number): FailureIdentity {
  return {
    bindingId: binding.id,
    expectedVersion,
    dataSourceId: binding.data_source_id,
    sourceKind: binding.source_kind,
    tenantId: binding.native_tenant_id,
    orgId: binding.native_org_id,
    itemId: binding.item_id,
    currentVersionId: binding.current_version_id,
    baseId: binding.base_id,
    name: binding.name,
    fingerprint: binding.source_fingerprint,
  }
}

function sameFailureIdentity(binding: BindingRow, identity: FailureIdentity): boolean {
  return binding.id === identity.bindingId
    && binding.data_source_id === identity.dataSourceId
    && binding.source_kind === identity.sourceKind
    && binding.native_tenant_id === identity.tenantId
    && binding.native_org_id === identity.orgId
    && binding.item_id === identity.itemId
    && binding.current_version_id === identity.currentVersionId
    && binding.base_id === identity.baseId
    && binding.name === identity.name
    && binding.source_fingerprint === identity.fingerprint
}

export class EcoCollaborationSnapshotService {
  constructor(private readonly deps: EcoCollaborationSnapshotDependencies) {}

  async preview(actor: string, body: unknown) {
    const input = parsePreviewRequest(body)
    this.refuseSpecialBase(input.baseId)
    this.requireWriterFence()
    const before = await this.transaction(async (query) => {
      this.requireWriterFence()
      await this.runtime(query)
      await this.active(query, actor)
      await this.authorizeBase(query, actor, input.baseId)
      return this.admit(query, actor, input.dataSourceId, 'share')
    })
    const snapshot = await this.fetch(input.dataSourceId, {
      itemId: input.itemId,
      ecoId: input.ecoId,
      currentVersionId: input.currentVersionId,
    }, before.config)
    const material = this.accept(snapshot, before.config, input)
    return this.transaction(async (query) => {
      this.requireWriterFence()
      await this.runtime(query)
      await this.active(query, actor)
      await this.authorizeBase(query, actor, input.baseId)
      const after = await this.admit(query, actor, input.dataSourceId, 'share')
      if (after.fingerprint !== before.fingerprint) fail(409, 'SOURCE_CHANGED')
      this.accept(snapshot, after.config, input)
      const id = randomUUID()
      const inserted = await query(
        `INSERT INTO meta_plm_collaboration_previews (
           id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
           current_version_id, base_id, name, row_key, source_fingerprint, business_hash, captured_at, expires_at
         ) VALUES (
           $1::uuid, $2, $3, 'eco', $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::timestamptz,
           now() + interval '15 minutes'
         ) RETURNING id, expires_at`,
        [
          id, actor, input.dataSourceId, material.tenantId, material.orgId, input.itemId,
          input.currentVersionId, input.baseId, input.name, JSON.stringify(material.rowKey),
          after.fingerprint, material.hash, material.snapshot.snapshot_at,
        ],
      )
      const row = inserted.rows[0]
      if (!row) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
      return {
        previewId: String(row.id),
        expiresAt: asText(row.expires_at),
        businessHash: material.hash,
        capturedAt: material.snapshot.snapshot_at,
        rowKey: material.rowKey,
        baseId: input.baseId,
        name: input.name,
        anchor: {
          dataSourceId: input.dataSourceId,
          tenantId: material.tenantId,
          orgId: material.orgId,
          itemId: input.itemId,
          currentVersionId: input.currentVersionId,
          ecoId: input.ecoId,
        },
        eco: material.snapshot.eco,
      }
    })
  }

  async confirm(actor: string, body: unknown) {
    const input = parseConfirmRequest(body)
    const existing = await this.transaction(async (query) => {
      await this.runtime(query)
      const preview = await this.readPreview(query, actor, input.previewId, false)
      if (!preview || preview.request_id || preview.binding_id || preview.consumed_at) return preview
      const taken = await query(
        'SELECT id FROM meta_plm_collaboration_previews WHERE request_id=$1::uuid AND id<>$2::uuid',
        [input.requestId, preview.id],
      )
      if (taken.rows[0]) fail(409, 'REQUEST_CONFLICT')
      return preview
    })
    if (!existing) fail(404, 'NOT_FOUND')
    if (existing.request_id || existing.binding_id || existing.consumed_at) return this.replay(actor, input)
    if (existing.expired) fail(409, 'PREVIEW_EXPIRED')
    this.requireWriterFence()
    const wire = {
      itemId: existing.item_id,
      ecoId: existing.row_key[3],
      currentVersionId: existing.current_version_id,
    }
    const before = await this.transaction(async (query) => {
      this.requireWriterFence()
      await this.lockSource(query, existing.data_source_id)
      await this.runtime(query)
      await this.active(query, actor)
      await this.authorizeBase(query, actor, existing.base_id)
      const retainedTarget = input.expectedVersion > 0
        ? await this.assertExplicitTarget(query, actor, existing, input.targetBindingId!, input.expectedVersion)
        : null
      const admitted = await this.admit(query, actor, existing.data_source_id, 'share')
      return { admitted, retainedTarget }
    })
    if (before.admitted.fingerprint !== existing.source_fingerprint) fail(409, 'SOURCE_CHANGED')
    let snapshot: EcoCollaborationSource
    try {
      snapshot = await this.fetch(existing.data_source_id, wire, before.admitted.config)
    } catch (error) {
      throw await this.retainProviderFailure(actor, before.retainedTarget, error)
    }
    const material = this.acceptFrozen(snapshot, before.admitted.config, existing)
    if (material.hash !== existing.business_hash) fail(409, 'SOURCE_CHANGED')
    try {
      return await this.transaction(async (query) => {
        this.requireWriterFence()
        await this.lockSource(query, existing.data_source_id)
        await this.runtime(query)
        const locked = await this.readPreview(query, actor, input.previewId, true)
        if (!locked) fail(404, 'NOT_FOUND')
        if (locked.data_source_id !== existing.data_source_id) fail(409, 'SOURCE_CHANGED')
        if (locked.request_id || locked.binding_id || locked.consumed_at) return this.replayLocked(query, actor, input, locked)
        if (locked.expired) fail(409, 'PREVIEW_EXPIRED')
        await this.active(query, actor)
        const after = await this.admit(query, actor, locked.data_source_id, 'update')
        if (after.fingerprint !== locked.source_fingerprint) fail(409, 'SOURCE_CHANGED')
        this.acceptFrozen(snapshot, after.config, locked)
        await this.authorizeBase(query, actor, locked.base_id)
        const published = input.expectedVersion === 0
          ? await this.provision(query, actor, locked, material.snapshot)
          : await this.append(query, actor, locked, input.targetBindingId!, input.expectedVersion, material.snapshot)
        await this.consume(query, actor, locked, input.requestId, published.bindingId)
        return { ...published, replayed: false }
      })
    } catch (error) {
      throw await this.retainProviderFailure(actor, before.retainedTarget, error)
    }
  }

  async get(actor: string, bindingId: string) {
    if (!z.string().uuid().safeParse(bindingId).success) fail(422, 'ECO_REQUEST_INVALID')
    return this.transaction(async (query) => {
      await this.runtime(query)
      await this.active(query, actor)
      const binding = await this.readBinding(query, bindingId, false)
      if (!binding) fail(404, 'NOT_FOUND')
      await this.authorizeSheet(query, actor, binding, false)
      const stored = await this.readStoredRow(query, binding.id, null)
      const denied = stored
        ? (await loadRecordPermissionScopeMap(query, binding.sheet_id, [stored.record_id], actor)).get(stored.record_id)?.accessLevel === 'none'
        : false
      const record = stored && !denied ? await this.readRecord(query, binding.sheet_id, stored.record_id, false) : null
      const projected = stored && !denied
        ? await this.visibleCells(query, actor, binding, stored.record_id, record?.data ?? {})
        : null
      return {
        id: binding.id,
        status: binding.status,
        version: binding.version,
        name: binding.name,
        baseId: binding.base_id,
        sheetId: binding.sheet_id,
        viewId: binding.view_id,
        sourceKind: 'eco' as const,
        anchor: this.anchor(binding),
        canRefresh: await this.canRefresh(query, actor, binding, denied ? null : stored, record),
        row: stored && !denied && projected ? {
          recordId: stored.record_id,
          rowKey: projected.sourceMetadataVisible ? stored.row_key : null,
          businessHash: projected.sourceMetadataVisible ? stored.business_hash : null,
          capturedAt: projected.sourceMetadataVisible ? stored.captured_at : null,
          cells: projected.cells,
        } : null,
      }
    })
  }

  async refresh(actor: string, bindingId: string, body: unknown) {
    const input = parseRefreshRequest(body)
    if (!z.string().uuid().safeParse(bindingId).success) fail(422, 'ECO_REQUEST_INVALID')
    this.requireWriterFence()
    const loaded = await this.transaction(async (query) => this.loadRefresh(query, actor, bindingId, input, 'share'))
    const retainedTarget = failureIdentity(loaded.binding, input.expectedVersion)
    let snapshot: EcoCollaborationSource
    try {
      snapshot = await this.fetch(loaded.binding.data_source_id, {
        itemId: loaded.binding.item_id,
        ecoId: loaded.stored.row_key[3],
        currentVersionId: loaded.binding.current_version_id,
      }, loaded.source.config)
    } catch (error) {
      throw await this.retainProviderFailure(actor, retainedTarget, error)
    }
    const material = this.acceptFrozen(snapshot, loaded.source.config, this.previewShape(loaded.binding, loaded.stored))
    if (material.hash === loaded.stored.business_hash) {
      await this.transaction(async (query) => {
        const again = await this.loadRefresh(query, actor, bindingId, input, 'share')
        if (again.stored.business_hash !== loaded.stored.business_hash) fail(409, 'VERSION_CONFLICT')
      })
      return this.retained(loaded.binding, loaded.stored.record_id, true)
    }
    try {
      return await this.transaction(async (query) => {
        this.requireWriterFence()
        const again = await this.loadRefresh(query, actor, bindingId, input, 'update')
        const after = this.acceptFrozen(snapshot, again.source.config, this.previewShape(again.binding, again.stored))
        if (after.hash === again.stored.business_hash) return this.retained(again.binding, again.stored.record_id, true)
        const published = await this.writeSource(query, actor, again.binding, again.stored, after.snapshot, after.hash, input.expectedVersion)
        return { ...published, replayed: false, noop: false }
      })
    } catch (error) {
      throw await this.retainProviderFailure(actor, retainedTarget, error)
    }
  }

  async disable(actor: string, bindingId: string, body: unknown) {
    const input = parseDisableRequest(body)
    if (!z.string().uuid().safeParse(bindingId).success) fail(422, 'ECO_REQUEST_INVALID')
    return this.transaction(async (query) => {
      await this.runtime(query)
      await this.active(query, actor)
      const binding = await this.readBinding(query, bindingId, true)
      if (!binding) fail(404, 'NOT_FOUND')
      if (binding.creator_id !== actor) fail(403, 'FORBIDDEN')
      await fenceWriterEntry(query, binding.sheet_id)
      await this.authorizeSheet(query, actor, binding, true)
      if (binding.status === 'disabled') {
        if (binding.version !== input.expectedVersion) fail(409, 'VERSION_CONFLICT')
        return this.retained(binding, null, false)
      }
      if (binding.version !== input.expectedVersion || (binding.status !== 'active' && binding.status !== 'stale')) {
        fail(409, 'VERSION_CONFLICT')
      }
      const updated = await query(
        `UPDATE meta_plm_collaboration_bindings
            SET status = 'disabled', version = version + 1, updated_at = now()
          WHERE id = $1::uuid AND version = $2 AND status = $3 AND creator_id = $4
          RETURNING version, status`,
        [binding.id, binding.version, binding.status, actor],
      )
      if ((updated.rowCount ?? 0) !== 1) fail(409, 'VERSION_CONFLICT')
      return this.retained({ ...binding, version: asVersion(updated.rows[0].version), status: 'disabled' }, null, false)
    })
  }

  private async transaction<T>(fn: (query: EcoQuery) => Promise<T>): Promise<T> {
    try {
      return await this.deps.pool.transaction(async ({ query }) => fn(query))
    } catch (error) {
      throw this.translate(error)
    }
  }

  private translate(error: unknown): unknown {
    if (error instanceof EcoCollaborationSnapshotError) return error
    if (error instanceof EcoCollaborationSourceError) return new EcoCollaborationSnapshotError(error.status, error.code)
    if (error instanceof ManagedCompanionRefusal) {
      const code = error.code === 'PLM_MANAGED_SCHEMA_MISSING'
        ? 'ECO_SOURCE_SCHEMA_MISSING'
        : error.code === 'PLM_MANAGED_BINDING_UNAVAILABLE'
          ? 'ECO_SOURCE_UNAVAILABLE'
          : error.code === 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'
            ? 'ECO_SOURCE_MANAGED'
            : 'ECO_SOURCE_ADMISSION_REFUSED'
      const status = code === 'ECO_SOURCE_UNAVAILABLE' ? 503 : 403
      return new EcoCollaborationSnapshotError(status, code)
    }
    if (error instanceof OperationLedgerSchemaError) return new EcoCollaborationSnapshotError(503, 'ECO_RUNTIME_UNAVAILABLE')
    if (error instanceof SheetWriterBlockedError) return new EcoCollaborationSnapshotError(409, 'SHEET_BLOCKED')
    if (error instanceof MultitableEnsureFieldsRefusedError) return new EcoCollaborationSnapshotError(409, 'COLLECTION_CONFLICT')
    const db = error as { code?: string; constraint?: string }
    if (db.code === '23505') {
      return new EcoCollaborationSnapshotError(
        409,
        db.constraint === 'meta_plm_collaboration_previews_request_id_key' ? 'REQUEST_CONFLICT' : 'COLLECTION_CONFLICT',
      )
    }
    return error
  }

  private async runtime(query: EcoQuery): Promise<void> {
    const found = await query(
      `SELECT (
         to_regclass('meta_plm_collaboration_bindings') IS NOT NULL
         AND to_regclass('meta_plm_collaboration_previews') IS NOT NULL
         AND to_regclass('meta_plm_collaboration_rows') IS NOT NULL
         AND to_regclass('meta_plm_collaboration_syncs') IS NOT NULL
         AND to_regclass('meta_config_revisions') IS NOT NULL
         AND to_regclass('meta_record_revisions') IS NOT NULL
         AND to_regclass('meta_record_history_operations') IS NOT NULL
       ) AS ready`,
    )
    if (found.rows[0]?.ready !== true) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
  }

  private async active(query: EcoQuery, actor: string): Promise<void> {
    const user = (await query(
      'SELECT is_active, role, activation_status, local_password_set FROM users WHERE id=$1 FOR SHARE',
      [actor],
    )).rows[0]
    if (!user || evaluateUserAuthenticationGate(user)) fail(403, 'FORBIDDEN')
  }

  private refuseSpecialBase(baseId: string): void {
    if (isElearningProjectionBaseIdCandidate(baseId)) fail(403, 'FORBIDDEN')
  }

  private async authorizeBase(query: EcoQuery, actor: string, baseId: string): Promise<void> {
    this.refuseSpecialBase(baseId)
    await lockRecordLinkAuthorityRowsOnQuery(query, { userId: actor, baseId, sheetId: '' })
    const row = (await query(
      'SELECT id, owner_id, deleted_at FROM meta_bases WHERE id=$1 AND deleted_at IS NULL',
      [baseId],
    )).rows[0]
    if (!row) fail(403, 'FORBIDDEN')
    const capabilities = deriveCapabilities(
      await listUserPermissionsOnQuery(query, actor),
      await isAdminOnQuery(query, actor),
    )
    if (!(row.owner_id === actor || capabilities.canManageViews)) fail(403, 'FORBIDDEN')
  }

  private async authorizeSheet(query: EcoQuery, actor: string, binding: BindingRow, manage: boolean): Promise<void> {
    this.refuseSpecialBase(binding.base_id)
    if (isElearningProjectionSheetIdCandidate(binding.sheet_id)) fail(403, 'FORBIDDEN')
    await lockRecordLinkAuthorityRowsOnQuery(query, {
      userId: actor,
      baseId: binding.base_id,
      sheetId: binding.sheet_id,
    })
    const alive = (await query(
      `SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id=s.base_id
        WHERE s.id=$1 AND s.base_id=$2 AND s.deleted_at IS NULL AND b.deleted_at IS NULL`,
      [binding.sheet_id, binding.base_id],
    )).rows[0]
    const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(query, binding.sheet_id, actor)
    if (!alive || !capabilities.canRead || (manage && !capabilities.canManageSheetAccess)) fail(403, 'FORBIDDEN')
  }

  private async lockSource(query: EcoQuery, dataSourceId: string): Promise<void> {
    // Same exclusive source key as admit, before any ECO preview or binding row lock.
    await query(ADVISORY_SQL, [dataSourceId])
  }

  private async admit(query: EcoQuery, actor: string, dataSourceId: string, mode: LockMode): Promise<OwnedSource> {
    await query(ADVISORY_SQL, [dataSourceId])
    const classified = await classifyManagedSourceOnQuery(query, dataSourceId)
    if (classified.kind === 'schema-missing') fail(403, 'ECO_SOURCE_SCHEMA_MISSING')
    if (classified.kind === 'unavailable') fail(503, 'ECO_SOURCE_UNAVAILABLE')
    if (classified.kind === 'bound') fail(403, 'ECO_SOURCE_MANAGED')
    const row = (await query(
      `SELECT ${SOURCE_COLUMNS} FROM data_sources WHERE id=$1 ${mode === 'update' ? 'FOR UPDATE' : 'FOR SHARE'}`,
      [dataSourceId],
    )).rows[0] as Record<string, unknown> | undefined
    if (!row || row.owner_id !== actor || row.is_active !== true || row.deleted_at || row.type !== 'plm') {
      fail(403, 'SOURCE_FORBIDDEN')
    }
    const config = freshConfig(row)
    if (config.options?.apiMode !== 'yuantus') fail(403, 'ECO_SOURCE_CONFIG_REJECTED')
    return { fingerprint: sourceFingerprint(row), config }
  }

  private async fetch(
    dataSourceId: string,
    input: { itemId: string; ecoId: string; currentVersionId: string | null },
    config: DataSourceConfig,
  ): Promise<EcoCollaborationSource> {
    let adapter: { getEcoCollaborationSource?: (input: unknown, freshSourceConfig: DataSourceConfig) => Promise<unknown> }
    try {
      adapter = this.deps.dataSourceManager.getDataSource(dataSourceId) as typeof adapter
    } catch {
      fail(502, 'ECO_SOURCE_UNAVAILABLE')
    }
    if (typeof adapter.getEcoCollaborationSource !== 'function') fail(502, 'ECO_SOURCE_UNAVAILABLE')
    try {
      const raw = await adapter.getEcoCollaborationSource(
        parseEcoCollaborationSourceInput(input),
        config,
      )
      return raw as EcoCollaborationSource
    } catch (error) {
      throw this.translate(error)
    }
  }

  private accept(
    snapshot: EcoCollaborationSource,
    config: DataSourceConfig,
    input: { itemId: string; ecoId: string; currentVersionId: string | null },
  ) {
    try {
      const tenantId = fixedScope(config, 'x-tenant-id', 'tenantId')
      const orgId = fixedScope(config, 'x-org-id', 'orgId')
      const parsed = parseEcoCollaborationSource(snapshot, {
        tenantId,
        orgId,
        itemId: input.itemId,
        ecoId: input.ecoId,
        currentVersionId: input.currentVersionId,
      })
      const rowKey = ecoCollaborationRowKey({ dataSourceId: config.id, tenantId, orgId, ecoId: input.ecoId })
      return { tenantId, orgId, snapshot: parsed, rowKey, hash: ecoCollaborationBusinessHash(config.id, parsed) }
    } catch (error) {
      throw this.translate(error)
    }
  }

  private acceptFrozen(snapshot: EcoCollaborationSource, config: DataSourceConfig, preview: PreviewRow) {
    const accepted = this.accept(snapshot, config, {
      itemId: preview.item_id,
      ecoId: preview.row_key[3],
      currentVersionId: preview.current_version_id,
    })
    if (
      accepted.tenantId !== preview.native_tenant_id
      || accepted.orgId !== preview.native_org_id
      || !sameKey(accepted.rowKey, preview.row_key)
    ) fail(409, 'ECO_SOURCE_ANCHOR_MISMATCH')
    return accepted
  }

  private async readPreview(query: EcoQuery, actor: string, id: string, lock: boolean): Promise<PreviewRow | null> {
    const found = await query(
      `SELECT id, actor_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
              current_version_id, base_id, name, row_key, source_fingerprint, business_hash, captured_at,
              request_id, binding_id, consumed_at, (expires_at <= now()) AS expired
         FROM meta_plm_collaboration_previews
        WHERE id=$1::uuid AND actor_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, actor],
    )
    return previewFrom(found.rows[0])
  }

  private async readBinding(query: EcoQuery, id: string, lock: boolean): Promise<BindingRow | null> {
    const found = await query(
      `SELECT id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
              current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields,
              local_fields, version, status, last_failure_code, last_failure_at
         FROM meta_plm_collaboration_bindings WHERE id=$1::uuid${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return bindingFrom(found.rows[0])
  }

  private async replay(actor: string, input: ConfirmRequest) {
    return this.transaction(async (query) => {
      await this.runtime(query)
      const peeked = await this.readPreview(query, actor, input.previewId, false)
      if (!peeked) fail(404, 'NOT_FOUND')
      await this.lockSource(query, peeked.data_source_id)
      const preview = await this.readPreview(query, actor, input.previewId, true)
      if (!preview) fail(404, 'NOT_FOUND')
      if (preview.data_source_id !== peeked.data_source_id) fail(409, 'SOURCE_CHANGED')
      return this.replayLocked(query, actor, input, preview)
    })
  }

  private async replayLocked(query: EcoQuery, actor: string, input: ConfirmRequest, preview: PreviewRow) {
    if (!preview.request_id || !preview.binding_id || !preview.consumed_at) fail(409, 'REQUEST_CONFLICT')
    if (preview.request_id !== input.requestId) fail(409, 'REQUEST_CONFLICT')
    const conflict = await query(
      'SELECT id FROM meta_plm_collaboration_previews WHERE request_id=$1::uuid AND id<>$2::uuid',
      [input.requestId, preview.id],
    )
    if (conflict.rows[0]) fail(409, 'REQUEST_CONFLICT')
    if (input.targetBindingId && input.targetBindingId !== preview.binding_id) fail(409, 'TARGET_MISMATCH')
    await this.active(query, actor)
    await this.lockSource(query, preview.data_source_id)
    const binding = await this.readBinding(query, preview.binding_id, true)
    if (!binding || !sameFrozen(preview, binding)) fail(409, 'TARGET_MISMATCH')
    const admitted = await this.admit(query, actor, binding.data_source_id, 'share')
    if (admitted.fingerprint !== preview.source_fingerprint || admitted.fingerprint !== binding.source_fingerprint) {
      fail(409, 'SOURCE_CHANGED')
    }
    await this.authorizeSheet(query, actor, binding, true)
    const stored = await this.readStoredRow(query, binding.id, preview.row_key)
    return this.retained(binding, stored?.record_id ?? null, false, true)
  }

  private async provision(query: EcoQuery, actor: string, preview: PreviewRow, snapshot: EcoCollaborationSource) {
    const occupied = await query(
      `SELECT id FROM meta_plm_collaboration_bindings
        WHERE base_id=$1 AND data_source_id=$2 AND native_tenant_id=$3 AND native_org_id=$4
          AND item_id=$5 AND source_kind='eco' FOR UPDATE`,
      [preview.base_id, preview.data_source_id, preview.native_tenant_id, preview.native_org_id, preview.item_id],
    )
    if (occupied.rows[0]) fail(409, 'COLLECTION_CONFLICT')
    const bindingId = randomUUID()
    const sheetId = getObjectSheetId(NAMESPACE, preview.id)
    const viewId = getObjectViewId(NAMESPACE, preview.id, 'grid')
    const sourceFields = Object.fromEntries(ECO_COLLABORATION_ECO_FIELDS.map((key) => [key, getObjectFieldId(NAMESPACE, preview.id, key)]))
    const localFields = Object.fromEntries(ECO_COLLABORATION_LOCAL_FIELDS.map((field) => [field.key, getObjectFieldId(NAMESPACE, preview.id, field.key)]))
    const ids = [...Object.values(sourceFields), ...Object.values(localFields)]
    if (new Set(ids).size !== ids.length) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
    const present = await query('SELECT id FROM meta_fields WHERE id = ANY($1::text[])', [ids])
    if (present.rows.length > 0) fail(409, 'COLLECTION_CONFLICT')
    await fenceWriterEntry(query, sheetId)
    const sheet = await createSheet({ query, sheetId, baseId: preview.base_id, name: preview.name })
    if (!sheet.created) fail(409, 'COLLECTION_CONFLICT')
    const descriptors = [
      ...ECO_COLLABORATION_ECO_FIELDS.map((key, order) => ({
        id: sourceFields[key],
        name: key,
        type: 'string' as const,
        order,
        property: { readOnly: true, plmCollaborationSnapshot: { source: true, key } },
      })),
      ...ECO_COLLABORATION_LOCAL_FIELDS.map((field, index) => ({
        id: localFields[field.key],
        name: field.key,
        type: field.type,
        order: ECO_COLLABORATION_ECO_FIELDS.length + index,
        property: {},
      })),
    ]
    await ensureFields({ query, sheetId, fields: descriptors })
    const view = await createView({ query, sheetId, viewId, name: '全部', type: 'grid' })
    if (!view.created) fail(409, 'COLLECTION_CONFLICT')
    await query(
      "INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user',$2,'spreadsheet:admin')",
      [sheetId, actor],
    )
    await recordConfigRevision(query, {
      sheetId, entityType: 'sheet_config', entityId: sheetId, action: 'create', before: null,
      after: { name: preview.name, baseId: preview.base_id }, changedKeys: ['name', 'baseId'], batchId: bindingId, actorId: actor,
    })
    for (const field of descriptors) {
      await recordConfigRevision(query, {
        sheetId, entityType: 'field', entityId: field.id, action: 'create', before: null, after: field,
        changedKeys: ['name', 'type', 'property'], batchId: bindingId, actorId: actor,
      })
    }
    await recordConfigRevision(query, {
      sheetId, entityType: 'view', entityId: viewId, action: 'create', before: null,
      after: { name: '全部', type: 'grid' }, changedKeys: ['name', 'type'], batchId: bindingId, actorId: actor,
    })
    await recordConfigRevision(query, {
      sheetId, entityType: 'permission', entityId: `${sheetId}:${actor}`, action: 'create', before: null,
      after: { subject_type: 'user', subject_id: actor, perm_code: 'spreadsheet:admin' },
      changedKeys: ['subject_type', 'subject_id', 'perm_code'], batchId: bindingId, actorId: actor,
    })
    await query(
      `INSERT INTO meta_plm_collaboration_bindings (
         id, creator_id, data_source_id, source_kind, native_tenant_id, native_org_id, item_id,
         current_version_id, source_fingerprint, base_id, sheet_id, view_id, name, source_fields,
         local_fields, version, status
       ) VALUES (
         $1::uuid, $2, $3, 'eco', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, 1, 'active'
       )`,
      [
        bindingId, actor, preview.data_source_id, preview.native_tenant_id, preview.native_org_id,
        preview.item_id, preview.current_version_id, preview.source_fingerprint, preview.base_id,
        sheetId, viewId, preview.name, JSON.stringify(sourceFields), JSON.stringify(localFields),
      ],
    )
    const binding = await this.readBinding(query, bindingId, true)
    if (!binding) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
    const recordId = `rec_${randomUUID()}`
    await this.publishRow(query, actor, binding, null, recordId, snapshot, ecoCollaborationBusinessHash(binding.data_source_id, snapshot), 1, false)
    return { bindingId, sheetId, viewId, version: 1, status: 'active' as const, recordId, noop: false }
  }

  private async append(
    query: EcoQuery,
    actor: string,
    preview: PreviewRow,
    targetBindingId: string,
    expectedVersion: number,
    snapshot: EcoCollaborationSource,
  ) {
    const binding = await this.readBinding(query, targetBindingId, true)
    if (!binding || !sameFrozen(preview, binding)) fail(409, 'TARGET_MISMATCH')
    if (binding.creator_id !== actor || binding.status !== 'active' || binding.version !== expectedVersion) {
      fail(409, 'VERSION_CONFLICT')
    }
    await fenceWriterEntry(query, binding.sheet_id)
    await this.authorizeSheet(query, actor, binding, true)
    const stored = await this.readStoredRow(query, binding.id, preview.row_key)
    const recordId = stored?.record_id ?? `rec_${randomUUID()}`
    const version = await this.publishRow(query, actor, binding, stored, recordId, snapshot, ecoCollaborationBusinessHash(binding.data_source_id, snapshot), expectedVersion, true)
    return {
      bindingId: binding.id,
      sheetId: binding.sheet_id,
      viewId: binding.view_id,
      version,
      status: 'active' as const,
      recordId,
      noop: false,
    }
  }

  private async publishRow(
    query: EcoQuery,
    actor: string,
    binding: BindingRow,
    stored: StoredRow | null,
    recordId: string,
    snapshot: EcoCollaborationSource,
    hash: string,
    expectedVersion: number,
    advanceBinding: boolean,
  ): Promise<number> {
    if (!stored) await this.assertSourceFieldGrants(query, actor, binding)
    const version = advanceBinding
      ? await this.advance(query, binding, expectedVersion, actor)
      : binding.version
    if (!advanceBinding && binding.version !== expectedVersion) fail(409, 'VERSION_CONFLICT')
    await this.writeGuardedRow(query, actor, { ...binding, version }, stored, recordId, snapshot, hash)
    return version
  }

  private async writeSource(
    query: EcoQuery,
    actor: string,
    binding: BindingRow,
    stored: StoredRow,
    snapshot: EcoCollaborationSource,
    hash: string,
    expectedVersion: number,
  ) {
    await this.fieldAndLock(query, actor, binding, stored.record_id, true)
    const version = await this.advance(query, binding, expectedVersion, actor)
    await this.writeGuardedRow(query, actor, { ...binding, version }, stored, stored.record_id, snapshot, hash)
    return {
      bindingId: binding.id,
      sheetId: binding.sheet_id,
      viewId: binding.view_id,
      version,
      status: binding.status,
      recordId: stored.record_id,
      noop: false,
    }
  }

  private async advance(query: EcoQuery, binding: BindingRow, expectedVersion: number, actor: string): Promise<number> {
    if (binding.version !== expectedVersion) fail(409, 'VERSION_CONFLICT')
    const updated = await query(
      `UPDATE meta_plm_collaboration_bindings
          SET version = version + 1, updated_at = now()
        WHERE id=$1::uuid AND version=$2 AND status='active' AND creator_id=$3
        RETURNING version`,
      [binding.id, expectedVersion, actor],
    )
    if ((updated.rowCount ?? 0) !== 1) fail(409, 'VERSION_CONFLICT')
    return asVersion(updated.rows[0].version)
  }

  private async writeGuardedRow(
    query: EcoQuery,
    actor: string,
    binding: BindingRow,
    stored: StoredRow | null,
    recordId: string,
    snapshot: EcoCollaborationSource,
    hash: string,
  ): Promise<void> {
    this.requireWriterFence()
    const cells = sourceCells(snapshot, binding.source_fields)
    const ledger = await mintOperation(query, binding.sheet_id)
    if (ledger.operationId === null) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
    const syncId = randomUUID()
    const patch = {
      row_key: [...ecoCollaborationRowKey({
        dataSourceId: binding.data_source_id,
        tenantId: binding.native_tenant_id,
        orgId: binding.native_org_id,
        ecoId: snapshot.eco.id,
      })],
      data: cells,
      business_hash: hash,
      captured_at: snapshot.snapshot_at,
    }
    await query(
      `INSERT INTO meta_plm_collaboration_syncs (id, binding_id, actor_id, binding_version, patches)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
      [syncId, binding.id, actor, binding.version, JSON.stringify({ [recordId]: patch })],
    )
    await query(`SELECT set_config('metasheet.plm_collaboration_sync', $1, true)`, [syncId])
    if (!stored) {
      await query(
        `INSERT INTO meta_plm_collaboration_rows (binding_id, row_key, record_id, business_hash, captured_at)
         VALUES ($1::uuid, $2::jsonb, $3, $4, $5::timestamptz)`,
        [binding.id, JSON.stringify(patch.row_key), recordId, hash, snapshot.snapshot_at],
      )
      await query(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, locked, locked_by, locked_at)
         VALUES ($1, $2, $3::jsonb, 1, $4, $4, false, NULL, NULL)`,
        [recordId, binding.sheet_id, JSON.stringify(cells), actor],
      )
      await this.history(query, actor, binding.sheet_id, recordId, 1, 'create', Object.values(binding.source_fields), cells, cells, ledger)
    } else {
      const current = await this.readRecord(query, binding.sheet_id, recordId, true)
      if (!current) fail(409, 'VERSION_CONFLICT')
      await acquireRecordLinkRowAuthLockOnQuery(query, binding.sheet_id, recordId)
      await this.fieldAndLock(query, actor, binding, recordId, true)
      ensureRecordNotLocked(actor, current, () => new EcoCollaborationSnapshotError(403, 'FORBIDDEN'))
      const changed = Object.values(binding.source_fields).filter((id) => JSON.stringify(current.data[id] ?? null) !== JSON.stringify(cells[id] ?? null))
      await query(
        `UPDATE meta_plm_collaboration_rows
            SET business_hash=$1, captured_at=$2::timestamptz
          WHERE binding_id=$3::uuid AND record_id=$4`,
        [hash, snapshot.snapshot_at, binding.id, recordId],
      )
      const updated = await query(
        `UPDATE meta_records
            SET data = data || $1::jsonb, version = version + 1, modified_by=$2, updated_at=now()
          WHERE id=$3 AND sheet_id=$4 AND version=$5
          RETURNING version, data`,
        [JSON.stringify(cells), actor, recordId, binding.sheet_id, current.version],
      )
      if ((updated.rowCount ?? 0) !== 1) fail(409, 'VERSION_CONFLICT')
      const postimage = { ...current.data, ...cells }
      await this.history(query, actor, binding.sheet_id, recordId, Number(updated.rows[0].version), 'update', changed, cells, postimage, ledger)
    }
    if (!(await sealOperation(query, ledger))) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
    await query(`SELECT set_config('metasheet.plm_collaboration_sync', '', true)`, [])
  }

  private async history(
    query: EcoQuery,
    actor: string,
    sheetId: string,
    recordId: string,
    version: number,
    action: 'create' | 'update',
    changedFieldIds: string[],
    patch: Record<string, string | null>,
    snapshot: Record<string, unknown>,
    ledger: OperationLedger,
  ): Promise<void> {
    await recordRecordRevision(query, {
      sheetId,
      recordId,
      version,
      action,
      source: 'system_sync',
      actorId: actor,
      changedFieldIds,
      patch,
      snapshot,
      ledger,
    })
  }

  private async consume(query: EcoQuery, actor: string, preview: PreviewRow, requestId: string, bindingId: string): Promise<void> {
    const updated = await query(
      `UPDATE meta_plm_collaboration_previews AS preview
          SET request_id=$1::uuid, binding_id=$2::uuid, consumed_at=now()
        WHERE preview.id=$3::uuid AND preview.actor_id=$4
          AND preview.request_id IS NULL AND preview.binding_id IS NULL AND preview.consumed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM meta_plm_collaboration_bindings AS anchor
            WHERE anchor.id=$2::uuid
              AND anchor.data_source_id = preview.data_source_id
              AND anchor.source_kind = preview.source_kind
              AND anchor.native_tenant_id = preview.native_tenant_id
              AND anchor.native_org_id = preview.native_org_id
              AND anchor.item_id = preview.item_id
              AND anchor.current_version_id IS NOT DISTINCT FROM preview.current_version_id
              AND anchor.base_id = preview.base_id
              AND anchor.source_fingerprint = preview.source_fingerprint
          )`,
      [requestId, bindingId, preview.id, actor],
    )
    if ((updated.rowCount ?? 0) !== 1) fail(409, 'REQUEST_CONFLICT')
  }

  private requireWriterFence(): void {
    if (!isWriterFenceEnabled()) fail(503, 'ECO_RUNTIME_UNAVAILABLE')
  }

  private async assertExplicitTarget(
    query: EcoQuery,
    actor: string,
    preview: PreviewRow,
    targetBindingId: string,
    expectedVersion: number,
  ): Promise<FailureIdentity> {
    await this.lockSource(query, preview.data_source_id)
    const binding = await this.readBinding(query, targetBindingId, true)
    if (!binding || !sameFrozen(preview, binding)) fail(409, 'TARGET_MISMATCH')
    if (binding.creator_id !== actor || binding.status !== 'active' || binding.version !== expectedVersion) {
      fail(409, 'VERSION_CONFLICT')
    }
    await fenceWriterEntry(query, binding.sheet_id)
    await this.authorizeSheet(query, actor, binding, true)
    return failureIdentity(binding, expectedVersion)
  }

  private async loadRefresh(
    query: EcoQuery,
    actor: string,
    bindingId: string,
    input: RefreshRequest,
    mode: LockMode,
  ) {
    this.requireWriterFence()
    await this.runtime(query)
    await this.active(query, actor)
    const peeked = await this.readBinding(query, bindingId, false)
    if (!peeked) fail(404, 'NOT_FOUND')
    await this.lockSource(query, peeked.data_source_id)
    const binding = await this.readBinding(query, bindingId, true)
    if (!binding) fail(404, 'NOT_FOUND')
    if (binding.data_source_id !== peeked.data_source_id) fail(409, 'VERSION_CONFLICT')
    if (binding.creator_id !== actor) fail(403, 'FORBIDDEN')
    if (binding.status !== 'active') fail(409, 'BINDING_NOT_ACTIVE')
    if (binding.version !== input.expectedVersion) fail(409, 'VERSION_CONFLICT')
    await fenceWriterEntry(query, binding.sheet_id)
    await this.authorizeSheet(query, actor, binding, true)
    const source = await this.admit(query, actor, binding.data_source_id, mode)
    if (source.fingerprint !== binding.source_fingerprint) fail(409, 'SOURCE_CHANGED')
    const stored = await this.readStoredRow(query, binding.id, input.rowKey)
    if (!stored || !sameKey(stored.row_key, input.rowKey)) fail(409, 'ROW_KEY_MISMATCH')
    await this.fieldAndLock(query, actor, binding, stored.record_id, true)
    return { binding, stored, source }
  }

  private async sourceFieldBlocked(query: EcoQuery, actor: string, binding: BindingRow): Promise<boolean> {
    const scopes = await loadFieldPermissionScopeMap(query, binding.sheet_id, actor)
    const fields = await query(
      'SELECT id, type, property FROM meta_fields WHERE sheet_id=$1 AND id = ANY($2::text[])',
      [binding.sheet_id, Object.values(binding.source_fields)],
    )
    const byId = new Map((fields.rows as Array<{ id: string; property?: unknown }>).map((row) => [row.id, row]))
    return Object.values(binding.source_fields).some((id) => {
      const scope = scopes.get(id)
      const field = byId.get(id)
      return !field
        || isFieldPermissionHidden({ property: field.property as Record<string, unknown> | undefined })
        || scope?.visible === false
        || scope?.readOnly === true
    })
  }

  private async assertSourceFieldGrants(query: EcoQuery, actor: string, binding: BindingRow): Promise<void> {
    if (await this.sourceFieldBlocked(query, actor, binding)) fail(403, 'FORBIDDEN')
  }

  private async fieldAndLock(query: EcoQuery, actor: string, binding: BindingRow, recordId: string, enforce: boolean): Promise<boolean> {
    await acquireRecordLinkRowAuthLockOnQuery(query, binding.sheet_id, recordId)
    const record = await this.readRecord(query, binding.sheet_id, recordId, enforce)
    const blocked = await this.sourceFieldBlocked(query, actor, binding)
    const recordScope = (await loadRecordPermissionScopeMap(query, binding.sheet_id, [recordId], actor)).get(recordId)
    const denied = recordScope?.accessLevel === 'none' || recordScope?.accessLevel === 'read'
    let locked = false
    if (record) {
      try {
        ensureRecordNotLocked(actor, record, () => new EcoCollaborationSnapshotError(403, 'FORBIDDEN'))
      } catch (error) {
        if (!enforce) locked = true
        else throw error
      }
    }
    if (enforce && (blocked || denied || !record)) fail(403, 'FORBIDDEN')
    return !blocked && !denied && !locked && Boolean(record)
  }

  private async canRefresh(
    query: EcoQuery,
    actor: string,
    binding: BindingRow,
    stored: StoredRow | null,
    record: { data: Record<string, unknown>; version: number; locked?: unknown; locked_by?: unknown; created_by?: unknown } | null,
  ): Promise<boolean> {
    if (binding.status !== 'active' || binding.creator_id !== actor || !stored || !record) return false
    try {
      const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(query, binding.sheet_id, actor)
      if (!capabilities.canManageSheetAccess) return false
      await query(ADVISORY_SQL, [binding.data_source_id])
      const classified = await classifyManagedSourceOnQuery(query, binding.data_source_id)
      if (classified.kind !== 'unbound') return false
      const row = (await query(
        `SELECT ${SOURCE_COLUMNS} FROM data_sources WHERE id=$1 FOR SHARE`,
        [binding.data_source_id],
      )).rows[0] as Record<string, unknown> | undefined
      if (!row || row.owner_id !== actor || row.is_active !== true || row.deleted_at || row.type !== 'plm') return false
      if (sourceFingerprint(row) !== binding.source_fingerprint) return false
      return this.fieldAndLock(query, actor, binding, stored.record_id, false)
    } catch {
      return false
    }
  }

  private async visibleCells(
    query: EcoQuery,
    actor: string,
    binding: BindingRow,
    recordId: string | null,
    data: Record<string, unknown>,
  ): Promise<{ cells: Record<string, unknown>; sourceMetadataVisible: boolean }> {
    if (recordId) {
      const recordScope = (await loadRecordPermissionScopeMap(query, binding.sheet_id, [recordId], actor)).get(recordId)
      if (recordScope?.accessLevel === 'none') return { cells: {}, sourceMetadataVisible: false }
    }
    const scopes = await loadFieldPermissionScopeMap(query, binding.sheet_id, actor)
    const ids = [...Object.values(binding.source_fields), ...Object.values(binding.local_fields)]
    const fields = await query(
      'SELECT id, property FROM meta_fields WHERE sheet_id=$1 AND id = ANY($2::text[])',
      [binding.sheet_id, ids],
    )
    const hidden = new Set((fields.rows as Array<{ id: string; property?: unknown }>)
      .filter((row) => isFieldPermissionHidden({ property: row.property as Record<string, unknown> | undefined }) || scopes.get(row.id)?.visible === false)
      .map((row) => row.id))
    const present = new Set((fields.rows as Array<{ id: string }>).map((row) => row.id))
    const cells: Record<string, unknown> = {}
    for (const [key, id] of Object.entries({ ...binding.source_fields, ...binding.local_fields })) {
      if (!hidden.has(id) && Object.prototype.hasOwnProperty.call(data, id)) cells[key] = data[id]
    }
    const sourceMetadataVisible = ECO_COLLABORATION_ECO_FIELDS.every((key) => {
      const id = binding.source_fields[key]
      return typeof id === 'string' && id.length > 0 && present.has(id) && !hidden.has(id)
    })
    return { cells, sourceMetadataVisible }
  }

  private async readStoredRow(query: EcoQuery, bindingId: string, rowKey: readonly string[] | null): Promise<StoredRow | null> {
    const found = rowKey
      ? await query(
        `SELECT record_id, row_key, business_hash, captured_at
           FROM meta_plm_collaboration_rows WHERE binding_id=$1::uuid AND row_key=$2::jsonb`,
        [bindingId, JSON.stringify(rowKey)],
      )
      : await query(
        `SELECT record_id, row_key, business_hash, captured_at
           FROM meta_plm_collaboration_rows WHERE binding_id=$1::uuid ORDER BY record_id LIMIT 1`,
        [bindingId],
      )
    const row = found.rows[0]
    if (!row) return null
    return {
      record_id: String(row.record_id),
      row_key: asRowKey(row.row_key),
      business_hash: String(row.business_hash),
      captured_at: asText(row.captured_at) ?? '',
    }
  }

  private async readRecord(query: EcoQuery, sheetId: string, recordId: string, lock: boolean) {
    const found = await query(
      `SELECT id, data, version, locked, locked_by, locked_at, created_by
         FROM meta_records WHERE id=$1 AND sheet_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [recordId, sheetId],
    )
    const row = found.rows[0]
    if (!row) return null
    const data = typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown> : (row.data ?? {})
    return { ...row, data, version: Number(row.version) }
  }

  private previewShape(binding: BindingRow, stored: StoredRow): PreviewRow {
    return {
      id: binding.id,
      actor_id: binding.creator_id,
      data_source_id: binding.data_source_id,
      source_kind: binding.source_kind,
      native_tenant_id: binding.native_tenant_id,
      native_org_id: binding.native_org_id,
      item_id: binding.item_id,
      current_version_id: binding.current_version_id,
      base_id: binding.base_id,
      name: binding.name,
      row_key: stored.row_key,
      source_fingerprint: binding.source_fingerprint,
      business_hash: stored.business_hash,
      captured_at: stored.captured_at,
      request_id: null,
      binding_id: binding.id,
      consumed_at: null,
      expired: false,
    }
  }

  private anchor(binding: BindingRow) {
    return {
      dataSourceId: binding.data_source_id,
      tenantId: binding.native_tenant_id,
      orgId: binding.native_org_id,
      itemId: binding.item_id,
      currentVersionId: binding.current_version_id,
    }
  }

  private retained(binding: BindingRow, recordId: string | null, noop: boolean, replayed = false) {
    return {
      bindingId: binding.id,
      sheetId: binding.sheet_id,
      viewId: binding.view_id,
      version: binding.version,
      status: binding.status,
      recordId,
      noop,
      replayed,
    }
  }

  private async retainProviderFailure(actor: string, identity: FailureIdentity | null, error: unknown): Promise<unknown> {
    const translated = this.translate(error)
    if (!(translated instanceof EcoCollaborationSnapshotError) || !identity || !STALE_CODES.has(translated.code)) {
      return translated
    }
    try {
      await this.transaction(async (query) => {
        this.requireWriterFence()
        await this.runtime(query)
        await this.active(query, actor)
        await this.lockSource(query, identity.dataSourceId)
        const binding = await this.readBinding(query, identity.bindingId, true)
        if (!binding || !sameFailureIdentity(binding, identity)) return
        if (binding.creator_id !== actor || binding.status !== 'active' || binding.version !== identity.expectedVersion) return
        await fenceWriterEntry(query, binding.sheet_id)
        await this.authorizeSheet(query, actor, binding, true)
        const admitted = await this.admit(query, actor, binding.data_source_id, 'share')
        if (admitted.fingerprint !== identity.fingerprint) return
        await query(
          `UPDATE meta_plm_collaboration_bindings
              SET status='stale', version=version+1, updated_at=now(), last_failure_code=$4, last_failure_at=now()
            WHERE id=$1::uuid AND version=$2 AND status='active' AND creator_id=$3
              AND data_source_id=$5 AND source_kind=$6 AND native_tenant_id=$7 AND native_org_id=$8
              AND item_id=$9 AND current_version_id IS NOT DISTINCT FROM $10
              AND base_id=$11 AND name=$12 AND source_fingerprint=$13`,
          [
            binding.id, identity.expectedVersion, actor, translated.code,
            identity.dataSourceId, identity.sourceKind, identity.tenantId, identity.orgId,
            identity.itemId, identity.currentVersionId, identity.baseId, identity.name, identity.fingerprint,
          ],
        )
      })
    } catch {
      // The provider failure remains the result. A lost race does not resurrect or overwrite.
    }
    return translated
  }
}
