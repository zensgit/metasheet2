import { parsePlmChangePage, type PlmChangePageRequest, type PlmChangePage, parsePlmChangeEvent, hashPlmChangeEvent, type PlmChangeEvent } from './plm-change-ingress-wire'
import { bomReviewSourceFingerprint } from './plm-bom-source-navigation'
import { isElearningProjectionBaseIdCandidate } from './elearning-projection-constants'
import { randomUUID } from 'crypto'
import type { DataSourceConfig } from '../data-adapters/BaseAdapter'
import type { DataSourceManager } from '../data-adapters/DataSourceManager'
import {
  decryptStoredSecretValue,
  isEncryptedSecretValue,
} from '../security/encrypted-secrets'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import {
  lockRecordLinkAuthorityRowsOnQuery,
  resolveSheetCapabilitiesForUserOnQuery,
  isAdminOnQuery,
  listUserPermissionsOnQuery,
} from '../services/approval-record-link-txn-auth'
import { acquireRecordLinkRowAuthLockOnQuery } from '../services/approval-record-link-row-auth-lock'
import { deriveCapabilities } from './sheet-capabilities'
import {
  loadRecordPermissionScopeMap,
  loadFieldPermissionScopeMap,
} from './permission-service'
import { ensureRecordNotLocked } from './record-lock'
import { fenceWriterEntry, isWriterFenceEnabled } from './canonical-sheet-fence'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import { mintOperation, sealOperation } from './operation-ledger'
import { recordRecordRevision } from './record-history-service'
import { recordConfigRevision } from './config-revision-recorder'
import { isFieldPermissionHidden } from './permission-derivation'
import { insertRecordSubscriptionNotifications } from './record-subscription-service'
import { UpdateWebhookSchema, WEBHOOK_DEFAULT_MAX_RETRIES } from './webhooks'
import { WebhookService } from './webhook-service'
import {
  createSheet,
  ensureFields,
  createView,
  getObjectSheetId,
  getObjectFieldId,
  getObjectViewId,
} from './provisioning'
import type { PlmPool, PlmQuery } from './plm-bom-review-db'
import {
  BomReviewError as Failure,
  requireBomReview,
  previewInput,
  confirmInput,
  versionInput,
  notificationInput,
  completionWebhookInput,
  parseShareSnapshot,
  projectBomRows,
  SOURCE_FIELDS,
  LOCAL_FIELDS,
  hash,
  snapshotHash,
  canonical,
  type ShareSnapshot,
} from './plm-bom-review-wire'

export type BomReviewPool = PlmPool & { query: PlmQuery }
export type BomReviewDependencies = {
  pool: BomReviewPool
  dataSourceManager: Pick<DataSourceManager, 'getDataSource'>
}
type Binding = {
  id: string
  data_source_id: string
  part_id: string
  creator_id: string
  source_fingerprint: string
  source: ShareSnapshot['source']
  base_id: string
  sheet_id: string
  view_id: string
  name: string
  fields: Record<string, string>
  version: number
  status: 'active' | 'stale' | 'disabled'
  snapshot_hash: string
  last_synced_at: Date
  line_count: number
  occurrence_count: number
  owner_view_initialized: boolean
  status_views_initialized: boolean
}
type SourceRow = {
  id: string
  name: string
  type: string
  config: Record<string, any>
  owner_id: string
  is_active: boolean
  deleted_at: unknown
  workspace_id: unknown
  tenant_id: unknown
  scope_kind: unknown
  plm_bom_listener_authority_version?: string
}
type ChangeCursor = { generation: string; cursor: number; sequence: number }
type Adapter = {
  getPlmChangePage?(input: PlmChangePageRequest, config: DataSourceConfig): Promise<PlmChangePage>
  verifyPlmChangeEvent?(input: unknown, config: DataSourceConfig): Promise<PlmChangeEvent>
  getBomShareContext(partId: string, config: DataSourceConfig): Promise<unknown>
}

