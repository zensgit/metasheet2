import { createHash, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { ATTACHMENT_ADMISSION_EXTRA_MIGRATIONS } from './recovery-archive-attachment-admission-fixture'
import { OWNED_CLAIM_MIGRATIONS } from './recovery-archive-owned-claim-fixture'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { sealDirectEventOperation } from '../../src/multitable/recovery-archive-seals'
import { seedVerifiedArchive, type Fixture } from './recovery-archive-verified-fixture'
import { createRecoveryArchiveDurableFixture, type RecoveryArchiveDurableFixture } from './recovery-archive-durable-fixture'
import type { RecoveryArchiveObjectDescriptor, RecoveryArchiveObjectReadResult, RecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import { canonicalizeRecoveryArchiveJson } from '../../src/multitable/recovery-archive-manifest'
import { hashAnchorRecoveryScope, hashExactAnchorLiveSet, hashExactAnchorSchema, hashRecoveryAuthorizationScope, mintExactArchiveRecoveryIdentity } from '../../src/multitable/restore-preview-identity'
import { compileRecoveryArchiveRestorePlan } from '../../src/multitable/recovery-archive-restore-plan'
import { persistRecoveryArchiveAsyncPlan, acceptFrozenRecoveryArchiveRestoreJob, type RecoveryArchiveAsyncChunkPayload, type RecoveryArchiveAsyncPlanPayload, type RecoveryArchiveAsyncPlanObject } from '../../src/multitable/recovery-archive-async-plan'
import { prepareRecoveryArchiveRestorePlan, selectRecoveryArchiveRestoreJobCandidate, claimRecoveryArchiveRestoreJob, type RecoveryArchiveRestoreJobQuery } from '../../src/multitable/recovery-archive-restore-jobs'

export const FOREIGN_RESET_EXTRA_MIGRATIONS = [
  'zzzz20260326124000_add_config_to_meta_views',
  'zzzz20260411140100_create_field_permissions',
  'zzzz20260413100000_create_record_permissions',
  'zzzz20260413130000_create_formula_dependencies',
  'zzzz20260430163000_add_meta_record_modified_by',
  'zzzz20260505103000_create_meta_record_subscriptions',
  'zzzz20260505110000_create_meta_field_auto_number_sequences',
  'zzzz20260612140000_add_meta_record_locked',
  'zzzz20260617140000_rowlevel_read_deny_foundation',
  'zzzz20260618120000_conditional_read_rules',
  'zzzz20260619120000_add_meta_record_revisions_batch_id',
  'zzzz20260711000000_add_meta_record_revisions_restored_from_version',
  'zzzz20260719120000_create_meta_recovery_token_burns',
  'zzzz20260721121000_add_recovery_authority_locks',
  'zzzz20260728120000_correct_recovery_authority_locks',
  'zzzz20260821120000_recovery_authority_functions_fix_search_path',
  'zzzz20260828125000_add_recovery_archive_object_receipt_authority',
  'zzzz20260828130000_add_recovery_archive_legal_hold_authority',
  'zzzz20260828131000_create_recovery_archive_restore_jobs',
  'zzzz20260915160000_create_recovery_archive_derived_effects',
] as const
export const FOREIGN_RESET_MIGRATIONS = [...new Set([...OWNED_CLAIM_MIGRATIONS, ...ATTACHMENT_ADMISSION_EXTRA_MIGRATIONS, ...FOREIGN_RESET_EXTRA_MIGRATIONS])].sort()
export type NativeHook = (sql: string, params: unknown[] | undefined, client: PoolClient,
  execute: () => Promise<QueryResult>) => Promise<QueryResult>
const digest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')

export async function createForeignResetFixture(admin: Pool, foreignFirst = true) {
  const namespace = `tm_foreign_reset_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const database = `${namespace}_db`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 500, options: '-c statement_timeout=15000' })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const identity = { actorId: randomUUID(), requestId: randomUUID(), workspaceId: `${namespace}_workspace`, baseId: `${namespace}_base`, sheetId: `${namespace}_foreign` }
  const owned = { pool, identity, keyId: `${namespace}_key`, checkpointId: `${namespace}_checkpoint`, recordId: `${namespace}_record`,
    async dispose() {
      await db.destroy()
      const outcome = await dropScratchDatabase(admin, database)
      console.log(formatScratchDropOutcome('foreign-reset-admission', outcome))
      if (outcome.forced || outcome.residualBackends) throw new Error('foreign_reset_scratch_cleanup_not_clean')
    },
    async addAttachments(count: number) {
      const ids = Array.from({ length: count }, (_, index) => `${namespace}_attachment_${index}`)
      for (const id of ids) await pool.query(`INSERT INTO multitable_attachments(id,sheet_id,storage_file_id,filename,mime_type,size,storage_path)
        VALUES($1,$2,$3,'Synthetic','application/octet-stream',17,$4)`, [id, identity.sheetId, `${id}_storage`, `${id}_opaque`])
      return ids
    },
  }
  let depth = 0
  const control: { hook?: NativeHook; defaultRR: boolean; rrOnce: boolean; inherited: string[]; pid: number } = { defaultRR: false, rrOnce: false, inherited: [], pid: 0 }
  const query = (sql: string, params?: unknown[]) => pool.query(sql, params)
  async function transaction<T>(work: (txQuery: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    control.pid = Reflect.get(client, 'processID') as number
    let prior: string | undefined
    try {
      if (control.defaultRR) {
        prior = (await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation
        await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        control.inherited.push((await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation)
        if (control.rrOnce) control.defaultRR = false
      }
      await client.query('BEGIN'); depth += 1
      const txQuery = (sql: string, params?: unknown[]) => control.hook
        ? control.hook(sql, params, client, () => client.query(sql, params)) : client.query(sql, params)
      const value = await work(txQuery)
      await client.query('COMMIT')
      return value
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally {
      depth -= 1
      if (prior !== undefined) await client.query("SELECT set_config('default_transaction_isolation',$1,false)", [prior])
      client.release()
    }
  }
  try {
    for (const name of FOREIGN_RESET_MIGRATIONS) await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    await query(`INSERT INTO meta_bases(id,name,workspace_id,owner_id) VALUES($1,'Synthetic',$2,$3)`, [identity.baseId, identity.workspaceId, identity.actorId])
    await query(`INSERT INTO meta_sheets(id,base_id,name,recovery_writer_owner_fence) VALUES($1,$2,'Synthetic',6)`, [identity.sheetId, identity.baseId])
    await query(`INSERT INTO meta_history_trust_checkpoints(id,sheet_id,state,trusted_since_seq) VALUES($1,$2,'active',1)`, [owned.checkpointId, identity.sheetId])
    await query(`INSERT INTO meta_recovery_archive_keys(key_id) VALUES($1)`, [owned.keyId])
    await query(`INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic-unused')`, [identity.actorId, `${identity.actorId}@synthetic.invalid`])
    await query(`INSERT INTO meta_records(id,sheet_id,data,created_by) VALUES($1,$2,'{}',$3)`, [owned.recordId, identity.sheetId, identity.actorId])
    // The real migration deliberately starts inert. This isolated fixture arms every authority trigger;
    // no teardown disables them: dropping the owned scratch database is the cleanup boundary.
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    const guards = (await query('SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[])', [RECOVERY_AUTHORITY_TRIGGERS.map(([, trigger]) => trigger)])).rows
    if (guards.length !== 9 || guards.some((guard) => guard.tgenabled !== 'O')) throw new Error('foreign_reset_authority_guards_not_enabled')
    console.log(`actualMigrationUps=${FOREIGN_RESET_MIGRATIONS.length} authorityTriggersEnabled=${guards.length}`)
    await query(`UPDATE users SET role='admin',permissions='["multitable:read","multitable:write","multitable:share","multitable:manage-schema"]' WHERE id=$1`, [identity.actorId])
    const pins = await owned.addAttachments(1)
    let sheetId = `${foreignFirst ? 'zz' : 'aa'}_${identity.sheetId}_target`
    let fieldId = `${sheetId}_note`
    let keepId = `${sheetId}_keep`
    let deleteId = `${sheetId}_delete`
    const linkField = `${identity.sheetId}_link`
    const linkId = `${identity.sheetId}_incoming`
    await query(`INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic target')`, [sheetId, identity.baseId])
    await query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,'Note','string','{}',1)`, [fieldId, sheetId])
    const floor = (await query(`SELECT nextval('meta_record_chain_seq')::text AS seq`)).rows[0].seq
    await query(`INSERT INTO meta_history_trust_checkpoints(id,sheet_id,state,trusted_since_seq) VALUES($1,$2,'active',$3::bigint)`, [`${sheetId}_checkpoint`, sheetId, floor])
    async function revision(recordId: string, version: number, action: 'create' | 'update', data: Record<string, unknown>) {
      return transaction(async (q) => {
        const op = randomUUID()
        const rows = await q(`INSERT INTO meta_record_revisions(sheet_id,record_id,version,action,source,operation_id,snapshot)
          VALUES($1,$2,$3,$4,'rest',$5::uuid,$6::jsonb) RETURNING seq::text`, [sheetId, recordId, version, action, op, JSON.stringify(data)])
        await sealDirectEventOperation(q, { sheetId, operationId: op, endpointSeq: rows.rows[0].seq, eventCount: 1, operationKind: 'ordinary' })
        return op
      })
    }
    await query(`INSERT INTO meta_records(id,sheet_id,data,created_by) VALUES($1,$2,$3::jsonb,$4)`, [keepId, sheetId, JSON.stringify({ [fieldId]: 'keep' }), identity.actorId])
    const anchorOperationId = await revision(keepId, 1, 'create', { [fieldId]: 'keep' })
    await query(`INSERT INTO meta_records(id,sheet_id,data,created_by) VALUES($1,$2,$3::jsonb,$4)`, [deleteId, sheetId, JSON.stringify({ [fieldId]: 'created after anchor' }), identity.actorId])
    await revision(deleteId, 1, 'create', { [fieldId]: 'created after anchor' })
    await query(`INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES($1,$2,'Incoming','link',$3::jsonb)`, [linkField, identity.sheetId, JSON.stringify({ foreignSheetId: sheetId })])
    await query(`INSERT INTO meta_links(id,field_id,record_id,foreign_record_id) VALUES($1,$2,$3,$4)`, [linkId, linkField, owned.recordId, deleteId])
    await query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,jsonb_build_array($3::text)) WHERE id=$1`, [owned.recordId, linkField, deleteId])
    const objects = new Map<string, RecoveryArchiveObjectReadResult>()
    const provider: RecoveryArchiveObjectStoreProvider = {
      async put(request) {
        if (depth) throw new Error('synthetic_provider_in_transaction')
        const key = `${request.generationId}/${request.objectId}`
        const existing = objects.get(key)
        if (existing && existing.sha256 !== request.sha256) throw new Error('synthetic_immutable_object_conflict')
        objects.set(key, { ...request, bytes: new Uint8Array(request.bytes) })
        const { bytes: _bytes, ...object } = request
        return { outcome: existing ? 'existing' : 'created', object }
      },
      async get(request) {
        if (depth) throw new Error('synthetic_provider_in_transaction')
        const value = objects.get(`${request.generationId}/${request.objectId}`)
        if (!value || value.sha256 !== request.expectedSha256 || value.version !== request.expectedVersion || value.size !== request.expectedSize) throw new Error('synthetic_object_binding_mismatch')
        return { ...value, bytes: new Uint8Array(value.bytes) }
      },
      async head(request) {
        const value = objects.get(`${request.generationId}/${request.objectId}`)
        if (!value) return null
        const { bytes: _bytes, ...descriptor } = value
        return descriptor
      },
      async pin(request) { const value = await this.head(request); if (!value) throw new Error('synthetic_missing_object'); const key = `${request.generationId}/${request.objectId}`; objects.set(key, { ...objects.get(key)!, pinned: true }); return { ...value, pinned: true } },
      async deleteExpired(request) { return { outcome: 'retained', object: await this.head(request) } },
    }
    let archive: Fixture | undefined
    let durable: RecoveryArchiveDurableFixture | undefined
    async function seedArchive(rowCount = 1) {
      archive = await seedVerifiedArchive({ prefix: `${foreignFirst ? 'zz' : 'aa'}_tm_foreign_reset`, query, transaction, label: randomUUID().slice(0, 8),
        materialize: async (candidate) => {
          candidate.actorId = identity.actorId
          fieldId = `${candidate.sheetId}_note`
          const time = (await query(`SELECT created_at,expires_at FROM meta_recovery_archives WHERE generation_id=$1::uuid`, [candidate.generationId])).rows[0]
          durable = await createRecoveryArchiveDurableFixture({ binding: { archive_generation_id: candidate.generationId,
            workspace_id: candidate.workspaceId, base_id: candidate.baseId, sheet_id: candidate.sheetId, anchor_operation_id: candidate.anchorOperationId,
            anchor_seq: candidate.anchorSeq, checkpoint_id: candidate.checkpointId, created_at: time.created_at.toISOString(), expires_at: time.expires_at.toISOString(), source_vector_hash: candidate.sourceVectorHash },
          keyId: candidate.keyId, sectionRows: { schema: [{ field_id: fieldId, name: 'Note', type: 'string', property: {}, order: 1 }],
            records: [], links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [], attachments_index: [], permission_evidence: [], views_config: [] },
          objectStore: provider, transactionDepth: { currentTransactionDepth: () => depth }, objectExpiresAt: time.expires_at.toISOString() })
          return durable
        },
      })
      sheetId = archive.sheetId; deleteId = `${sheetId}_record_00000`; keepId = `${sheetId}_unused`
      await query(`UPDATE meta_bases SET owner_id=$2 WHERE id=$1`, [archive.baseId, identity.actorId])
      await query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,'Note','string','{}',1)`, [fieldId, sheetId])
      await query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by) SELECT $1||lpad(n::text,5,'0'),$2,jsonb_build_object($3::text,'live'),1,$4 FROM generate_series(0,$5::int-1) n`, [`${sheetId}_record_`, sheetId, fieldId, identity.actorId, rowCount])
      await query(`UPDATE meta_fields SET property=$2::jsonb WHERE id=$1`, [linkField, JSON.stringify({ foreignSheetId: sheetId })])
      await query(`UPDATE meta_links SET foreign_record_id=$2 WHERE id=$1`, [linkId, deleteId])
      await query(`UPDATE meta_records SET data=data||jsonb_build_object($2::text,jsonb_build_array($3::text)) WHERE id=$1`, [owned.recordId, linkField, deleteId])
      return { archive, runtime: { keyCustody: durable!.keyCustody, objectStore: provider, transactionDepth: { currentTransactionDepth: () => depth } } }
    }
    return { ...owned, query, transaction, control, pins, linkField, linkId, anchorOperationId,
      get sheetId() { return sheetId }, get fieldId() { return fieldId }, get keepId() { return keepId }, get deleteId() { return deleteId },
      seedArchive,
      async seedAsyncJob(recheckAuthority: (query: RecoveryArchiveRestoreJobQuery, identity: { workspaceId: string; baseId: string; sheetId: string; actorId: string }) => Promise<boolean>, workerLeaseMs = 300000) {
        const seeded = await seedArchive(5001)
        const target = seeded.archive
        const recordIds = Array.from({ length: 5001 }, (_, index) => `${sheetId}_record_${String(index).padStart(5, '0')}`)
        const expiresAt = new Date(Date.now() + 300000).toISOString()
        const live = recordIds.map((id) => ({ recordId: id, version: 1 }))
        const initialHash = hashExactAnchorLiveSet(live, [])
        const afterHash = hashExactAnchorLiveSet(live.slice(1), [])
        const schemaHash = hashExactAnchorSchema([{ id: fieldId, type: 'string', property: {} }])
        function object<T>(payload: T): RecoveryArchiveAsyncPlanObject<T> {
          const bytes = new TextEncoder().encode(canonicalizeRecoveryArchiveJson(payload))
          const sha256 = digest(bytes)
          return { payload, bytes, descriptor: { generationId: target.generationId, objectId: sha256, version: '1', sha256, size: String(bytes.length), expiresAt, pinned: false } }
        }
        const chunkObjects = [recordIds.slice(0, 1), recordIds.slice(1)].map((ids, index) => object<RecoveryArchiveAsyncChunkPayload>({
          format: 'metasheet.recovery-archive.restore-chunk.v1', chunkIndex: index,
          expectedAnchorScopeHash: hashAnchorRecoveryScope(ids.map((recordId) => ({ recordId, exists: false, version: null }))),
          expectedLiveSetHash: index === 0 ? initialHash : afterHash,
          expectedFinalLiveSetHash: index === 0 ? afterHash : hashExactAnchorLiveSet([], []), schemaHash,
          operations: ids.map((recordId) => ({ kind: 'delete', recordId, expectedVersion: 1 })),
        }))
        const payload: RecoveryArchiveAsyncPlanPayload = { format: 'metasheet.recovery-archive.restore-plan.v1', workspaceId: target.workspaceId,
          baseId: target.baseId, sheetId, actorId: identity.actorId, recoveryMode: 'reset', scopeKind: 'whole_sheet', scopeHash: hashAnchorRecoveryScope([]),
          archiveGenerationId: target.generationId, archiveRootHash: target.rootHash, sourceVectorHash: target.sourceVectorHash, keyId: target.keyId,
          anchorOperationId: target.anchorOperationId, anchorSeq: target.anchorSeq, checkpointId: target.checkpointId, schemaHash,
          authorizedScopeHash: hashRecoveryAuthorizationScope({ sheetId, actorId: identity.actorId }), initialLiveSetHash: initialHash, finalLiveSetHash: hashExactAnchorLiveSet([], []),
          selectedRecordIds: [], selectedFieldIds: [], chunks: chunkObjects.map((obj, index) => ({ chunkIndex: index, chunkHash: obj.descriptor.sha256, objectId: obj.descriptor.objectId, version: obj.descriptor.version, sha256: obj.descriptor.sha256, size: obj.descriptor.size, expiresAt: obj.descriptor.expiresAt, recordCount: String(obj.payload.operations.length) })),
        }
        const planObject = object(payload)
        const plan = compileRecoveryArchiveRestorePlan({ ...payload, planObjectId: planObject.descriptor.objectId, planObjectVersion: planObject.descriptor.version,
          planObjectSha256: planObject.descriptor.sha256, planObjectSize: planObject.descriptor.size, planObjectExpiresAt: expiresAt,
          chunks: payload.chunks.map((c) => ({ chunkIndex: c.chunkIndex, chunkHash: c.chunkHash, chunkObjectId: c.objectId, chunkObjectVersion: c.version,
            chunkObjectSha256: c.sha256, chunkObjectSize: c.size, chunkObjectExpiresAt: expiresAt, recordCount: c.recordCount })) })
        const bundle = { plan, planObject, chunkObjects }
        await persistRecoveryArchiveAsyncPlan(provider, bundle)
        const token = mintExactArchiveRecoveryIdentity({ sheetId, actorId: identity.actorId, mode: 'reset', scopeKind: 'whole_sheet', scopeHash: payload.scopeHash,
          anchorOperationId: target.anchorOperationId, anchorSeq: target.anchorSeq, checkpointId: target.checkpointId, liveSetHash: initialHash, schemaHash,
          authorizedScopeHash: payload.authorizedScopeHash, archiveGenerationId: target.generationId, archiveRootHash: target.rootHash, archiveSourceVectorHash: target.sourceVectorHash,
          archiveKeyId: target.keyId, archivePlanHash: plan.planHash, archivePlanObject: { objectId: planObject.descriptor.objectId, version: planObject.descriptor.version, sha256: planObject.descriptor.sha256, size: planObject.descriptor.size, expiresAt } }, '60s')
        const restoreIdentity = { workspaceId: target.workspaceId, baseId: target.baseId, sheetId, actorId: identity.actorId }
        await prepareRecoveryArchiveRestorePlan(transaction, { token, plan, identity: restoreIdentity })
        const accepted = await acceptFrozenRecoveryArchiveRestoreJob(transaction, provider, { currentTransactionDepth: () => depth }, { identity: restoreIdentity, token,
          resumeDeadline: expiresAt, recheckAuthority: (q) => recheckAuthority(q, restoreIdentity) })
        const candidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
        if (!candidate || candidate.jobId !== accepted.id) throw new Error('foreign_reset_actual_candidate_missing')
        const worker = await claimRecoveryArchiveRestoreJob(transaction, candidate, { workerOwnerId: 'synthetic_g2_worker', leaseUntil: new Date(Math.min(Date.now() + workerLeaseMs, Date.parse(expiresAt))).toISOString() })
        return { ...seeded, worker, accepted, bundle, actualRows: 5001, actualOperations: 5001, chunks: [1, 5000] }
      },
    }
  } catch (error) { await owned.dispose(); throw error }
}
export type ForeignResetFixture = Awaited<ReturnType<typeof createForeignResetFixture>>
