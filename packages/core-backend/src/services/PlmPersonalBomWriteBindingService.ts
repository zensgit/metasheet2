import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
  isEncryptedSecretValue,
} from '../security/encrypted-secrets'
import {
  acceptedPersonalBomWriteResult,
  bindingAuthorizesFrozen,
  canonicalPayload,
  freezeDispatchAttempt,
  freezeNativeOperation,
  grantPublicId,
  normalizeMetaTenant,
  personalBomWriteManagementUrl,
  providerIdempotencyKey,
  readPersonalBomWriteDispatch,
  requirePlmPersonalBomWrite,
  personalBomWriteBindingInput,
  personalBomWriteFreezeInput,
  personalBomWriteGrantSchema,
  resolvePersistedPlmSource,
  linePatchBody,
  type PersonalBomWriteActor,
  type PersonalBomWriteAuthority,
  type PersonalBomWriteDispatchRequest,
  PlmPersonalBomWriteError as Failure,
  type BindingAuthorizationView,
  type FrozenDispatchAttempt,
  type FrozenNativeOperation,
  type PersonalBomWriteTransport,
} from './plm-personal-bom-write-wire'

const SCOPE_KINDS = new Set(['legacy_private', 'private', 'workspace'])

interface SourceRow {
  id: string
  owner_id: string
  workspace_id: string | null
  tenant_id: string | null
  scope_kind: string | null
  type: string
  config: unknown
  is_active: boolean
  deleted_at: Date | string | null
}

interface Binding {
  id: string
  owner_id: string
  data_source_id: string
  connection_id: string
  subject_id: string
  meta_tenant_id: string | null
  yuantus_tenant_id: string
  yuantus_org_id: string
  target_origin: string
  workspace_id: string | null
  scope_kind: string
  grant_id: string
  expires_at: Date | string
  encrypted_grant: string | null
  generation: number
  purpose: string
  remote_revoke_state: string | null
  previous_grant_revoke_state: string | null
}

interface RetiredGrant {
  id: string
  binding_id: string
  owner_id: string
  connection_id: string
  yuantus_tenant_id: string
  yuantus_org_id: string
  target_origin: string
  grant_id: string
  encrypted_grant: string | null
  state: string
  slot: string
  binding_generation: number
  successor_grant_id: string
}

export interface PersonalBomWriteBindingMetadata extends BindingAuthorizationView {
  id: string
  workspaceId: string | null
  scopeKind: string
  expiresAt: string
  bound: boolean
  remoteRevokeState: string | null
  previousGrantRevokeState: string | null
}

const BINDING_COLUMNS = `id, owner_id, data_source_id, connection_id, subject_id, meta_tenant_id,
  yuantus_tenant_id, yuantus_org_id, target_origin, workspace_id, scope_kind, grant_id, expires_at,
  encrypted_grant, generation, purpose, remote_revoke_state, previous_grant_revoke_state`

const INTENT_COLUMNS = `id, owner_id, data_source_id, operation_kind, client_key_sha256,
  actor_meta_tenant_id, source_meta_tenant_id, workspace_id, scope_kind, target_origin, connection_id,
  yuantus_tenant_id, yuantus_org_id, subject_id, purpose, part_id, bom_line_id, if_match, request_body,
  payload_fingerprint, provider_idempotency_key, binding_id, outcome, saw_unknown, confirmed_response`

interface IntentRow {
  id: string
  owner_id: string
  data_source_id: string
  operation_kind: 'line' | 'eco-intent'
  client_key_sha256: string
  actor_meta_tenant_id: string | null
  source_meta_tenant_id: string | null
  workspace_id: string | null
  scope_kind: string
  target_origin: string
  connection_id: string
  yuantus_tenant_id: string
  yuantus_org_id: string
  subject_id: string
  purpose: string
  part_id: string
  bom_line_id: string | null
  if_match: string | null
  request_body: string
  payload_fingerprint: string
  provider_idempotency_key: string
  binding_id: string
  outcome: string
  saw_unknown: boolean
  confirmed_response: string | null
}

export interface PersonalBomWriteDispatchReceipt {
  intentId: string
  operationKind: 'line' | 'eco-intent'
  dataSourceId: string
  partId: string
  bomLineId: string | null
  providerIdempotencyKey: string
  clientKeySha256: string
  actorMetaTenantId: string | null
  sourceMetaTenantId: string | null
  outcome: 'accepted'
  native: ReturnType<typeof acceptedPersonalBomWriteResult>
}