export class PlmBomReviewService {
  private readonly query: PlmQuery
  constructor(private readonly deps: BomReviewDependencies) {
    this.query = deps.pool.query.bind(deps.pool)
  }
  private async runtime(query: PlmQuery): Promise<void> {
    requireBomReview()
    if (!isWriterFenceEnabled() || !isDurableDeliveryEnabled())
      throw new Failure(503, 'RUNTIME_UNAVAILABLE')
    const schema = (
      await query(
        `SELECT to_regclass('meta_plm_bom_review_bindings') IS NOT NULL AND to_regclass('meta_plm_bom_review_state_fields') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('meta_plm_bom_review_bindings') AND attname='owner_view_initialized' AND NOT attisdropped) AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('meta_plm_bom_review_bindings') AND attname='status_views_initialized' AND NOT attisdropped) AND to_regclass('meta_config_revisions') IS NOT NULL AND to_regclass('meta_record_history_operations') IS NOT NULL AND to_regclass('meta_automation_outbox') IS NOT NULL AND to_regclass('meta_automation_outbox_consumer') IS NOT NULL AS ready`,
      )
    ).rows[0]
    if (!schema?.ready) throw new Failure(503, 'RUNTIME_UNAVAILABLE')
  }
  private async active(query: PlmQuery, actor: string): Promise<void> {
    const user = (
      await query(
        'SELECT is_active,role,activation_status,local_password_set FROM users WHERE id=$1 FOR SHARE',
        [actor],
      )
    ).rows[0]
    if (!user || evaluateUserAuthenticationGate(user))
      throw new Failure(403, 'FORBIDDEN')
  }
  private async base(
    query: PlmQuery,
    actor: string,
    baseId: string,
  ): Promise<void> {
    if (isElearningProjectionBaseIdCandidate(baseId))
      throw new Failure(403, 'FORBIDDEN')
    await lockRecordLinkAuthorityRowsOnQuery(query, {
      userId: actor,
      baseId,
      sheetId: '',
    })
    await this.active(query, actor)
    const row = (
      await query(
        'SELECT owner_id FROM meta_bases WHERE id=$1 AND deleted_at IS NULL',
        [baseId],
      )
    ).rows[0]
    const caps = deriveCapabilities(
      await listUserPermissionsOnQuery(query, actor),
      await isAdminOnQuery(query, actor),
    )
    if (!row || !(row.owner_id === actor || caps.canManageViews))
      throw new Failure(403, 'FORBIDDEN')
  }
  private async sheet(
    query: PlmQuery,
    actor: string,
    b: Binding,
    manage: boolean,
  ): Promise<void> {
    await lockRecordLinkAuthorityRowsOnQuery(query, {
      userId: actor,
      baseId: b.base_id,
      sheetId: b.sheet_id,
    })
    await this.active(query, actor)
    const alive = (
      await query(
        'SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id=s.base_id WHERE s.id=$1 AND s.base_id=$2 AND s.deleted_at IS NULL AND b.deleted_at IS NULL',
        [b.sheet_id, b.base_id],
      )
    ).rows[0]
    const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
      query,
      b.sheet_id,
      actor,
    )
    if (
      !alive ||
      !capabilities.canRead ||
      (manage && !capabilities.canManageSheetAccess)
    )
      throw new Failure(403, 'FORBIDDEN')
  }
  private async source(
    query: PlmQuery,
    actor: string,
    id: string,
    lock = false,
  ): Promise<{
    row: SourceRow
    fingerprint: string
    adapter: Adapter
    config: DataSourceConfig
  }> {
    const row = (
      await query(
        `SELECT * FROM data_sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
        [id],
      )
    ).rows[0] as SourceRow | undefined
    if (
      !row ||
      row.owner_id !== actor ||
      !row.is_active ||
      row.deleted_at ||
      row.type !== 'plm'
    )
      throw new Failure(403, 'SOURCE_FORBIDDEN')
    let adapter: Adapter
    try {
      adapter = this.deps.dataSourceManager.getDataSource(
        id,
      ) as unknown as Adapter
    } catch {
      throw new Failure(502, 'SOURCE_UNAVAILABLE')
    }
    if (typeof adapter.getBomShareContext !== 'function')
      throw new Failure(502, 'SOURCE_UNAVAILABLE')
    const credentials = row.config.credentials
      ? { ...row.config.credentials }
      : undefined
    if (credentials)
      for (const key of ['password', 'apiKey', 'token'])
        if (isEncryptedSecretValue(credentials[key]))
          credentials[key] = decryptStoredSecretValue(credentials[key])
    const currentConfig = {
      id: row.id,
      name: row.name,
      type: row.type,
      connection: row.config.connection || {},
      credentials,
      options: row.config.options,
      poolConfig: row.config.poolConfig,
    }
    return {
      row,
      adapter,
      config: currentConfig as DataSourceConfig,
      fingerprint: bomReviewSourceFingerprint(row),
    }
  }
  private async fetch(
    actor: string,
    id: string,
    partId: string,
  ): Promise<{ snapshot: ShareSnapshot; fingerprint: string }> {
    await this.runtime(this.query)
    await this.active(this.query, actor)
    const before = await this.source(this.query, actor, id)
    let raw: unknown, failure: unknown
    try {
      raw = await before.adapter.getBomShareContext(partId, before.config)
    } catch (e) {
      failure = e
    }
    const after = await this.source(this.query, actor, id)
    if (
      before.fingerprint !== after.fingerprint ||
      before.adapter !== after.adapter
    )
      throw new Failure(409, 'SOURCE_CHANGED')
    if (failure) {
      const status = (failure as { response?: { status?: number } })?.response
        ?.status
      throw new Failure(
        status === 401 || status === 403 ? 403 : 502,
        status === 401 || status === 403
          ? 'SOURCE_FORBIDDEN'
          : 'SOURCE_UNAVAILABLE',
      )
    }
    const snapshot = parseShareSnapshot(raw, partId)
    // The dedicated transport checks response scope against its explicit source headers.
    // The same persisted source config is held through commit; legacy adapter cache is not authority.
    projectBomRows(snapshot) // Validate repeated relationship occurrences before exposing a preview.
    return { snapshot, fingerprint: after.fingerprint }
  }
  async receiveChange(actor: string, input: unknown, cursor?: ChangeCursor) {
    const event = parsePlmChangeEvent(input)
    const context = async (query: PlmQuery) => {
      const b = await this.completionAccess(query, actor, event.binding_id)
      if (!(await query("SELECT to_regclass('meta_plm_bom_change_inbox') IS NOT NULL AS ready")).rows[0]?.ready)
        throw new Failure(503, 'RUNTIME_UNAVAILABLE')
      if (b.status !== 'active' || Number(b.version) !== event.binding_version ||
        event.source.connection_id !== b.data_source_id || event.source.part_id !== b.part_id ||
        event.source.tenant_id !== b.source.tenant_id || event.source.org_id !== b.source.org_id)
        throw new Failure(409, 'SOURCE_CHANGED')
      const source = await this.source(query, actor, b.data_source_id, true)
      const captured = (await query('SELECT listener_generation FROM meta_plm_bom_change_inbox WHERE binding_id=$1 AND event_id=$2',[b.id,event.event_id])).rows[0]
      const generation = cursor?.generation ?? captured?.listener_generation
      if (generation) await this.listenerAuthority(query,b,actor,source.fingerprint,generation)
      else if (source.fingerprint !== b.source_fingerprint) throw new Failure(409, 'SOURCE_CHANGED')
      if (event.change.kind === 'bom_line_writeback') {
        const row = (await query(`SELECT p.record_id FROM meta_plm_bom_review_rows p
          JOIN meta_records r ON r.id=p.record_id WHERE p.binding_id=$1 AND p.bom_line_id=$2
          AND r.sheet_id=$3 AND r.data->>$4='snapshot'`,
          [b.id,event.change.bom_line_id,b.sheet_id,b.fields.sync_status])).rows[0]
        if (!row || !await this.canReadNotificationRecord(query,actor,b,row.record_id,
          [b.fields.bom_line_id,b.fields.sync_status])) throw new Failure(403, 'FORBIDDEN')
      }
      const policy = (await query(`SELECT c.* FROM meta_plm_bom_review_completion_config c
        JOIN meta_config_revisions a ON a.id=c.revision_id WHERE c.binding_id=$1
        AND a.actor_id=c.updated_by AND a.sheet_id=$2 AND a.entity_type='sheet_config'
        AND lower(a.entity_id)='plm-bom-review:'||c.binding_id::text||':completion-webhooks'
        AND a.after->'webhooks'=c.webhooks FOR SHARE OF c,a`,[b.id,b.sheet_id])).rows[0]
      const rule = policy?.webhooks?.plmChangeApplied
      if (!rule?.enabled || rule.source !== event.change.kind || !rule.webhookId)
        throw new Failure(409, 'RULE_DISABLED')
      if (cursor) await this.checkChangeCursor(query,b.id,cursor)
      return { b,source,policy,rule }
    }
    const before = await this.deps.pool.transaction(({ query }) => context(query))
    if (typeof before.source.adapter.verifyPlmChangeEvent !== 'function') throw new Failure(502, 'SOURCE_UNAVAILABLE')
    let verified: PlmChangeEvent
    try {
      verified = parsePlmChangeEvent(await before.source.adapter.verifyPlmChangeEvent(event,before.source.config))
      if (hashPlmChangeEvent(verified) !== hashPlmChangeEvent(event)) throw new Failure(409, 'SOURCE_CHANGED')
    } catch (error) {
      if (error instanceof Failure) throw error
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 404 || status === 409) throw new Failure(409, 'SOURCE_CHANGED')
      throw new Failure(status === 401 || status === 403 ? 403 : 502,
        status === 401 || status === 403 ? 'SOURCE_FORBIDDEN' : 'SOURCE_UNAVAILABLE')
    }
    return this.deps.pool.transaction(async ({ query }) => {
      const after = await context(query)
      if (after.source.fingerprint !== before.source.fingerprint || after.source.adapter !== before.source.adapter ||
        after.policy.revision_id !== before.policy.revision_id) throw new Failure(409, 'SOURCE_CHANGED')
      const digest = hashPlmChangeEvent(verified)
      const existing = (await query('SELECT payload_hash,receipt FROM meta_plm_bom_change_inbox WHERE binding_id=$1 AND event_id=$2',
        [event.binding_id,event.event_id])).rows[0]
      if (existing) {
        if (existing.payload_hash !== digest) throw new Failure(409, 'EVENT_CONFLICT')
        if (cursor) await this.advanceChangeCursor(query,event.binding_id,cursor)
        return existing.receipt
      }
      const receipt = { eventId: event.event_id,bindingId: event.binding_id,verified: true }
      await query(`INSERT INTO meta_plm_bom_change_inbox(binding_id,event_id,payload_hash,payload,receipt,
        source_fingerprint,verified_by,configuration_revision_id,creator_id,webhook_id,listener_generation)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [event.binding_id,event.event_id,digest,JSON.stringify(verified),JSON.stringify(receipt),
          after.source.fingerprint,actor,after.policy.revision_id,after.policy.updated_by,after.rule.webhookId,cursor?.generation ?? null])
      if (cursor) await this.advanceChangeCursor(query,event.binding_id,cursor)
      return receipt
    })
  }
  private async listenerAuthority(query: PlmQuery, b: Binding, actor: string, fingerprint: string, generation: string) {
    const listener = (await query(`SELECT generation FROM meta_plm_bom_change_listeners
      WHERE binding_id=$1 AND generation=$2 AND owner_id=$3 AND source_fingerprint=$4
        AND binding_version=$5 AND status='active' FOR SHARE`,[b.id,generation,actor,fingerprint,b.version])).rows[0]
    if (!listener) throw new Failure(403,'LISTENER_STOPPED')
  }
  private async listenerContext(query: PlmQuery, actor: string, id: string) {
    const b = await this.completionAccess(query,actor,id)
    if (!(await query("SELECT to_regclass('meta_plm_bom_change_listeners') IS NOT NULL AS ready")).rows[0]?.ready)
      throw new Failure(503,'RUNTIME_UNAVAILABLE')
    if (b.status !== 'active') throw new Failure(409,'SOURCE_CHANGED')
    const source = await this.source(query,actor,b.data_source_id,true)
    const owner = (await query('SELECT * FROM users WHERE id=$1',[actor])).rows[0]
    if (!source.row.plm_bom_listener_authority_version || !owner?.plm_bom_listener_authority_version)
      throw new Failure(503,'RUNTIME_UNAVAILABLE')
    const policy = (await query(`SELECT c.* FROM meta_plm_bom_review_completion_config c
      JOIN meta_config_revisions a ON a.id=c.revision_id WHERE c.binding_id=$1
      AND a.actor_id=c.updated_by AND a.sheet_id=$2 AND a.entity_type='sheet_config'
      AND lower(a.entity_id)='plm-bom-review:'||c.binding_id::text||':completion-webhooks'
      AND a.after->'webhooks'=c.webhooks FOR SHARE OF c,a`,[id,b.sheet_id])).rows[0]
    if (!policy?.webhooks?.plmChangeApplied?.enabled) throw new Failure(409,'RULE_DISABLED')
    return { b,source,policy,ownerAuthorityVersion: String(owner.plm_bom_listener_authority_version) }
  }
  private async checkChangeCursor(query: PlmQuery, id: string, cursor: ChangeCursor) {
    const row = (await query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1 FOR UPDATE',[id])).rows[0]
    if (!row || row.status !== 'active' || row.generation !== cursor.generation ||
      Number(row.cursor) !== cursor.cursor || cursor.sequence !== cursor.cursor+1)
      throw new Failure(409,'LISTENER_CHANGED')
    const current = await this.listenerContext(query,row.owner_id,id)
    if (row.source_fingerprint !== current.source.fingerprint ||
      Number(row.binding_version) !== Number(current.b.version) || row.configuration_revision_id !== current.policy.revision_id)
      throw new Failure(409,'SOURCE_CHANGED')
  }
  private async advanceChangeCursor(query: PlmQuery, id: string, cursor: ChangeCursor) {
    await query(`UPDATE meta_plm_bom_change_listeners SET cursor=$3,updated_at=clock_timestamp()
      WHERE binding_id=$1 AND generation=$2`,[id,cursor.generation,cursor.sequence])
  }
  async changeListener(actor: string, id: string, input?: unknown) {
    // GET exposes only status to current sheet managers; it cannot start a listener.
    if (input === undefined) return this.deps.pool.transaction(async ({ query }) => {
      await this.completionAccess(query,actor,id)
      const row = (await query('SELECT generation,cursor,status,stop_reason FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[id])).rows[0]
      return row ? { ...row,cursor: Number(row.cursor) } : { status: 'not_started' }
    })
    const { expectedVersion } = versionInput.parse(input)
    const before = await this.deps.pool.transaction(async ({ query }) => {
      const context = await this.listenerContext(query,actor,id)
      if (Number(context.b.version) !== expectedVersion) throw new Failure(409,'VERSION_CONFLICT')
      const prior = (await query('SELECT generation,cursor,status FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[id])).rows[0]
      return { ...context,priorGeneration: prior?.generation,priorCursor: prior?.cursor,priorStatus: prior?.status }
    })
    if (!before.source.adapter.getPlmChangePage) throw new Failure(502,'SOURCE_UNAVAILABLE')
    const version = expectedVersion
    if (!Number.isSafeInteger(version)) throw new Failure(409,'VERSION_CONFLICT')
    const request = { binding_id: id,binding_version: version,source: {
      connection_id: before.b.data_source_id,tenant_id: before.b.source.tenant_id,
      org_id: before.b.source.org_id,part_id: before.b.part_id } }
    let baseline: PlmChangePage
    try { baseline = parsePlmChangePage(await before.source.adapter.getPlmChangePage(request,before.source.config),request) }
    catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      throw new Failure(status === 401 || status === 403 ? 403 : 502,'SOURCE_UNAVAILABLE')
    }
    return this.deps.pool.transaction(async ({ query }) => {
      const after = await this.listenerContext(query,actor,id)
      if (Number(after.b.version) !== expectedVersion || after.source.fingerprint !== before.source.fingerprint ||
        after.source.row.plm_bom_listener_authority_version !== before.source.row.plm_bom_listener_authority_version ||
        after.ownerAuthorityVersion !== before.ownerAuthorityVersion ||
        after.source.adapter !== before.source.adapter || after.policy.revision_id !== before.policy.revision_id)
        throw new Failure(409,'SOURCE_CHANGED')
      const previous = (await query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1 FOR UPDATE',[id])).rows[0]
      if (previous?.generation !== before.priorGeneration || previous?.cursor !== before.priorCursor ||
        previous?.status !== before.priorStatus) throw new Failure(409,'LISTENER_CHANGED')
      const generation = randomUUID()
      // Listener authority is separate from the immutable original snapshot/source binding.
      await query(`INSERT INTO meta_plm_bom_change_listeners(binding_id,generation,owner_id,source_fingerprint,
        binding_version,configuration_revision_id,cursor,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active')
        ON CONFLICT(binding_id) DO UPDATE SET generation=EXCLUDED.generation,owner_id=EXCLUDED.owner_id,
        source_fingerprint=EXCLUDED.source_fingerprint,binding_version=EXCLUDED.binding_version,
        configuration_revision_id=EXCLUDED.configuration_revision_id,cursor=EXCLUDED.cursor,status='active',
        stop_reason=NULL,updated_at=clock_timestamp()`,
        [id,generation,actor,after.source.fingerprint,version,after.policy.revision_id,baseline.next_sequence])
      await recordConfigRevision(query,{ sheetId: after.b.sheet_id,entityType: 'sheet_config',
        entityId: `plm-bom-review:${id}:change-listener`,action: previous ? 'update' : 'create',
        before: previous ? { generation: previous.generation,cursor: Number(previous.cursor),owner: previous.owner_id } : null,
        after: { generation,cursor: baseline.next_sequence,owner: actor,bindingVersion: version },
        changedKeys: ['listener'],batchId: randomUUID(),actorId: actor,id: randomUUID() })
      return { status: 'active',generation,cursor: baseline.next_sequence,bindingVersion: version }
    })
  }
  async pollChanges(id: string) {
    const listener = (await this.query("SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1 AND status='active'",[id])).rows[0]
    if (!listener) return { state: 'inactive' }
    try {
      const before = await this.deps.pool.transaction(async ({ query }) => {
        // Keep the same binding-before-listener lock order as intake and explicit rebind.
        const context = await this.listenerContext(query,listener.owner_id,id)
        await this.checkChangeCursor(query,id,{ generation: listener.generation,cursor: Number(listener.cursor),sequence: Number(listener.cursor)+1 })
        return context
      })
      if (!before.source.adapter.getPlmChangePage) throw new Failure(502,'SOURCE_UNAVAILABLE')
      const request = { binding_id: id,binding_version: Number(before.b.version),after_sequence: Number(listener.cursor),
        source: { connection_id: before.b.data_source_id,tenant_id: before.b.source.tenant_id,
          org_id: before.b.source.org_id,part_id: before.b.part_id } }
      const page = parsePlmChangePage(await before.source.adapter.getPlmChangePage(request,before.source.config),request)
      let cursor = Number(listener.cursor)
      for (const entry of page.events) {
        const progress = { generation: listener.generation,cursor,sequence: entry.sequence }
        if (entry.event.change.kind === before.policy.webhooks.plmChangeApplied.source)
          await this.receiveChange(listener.owner_id,entry.event,progress)
        else await this.deps.pool.transaction(async ({ query }) => {
          await this.listenerContext(query,listener.owner_id,id)
          await this.checkChangeCursor(query,id,progress)
          await this.advanceChangeCursor(query,id,progress)
        })
        cursor = entry.sequence
      }
      // Even an empty response must not hide an ownership/revocation change during the HTTP await.
      await this.deps.pool.transaction(async ({ query }) => {
        await this.listenerContext(query,listener.owner_id,id)
        await this.checkChangeCursor(query,id,{ generation: listener.generation,cursor,sequence: cursor+1 })
      })
      return { state: 'active',cursor }
    } catch (error) {
      if (error instanceof Failure && error.code === 'LISTENER_CHANGED') return { state: 'superseded' }
      const status = error instanceof Failure ? error.status : (error as { response?: { status?: number } })?.response?.status
      if (status && [401,403,404,409].includes(status)) {
        await this.query(`UPDATE meta_plm_bom_change_listeners SET status='stopped',stop_reason='AUTHORITY_CHANGED',
          updated_at=clock_timestamp() WHERE binding_id=$1 AND generation=$2 AND status='active'`,[id,listener.generation])
        return { state: 'stopped' }
      }
      return { state: 'waiting' }
    }
  }
  private dto(b: Binding, actor: string, manage: boolean) {
    return {
      id: b.id,
      version: Number(b.version),
      dataSourceId: b.data_source_id,
      partId: b.part_id,
      baseId: b.base_id,
      sheetId: b.sheet_id,
      viewId: b.view_id,
      name: b.name,
      status: b.status,
      lastSyncedAt: new Date(b.last_synced_at).toISOString(),
      sourceSnapshotHash: b.snapshot_hash,
      lineCount: b.line_count,
      occurrenceCount: b.occurrence_count,
      navigationPath: `/multitable/${encodeURIComponent(b.sheet_id)}/${encodeURIComponent(b.view_id)}`,
      canRefresh: manage && b.creator_id === actor && b.status !== 'disabled',
      canDisable: manage && b.creator_id === actor && b.status !== 'disabled',
      canConfigureNotifications: manage,
    }
  }
  async bases(actor: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await this.active(query, actor)
      const bases = (
        await query(
          'SELECT id,name FROM meta_bases WHERE deleted_at IS NULL ORDER BY id',
        )
      ).rows
      const items = []
      for (const b of bases) {
        try {
          await this.base(query, actor, b.id)
          items.push(b)
        } catch (e) {
          if (!(e instanceof Failure && e.code === 'FORBIDDEN')) throw e
        }
      }
      return { items }
    })
  }
  async preview(actor: string, input: unknown) {
    const v = previewInput.parse(input)
    await this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await this.base(query, actor, v.baseId)
    })
    const { snapshot, fingerprint } = await this.fetch(
      actor,
      v.dataSourceId,
      v.partId,
    )
    const previewId = randomUUID(),
      expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      digest = snapshotHash(snapshot)
    await this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await this.base(query, actor, v.baseId)
      const source = await this.source(query, actor, v.dataSourceId, true)
      if (source.fingerprint !== fingerprint)
        throw new Failure(409, 'SOURCE_CHANGED')
      await query(
        `INSERT INTO meta_plm_bom_review_previews(id,actor_id,data_source_id,part_id,base_id,name,source_fingerprint,snapshot_hash,source,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          previewId,
          actor,
          v.dataSourceId,
          v.partId,
          v.baseId,
          v.name,
          fingerprint,
          digest,
          JSON.stringify(snapshot.source),
          expiresAt,
        ],
      )
    })
    return {
      previewId,
      expiresAt,
      snapshotHash: digest,
      snapshotAt: snapshot.snapshot_at,
      part: {
        partId: snapshot.context.part.part_id,
        itemNumber: snapshot.context.part.item_number,
        name: snapshot.context.part.name,
      },
      lineCount: projectBomRows(snapshot).size,
      occurrenceCount: snapshot.context.lines.length,
      source: {
        tenantId: snapshot.source.tenant_id,
        orgId: snapshot.source.org_id,
        authUserId: snapshot.source.auth_user_id,
        partId: snapshot.source.part_id,
      },
    }
  }
  async create(actor: string, input: unknown) {
    const v = confirmInput.parse(input)
    await this.runtime(this.query)
    const p = (
      await this.query(
        'SELECT * FROM meta_plm_bom_review_previews WHERE id=$1 AND actor_id=$2',
        [v.previewId, actor],
      )
    ).rows[0]
    if (!p) throw new Failure(404, 'NOT_FOUND')
    // Replays recheck live authority but do not refetch or mutate snapshot/history.
    if (p.binding_id) return this.replay(actor, p, v.requestId)
    if (new Date(p.expires_at).getTime() <= Date.now())
      throw new Failure(409, 'PREVIEW_EXPIRED')
    const fetched = await this.fetch(actor, p.data_source_id, p.part_id)
    if (
      fetched.fingerprint !== p.source_fingerprint ||
      snapshotHash(fetched.snapshot) !== p.snapshot_hash ||
      canonical(fetched.snapshot.source) !== canonical(p.source)
    )
      throw new Failure(409, 'SOURCE_CHANGED')
    const id = randomUUID(),
      sheetId = getObjectSheetId('plm-bom-review', v.previewId),
      viewId = getObjectViewId('plm-bom-review', v.previewId, 'grid')
    return this.deps.pool
      .transaction(async ({ query }) => {
        await this.runtime(query)
        await fenceWriterEntry(query, sheetId)
        const locked = (
          await query(
            'SELECT * FROM meta_plm_bom_review_previews WHERE id=$1 AND actor_id=$2 FOR UPDATE',
            [v.previewId, actor],
          )
        ).rows[0]
        if (!locked) throw new Failure(404, 'NOT_FOUND')
        if (locked.binding_id)
          return this.replayInTxn(query, actor, locked, v.requestId)
        if (new Date(locked.expires_at).getTime() <= Date.now())
          throw new Failure(409, 'PREVIEW_EXPIRED')
        await this.base(query, actor, p.base_id)
        const source = await this.source(query, actor, p.data_source_id, true)
        if (source.fingerprint !== fetched.fingerprint)
          throw new Failure(409, 'SOURCE_CHANGED')
        const fields = Object.fromEntries(
          SOURCE_FIELDS.map((k) => [
            k,
            getObjectFieldId('plm-bom-review', v.previewId, k),
          ]),
        )
        const descriptors = [
          ...SOURCE_FIELDS.map((k) => ({
            id: fields[k],
            name: `PLM ${k}`,
            type: 'string' as const,
            property: { readOnly: true },
          })),
          ...LOCAL_FIELDS.map((f) => ({
            ...f,
            id: getObjectFieldId('plm-bom-review', v.previewId, f.id),
            property:
              'property' in f ? { options: [...f.property.options] } : {},
          })),
        ]
        await createSheet({ query, sheetId, baseId: p.base_id, name: p.name })
        await ensureFields({ query, sheetId, fields: descriptors })
        await createView({
          query,
          sheetId,
          viewId,
          name: '全部',
          type: 'grid',
        })
        await query(
          "INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES($1,'user',$2,'spreadsheet:admin')",
          [sheetId, actor],
        )
        for (const f of descriptors)
          await recordConfigRevision(query, {
            sheetId,
            entityType: 'field',
            entityId: f.id,
            action: 'create',
            before: null,
            after: f,
            changedKeys: ['name', 'type', 'property'],
            batchId: id,
            actorId: actor,
          })
        await recordConfigRevision(query, {
          sheetId,
          entityType: 'permission',
          entityId: `${sheetId}:${actor}`,
          action: 'create',
          before: null,
          after: {
            subject_type: 'user',
            subject_id: actor,
            perm_code: 'spreadsheet:admin',
          },
          changedKeys: ['subject_type', 'subject_id', 'perm_code'],
          batchId: id,
          actorId: actor,
        })
        const b = (
          await query(
            `INSERT INTO meta_plm_bom_review_bindings(id,data_source_id,part_id,creator_id,source_fingerprint,source,base_id,sheet_id,view_id,name,fields,status,snapshot_hash,last_synced_at,line_count,occurrence_count)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,'active',$12,$13,$14,$15) RETURNING *`,
            [
              id,
              p.data_source_id,
              p.part_id,
              actor,
              fetched.fingerprint,
              JSON.stringify(fetched.snapshot.source),
              p.base_id,
              sheetId,
              viewId,
              p.name,
              JSON.stringify(fields),
              p.snapshot_hash,
              fetched.snapshot.snapshot_at,
              projectBomRows(fetched.snapshot).size,
              fetched.snapshot.context.lines.length,
            ],
          )
        ).rows[0] as Binding
        await this.initializeOwnerView(query, actor, b, v.previewId)
        await query(
          'INSERT INTO meta_plm_bom_review_state_fields(binding_id,field_id,owner_field_id,due_field_id) VALUES($1,$2,$3,$4)',
          [b.id, getObjectFieldId('plm-bom-review', v.previewId, 'status'), getObjectFieldId('plm-bom-review', v.previewId, 'owner'), getObjectFieldId('plm-bom-review', v.previewId, 'due_date')],
        )
        await this.initializeStatusViews(query,actor,b,v.previewId)
        await this.writeSnapshot(query, actor, b, fetched.snapshot)
        await query(
          'UPDATE meta_plm_bom_review_previews SET request_id=$2,binding_id=$3 WHERE id=$1',
          [v.previewId, v.requestId, id],
        )
        return this.dto(b, actor, true)
      })
      .catch((error: unknown) => {
        const violation = error as { code?: string; constraint?: string }
        if (
          violation.code === '23505' &&
          violation.constraint === 'meta_plm_bom_review_previews_request_id_key'
        )
          throw new Failure(409, 'BINDING_CONFLICT')
        throw error
      })
  }
  private async replay(actor: string, p: any, requestId: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await fenceWriterEntry(query, getObjectSheetId('plm-bom-review', p.id))
      return this.replayInTxn(query, actor, p, requestId)
    })
  }
  private async replayInTxn(
    query: PlmQuery,
    actor: string,
    p: any,
    requestId: string,
  ) {
    if (p.request_id !== requestId) throw new Failure(409, 'BINDING_CONFLICT')
    const b = (
      await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [
        p.binding_id,
      ])
    ).rows[0] as Binding
    await this.sheet(query, actor, b, true)
    const source = await this.source(query, actor, b.data_source_id, true)
    if (source.fingerprint !== b.source_fingerprint)
      throw new Failure(409, 'SOURCE_CHANGED')
    return this.dto(b, actor, true)
  }
  async list(actor: string, dataSourceId: string, partId: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await this.active(query, actor)
      const bindings = (
        await query(
          'SELECT * FROM meta_plm_bom_review_bindings WHERE data_source_id=$1 AND part_id=$2 ORDER BY created_at,id',
          [dataSourceId, partId],
        )
      ).rows as Binding[]
      const items = []
      for (const b of bindings) {
        try {
          await this.sheet(query, actor, b, false)
        } catch (e) {
          if (e instanceof Failure && e.code === 'FORBIDDEN') continue
          throw e
        }
        const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
          query,
          b.sheet_id,
          actor,
        )
        items.push(this.dto(b, actor, capabilities.canManageSheetAccess))
      }
      return { items }
    })
  }
  async refresh(actor: string, id: string, input: unknown) {
    const { expectedVersion } = versionInput.parse(input)
    const b = await this.bindingForChange(actor, id, expectedVersion)
    let fetched: Awaited<ReturnType<PlmBomReviewService['fetch']>>
    try {
      fetched = await this.fetch(actor, b.data_source_id, b.part_id)
      if (
        fetched.fingerprint !== b.source_fingerprint ||
        canonical(fetched.snapshot.source) !== canonical(b.source)
      )
        throw new Failure(409, 'SOURCE_CHANGED')
    } catch (e) {
      // Only an authorized, current attempt may mark this stored snapshot stale; data is retained.
      if (e instanceof Failure)
        await this.deps.pool.transaction(async ({ query }) => {
          await fenceWriterEntry(query, b.sheet_id)
          await this.sheet(query, actor, b, true)
          await query(
            "UPDATE meta_plm_bom_review_bindings SET status='stale',version=version+1,last_failure_code=$3,last_failure_at=now() WHERE id=$1 AND version=$2 AND status<>'disabled'",
            [id, expectedVersion, e.code],
          )
        })
      throw e
    }
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await fenceWriterEntry(query, b.sheet_id)
      const current = (
        await query(
          'SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Binding
      this.checkVersion(current, actor, expectedVersion)
      await this.sheet(query, actor, current, true)
      const source = await this.source(
        query,
        actor,
        current.data_source_id,
        true,
      )
      if (source.fingerprint !== fetched.fingerprint)
        throw new Failure(409, 'SOURCE_CHANGED')
      await this.initializeOwnerView(query, actor, current)
      await this.initializeStatusViews(query,actor,current)
      await this.writeSnapshot(query, actor, current, fetched.snapshot)
      const updated = (
        await query(
          "UPDATE meta_plm_bom_review_bindings SET version=version+1,status='active',snapshot_hash=$2,last_synced_at=$3,line_count=$4,occurrence_count=$5,last_failure_code=null,last_failure_at=null WHERE id=$1 RETURNING *",
          [
            id,
            snapshotHash(fetched.snapshot),
            fetched.snapshot.snapshot_at,
            projectBomRows(fetched.snapshot).size,
            fetched.snapshot.context.lines.length,
          ],
        )
      ).rows[0]
      return this.dto(updated, actor, true)
    })
  }
  private checkVersion(
    b: Binding | undefined,
    actor: string,
    version: number,
  ): asserts b is Binding {
    if (!b) throw new Failure(404, 'NOT_FOUND')
    if (b.creator_id !== actor) throw new Failure(403, 'FORBIDDEN')
    if (Number(b.version) !== version || b.status === 'disabled')
      throw new Failure(409, 'VERSION_CONFLICT')
  }
  private async bindingForChange(
    actor: string,
    id: string,
    version: number,
  ): Promise<Binding> {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const b = (
        await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [
          id,
        ])
      ).rows[0] as Binding
      this.checkVersion(b, actor, version)
      await this.sheet(query, actor, b, true)
      return b
    })
  }
  async scanNotifications(id: string, now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw new Failure(400, 'INVALID_REQUEST')
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const candidate = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [id])).rows[0] as Binding
      if (!candidate) throw new Failure(404, 'NOT_FOUND')
      await fenceWriterEntry(query, candidate.sheet_id)
      const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR SHARE', [id])).rows[0] as Binding
      if (b.status === 'disabled') return { created: 0 }
      const config = (await query('SELECT * FROM meta_plm_bom_review_notification_config WHERE binding_id=$1 FOR SHARE', [id])).rows[0]
      if (!config) return { created: 0 }
      const policy = notificationInput.parse({ expectedVersion: Number(config.version), notifications: config.notifications }).notifications
      const actor = String(config.updated_by)
      await this.sheet(query, actor, b, true)
      const mapping = (await query('SELECT * FROM meta_plm_bom_review_state_fields WHERE binding_id=$1', [id])).rows[0]
      if (!mapping) throw new Failure(409, 'REVIEW_STATE_NOT_INITIALIZED')
      const fields = [mapping.field_id,mapping.owner_field_id,mapping.due_field_id,b.fields.sync_status]
      await query('SELECT field_id FROM field_permissions WHERE sheet_id=$1 AND field_id=ANY($2::text[]) FOR SHARE', [b.sheet_id,fields])
      const scopes = await loadFieldPermissionScopeMap(query,b.sheet_id,actor)
      const metadata = (await query('SELECT id,property FROM meta_fields WHERE sheet_id=$1 AND id=ANY($2::text[]) FOR SHARE', [b.sheet_id,fields])).rows
      const readable = (field: string) => metadata.some((f) => f.id === field && !isFieldPermissionHidden(f)) && scopes.get(field)?.visible !== false
      if (!readable(mapping.field_id) || !readable(b.fields.sync_status)) throw new Failure(403, 'FORBIDDEN')
      const canReadDue = policy.reminder.enabled && readable(mapping.due_field_id)
      const records = (await query('SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 ORDER BY record_id', [id])).rows
      let created = 0
      for (const entry of records) {
        await acquireRecordLinkRowAuthLockOnQuery(query,b.sheet_id,entry.record_id)
        const scope = (await loadRecordPermissionScopeMap(query,b.sheet_id,[entry.record_id],actor)).get(entry.record_id)
        if (scope?.accessLevel === 'none') continue
        const canReadOwner = readable(mapping.owner_field_id)
        const row = (await query(`SELECT r.id,r.data->>$2 AS state,r.data->>$3 AS sync_status,
          CASE WHEN $4::boolean THEN r.data->>$5 ELSE NULL END AS due_text,
          CASE WHEN $7::boolean THEN r.data->$8 ELSE NULL END AS current_owners,
          CASE WHEN $7::boolean THEN c.issue_owner_ids ELSE NULL END AS issue_owners,
          c.round,c.issue_started_at,c.completed_at
          FROM meta_records r JOIN meta_plm_bom_review_rounds c ON c.record_id=r.id
          WHERE r.id=$1 AND r.sheet_id=$6 ORDER BY c.round DESC LIMIT 1 FOR UPDATE OF r`,
          [entry.record_id,mapping.field_id,b.fields.sync_status,canReadDue,mapping.due_field_id,b.sheet_id,canReadOwner,mapping.owner_field_id])).rows[0]
        if (!row || row.sync_status !== 'snapshot' || row.state === '已完成' || row.completed_at) continue
        const events: Array<{ kind: string; key: string }> = []
        if (policy.issue.enabled && row.issue_started_at && readable(mapping.owner_field_id)) events.push({ kind: 'issue',key: 'issue' })
        const due = row.due_text ? new Date(row.due_text).getTime() : NaN
        if (canReadDue && canReadOwner && Number.isFinite(due) && due-policy.reminder.leadMinutes!*60000 <= now.getTime())
          events.push({ kind: 'reminder',key: new Date(due).toISOString() })
        if (policy.escalation.enabled && row.issue_started_at &&
          new Date(row.issue_started_at).getTime()+policy.escalation.slaMinutes!*60000 <= now.getTime())
          events.push({ kind: 'escalation',key: 'escalation' })
        for (const event of events) {
          const result = await query(`INSERT INTO meta_plm_bom_review_notification_events
            (id,binding_id,record_id,round,kind,occurrence_key,configuration_version,configuration_revision_id,creator_id,owner_ids)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(record_id,round,kind,occurrence_key) DO NOTHING RETURNING id`,
            [randomUUID(),id,row.id,row.round,event.kind,event.key,config.version,config.revision_id,actor,
              JSON.stringify(event.kind === 'issue' ? (row.issue_owners ?? []) : event.kind === 'reminder' ? (row.current_owners ?? []) : [])])
          created += result.rows.length
        }
      }
      return { created }
    })
  }
  private async canReadNotificationRecord(query: PlmQuery, actor: string, b: Binding, recordId: string, fields: string[]) {
    try { await this.sheet(query,actor,b,false) }
    catch (e) { if (e instanceof Failure && e.code === 'FORBIDDEN') return false; throw e }
    await acquireRecordLinkRowAuthLockOnQuery(query,b.sheet_id,recordId)
    if ((await loadRecordPermissionScopeMap(query,b.sheet_id,[recordId],actor)).get(recordId)?.accessLevel === 'none') return false
    await query('SELECT field_id FROM field_permissions WHERE sheet_id=$1 AND field_id=ANY($2::text[]) FOR SHARE',[b.sheet_id,fields])
    const scopes = await loadFieldPermissionScopeMap(query,b.sheet_id,actor)
    const metadata = (await query('SELECT id,property FROM meta_fields WHERE sheet_id=$1 AND id=ANY($2::text[]) FOR SHARE',[b.sheet_id,fields])).rows
    return fields.every((field) => metadata.some((f) => f.id === field && !isFieldPermissionHidden(f)) && scopes.get(field)?.visible !== false)
  }
  private async notificationContext(query: PlmQuery, event: Record<string,unknown>, now: Date) {
    const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR SHARE',[event.binding_id])).rows[0] as Binding
    const config = (await query(`SELECT c.*,a.after AS audited FROM meta_plm_bom_review_notification_config c
      JOIN meta_config_revisions a ON a.id=c.revision_id WHERE c.binding_id=$1 FOR SHARE OF c,a`,[event.binding_id])).rows[0]
    if (!b || b.status === 'disabled' || !config || Number(config.version) < Number(event.configuration_version) || config.updated_by !== event.creator_id
      || canonical(config.notifications) !== canonical(config.audited?.notifications)) return null
    const policy = notificationInput.parse({ expectedVersion: Number(config.version),notifications: config.notifications }).notifications
    const kind = String(event.kind)
    if (kind !== 'issue' && kind !== 'reminder' && kind !== 'escalation') return null
    const rule = policy[kind]
    if (!rule.enabled) return null
    const original = (await query(`SELECT after AS audited FROM meta_config_revisions WHERE id=$1 AND sheet_id=$2
      AND actor_id=$3 AND entity_type='sheet_config' AND lower(entity_id)=lower($4) FOR SHARE`,
      [event.configuration_revision_id,b.sheet_id,event.creator_id,`plm-bom-review:${b.id}:notifications`])).rows[0]
    const recorded = notificationInput.safeParse({ expectedVersion: Number(event.configuration_version),notifications: original?.audited?.notifications })
    // A sibling rule edit must not consume an otherwise unchanged pending occurrence.
    if (!recorded.success || canonical(recorded.data.notifications[kind]) !== canonical(rule)) return null
    const mapping = (await query('SELECT * FROM meta_plm_bom_review_state_fields WHERE binding_id=$1',[event.binding_id])).rows[0]
    if (!mapping) return null
    try { await this.sheet(query,String(event.creator_id),b,true) }
    catch (e) { if (e instanceof Failure && e.code === 'FORBIDDEN') return null; throw e }
    const fields = [mapping.field_id,b.fields.sync_status,
      ...(kind === 'escalation' ? [] : [mapping.owner_field_id]), ...(kind === 'reminder' ? [mapping.due_field_id] : [])]
    if (!await this.canReadNotificationRecord(query,String(event.creator_id),b,String(event.record_id),fields)) return null
    const row = (await query(`SELECT r.data->>$2 AS state,r.data->>$3 AS sync_status,
      CASE WHEN $4::boolean THEN r.data->$5 ELSE NULL END AS current_owners,
      CASE WHEN $6::boolean THEN r.data->>$7 ELSE NULL END AS due_text,c.round,c.issue_started_at,c.completed_at
      FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id AND l.binding_id=$8
      JOIN meta_plm_bom_review_rounds c ON c.record_id=r.id
      WHERE r.id=$1 AND r.sheet_id=$9 ORDER BY c.round DESC LIMIT 1 FOR UPDATE OF r`,
      [event.record_id,mapping.field_id,b.fields.sync_status,kind !== 'escalation',mapping.owner_field_id,kind === 'reminder',mapping.due_field_id,b.id,b.sheet_id])).rows[0]
    if (!row || String(row.round) !== String(event.round) || row.completed_at || row.state === '已完成' || row.sync_status !== 'snapshot') return null
    if (kind === 'issue' && !row.issue_started_at) return null
    if (kind === 'reminder') {
      const due = row.due_text ? new Date(row.due_text).getTime() : NaN
      if (!Number.isFinite(due) || new Date(due).toISOString() !== event.occurrence_key || due-policy.reminder.leadMinutes!*60000 > now.getTime()) return null
    }
    if (kind === 'escalation' && (!row.issue_started_at || new Date(row.issue_started_at).getTime()+policy.escalation.slaMinutes!*60000 > now.getTime())) return null
    return { b,mapping,policy,row,kind }
  }
  async prepareNotification(eventId: string, now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw new Failure(400,'INVALID_REQUEST')
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const candidate = (await query(`SELECT e.*,b.sheet_id FROM meta_plm_bom_review_notification_events e
        JOIN meta_plm_bom_review_bindings b ON b.id=e.binding_id WHERE e.id=$1`,[eventId])).rows[0]
      if (!candidate) throw new Failure(404,'NOT_FOUND')
      await fenceWriterEntry(query,candidate.sheet_id)
      const existing = (await query('SELECT * FROM meta_plm_bom_review_notification_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
      if (existing) return { state: String(existing.state) }
      if (await this.bindingDisabled(query,String(candidate.binding_id))) {
        await query("INSERT INTO meta_plm_bom_review_notification_intents(event_id,recipient_ids,state,cancellation_reason) VALUES($1,'[]'::jsonb,'cancelled','BINDING_DISABLED')",[eventId])
        return { state: 'cancelled' }
      }
      const context = await this.notificationContext(query,candidate,now)
      let recipients: string[] = [], reason: string | null = context ? null : 'CONTEXT_INVALID'
      if (context) {
        const strategy = context.kind === 'issue' ? context.policy.issue.recipientStrategy : context.policy.reminder.recipientStrategy
        const raw: unknown = context.kind === 'escalation' ? context.policy.escalation.recipientUserIds
          : strategy === 'event_owner' ? candidate.owner_ids : (context.row.current_owners ?? [])
        if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id.trim())) reason = 'RECIPIENT_INVALID'
        else recipients = [...new Set(raw.map((id: string) => id.trim()))].sort()
        if (!reason && !recipients.length) {
          if (context.kind !== 'escalation' && strategy === 'current_owner') return { state: 'waiting' }
          reason = 'NO_RECIPIENTS'
        }
        for (const user of recipients) if (!await this.canReadNotificationRecord(query,user,context.b,String(candidate.record_id),
          [context.mapping.field_id,context.b.fields.sync_status,...(context.kind === 'reminder' ? [context.mapping.due_field_id] : [])])) reason = 'RECIPIENT_FORBIDDEN'
      }
      const state = reason ? 'cancelled' : 'prepared'
      await query('INSERT INTO meta_plm_bom_review_notification_intents(event_id,recipient_ids,state,cancellation_reason) VALUES($1,$2::jsonb,$3,$4)',
        [eventId,JSON.stringify(recipients),state,reason])
      return { state }
    })
  }
  async deliverNotification(eventId: string, now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw new Failure(400,'INVALID_REQUEST')
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const event = (await query(`SELECT e.*,b.sheet_id FROM meta_plm_bom_review_notification_events e
        JOIN meta_plm_bom_review_bindings b ON b.id=e.binding_id WHERE e.id=$1`,[eventId])).rows[0]
      if (!event) throw new Failure(404,'NOT_FOUND')
      await fenceWriterEntry(query,event.sheet_id)
      const intent = (await query('SELECT * FROM meta_plm_bom_review_notification_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
      if (!intent || intent.state !== 'prepared') return { state: intent ? String(intent.state) : 'unprepared',inserted: 0 }
      if (await this.bindingDisabled(query,String(event.binding_id))) {
        await query("UPDATE meta_plm_bom_review_notification_intents SET state='cancelled',cancellation_reason='BINDING_DISABLED' WHERE event_id=$1",[eventId])
        return { state: 'cancelled',inserted: 0 }
      }
      const context = await this.notificationContext(query,event,now)
      let valid = Boolean(context) && Array.isArray(intent.recipient_ids) && intent.recipient_ids.length > 0
        && intent.recipient_ids.every((id: unknown) => typeof id === 'string' && id.trim() === id && id.length > 0)
        && new Set(intent.recipient_ids).size === intent.recipient_ids.length
      if (context && valid) for (const user of intent.recipient_ids) if (!await this.canReadNotificationRecord(query,user,context.b,String(event.record_id),
        [context.mapping.field_id,context.b.fields.sync_status,...(context.kind === 'reminder' ? [context.mapping.due_field_id] : [])])) valid = false
      if (!valid || !context) {
        await query("UPDATE meta_plm_bom_review_notification_intents SET state='cancelled',cancellation_reason='CONTEXT_OR_RECIPIENT_INVALID' WHERE event_id=$1",[eventId])
        return { state: 'cancelled',inserted: 0 }
      }
      const result = await insertRecordSubscriptionNotifications(query,{
        userIds: intent.recipient_ids,sheetId: context.b.sheet_id,recordId: String(event.record_id),
        eventType: 'notification.sent',actorId: String(event.creator_id),
        sourceEventId: `bom-review:${eventId}`,
        message: { issue: 'BOM 评审问题通知',reminder: 'BOM 评审截止提醒',escalation: 'BOM 评审问题 SLA 升级' }[context.kind as 'issue' | 'reminder' | 'escalation'],
      })
      const receipts = (await query(`SELECT user_id FROM meta_record_subscription_notifications WHERE source_event_id=$1
        AND sheet_id=$2 AND record_id=$3 AND actor_id=$4 AND event_type='notification.sent'`,
        [`bom-review:${eventId}`,context.b.sheet_id,event.record_id,event.creator_id])).rows
      if (receipts.length !== intent.recipient_ids.length || receipts.some((r) => !intent.recipient_ids.includes(r.user_id)))
        throw new Failure(503,'NOTIFICATION_WRITE_INCOMPLETE')
      await query("UPDATE meta_plm_bom_review_notification_intents SET state='delivered',delivered_at=now() WHERE event_id=$1",[eventId])
      return { state: 'delivered',inserted: result.inserted }
    })
  }
  private async bindingDisabled(query: PlmQuery, id: string): Promise<boolean> {
    return (await query('SELECT status FROM meta_plm_bom_review_bindings WHERE id=$1 FOR SHARE',[id])).rows[0]?.status === 'disabled'
  }
  async notificationRecipients(actor: string, id: string, search: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [id])).rows[0] as Binding
      if (!b) throw new Failure(404, 'NOT_FOUND')
      await this.sheet(query, actor, b, true)
      const candidates = (await query(`SELECT id,name FROM users WHERE is_active=true
        AND (id=$1 OR position(lower($1) in lower(coalesce(name,'')))>0) ORDER BY id LIMIT 30`, [search])).rows
      const items = []
      for (const user of candidates) {
        try { await this.sheet(query, String(user.id), b, false) }
        catch (e) { if (e instanceof Failure && e.code === 'FORBIDDEN') continue; throw e }
        items.push({ id: String(user.id), name: user.name || String(user.id) })
      }
      return { items }
    })
  }
  async notifications(actor: string, id: string, input?: unknown) {
    const change = input === undefined ? undefined : notificationInput.parse(input)
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const candidate = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [id])).rows[0] as Binding
      if (!candidate) throw new Failure(404, 'NOT_FOUND')
      await fenceWriterEntry(query, candidate.sheet_id)
      const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR UPDATE', [id])).rows[0] as Binding
      if (!b) throw new Failure(404, 'NOT_FOUND')
      await this.sheet(query, actor, b, true)
      if (!(await query('SELECT binding_id FROM meta_plm_bom_review_state_fields WHERE binding_id=$1', [id])).rows[0])
        throw new Failure(409, 'REVIEW_STATE_NOT_INITIALIZED')
      const before = (await query('SELECT * FROM meta_plm_bom_review_notification_config WHERE binding_id=$1 FOR UPDATE', [id])).rows[0]
      const version = Number(before?.version ?? 0)
      if (!change) return { version, notifications: before?.notifications ?? null }
      if (change.expectedVersion !== version || version === Number.MAX_SAFE_INTEGER)
        throw new Failure(409, 'VERSION_CONFLICT')
      for (const user of change.notifications.escalation.enabled ? [...change.notifications.escalation.recipientUserIds].sort() : [])
        await this.sheet(query, user, b, false)
      if (before && canonical(before.notifications) === canonical(change.notifications))
        return { version, notifications: before.notifications }
      const revisionId = randomUUID()
      await query(`INSERT INTO meta_plm_bom_review_notification_config(binding_id,version,notifications,updated_by,revision_id)
        VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(binding_id) DO UPDATE SET version=EXCLUDED.version,
        notifications=EXCLUDED.notifications,updated_by=EXCLUDED.updated_by,revision_id=EXCLUDED.revision_id,updated_at=now()`,
        [id,version+1,JSON.stringify(change.notifications),actor,revisionId])
      await recordConfigRevision(query, {
        sheetId: b.sheet_id, entityType: 'sheet_config', entityId: `plm-bom-review:${id}:notifications`,
        action: before ? 'update' : 'create', before: before ? { notifications: before.notifications } : null,
        after: { notifications: change.notifications }, changedKeys: ['notifications'], batchId: randomUUID(), actorId: actor, id: revisionId,
      })
      return { version: version+1, notifications: change.notifications }
    })
  }
  private async completionEventContext(query: PlmQuery, event: Record<string,unknown>) {
    const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR SHARE',[event.binding_id])).rows[0] as Binding
    const config = (await query(`SELECT c.*,a.after AS audited FROM meta_plm_bom_review_completion_config c
      JOIN meta_config_revisions a ON a.id=c.revision_id AND a.sheet_id=$2 AND a.actor_id=c.updated_by
      AND a.entity_type='sheet_config' AND lower(a.entity_id)=$3
      WHERE c.binding_id=$1 FOR SHARE OF c,a`,[event.binding_id,b?.sheet_id,`plm-bom-review:${event.binding_id}:completion-webhooks`])).rows[0]
    if (!b || b.status !== 'active' || !config || config.updated_by !== event.creator_id
      || canonical(config.webhooks) !== canonical(config.audited?.webhooks)) return null
    const origin = (await query(`SELECT after FROM meta_config_revisions WHERE id=$1 AND sheet_id=$2 AND actor_id=$3
      AND entity_type='sheet_config' AND lower(entity_id)=$4`,
      [event.configuration_revision_id,b.sheet_id,event.creator_id,`plm-bom-review:${b.id}:completion-webhooks`])).rows[0]
    const original = completionWebhookInput.safeParse({ expectedVersion: 0,webhooks: origin?.after?.webhooks })
    const current = completionWebhookInput.safeParse({ expectedVersion: Number(config.version),webhooks: config.webhooks })
    if (!original.success || !current.success) return null
    const plm = event.event_type === 'bom.plm_change.applied'
    const rule = plm ? current.data.webhooks.plmChangeApplied : current.data.webhooks.reviewCompleted
    const originalRule = plm ? original.data.webhooks.plmChangeApplied : original.data.webhooks.reviewCompleted
    if (canonical(rule) !== canonical(originalRule) || !rule.enabled || rule.webhookId !== event.webhook_id) return null
    if (!plm && current.data.webhooks.reviewCompleted.granularity !== 'row') return null
    try { await this.sheet(query,String(event.creator_id),b,true); await this.completionEgress(query,String(event.creator_id)) }
    catch (e) { if (e instanceof Failure && (e.code === 'FORBIDDEN' || e.code === 'WEBHOOK_SEND_FORBIDDEN')) return null; throw e }
    if (plm) {
      const fact = (await query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1 AND event_id=$2',
        [b.id,event.plm_event_id])).rows[0]
      if (!fact || fact.configuration_revision_id !== event.configuration_revision_id ||
        current.data.webhooks.plmChangeApplied.source !== fact.payload.change.kind ||
        Number(fact.payload.binding_version) !== Number(b.version)) return null
      try {
        await this.sheet(query,fact.verified_by,b,true)
        const source = await this.source(query,fact.verified_by,b.data_source_id,true)
        if (source.fingerprint !== fact.source_fingerprint) return null
        if (fact.listener_generation) await this.listenerAuthority(query,b,fact.verified_by,source.fingerprint,fact.listener_generation)
        else if (source.fingerprint !== b.source_fingerprint) return null
      } catch (error) { if (error instanceof Failure) return null; throw error }
      if (fact.payload.change.kind === 'bom_line_writeback') {
        const row = (await query(`SELECT l.record_id FROM meta_plm_bom_review_rows l JOIN meta_records r ON r.id=l.record_id
          WHERE l.binding_id=$1 AND l.bom_line_id=$2 AND r.sheet_id=$3 AND r.data->>$4='snapshot'`,
          [b.id,fact.payload.change.bom_line_id,b.sheet_id,b.fields.sync_status])).rows[0]
        if (!row) return null
        for (const actor of [fact.verified_by,String(event.creator_id)])
          if (!await this.canReadNotificationRecord(query,actor,b,row.record_id,[b.fields.bom_line_id,b.fields.sync_status])) return null
      }
    } else {
      const fact = (await query('SELECT * FROM meta_plm_bom_review_completion_occurrences WHERE id=$1',[event.occurrence_id])).rows[0]
      if (!fact || fact.binding_id !== b.id || fact.configuration_revision_id !== event.configuration_revision_id
        || Number(config.version) < Number(fact.configuration_version)) return null
      const mapping = (await query('SELECT field_id FROM meta_plm_bom_review_state_fields WHERE binding_id=$1',[b.id])).rows[0]
      if (!mapping || !await this.canReadNotificationRecord(query,String(event.creator_id),b,String(fact.record_id),
        [mapping.field_id,b.fields.sync_status,b.fields.bom_line_id])) return null
      const row = (await query(`SELECT r.data->>$2 AS state,r.data->>$3 AS sync_status,c.round,c.completed_at
        FROM meta_records r JOIN meta_plm_bom_review_rows l ON l.record_id=r.id AND l.binding_id=$4
        JOIN meta_plm_bom_review_rounds c ON c.record_id=r.id WHERE r.id=$1 AND r.sheet_id=$5
        ORDER BY c.round DESC LIMIT 1 FOR UPDATE OF r`,[fact.record_id,mapping.field_id,b.fields.sync_status,b.id,b.sheet_id])).rows[0]
      if (!row || String(row.round) !== String(fact.round) || !row.completed_at || row.state !== '已完成' || row.sync_status !== 'snapshot') return null
    }
    const webhook = (await query('SELECT * FROM multitable_webhooks WHERE id=$1 AND created_by=$2 AND active=true FOR SHARE',
      [event.webhook_id,event.creator_id])).rows[0]
    if (!webhook) return null
    const retry = UpdateWebhookSchema.safeParse({ maxRetries: webhook.max_retries ?? WEBHOOK_DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: webhook.retry_base_delay_ms ?? undefined,retryMaxDelayMs: webhook.retry_max_delay_ms ?? undefined })
    if (!retry.success) return null
    let url: URL
    try { url = new URL(webhook.url) } catch { return null }
    if (!['http:','https:'].includes(url.protocol) || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) return null
    return { webhook,retry: retry.data,
      fingerprint: hash({ id: webhook.id,creator: webhook.created_by,url: webhook.url,secret: webhook.secret,retry: retry.data }) }
  }
  async prepareCompletion(eventId: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      const event = (await query(`SELECT e.*,b.sheet_id FROM meta_plm_bom_review_completion_events e
        JOIN meta_plm_bom_review_bindings b ON b.id=e.binding_id WHERE e.id=$1`,[eventId])).rows[0]
      if (!event) throw new Failure(404,'NOT_FOUND')
      await fenceWriterEntry(query,event.sheet_id)
      const existing = (await query('SELECT * FROM meta_plm_bom_review_completion_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
      if (existing && existing.state !== 'prepared') return { state: String(existing.state) }
      const context = await this.completionEventContext(query,event)
      if (existing) {
        if (!context || existing.destination_fingerprint !== context.fingerprint) {
          await query("UPDATE meta_plm_bom_review_completion_intents SET state='cancelled',cancellation_reason='CONTEXT_INVALID',lease_id=NULL,lease_until=NULL,next_retry_at=NULL WHERE event_id=$1",[eventId])
          return { state: 'cancelled' }
        }
        return { state: 'prepared' }
      }
      const state = context ? 'prepared' : 'cancelled'
      await query(`INSERT INTO meta_plm_bom_review_completion_intents(event_id,destination_fingerprint,state,cancellation_reason)
        VALUES($1,$2,$3,$4)`,[eventId,context?.fingerprint ?? null,state,context ? null : 'CONTEXT_INVALID'])
      return { state }
    })
  }
  async deliverCompletion(eventId: string) {
    const prepared = await this.prepareCompletion(eventId)
    if (prepared.state !== 'prepared') return prepared
    const sourceFact = (await this.query(`SELECT i.* FROM meta_plm_bom_review_completion_events e
      JOIN meta_plm_bom_change_inbox i ON i.binding_id=e.binding_id AND i.event_id=e.plm_event_id WHERE e.id=$1`,[eventId])).rows[0]
    if (sourceFact) {
      try { await this.receiveChange(sourceFact.verified_by,sourceFact.payload) }
      catch (error) {
        if (!(error instanceof Failure) || error.status >= 500) return { state: 'waiting' }
        return this.deps.pool.transaction(async ({ query }) => {
          const b = (await query('SELECT sheet_id FROM meta_plm_bom_review_bindings WHERE id=$1',[sourceFact.binding_id])).rows[0]
          if (!b) return { state: 'cancelled' }
          await fenceWriterEntry(query,b.sheet_id)
          const intent = (await query('SELECT state FROM meta_plm_bom_review_completion_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
          if (intent.state !== 'prepared') return { state: String(intent.state) }
          await query("UPDATE meta_plm_bom_review_completion_intents SET state='cancelled',cancellation_reason='SOURCE_INVALID',lease_id=NULL,lease_until=NULL,next_retry_at=NULL WHERE event_id=$1",[eventId])
          return { state: 'cancelled' }
        })
      }
    }
    // Commit the attempt reservation before network I/O. A process crash cannot refund its budget.
    const reservation = await this.deps.pool.transaction(async ({ query }) => {
      const event = (await query(`SELECT e.*,b.sheet_id FROM meta_plm_bom_review_completion_events e
        JOIN meta_plm_bom_review_bindings b ON b.id=e.binding_id WHERE e.id=$1`,[eventId])).rows[0]
      await fenceWriterEntry(query,event.sheet_id)
      const intent = (await query('SELECT *,clock_timestamp() AS db_now FROM meta_plm_bom_review_completion_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
      if (intent.state !== 'prepared') return { state: String(intent.state) }
      const now = new Date(intent.db_now).getTime()
      if ((intent.lease_until && new Date(intent.lease_until).getTime()>now) || (intent.next_retry_at && new Date(intent.next_retry_at).getTime()>now)) return { state: 'waiting' }
      const context = await this.completionEventContext(query,event)
      if (!context || context.fingerprint !== intent.destination_fingerprint || intent.attempt_count >= Math.max(1,context.retry.maxRetries!)) {
        await query("UPDATE meta_plm_bom_review_completion_intents SET state='cancelled',cancellation_reason=$2,lease_id=NULL,lease_until=NULL,next_retry_at=NULL WHERE event_id=$1",
          [eventId,!context || context.fingerprint !== intent.destination_fingerprint ? 'CONTEXT_INVALID'
            : intent.lease_id ? 'OUTCOME_UNKNOWN' : 'ATTEMPTS_EXHAUSTED'])
        return { state: 'cancelled' }
      }
      const lease = randomUUID()
      await query("UPDATE meta_plm_bom_review_completion_intents SET attempt_count=attempt_count+1,lease_id=$2,lease_until=clock_timestamp()+interval '30 seconds',next_retry_at=NULL WHERE event_id=$1",[eventId,lease])
      return { state: 'reserved',lease }
    })
    if (reservation.state !== 'reserved') return { state: reservation.state }
    return this.deps.pool.transaction(async ({ query }) => {
      const event = (await query(`SELECT e.*,b.sheet_id FROM meta_plm_bom_review_completion_events e
        JOIN meta_plm_bom_review_bindings b ON b.id=e.binding_id WHERE e.id=$1`,[eventId])).rows[0]
      await fenceWriterEntry(query,event.sheet_id)
      const intent = (await query('SELECT * FROM meta_plm_bom_review_completion_intents WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0]
      if (intent.state !== 'prepared' || intent.lease_id !== reservation.lease) return { state: String(intent.state) }
      const context = await this.completionEventContext(query,event)
      if (!context || context.fingerprint !== intent.destination_fingerprint) {
        await query("UPDATE meta_plm_bom_review_completion_intents SET state='cancelled',cancellation_reason='CONTEXT_INVALID',lease_id=NULL,lease_until=NULL,next_retry_at=NULL WHERE event_id=$1",[eventId])
        return { state: 'cancelled' }
      }
      const clock = (await query('SELECT clock_timestamp() AS now')).rows[0].now
      if (new Date(intent.lease_until).getTime() <= new Date(clock).getTime()) return { state: 'waiting' }
      const body = JSON.stringify(event.payload)
      const headers: Record<string,string> = { 'Content-Type': 'application/json','X-Webhook-Id': String(event.webhook_id),
        'X-Webhook-Event': String(event.event_type),'X-Webhook-Timestamp': new Date().toISOString(),
        'Idempotency-Key': String(event.id),'X-Webhook-Delivery-Id': String(event.id) }
      if (context.webhook.secret) headers['X-Webhook-Signature'] = WebhookService.signPayload(body,context.webhook.secret)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(),5000)
      let status: number | null = null, ok = false
      try {
        const response = await fetch(context.webhook.url,{ method: 'POST',headers,body,redirect: 'error',signal: controller.signal })
        status = response.status; ok = response.ok
        await response.body?.cancel()
      } catch { /* Network failures and redirects retain the same logical event for a bounded retry. */ }
      finally { clearTimeout(timer) }
      const exhausted = intent.attempt_count >= Math.max(1,context.retry.maxRetries!)
      const state = ok ? 'delivered' : exhausted ? 'cancelled' : 'prepared'
      const delay = WebhookService.computeBackoffMs(intent.attempt_count,context.retry.retryBaseDelayMs,context.retry.retryMaxDelayMs)
      await query(`UPDATE meta_plm_bom_review_completion_intents SET state=$2,last_http_status=$3,
        delivered_at=CASE WHEN $2='delivered' THEN clock_timestamp() ELSE NULL END,
        cancellation_reason=CASE WHEN $2='cancelled' THEN CASE WHEN $3::integer IS NULL THEN 'OUTCOME_UNKNOWN' ELSE 'ATTEMPTS_EXHAUSTED' END ELSE NULL END,
        lease_id=NULL,lease_until=NULL,next_retry_at=CASE WHEN $2='prepared' THEN clock_timestamp()+$4*interval '1 millisecond' ELSE NULL END WHERE event_id=$1`,
        [eventId,state,status,delay])
      return { state }
    })
  }
  private async completionAccess(query: PlmQuery, actor: string, id: string): Promise<Binding> {
    await this.runtime(query)
    const candidate = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1', [id])).rows[0] as Binding
    if (!candidate) throw new Failure(404, 'NOT_FOUND')
    await fenceWriterEntry(query, candidate.sheet_id)
    const b = (await query('SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR UPDATE', [id])).rows[0] as Binding
    if (!b) throw new Failure(404, 'NOT_FOUND')
    await this.sheet(query, actor, b, true)
    if (!(await query('SELECT binding_id FROM meta_plm_bom_review_state_fields WHERE binding_id=$1',[id])).rows[0])
      throw new Failure(409, 'REVIEW_STATE_NOT_INITIALIZED')
    return b
  }
  private async completionEgress(query: PlmQuery, actor: string): Promise<void> {
    if (!(await isAdminOnQuery(query,actor)) && !(await listUserPermissionsOnQuery(query,actor)).includes('multitable:send_webhook'))
      throw new Failure(403, 'WEBHOOK_SEND_FORBIDDEN')
  }
  async completionWebhookDestinations(actor: string, id: string) {
    return this.deps.pool.transaction(async ({ query }) => {
      await this.completionAccess(query,actor,id)
      await this.completionEgress(query,actor)
      const rows = (await query(`SELECT id,name FROM multitable_webhooks WHERE created_by=$1 AND active=true ORDER BY name,id LIMIT 100`,[actor])).rows
      // Destination selection is explicit; this does not subscribe the BOM to global fan-out.
      return rows.map((row) => ({ id: String(row.id),name: String(row.name) }))
    })
  }
  async completionWebhooks(actor: string, id: string, input?: unknown) {
    const change = input === undefined ? undefined : completionWebhookInput.parse(input)
    return this.deps.pool.transaction(async ({ query }) => {
      const b = await this.completionAccess(query,actor,id)
      const before = (await query('SELECT * FROM meta_plm_bom_review_completion_config WHERE binding_id=$1 FOR UPDATE',[id])).rows[0]
      const version = Number(before?.version ?? 0)
      if (!change) return { version,webhooks: before?.webhooks ?? null }
      if (change.expectedVersion !== version || version === Number.MAX_SAFE_INTEGER) throw new Failure(409,'VERSION_CONFLICT')
      if (Object.values(change.webhooks).some((rule) => rule.enabled)) await this.completionEgress(query,actor)
      for (const webhookId of [...new Set(Object.values(change.webhooks).filter((rule) => rule.enabled).map((rule) => rule.webhookId))].sort()) {
        const wh = (await query('SELECT id FROM multitable_webhooks WHERE id=$1 AND created_by=$2 AND active=true FOR SHARE',[webhookId,actor])).rows[0]
        if (!wh) throw new Failure(403,'FORBIDDEN')
      }
      if (before && canonical(before.webhooks) === canonical(change.webhooks)) return { version,webhooks: before.webhooks }
      const revisionId = randomUUID()
      await query(`INSERT INTO meta_plm_bom_review_completion_config(binding_id,version,webhooks,updated_by,revision_id)
        VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(binding_id) DO UPDATE SET version=EXCLUDED.version,
        webhooks=EXCLUDED.webhooks,updated_by=EXCLUDED.updated_by,revision_id=EXCLUDED.revision_id,updated_at=now()`,
        [id,version+1,JSON.stringify(change.webhooks),actor,revisionId])
      await recordConfigRevision(query,{
        sheetId: b.sheet_id,entityType: 'sheet_config',entityId: `plm-bom-review:${id}:completion-webhooks`,
        action: before ? 'update' : 'create',before: before ? { webhooks: before.webhooks } : null,
        after: { webhooks: change.webhooks },changedKeys: ['webhooks'],batchId: randomUUID(),actorId: actor,id: revisionId,
      })
      return { version: version+1,webhooks: change.webhooks }
    })
  }
  async disable(actor: string, id: string, input: unknown) {
    const { expectedVersion } = versionInput.parse(input),
      candidate = await this.bindingForChange(actor, id, expectedVersion)
    return this.deps.pool.transaction(async ({ query }) => {
      await this.runtime(query)
      await fenceWriterEntry(query, candidate.sheet_id)
      const b = (
        await query(
          'SELECT * FROM meta_plm_bom_review_bindings WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Binding
      this.checkVersion(b, actor, expectedVersion)
      await this.sheet(query, actor, b, true)
      const updated = (
        await query(
          "UPDATE meta_plm_bom_review_bindings SET status='disabled',version=version+1 WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0]
      // Same binding-before-listener lock order as intake and rebind; the cursor is kept as evidence.
      const listener = (await query("SELECT to_regclass('meta_plm_bom_change_listeners') IS NOT NULL AS ready")).rows[0]?.ready
        ? (await query(`UPDATE meta_plm_bom_change_listeners SET status='stopped',stop_reason='BINDING_DISABLED',
            updated_at=clock_timestamp() WHERE binding_id=$1 AND status='active' RETURNING generation,cursor`,[id])).rows[0]
        : undefined
      await recordConfigRevision(query, {
        sheetId: b.sheet_id, entityType: 'sheet_config', entityId: `plm-bom-review:${id}:lifecycle`,
        action: 'update', before: { status: b.status, version: Number(b.version) },
        after: { status: 'disabled', version: Number(updated.version),
          ...(listener ? { stoppedListener: { generation: listener.generation, cursor: Number(listener.cursor) } } : {}) },
        changedKeys: ['status'], batchId: randomUUID(), actorId: actor,
      })
      return this.dto(updated, actor, true)
    })
  }
  // Called only inside create/refresh's sheet fence and authorized transaction. The marker is
  // independent of the view: later user edits or deletion must never be reconciled away.
  private async initializeOwnerView(
    query: PlmQuery,
    actor: string,
    b: Binding,
    confirmedPreviewId?: string,
  ): Promise<void> {
    if (b.owner_view_initialized) return
    const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(
      query,
      b.sheet_id,
      actor,
    )
    // Managing sharing is not the same permission as managing views. A share-only owner may
    // continue an otherwise authorized snapshot refresh, leaving initialization for a later editor.
    if (!capabilities.canManageViews) return
    const previews = confirmedPreviewId
      ? [{ id: confirmedPreviewId }]
      : (
          await query(
            'SELECT id FROM meta_plm_bom_review_previews WHERE binding_id=$1 LIMIT 2',
            [b.id],
          )
        ).rows
    if (
      previews.length !== 1 ||
      getObjectSheetId('plm-bom-review', previews[0].id) !== b.sheet_id
    )
      throw new Failure(503, 'RUNTIME_UNAVAILABLE')
    const ownerId = getObjectFieldId('plm-bom-review', previews[0].id, 'owner')
    const owner = (
      await query(
        "SELECT id FROM meta_fields WHERE id=$1 AND sheet_id=$2 AND type='person'",
        [ownerId, b.sheet_id],
      )
    ).rows[0]
    // Never guess by label or restore a deleted/retyped local field.
    if (owner) {
      const result = await createView({
        query,
        sheetId: b.sheet_id,
        viewId: getObjectViewId('plm-bom-review', previews[0].id, 'owner'),
        name: '按负责人',
        type: 'grid',
        groupInfo: { fieldId: ownerId, fieldIds: [ownerId] },
        createdAtOffsetMicros: 1,
      })
      if (result.created && result.view) {
        const { id, sheetId: _sheetId, ...after } = result.view
        await recordConfigRevision(query, {
          sheetId: b.sheet_id,
          entityType: 'view',
          entityId: id,
          action: 'create',
          before: null,
          after,
          changedKeys: Object.keys(after),
          batchId: b.id,
          actorId: actor,
        })
      }
    }
    // Missing/retyped owner is a one-time skip, not a fake view create.
    await query(
      'UPDATE meta_plm_bom_review_bindings SET owner_view_initialized=true WHERE id=$1',
      [b.id],
    )
  }
  private async initializeStatusViews(query: PlmQuery, actor: string, b: Binding, confirmedPreviewId?: string): Promise<void> {
    if (b.status_views_initialized) return
    const mapping = (await query('SELECT field_id FROM meta_plm_bom_review_state_fields WHERE binding_id=$1',[b.id])).rows[0]
    // Legacy custom status fields are not automatically enrolled or renamed.
    if (!mapping) return
    const { capabilities } = await resolveSheetCapabilitiesForUserOnQuery(query,b.sheet_id,actor)
    if (!capabilities.canManageViews) return
    const scopes = await loadFieldPermissionScopeMap(query,b.sheet_id,actor)
    const field = (await query('SELECT * FROM meta_fields WHERE id=$1 AND sheet_id=$2',[mapping.field_id,b.sheet_id])).rows[0]
    if (!field || isFieldPermissionHidden(field) || scopes.get(mapping.field_id)?.visible === false) return
    const previews = confirmedPreviewId ? [{ id: confirmedPreviewId }] :
      (await query('SELECT id FROM meta_plm_bom_review_previews WHERE binding_id=$1 LIMIT 2',[b.id])).rows
    if (previews.length !== 1 || getObjectSheetId('plm-bom-review',previews[0].id) !== b.sheet_id
      || getObjectFieldId('plm-bom-review',previews[0].id,'status') !== mapping.field_id)
      throw new Failure(503,'RUNTIME_UNAVAILABLE')
    for (const [key,name,state,offset] of [
      ['pending-review','待评审','待评审',2],['issues','问题项','有问题',3],
    ] as const) {
      const viewId = getObjectViewId('plm-bom-review',previews[0].id,key)
      // A previously configured missing view may have been physically deleted by its owner.
      if ((await query("SELECT id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 LIMIT 1",[b.sheet_id,viewId])).rows[0]) continue
      const result = await createView({
        query,sheetId: b.sheet_id,viewId,name,type: 'grid',
        filterInfo: { conjunction: 'and',conditions: [{ fieldId: mapping.field_id,operator: 'is',value: state }] },
        createdAtOffsetMicros: offset,
      })
      if (result.created && result.view) {
        const { id,sheetId: _sheetId,...after } = result.view
        await recordConfigRevision(query,{
          sheetId: b.sheet_id,entityType: 'view',entityId: id,action: 'create',before: null,after,
          changedKeys: Object.keys(after),batchId: b.id,actorId: actor,
        })
      }
    }
    await query('UPDATE meta_plm_bom_review_bindings SET status_views_initialized=true WHERE id=$1',[b.id])
  }
  private async writeSnapshot(
    query: PlmQuery,
    actor: string,
    b: Binding,
    snapshot: ShareSnapshot,
  ): Promise<void> {
    await query(
      'SELECT field_id FROM field_permissions WHERE sheet_id=$1 AND field_id=ANY($2::text[]) FOR SHARE',
      [b.sheet_id, Object.values(b.fields)],
    )
    const fieldScopes = await loadFieldPermissionScopeMap(
      query,
      b.sheet_id,
      actor,
    )
    if (
      Object.values(b.fields).some((id) => {
        const scope = fieldScopes.get(id)
        return scope && (!scope.visible || scope.readOnly)
      })
    )
      throw new Failure(403, 'FORBIDDEN')
    const projected = projectBomRows(snapshot),
      existing = (
        await query(
          'SELECT * FROM meta_plm_bom_review_rows WHERE binding_id=$1 ORDER BY record_id',
          [b.id],
        )
      ).rows
    const pending: {
      id: string
      line: string
      data?: Record<string, unknown>
      version?: number
      patch: Record<string, unknown>
    }[] = []
    for (const r of existing) {
      await acquireRecordLinkRowAuthLockOnQuery(query, b.sheet_id, r.record_id)
      const old = (
        await query(
          'SELECT * FROM meta_records WHERE id=$1 AND sheet_id=$2 FOR UPDATE',
          [r.record_id, b.sheet_id],
        )
      ).rows[0]
      if (!old) throw new Failure(409, 'BINDING_CONFLICT')
      const scope = (
        await loadRecordPermissionScopeMap(
          query,
          b.sheet_id,
          [r.record_id],
          actor,
        )
      ).get(r.record_id)
      if (
        scope?.accessLevel === 'none' ||
        scope?.accessLevel === 'read'
      )
        throw new Failure(403, 'FORBIDDEN')
      ensureRecordNotLocked(actor, old, () => new Failure(403, 'FORBIDDEN'))
      const row = projected.get(r.bom_line_id)
      const cells =
        row?.cells ??
        Object.fromEntries(
          SOURCE_FIELDS.map((key) => [
            key,
            key === 'sync_status'
              ? 'removed'
              : key === 'occurrences'
                ? '[]'
                : (old.data[b.fields[key]] ?? null),
          ]),
        )
      const patch = Object.fromEntries(
        SOURCE_FIELDS.map((key) => [b.fields[key], cells[key]]),
      )
      if (
        Object.entries(patch).some(
          ([k, v]) => canonical(old.data[k]) !== canonical(v),
        )
      )
        pending.push({
          id: r.record_id,
          line: r.bom_line_id,
          data: old.data,
          version: Number(old.version),
          patch,
        })
      projected.delete(r.bom_line_id)
    }
    for (const [line, row] of projected)
      pending.push({
        id: `rec_${randomUUID()}`,
        line,
        patch: Object.fromEntries(
          SOURCE_FIELDS.map((key) => [b.fields[key], row.cells[key]]),
        ),
      })
    if (!pending.length) return
    const ledger = await mintOperation(query, b.sheet_id)
    if (!ledger.operationId) throw new Failure(503, 'RUNTIME_UNAVAILABLE')
    const syncId = randomUUID()
    await query(
      'INSERT INTO meta_plm_bom_review_syncs(id,binding_id,patches,actor_id) VALUES($1,$2,$3::jsonb,$4)',
      [
        syncId,
        b.id,
        JSON.stringify(Object.fromEntries(pending.map((p) => [p.id, p.patch]))),
        actor,
      ],
    )
    await query("SELECT set_config('metasheet.bom_review_sync',$1,true)", [
      syncId,
    ])
    for (const p of pending) {
      if (!p.data)
        await query(
          'INSERT INTO meta_plm_bom_review_rows(binding_id,bom_line_id,record_id) VALUES($1,$2,$3)',
          [b.id, p.line, p.id],
        )
      const row = (
        p.data
          ? await query(
              // lock-guarded: writeSnapshot checks the locked row through ensureRecordNotLocked.
              // revision-emitted: recordRecordRevision and sealOperation below share this transaction.
              'UPDATE meta_records SET data=data||$1::jsonb,version=version+1,modified_by=$3,updated_at=now() WHERE id=$2 RETURNING data,version',
              [JSON.stringify(p.patch), p.id, actor],
            )
          : await query(
              // revision-emitted: recordRecordRevision and sealOperation below share this transaction.
              'INSERT INTO meta_records(id,sheet_id,data,created_by,modified_by) VALUES($1,$2,$3::jsonb,$4,$4) RETURNING data,version',
              [p.id, b.sheet_id, JSON.stringify(p.patch), actor],
            )
      ).rows[0]
      await recordRecordRevision(query, {
        sheetId: b.sheet_id,
        recordId: p.id,
        version: Number(row.version),
        action: p.data ? 'update' : 'create',
        source: 'system_sync',
        actorId: actor,
        changedFieldIds: Object.keys(p.data ? p.patch : row.data),
        patch: p.data ? p.patch : row.data,
        snapshot: row.data,
        ledger,
      })
    }
    if (!(await sealOperation(query, ledger)))
      throw new Failure(503, 'RUNTIME_UNAVAILABLE')
    // Snapshot sync is intentionally silent. Ordinary native collaboration writes retain their durable events.
  }
}