export class PlmPersonalBomWriteBindingService {
  constructor(
    readonly pool: Pick<Pool, 'connect'>,
    readonly provider: () => PersonalBomWriteTransport,
  ) {}

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the original error is the caller-facing result */
      }
      throw error
    } finally {
      client.release()
    }
  }

  private async activeOwner(client: PoolClient, owner: string): Promise<void> {
    const found = await client.query('SELECT id FROM users WHERE id=$1 AND is_active=true FOR SHARE', [owner])
    if (!found.rowCount) throw new Failure(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
  }

  /**
   * Explicit null stays null. A missing, blank, or non-string tenant is not legacy_private admission.
   * normalizeMetaTenant collapses those caller values to null, so they are rejected here.
   */
  private readActor(actor: PersonalBomWriteActor): { userId: string; metaTenantId: string | null } {
    if (!actor || typeof actor.userId !== 'string' || actor.userId.length < 1)
      throw new Failure(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
    if (actor.metaTenantId === null)
      return { userId: actor.userId, metaTenantId: null }
    const metaTenantId = normalizeMetaTenant(actor.metaTenantId)
    if (metaTenantId === null) throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
    return { userId: actor.userId, metaTenantId }
  }

  /**
   * Active membership for a non-null Meta tenant.
   * FOR SHARE is held by the caller through the provider call and commit.
   */
  private async shareMembership(client: PoolClient, userId: string, metaTenantId: string): Promise<boolean> {
    const found = await client.query(
      `SELECT user_id FROM user_orgs
       WHERE user_id=$1 AND org_id=$2 AND is_active=true
       FOR SHARE`,
      [userId, metaTenantId],
    )
    return !!found.rowCount
  }

  private async requireMembership(client: PoolClient, userId: string, metaTenantId: string): Promise<void> {
    if (!(await this.shareMembership(client, userId, metaTenantId)))
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }

  /** Null is admitted only for an explicit legacy_private source, and stays null. */
  private persistedTenantMatches(source: SourceRow, metaTenantId: string | null): boolean {
    const persisted = normalizeMetaTenant(source.tenant_id)
    if (persisted !== metaTenantId) return false
    return persisted !== null || source.scope_kind === 'legacy_private'
  }

  private assertPersistedTenant(source: SourceRow, metaTenantId: string | null): void {
    if (!this.persistedTenantMatches(source, metaTenantId)) throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }

  private async lockSource(client: PoolClient, dataSourceId: string, owner: string): Promise<SourceRow> {
    const found = await client.query<SourceRow>(
      `SELECT id, owner_id, workspace_id, tenant_id, scope_kind, type, config, is_active, deleted_at
       FROM data_sources WHERE id=$1 FOR UPDATE`,
      [dataSourceId],
    )
    const source = found.rows[0]
    if (
      !source ||
      source.owner_id !== owner ||
      source.type !== 'plm' ||
      source.is_active !== true ||
      source.deleted_at != null ||
      !SCOPE_KINDS.has(String(source.scope_kind))
    )
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
    return source
  }

  private configOf(source: SourceRow): unknown {
    let config: unknown = source.config
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config) as unknown
      } catch {
        throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
    // DataSourceManager persists type in its column; config contains connection/options.
    return { ...config, type: source.type }
  }

  private metadata(row: Binding): PersonalBomWriteBindingMetadata {
    return {
      id: row.id,
      ownerId: row.owner_id,
      dataSourceId: row.data_source_id,
      connectionId: row.connection_id,
      subjectId: row.subject_id,
      metaTenantId: row.meta_tenant_id,
      targetOrigin: row.target_origin,
      yuantusTenantId: row.yuantus_tenant_id,
      yuantusOrgId: row.yuantus_org_id,
      workspaceId: row.workspace_id,
      scopeKind: row.scope_kind,
      grantId: row.grant_id,
      generation: Number(row.generation),
      expiresAt: new Date(row.expires_at).toISOString(),
      bound: !!row.encrypted_grant,
      remoteRevokeState: row.remote_revoke_state,
      previousGrantRevokeState: row.previous_grant_revoke_state,
    }
  }

  /** Current persisted origin and Y scope must still be the bound target. Cache is not consulted. */
  private assertCurrentTarget(source: SourceRow, row: Binding): void {
    const resolved = resolvePersistedPlmSource(this.configOf(source))
    if (
      resolved.origin.origin !== row.target_origin ||
      resolved.tenantId !== row.yuantus_tenant_id ||
      resolved.orgId !== row.yuantus_org_id
    )
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }

  /** Source owner and the current Meta tenant snapshot. Feature flag is not authority. */
  private async ownedSource(client: PoolClient, dataSourceId: string, owner: string): Promise<SourceRow | undefined> {
    const found = await client.query<SourceRow>(
      `SELECT id, owner_id, workspace_id, tenant_id, scope_kind, type, config, is_active, deleted_at
       FROM data_sources WHERE id=$1 FOR UPDATE`,
      [dataSourceId],
    )
    const source = found.rows[0]
    if (!source || source.owner_id !== owner || source.type !== 'plm' || source.deleted_at != null) return undefined
    return source
  }

  private snapshotMatches(source: SourceRow, row: Binding): boolean {
    const metaTenantId = normalizeMetaTenant(source.tenant_id)
    const workspaceId = source.workspace_id ?? null
    return (
      metaTenantId === row.meta_tenant_id &&
      workspaceId === row.workspace_id &&
      source.scope_kind === row.scope_kind
    )
  }

  private sameSnapshot(source: SourceRow, row: Binding): void {
    const metaTenantId = normalizeMetaTenant(source.tenant_id)
    const workspaceId = source.workspace_id ?? null
    if (
      source.owner_id !== row.owner_id ||
      metaTenantId !== row.meta_tenant_id ||
      workspaceId !== row.workspace_id ||
      source.scope_kind !== row.scope_kind
    )
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
    this.assertCurrentTarget(source, row)
  }

  private secret(row: Binding): string | null {
    if (!row.encrypted_grant || !isEncryptedSecretValue(row.encrypted_grant)) return null
    return this.secretValue(row.encrypted_grant)
  }

  async managementUrl(actor: PersonalBomWriteActor, dataSourceId: string): Promise<string> {
    requirePlmPersonalBomWrite()
    const { userId, metaTenantId } = this.readActor(actor)
    return this.tx(async (client) => {
      await this.activeOwner(client, userId)
      if (metaTenantId !== null) await this.requireMembership(client, userId, metaTenantId)
      const source = await this.lockSource(client, dataSourceId, userId)
      this.assertPersistedTenant(source, metaTenantId)
      return personalBomWriteManagementUrl(resolvePersistedPlmSource(this.configOf(source)).origin)
    })
  }

  async bind(actor: PersonalBomWriteActor, input: unknown): Promise<PersonalBomWriteBindingMetadata> {
    requirePlmPersonalBomWrite()
    const parsed = personalBomWriteBindingInput.safeParse(input)
    if (!parsed.success) {
      const grant = input && typeof input === 'object' ? (input as { grant?: unknown }).grant : undefined
      if (typeof grant === 'string' && grant.startsWith('yua_'))
        throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
    }
    const { userId, metaTenantId: actorTenantId } = this.readActor(actor)
    const body = parsed.data
    const bound = await this.tx(async (client) => {
      await this.activeOwner(client, userId)
      if (actorTenantId !== null) await this.requireMembership(client, userId, actorTenantId)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `plm-personal-bom-write:${userId}:${body.dataSourceId}`,
      ])
      const source = await this.lockSource(client, body.dataSourceId, userId)
      this.assertPersistedTenant(source, actorTenantId)
      const resolved = resolvePersistedPlmSource(this.configOf(source))
      const authority: PersonalBomWriteAuthority = {
        origin: resolved.origin.origin,
        tenantId: resolved.tenantId,
        orgId: resolved.orgId,
      }
      const raw = await this.provider().personalBomWriteRequest('verify', body.grant, body.connectionId, authority)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
      if ((raw as { purpose?: unknown }).purpose !== 'bom_write')
        throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      const verified = personalBomWriteGrantSchema.safeParse(raw)
      if (!verified.success) throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
      const grant = verified.data
      if (
        grant.grant_id !== grantPublicId(body.grant) ||
        grant.connection_id !== body.connectionId ||
        grant.tenant_id !== resolved.tenantId ||
        grant.org_id !== resolved.orgId ||
        grant.purpose !== 'bom_write'
      )
        throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      if (new Date(grant.expires_at).getTime() <= Date.now())
        throw new Failure(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
      const previous = (
        await client.query<Binding>(
          `SELECT ${BINDING_COLUMNS} FROM plm_personal_bom_write_bindings
           WHERE owner_id=$1 AND data_source_id=$2 FOR UPDATE`,
          [userId, body.dataSourceId],
        )
      ).rows[0]
      if (previous) {
        await this.rejectRetiredReuse(client, previous.id, userId, {
          grantId: grant.grant_id,
          connectionId: grant.connection_id,
          tenantId: grant.tenant_id,
          orgId: grant.org_id,
          origin: authority.origin,
        })
      }
      const encrypted = encryptStoredSecretValue(body.grant)
      if (!isEncryptedSecretValue(encrypted)) throw new Failure(503, 'PLM_BOM_WRITE_UNAVAILABLE')
      const metaTenantId = normalizeMetaTenant(source.tenant_id)
      const saved = (
        await client.query<Binding>(
          `INSERT INTO plm_personal_bom_write_bindings(
             id, owner_id, data_source_id, connection_id, subject_id, meta_tenant_id,
             yuantus_tenant_id, yuantus_org_id, target_origin, workspace_id, scope_kind, grant_id,
             expires_at, encrypted_grant, purpose
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bom_write')
           ON CONFLICT (owner_id, data_source_id) DO UPDATE SET
             connection_id=EXCLUDED.connection_id,
             subject_id=EXCLUDED.subject_id,
             meta_tenant_id=EXCLUDED.meta_tenant_id,
             yuantus_tenant_id=EXCLUDED.yuantus_tenant_id,
             yuantus_org_id=EXCLUDED.yuantus_org_id,
             target_origin=EXCLUDED.target_origin,
             workspace_id=EXCLUDED.workspace_id,
             scope_kind=EXCLUDED.scope_kind,
             grant_id=EXCLUDED.grant_id,
             expires_at=EXCLUDED.expires_at,
             encrypted_grant=EXCLUDED.encrypted_grant,
             purpose='bom_write',
             generation=plm_personal_bom_write_bindings.generation+1,
             remote_revoke_state=NULL,
             previous_grant_revoke_state=CASE
               WHEN plm_personal_bom_write_bindings.encrypted_grant IS NOT NULL
                AND plm_personal_bom_write_bindings.grant_id IS DISTINCT FROM EXCLUDED.grant_id
               THEN 'pending' ELSE NULL END,
             updated_at=now()
           WHERE plm_personal_bom_write_bindings.generation=$15
           RETURNING ${BINDING_COLUMNS}`,
          [
            randomUUID(),
            userId,
            body.dataSourceId,
            grant.connection_id,
            grant.auth_user_id,
            metaTenantId,
            grant.tenant_id,
            grant.org_id,
            authority.origin,
            source.workspace_id ?? null,
            source.scope_kind,
            grant.grant_id,
            new Date(grant.expires_at),
            encrypted,
            previous?.generation ?? 0,
          ],
        )
      ).rows[0]
      if (!saved) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
      const retiredId =
        previous?.encrypted_grant &&
        isEncryptedSecretValue(previous.encrypted_grant) &&
        previous.grant_id !== grant.grant_id
          ? await this.insertRetired(
              client,
              previous,
              previous.encrypted_grant,
              'previous',
              Number(saved.generation),
              saved.grant_id,
            )
          : null
      return { saved, retiredId }
    })
    if (bound.retiredId) await this.attemptRetired(userId, bound.retiredId)
    const current = await this.readOwn(userId, bound.saved.id)
    return this.metadata(current ?? bound.saved)
  }

  /** Owned metadata for the trusted actor. The enable flag is not consulted. */
  async list(actor: PersonalBomWriteActor): Promise<PersonalBomWriteBindingMetadata[]> {
    const { userId, metaTenantId } = this.readActor(actor)
    return this.tx(async (client) => {
      await this.activeOwner(client, userId)
      if (metaTenantId !== null && !(await this.shareMembership(client, userId, metaTenantId))) return []
      const rows = (
        await client.query<Binding>(
          `SELECT ${BINDING_COLUMNS} FROM plm_personal_bom_write_bindings WHERE owner_id=$1 ORDER BY id`,
          [userId],
        )
      ).rows
      const visible: PersonalBomWriteBindingMetadata[] = []
      for (const row of rows) {
        const source = await this.ownedSource(client, row.data_source_id, userId)
        if (!source || !this.snapshotMatches(source, row)) continue
        if (!this.persistedTenantMatches(source, metaTenantId)) continue
        visible.push(this.metadata(row))
      }
      return visible
    })
  }

  /**
   * Local invalidation, then exact-secret self-revoke.
   * Remains available when the feature flag is off, the grant is expired, or the native registry no longer issues.
   */
  async unbind(owner: string, bindingId: string): Promise<PersonalBomWriteBindingMetadata> {
    const cleared = await this.tx(async (client) => {
      await this.activeOwner(client, owner)
      const dataSourceId = await this.mapOwn(client, owner, bindingId)
      const source = await this.ownedSource(client, dataSourceId, owner)
      if (!source) throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      const row = await this.lockOwn(client, owner, bindingId)
      this.assertMappedSource(row, owner, dataSourceId, source.id)
      if (!this.snapshotMatches(source, row)) throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
      if (!row.encrypted_grant) return { row, changed: false, retiredId: null as string | null }
      const saved = (
        await client.query<Binding>(
          `UPDATE plm_personal_bom_write_bindings
           SET encrypted_grant=NULL, generation=generation+1, remote_revoke_state='pending', updated_at=now()
           WHERE id=$1 AND owner_id=$2 AND generation=$3
           RETURNING ${BINDING_COLUMNS}`,
          [row.id, owner, row.generation],
        )
      ).rows[0]
      if (!saved) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
      const retiredId = isEncryptedSecretValue(row.encrypted_grant)
        ? await this.insertRetired(
            client,
            row,
            row.encrypted_grant,
            'current',
            Number(saved.generation),
            saved.grant_id,
          )
        : null
      return { row: saved, changed: true, retiredId }
    })
    if (!cleared.changed) return this.metadata(cleared.row)
    if (cleared.retiredId) await this.attemptRetired(owner, cleared.retiredId)
    else await this.markCurrentUnresolved(owner, cleared.row)
    const current = await this.readOwn(owner, cleared.row.id)
    return this.metadata(current ?? cleared.row)
  }

  /**
   * Restart entry for a retired grant whose remote revoke did not finish.
   * Pending and unknown keep the ciphertext. Revoked and rejected do not.
   * The enable flag is not consulted: exact self-revoke stays available after disablement.
   */
  async retryRetiredRevocations(owner: string): Promise<void> {
    const ids = await this.tx(async (client) => {
      await this.activeOwner(client, owner)
      const found = await client.query<{ id: string }>(
        `SELECT id FROM plm_personal_bom_write_retired_grants
         WHERE owner_id=$1 AND state IN ('pending', 'unknown') AND encrypted_grant IS NOT NULL
         ORDER BY created_at, id`,
        [owner],
      )
      return found.rows.map((row) => row.id)
    })
    for (const id of ids) await this.attemptRetired(owner, id)
  }

  async requireUsable(actor: PersonalBomWriteActor, bindingId: string): Promise<PersonalBomWriteBindingMetadata> {
    requirePlmPersonalBomWrite()
    return this.tx(async (client) => this.metadata(await this.usable(client, actor, bindingId)))
  }

  async freezeForOperation(
    actor: PersonalBomWriteActor,
    bindingId: string,
    input: unknown,
  ): Promise<{
    binding: PersonalBomWriteBindingMetadata
    operation: FrozenNativeOperation
    attempt: FrozenDispatchAttempt
    authorizes: boolean
  }> {
    requirePlmPersonalBomWrite()
    const parsed = personalBomWriteFreezeInput.safeParse(input)
    if (!parsed.success) throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
    const request = parsed.data
    if (request.operationKind === 'line' && !request.bomLineId)
      throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
    if (request.operationKind === 'eco-intent' && (request.bomLineId !== undefined || request.patch !== undefined))
      throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
    const payload = request.operationKind === 'line' ? linePatchBody(request.patch) : { partId: request.partId }
    return this.tx(async (client) => {
      const row = await this.usable(client, actor, bindingId)
      const operation = freezeNativeOperation({
        operationKind: request.operationKind,
        ownerId: row.owner_id,
        dataSourceId: row.data_source_id,
        metaTenantId: row.meta_tenant_id,
        targetOrigin: row.target_origin,
        connectionId: row.connection_id,
        yuantusTenantId: row.yuantus_tenant_id,
        yuantusOrgId: row.yuantus_org_id,
        subjectId: row.subject_id,
        partId: request.partId,
        bomLineId: request.operationKind === 'line' ? request.bomLineId! : null,
        clientKey: request.clientKey,
        payload,
      })
      const attempt = freezeDispatchAttempt(operation, Number(row.generation), 1)
      return {
        binding: this.metadata(row),
        operation,
        attempt,
        authorizes: bindingAuthorizesFrozen(this.metadata(row), operation),
      }
    })
  }

  private async usable(client: PoolClient, actor: PersonalBomWriteActor, bindingId: string): Promise<Binding> {
    const { userId, metaTenantId } = this.readActor(actor)
    await this.activeOwner(client, userId)
    if (metaTenantId !== null) await this.requireMembership(client, userId, metaTenantId)
    const dataSourceId = await this.mapOwn(client, userId, bindingId)
    const source = await this.lockSource(client, dataSourceId, userId)
    this.assertPersistedTenant(source, metaTenantId)
    const row = await this.lockOwn(client, userId, bindingId)
    this.assertMappedSource(row, userId, dataSourceId, source.id)
    this.sameSnapshot(source, row)
    if (row.purpose !== 'bom_write' || !row.encrypted_grant || row.remote_revoke_state)
      throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
    if (!this.secret(row) || new Date(row.expires_at).getTime() <= Date.now())
      throw new Failure(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
    return row
  }

  /** Id to source, without a row lock. Callers lock the source before lockOwn. */
  private async mapOwn(client: PoolClient, owner: string, bindingId: string): Promise<string> {
    const mapped = (
      await client.query<{ data_source_id: string }>(
        `SELECT data_source_id FROM plm_personal_bom_write_bindings
         WHERE id=$1 AND owner_id=$2`,
        [bindingId, owner],
      )
    ).rows[0]
    if (!mapped) throw new Failure(404, 'PLM_BOM_WRITE_NOT_FOUND')
    return mapped.data_source_id
  }

  /** The binding id keeps its owner and source. A mismatch is not followed into a second source lock. */
  private assertMappedSource(row: Binding, owner: string, dataSourceId: string, lockedSourceId: string): void {
    if (row.owner_id !== owner || row.data_source_id !== dataSourceId || row.data_source_id !== lockedSourceId)
      throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
  }

  private async lockOwn(client: PoolClient, owner: string, bindingId: string): Promise<Binding> {
    const row = (
      await client.query<Binding>(
        `SELECT ${BINDING_COLUMNS} FROM plm_personal_bom_write_bindings
         WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [bindingId, owner],
      )
    ).rows[0]
    if (!row) throw new Failure(404, 'PLM_BOM_WRITE_NOT_FOUND')
    return row
  }

  private async readOwn(owner: string, bindingId: string): Promise<Binding | undefined> {
    const found = await this.pool.connect()
    try {
      const row = (
        await found.query<Binding>(
          `SELECT ${BINDING_COLUMNS} FROM plm_personal_bom_write_bindings WHERE id=$1 AND owner_id=$2`,
          [bindingId, owner],
        )
      ).rows[0]
      return row
    } finally {
      found.release()
    }
  }

  /**
   * A pending or unknown retirement still holds this credential for the binding's native scope.
   * Installing it again would let retryRetiredRevocations revoke the live grant.
   */
  private async rejectRetiredReuse(
    client: PoolClient,
    bindingId: string,
    owner: string,
    scope: { grantId: string; connectionId: string; tenantId: string; orgId: string; origin: string },
  ): Promise<void> {
    const found = await client.query(
      `SELECT id FROM plm_personal_bom_write_retired_grants
       WHERE binding_id=$1 AND owner_id=$2 AND grant_id=$3
         AND connection_id=$4 AND yuantus_tenant_id=$5 AND yuantus_org_id=$6
         AND target_origin=$7
         AND state IN ('pending', 'unknown') AND encrypted_grant IS NOT NULL
       LIMIT 1`,
      [bindingId, owner, scope.grantId, scope.connectionId, scope.tenantId, scope.orgId, scope.origin],
    )
    if (found.rowCount) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
  }

  private async insertRetired(
    client: PoolClient,
    row: Binding,
    ciphertext: string,
    slot: 'current' | 'previous',
    bindingGeneration: number,
    successorGrantId: string,
  ): Promise<string> {
    const id = randomUUID()
    await client.query(
      `INSERT INTO plm_personal_bom_write_retired_grants(
         id, binding_id, owner_id, connection_id, yuantus_tenant_id, yuantus_org_id,
         target_origin, grant_id, encrypted_grant, state, binding_generation, successor_grant_id, slot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12)`,
      [
        id,
        row.id,
        row.owner_id,
        row.connection_id,
        row.yuantus_tenant_id,
        row.yuantus_org_id,
        row.target_origin,
        row.grant_id,
        ciphertext,
        bindingGeneration,
        successorGrantId,
        slot,
      ],
    )
    return id
  }

  private async markCurrentUnresolved(owner: string, row: Binding): Promise<void> {
    await this.tx(async (client) => {
      await client.query(
        `UPDATE plm_personal_bom_write_bindings
         SET remote_revoke_state='unknown', updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND generation=$3 AND remote_revoke_state='pending' AND encrypted_grant IS NULL`,
        [row.id, owner, row.generation],
      )
    })
  }

  /** Decrypt the stored retired credential, revoke at its original origin, then record the outcome. */
  private async attemptRetired(owner: string, retiredId: string): Promise<void> {
    const row = await this.readRetired(owner, retiredId)
    if (!row?.encrypted_grant || (row.state !== 'pending' && row.state !== 'unknown')) return
    const secret = isEncryptedSecretValue(row.encrypted_grant) ? this.secretValue(row.encrypted_grant) : null
    const outcome = secret
      ? await this.revokeOutcome(secret, row.connection_id, {
          origin: row.target_origin,
          tenantId: row.yuantus_tenant_id,
          orgId: row.yuantus_org_id,
        })
      : 'unknown'
    await this.tx(async (client) => {
      const settled = await client.query(
        `UPDATE plm_personal_bom_write_retired_grants
         SET state=$2,
             encrypted_grant=CASE WHEN $2 IN ('revoked', 'rejected') THEN NULL ELSE encrypted_grant END,
             updated_at=now()
         WHERE id=$1 AND owner_id=$3 AND encrypted_grant=$4 AND state IN ('pending', 'unknown')`,
        [row.id, outcome, owner, row.encrypted_grant],
      )
      if (!settled.rowCount) return
      if (row.slot === 'current') {
        await client.query(
          `UPDATE plm_personal_bom_write_bindings
           SET remote_revoke_state=$3, updated_at=now()
           WHERE id=$1 AND generation=$2 AND remote_revoke_state IN ('pending', 'unknown') AND encrypted_grant IS NULL`,
          [row.binding_id, row.binding_generation, outcome],
        )
        return
      }
      await client.query(
        `UPDATE plm_personal_bom_write_bindings
         SET previous_grant_revoke_state=$4, updated_at=now()
         WHERE id=$1 AND generation=$2 AND grant_id=$3 AND previous_grant_revoke_state IN ('pending', 'unknown')`,
        [row.binding_id, row.binding_generation, row.successor_grant_id, outcome],
      )
    })
  }

  private secretValue(ciphertext: string): string | null {
    try {
      return decryptStoredSecretValue(ciphertext)
    } catch {
      return null
    }
  }

  private async readRetired(owner: string, retiredId: string): Promise<RetiredGrant | undefined> {
    const found = await this.pool.connect()
    try {
      const row = (
        await found.query<RetiredGrant>(
          `SELECT id, binding_id, owner_id, connection_id, yuantus_tenant_id, yuantus_org_id,
                  target_origin, grant_id, encrypted_grant, state, binding_generation, successor_grant_id, slot
           FROM plm_personal_bom_write_retired_grants
           WHERE id=$1 AND owner_id=$2`,
          [retiredId, owner],
        )
      ).rows[0]
      return row
    } finally {
      found.release()
    }
  }

  /**
   * One attempt. 408 and 429 refuse this call and leave the native grant valid, so the
   * ciphertext stays for a later caller-driven retry. There is no delay and no internal loop.
   * A definite received 4xx, such as 401, is rejected and drops the ciphertext.
   */
  private async revokeOutcome(
    secret: string,
    connectionId: string,
    authority: PersonalBomWriteAuthority,
  ): Promise<'revoked' | 'unknown' | 'rejected'> {
    try {
      await this.provider().personalBomWriteRequest('revoke', secret, connectionId, authority)
      return 'revoked'
    } catch (error) {
      if (!(error instanceof Failure) || !error.received || error.status >= 500) return 'unknown'
      if (error.status === 408 || error.status === 429) return 'unknown'
      return 'rejected'
    }
  }

  /**
   * Commit the immutable intent, then send it once.
   * A thrown phase-1 COMMIT is uncertain and does not call the provider.
   * The provider key is hashed only on first insert. A later denial does not erase a confirmed response.
   */
  async dispatchOperation(
    actor: PersonalBomWriteActor,
    dataSourceId: string,
    input: unknown,
  ): Promise<PersonalBomWriteDispatchReceipt> {
    requirePlmPersonalBomWrite()
    if (
      typeof dataSourceId !== 'string' ||
      dataSourceId.length < 1 ||
      dataSourceId.length > 256 ||
      !/^[\x20-\x7e]+$/.test(dataSourceId)
    )
      throw new Failure(422, 'PLM_BOM_WRITE_INVALID')
    const request = readPersonalBomWriteDispatch(input)
    const caller = this.readActor(actor)
    const intentId = await this.tx((client) => this.freezeIntent(client, caller, dataSourceId, request))
    const sent = await this.tx((client) => this.sendIntent(client, caller, dataSourceId, request, intentId))
    if (!('receipt' in sent)) throw sent.failure
    return sent.receipt
  }

  private async freezeIntent(
    client: PoolClient,
    caller: { userId: string; metaTenantId: string | null },
    dataSourceId: string,
    request: PersonalBomWriteDispatchRequest,
  ): Promise<string> {
    const { source, binding } = await this.lockDispatch(client, caller, dataSourceId)
    const intent = await this.lockIntent(client, caller.userId, dataSourceId, request)
    if (intent) {
      if (!this.sameFrozenRequest(intent, request)) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
      return intent.id
    }
    this.usableGrant(binding)
    this.assertLiveBinding(source, binding)
    const sourceTenant = normalizeMetaTenant(source.tenant_id)
    const providerKey = providerIdempotencyKey({
      operationKind: request.operationKind,
      ownerId: binding.owner_id,
      dataSourceId: binding.data_source_id,
      metaTenantId: binding.meta_tenant_id,
      targetOrigin: binding.target_origin,
      connectionId: binding.connection_id,
      yuantusTenantId: binding.yuantus_tenant_id,
      yuantusOrgId: binding.yuantus_org_id,
      subjectId: binding.subject_id,
      clientKey: request.clientKey,
    })
    const created = (
      await client.query<IntentRow>(
        `INSERT INTO plm_personal_bom_write_intents(
           id, owner_id, data_source_id, operation_kind, client_key_sha256,
           actor_meta_tenant_id, source_meta_tenant_id, workspace_id, scope_kind, target_origin,
           connection_id, yuantus_tenant_id, yuantus_org_id, subject_id, purpose,
           part_id, bom_line_id, if_match, request_body, payload_fingerprint, provider_idempotency_key,
           binding_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'bom_write',$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (owner_id, data_source_id, operation_kind, client_key_sha256) DO NOTHING
         RETURNING ${INTENT_COLUMNS}`,
        [
          randomUUID(),
          caller.userId,
          dataSourceId,
          request.operationKind,
          request.clientKeySha256,
          caller.metaTenantId,
          sourceTenant,
          source.workspace_id ?? null,
          source.scope_kind,
          binding.target_origin,
          binding.connection_id,
          binding.yuantus_tenant_id,
          binding.yuantus_org_id,
          binding.subject_id,
          request.partId,
          request.bomLineId,
          request.ifMatch,
          request.requestBody,
          request.payloadFingerprint,
          providerKey,
          binding.id,
        ],
      )
    ).rows[0]
    if (created) return created.id
    const raced = await this.lockIntent(client, caller.userId, dataSourceId, request)
    if (!raced || !this.sameFrozenRequest(raced, request)) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
    return raced.id
  }

  private async sendIntent(
    client: PoolClient,
    caller: { userId: string; metaTenantId: string | null },
    dataSourceId: string,
    request: PersonalBomWriteDispatchRequest,
    intentId: string,
  ): Promise<{ failure: Failure } | { failure: null; receipt: PersonalBomWriteDispatchReceipt }> {
    const { source, binding } = await this.lockDispatch(client, caller, dataSourceId)
    const intent = await this.lockIntent(client, caller.userId, dataSourceId, request)
    if (!intent || intent.id !== intentId) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
    if (!this.sameFrozenRequest(intent, request)) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
    this.assertLiveIntent(source, binding, intent, caller.metaTenantId)
    const grant = this.usableGrant(binding)
    const authority: PersonalBomWriteAuthority = {
      origin: intent.target_origin,
      tenantId: intent.yuantus_tenant_id,
      orgId: intent.yuantus_org_id,
    }
    const data = intent.operation_kind === 'line' ? JSON.parse(intent.request_body) as unknown : undefined
    let native: unknown
    try {
      native = await this.provider().personalBomWriteRequest(
        intent.operation_kind,
        grant,
        intent.connection_id,
        authority,
        data,
        {
          partId: intent.part_id,
          ...(intent.bom_line_id ? { bomLineId: intent.bom_line_id } : {}),
          idempotencyKey: intent.provider_idempotency_key,
          ...(intent.if_match ? { ifMatch: intent.if_match } : {}),
        },
      )
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(503, 'PLM_BOM_WRITE_UNAVAILABLE')
      await this.recordIntentOutcome(client, intent, this.wireOutcome(failure), null)
      return { failure }
    }
    let parsed: ReturnType<typeof acceptedPersonalBomWriteResult>
    try {
      parsed = acceptedPersonalBomWriteResult(intent.operation_kind, native)
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
      await this.recordIntentOutcome(client, intent, 'unknown', null)
      return { failure }
    }
    const canonical = canonicalPayload(parsed)
    if (!this.acknowledgementAgrees(intent, parsed, canonical)) {
      const failure = new Failure(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
      await this.recordIntentOutcome(client, intent, 'unknown', null)
      return { failure }
    }
    await this.recordIntentOutcome(client, intent, 'accepted', canonical)
    return { failure: null, receipt: this.receipt(intent, parsed) }
  }

  /** A shape-valid body is not acceptance unless it names the frozen line and repeats a stored confirmation. */
  private acknowledgementAgrees(
    intent: IntentRow,
    parsed: ReturnType<typeof acceptedPersonalBomWriteResult>,
    canonical: string,
  ): boolean {
    if (intent.operation_kind === 'line') {
      const line = parsed as { bom_line_id?: string }
      if (line.bom_line_id !== intent.bom_line_id) return false
    }
    return intent.confirmed_response == null || intent.confirmed_response === canonical
  }

  private receipt(intent: IntentRow, native: ReturnType<typeof acceptedPersonalBomWriteResult>): PersonalBomWriteDispatchReceipt {
    return {
      intentId: intent.id,
      operationKind: intent.operation_kind,
      dataSourceId: intent.data_source_id,
      partId: intent.part_id,
      bomLineId: intent.bom_line_id,
      providerIdempotencyKey: intent.provider_idempotency_key,
      clientKeySha256: intent.client_key_sha256,
      actorMetaTenantId: intent.actor_meta_tenant_id,
      sourceMetaTenantId: intent.source_meta_tenant_id,
      outcome: 'accepted',
      native,
    }
  }

  /** users SHARE, membership SHARE, source UPDATE, binding UPDATE. The intent lock follows. */
  private async lockDispatch(
    client: PoolClient,
    caller: { userId: string; metaTenantId: string | null },
    dataSourceId: string,
  ): Promise<{ source: SourceRow; binding: Binding }> {
    await this.activeOwner(client, caller.userId)
    if (caller.metaTenantId !== null) await this.requireMembership(client, caller.userId, caller.metaTenantId)
    const source = await this.lockSource(client, dataSourceId, caller.userId)
    this.assertPersistedTenant(source, caller.metaTenantId)
    const binding = (
      await client.query<Binding>(
        `SELECT ${BINDING_COLUMNS} FROM plm_personal_bom_write_bindings
         WHERE owner_id=$1 AND data_source_id=$2 FOR UPDATE`,
        [caller.userId, dataSourceId],
      )
    ).rows[0]
    if (!binding) throw new Failure(404, 'PLM_BOM_WRITE_NOT_FOUND')
    return { source, binding }
  }

  private async lockIntent(
    client: PoolClient,
    ownerId: string,
    dataSourceId: string,
    request: PersonalBomWriteDispatchRequest,
  ): Promise<IntentRow | undefined> {
    const found = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM plm_personal_bom_write_intents
       WHERE owner_id=$1 AND data_source_id=$2 AND operation_kind=$3 AND client_key_sha256=$4
       FOR UPDATE`,
      [ownerId, dataSourceId, request.operationKind, request.clientKeySha256],
    )
    return found.rows[0]
  }

  private sameFrozenRequest(intent: IntentRow, request: PersonalBomWriteDispatchRequest): boolean {
    return (
      intent.operation_kind === request.operationKind &&
      intent.part_id === request.partId &&
      (intent.bom_line_id ?? null) === request.bomLineId &&
      (intent.if_match ?? null) === request.ifMatch &&
      intent.request_body === request.requestBody &&
      intent.payload_fingerprint === request.payloadFingerprint &&
      intent.client_key_sha256 === request.clientKeySha256
    )
  }

  private assertLiveBinding(source: SourceRow, binding: Binding): void {
    this.sameSnapshot(source, binding)
    this.assertCurrentTarget(source, binding)
  }

  /** Same person and native scope. A replacement grant is allowed; its id is not compared. */
  private assertLiveIntent(
    source: SourceRow,
    binding: Binding,
    intent: IntentRow,
    actorTenant: string | null,
  ): void {
    this.assertLiveBinding(source, binding)
    const resolved = resolvePersistedPlmSource(this.configOf(source))
    const sourceTenant = normalizeMetaTenant(source.tenant_id)
    const workspaceId = source.workspace_id ?? null
    if (
      actorTenant !== intent.actor_meta_tenant_id ||
      sourceTenant !== intent.source_meta_tenant_id ||
      workspaceId !== (intent.workspace_id ?? null) ||
      source.scope_kind !== intent.scope_kind ||
      source.owner_id !== intent.owner_id ||
      source.id !== intent.data_source_id ||
      resolved.origin.origin !== intent.target_origin ||
      resolved.tenantId !== intent.yuantus_tenant_id ||
      resolved.orgId !== intent.yuantus_org_id ||
      binding.owner_id !== intent.owner_id ||
      binding.data_source_id !== intent.data_source_id ||
      binding.subject_id !== intent.subject_id ||
      binding.connection_id !== intent.connection_id ||
      binding.yuantus_tenant_id !== intent.yuantus_tenant_id ||
      binding.yuantus_org_id !== intent.yuantus_org_id ||
      binding.target_origin !== intent.target_origin ||
      binding.meta_tenant_id !== intent.source_meta_tenant_id ||
      (binding.workspace_id ?? null) !== (intent.workspace_id ?? null) ||
      binding.scope_kind !== intent.scope_kind ||
      binding.purpose !== 'bom_write' ||
      intent.purpose !== 'bom_write'
    )
      throw new Failure(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }

  private usableGrant(row: Binding): string {
    if (row.purpose !== 'bom_write' || !row.encrypted_grant || row.remote_revoke_state)
      throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
    const secret = this.secret(row)
    if (!secret || new Date(row.expires_at).getTime() <= Date.now())
      throw new Failure(401, 'PLM_BOM_WRITE_UNAUTHORIZED')
    return secret
  }

  /** Received 408, 429, and 5xx stay unknown. A later 403 does not clear saw_unknown or a confirmed body. */
  private wireOutcome(error: Failure): 'unknown' | 'denied' {
    if (!error.received || error.status === 408 || error.status === 429 || error.status >= 500) return 'unknown'
    return 'denied'
  }

  private async recordIntentOutcome(
    client: PoolClient,
    intent: IntentRow,
    outcome: 'accepted' | 'unknown' | 'denied',
    confirmed: string | null,
  ): Promise<void> {
    const saved = await client.query(
      `UPDATE plm_personal_bom_write_intents
       SET outcome=$2,
           saw_unknown = saw_unknown OR $3,
           confirmed_response = CASE
             WHEN confirmed_response IS NULL AND $4::text IS NOT NULL THEN $4
             ELSE confirmed_response
           END,
           updated_at=now()
       WHERE id=$1 AND owner_id=$5 AND provider_idempotency_key=$6
         AND client_key_sha256=$7 AND request_body=$8 AND part_id=$9
         AND bom_line_id IS NOT DISTINCT FROM $10
         AND if_match IS NOT DISTINCT FROM $11`,
      [
        intent.id,
        outcome,
        outcome === 'unknown',
        outcome === 'accepted' ? confirmed : null,
        intent.owner_id,
        intent.provider_idempotency_key,
        intent.client_key_sha256,
        intent.request_body,
        intent.part_id,
        intent.bom_line_id,
        intent.if_match,
      ],
    )
    if (!saved.rowCount) throw new Failure(409, 'PLM_BOM_WRITE_CONFLICT')
  }
}
