/**
 * SA06AQ: public archive preview/execute FACADES, not an HTTP/JWT or browser test.
 * A fresh, local, fully migrated PostgreSQL database is supplied by the harness.
 * Archive bytes and custody are synthetic; authentication/decryption, permissions,
 * L8 recovery, revision/seal/burn accounting and the record producer are real.
 * SA06AR also runs one real async worker tick; no background loop or delivery
 * consumer is started. This file never installs/repairs the public schema.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { createAutomationReadRecordConditions } from '../../src/integration/automation-read-record-conditions'
import { createRecoveryArchiveWorkerAuthorization, createRecoveryArchiveWorkerCallbacks } from '../../src/routes/univer-meta'
import type { ExactAnchorAppliedMutation } from '../../src/multitable/exact-anchor-recovery-execute'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { createLocalRecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import { acceptFrozenRecoveryArchiveRestoreJob } from '../../src/multitable/recovery-archive-async-plan'
import { previewRecoveryArchive, type RecoveryArchivePreviewRuntime } from '../../src/multitable/recovery-archive-preview'
import type { RecoveryArchiveRestoreJobTransaction } from '../../src/multitable/recovery-archive-restore-jobs'
import { createRecoveryArchiveRestoreWorker } from '../../src/multitable/recovery-archive-restore-worker'
import { executeRecoveryArchiveSync } from '../../src/multitable/recovery-archive-sync-execute'
import { enqueueRecoveryMutationEvent, type RecoveryMutationEvent } from '../../src/multitable/recovery-mutation-events'
import { createRecoveryArchiveDurableFixture, type RecoveryArchiveDurableFixture } from '../utils/recovery-archive-durable-fixture'
import { seedVerifiedArchive, type Fixture } from '../utils/recovery-archive-verified-fixture'

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  throw new Error('SA06AQ_REAL_DB_HARNESS_MISSING_DATABASE_URL')
}
const enabled = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = enabled ? describe : describe.skip
const prefix = 'sa06aq_' + randomBytes(8).toString('hex')
const fullPermissions = ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema']
const flagNames = ['JWT_SECRET', 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE',
  'MULTITABLE_HISTORY_CONTIGUITY_STRICT', 'AUTOMATION_DURABLE_DELIVERY_ENABLED'] as const
const previousEnv = new Map(flagNames.map(name => [name, process.env[name]]))

type Observations = { captures: number; conflicts: number; savepointRollbacks: number; updates: number; zeroUpdates: number; imageFailures: number }
const observation = (): Observations => ({ captures: 0, conflicts: 0, savepointRollbacks: 0, updates: 0, zeroUpdates: 0, imageFailures: 0 })
const errorCode = (error: unknown): unknown => error && typeof error === 'object'
  ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
let pool: Pool | undefined
let transactionDepth = 0
let activeObservation: Observations | undefined
const roots: string[] = []
const triggerPostures: Array<{ table: string; trigger: string; restore: string }> = []

function database(): Pool {
  if (!pool) throw new Error('SA06AQ_DATABASE_NOT_READY')
  return pool
}
const q = (statement: string, params: unknown[] = []) => database().query<Record<string, unknown>>(statement, params)
const transaction: RecoveryArchiveRestoreJobTransaction = async work => {
  const client = await database().connect()
  let began = false
  try {
    await client.query('BEGIN')
    began = true
    transactionDepth += 1
    const query: QueryFn = (statement, params) => {
      // Observe the original query Promise, never replace its result or rejection.
      const pending = client.query<Record<string, unknown>>(statement, params)
      const observed = activeObservation
      if (observed) {
        const normalized = statement.replace(/\s+/gu, ' ').trim()
        const capture = normalized.startsWith('LOCK TABLE meta_sheets, meta_fields, plugin_multitable_object_registry IN SHARE MODE NOWAIT')
        const rollback = normalized === 'ROLLBACK TO SAVEPOINT automation_record_schema_capture'
        const update = normalized.startsWith('UPDATE meta_records SET data =')
        if (capture) observed.captures += 1
        void pending.then(result => {
          if (rollback) observed.savepointRollbacks += 1
          if (update) { observed.updates += 1; if (result.rows.length === 0) observed.zeroUpdates += 1 }
        }, error => {
          if (capture && errorCode(error) === '55P03') observed.conflicts += 1
          if (normalized.includes('INSERT INTO meta_automation_record_after_images') && errorCode(error) === 'P0001') observed.imageFailures += 1
        })
      }
      return pending
    }
    const result = await work(query)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (began) await client.query('ROLLBACK')
    throw error
  } finally {
    if (began) transactionDepth -= 1
    client.release()
  }
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('SA06AQ_UNSAFE_IDENTIFIER')
  return '"' + value + '"'
}

async function removeOwnedTemporaryRoot(root: string): Promise<void> {
  const target = resolve(root)
  if (dirname(target) !== resolve(tmpdir()) || !/^sa06aq-recovery-[A-Za-z0-9]+$/u.test(basename(target))) {
    throw new Error('SA06AQ_TEMP_ROOT_NOT_OWNED')
  }
  await rm(target, { recursive: true, force: true })
}

async function cleanupOwnedRows(): Promise<void> {
  if (!pool) return
  await transaction(async query => {
    // Cleanup only our random-prefix fixture identities, after all operations/holders settle.
    // Replica mode is scoped to THIS cleanup transaction, never to the producer under test.
    await query('SET LOCAL session_replication_role = replica')
    const sheets = (await query('SELECT id FROM public.meta_sheets WHERE left(id,length($1))=$1', [prefix])).rows as Array<{ id: string }>
    const sheetIds = sheets.map(row => row.id)
    if (sheetIds.length) {
      await query(`DELETE FROM meta_automation_outbox_consumer WHERE outbox_id IN
        (SELECT id FROM meta_automation_outbox WHERE payload->>'sheetId'=ANY($1::text[]))`, [sheetIds])
      await query('DELETE FROM meta_automation_record_after_images WHERE sheet_id=ANY($1::text[])', [sheetIds])
      await query("DELETE FROM meta_automation_outbox WHERE payload->>'sheetId'=ANY($1::text[])", [sheetIds])
      await query('DELETE FROM automation_rules WHERE sheet_id=ANY($1::text[])', [sheetIds])
      for (const table of ['meta_recovery_archive_job_chunks', 'meta_recovery_archive_derived_effects']) {
        await query(`DELETE FROM public.${identifier(table)} WHERE job_id IN
          (SELECT id FROM public.meta_recovery_archive_jobs WHERE sheet_id=ANY($1::text[]))`, [sheetIds])
      }
      await query('DELETE FROM public.meta_recovery_archive_restore_plans WHERE sheet_id=ANY($1::text[])', [sheetIds])
      await query('DELETE FROM public.meta_recovery_archive_jobs WHERE sheet_id=ANY($1::text[])', [sheetIds])
      for (const table of ['meta_recovery_token_burns', 'meta_recovery_archive_sync_receipts',
        'meta_record_history_operation_members', 'meta_record_history_snapshot_members']) {
        await query(`DELETE FROM public.${identifier(table)} WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      }
      for (const table of ['meta_recovery_archive_objects', 'meta_recovery_archive_snapshot_reservations',
        'meta_recovery_archive_staging_objects', 'meta_recovery_archive_attachment_refs', 'meta_recovery_archive_coverage_items']) {
        await query(`DELETE FROM public.${identifier(table)} WHERE generation_id IN
          (SELECT generation_id FROM public.meta_recovery_archives WHERE sheet_id=ANY($1::text[]))`, [sheetIds])
      }
      for (const table of ['meta_recovery_archive_section_bootstrap_markers', 'meta_recovery_archive_legal_holds',
        'meta_recovery_archives', 'meta_sheet_section_revisions', 'meta_record_revisions',
        'meta_record_history_operations', 'meta_history_trust_checkpoints', 'meta_records', 'meta_fields']) {
        await query(`DELETE FROM public.${identifier(table)} WHERE sheet_id=ANY($1::text[])`, [sheetIds])
      }
      await query('DELETE FROM public.meta_sheets WHERE id=ANY($1::text[])', [sheetIds])
    }
    await query("DELETE FROM automation_read_material_epochs WHERE kind IN ('base','sheet') AND left(scope->>'id',length($1))=$1", [prefix])
    await query('DELETE FROM public.meta_recovery_archive_keys WHERE left(key_id,length($1))=$1', [prefix])
    await query('DELETE FROM public.meta_bases WHERE left(id,length($1))=$1', [prefix])
    await query('DELETE FROM public.users WHERE left(id,length($1))=$1', [prefix])
  })
}

/** Real encrypted preview facade; the async caller must separately accept its actual frozen plan. */
async function createWorld(label: string, recordCount: 1 | 5001 = 1) {
  const root = await mkdtemp(join(tmpdir(), 'sa06aq-recovery-'))
  roots.push(root)
  const provider = createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: root })
  let reads = 0
  const objectStore: typeof provider = { ...provider, get: request => { reads += 1; return provider.get(request) } }
  const depth = { currentTransactionDepth: () => transactionDepth }
  let durable: RecoveryArchiveDurableFixture | undefined
  let fieldId = '', preservedFieldId = '', recordId = ''
  let recordIds: string[] = []
  const fixture = await seedVerifiedArchive({ prefix, query: q, transaction, label,
    materialize: async candidate => {
      fieldId = candidate.sheetId + '_value'
      preservedFieldId = candidate.sheetId + '_preserved'
      recordId = candidate.sheetId + '_record'
      recordIds = recordCount === 1 ? [recordId]
        : Array.from({ length: recordCount }, (_, index) => recordId + '_' + String(index).padStart(5, '0'))
      recordId = recordIds[0]
      const archive = (await q(`SELECT created_at,expires_at FROM public.meta_recovery_archives
        WHERE generation_id=$1::uuid`, [candidate.generationId])).rows[0]
      const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
      durable = await createRecoveryArchiveDurableFixture({
        binding: { archive_generation_id: candidate.generationId, workspace_id: candidate.workspaceId,
          base_id: candidate.baseId, sheet_id: candidate.sheetId, anchor_operation_id: candidate.anchorOperationId,
          anchor_seq: candidate.anchorSeq, checkpoint_id: candidate.checkpointId,
          created_at: iso(archive.created_at), expires_at: iso(archive.expires_at), source_vector_hash: candidate.sourceVectorHash },
        keyId: candidate.keyId, objectStore, transactionDepth: depth, objectExpiresAt: iso(archive.expires_at),
        sectionRows: {
          schema: [fieldId, preservedFieldId].map((id, index) => ({ field_id: id, name: 'Synthetic value',
            type: 'string', property: {}, order: index + 1 })),
          records: recordIds.map(id => ({ record_id: id, exists: true, version: 1,
            data: { [fieldId]: 'archived', [preservedFieldId]: 'unchanged' } })),
          links: [], field_value_tombstones: [], link_tombstones: [], auto_number: [],
          attachments_index: [], permission_evidence: [], views_config: [],
        },
      })
      return durable
    },
  })
  if (!durable) throw new Error('SA06AQ_ARCHIVE_NOT_MATERIALIZED')
  await q(`INSERT INTO users(id,password_hash,permissions,is_active,role)
    VALUES($1,'synthetic-not-a-password',$2::jsonb,true,'user')`, [fixture.actorId, JSON.stringify(fullPermissions)])
  await q('UPDATE meta_sheets SET row_level_read_permissions_enabled=false WHERE id=$1', [fixture.sheetId])
  for (const [index, id] of [fieldId, preservedFieldId].entries()) {
    await q(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order")
      VALUES($1,$2,'Synthetic value','string','{}'::jsonb,$3)`, [id, fixture.sheetId, index + 1])
  }
  const liveData = { [fieldId]: 'live', [preservedFieldId]: 'unchanged' }
  await q(`INSERT INTO meta_records(id,sheet_id,data,version,created_by,modified_by)
    SELECT id,$2,$3::jsonb,2,$4,$4 FROM unnest($1::text[]) AS records(id)`,
  [recordIds, fixture.sheetId, JSON.stringify(liveData), fixture.actorId])
  const runtime: RecoveryArchivePreviewRuntime = { keyCustody: durable.keyCustody, objectStore, transactionDepth: depth }
  // Reuse the real, requestless owner/full-read/write policy. jobId is only this
  // adapter's required nonempty identity; it does NOT claim a persisted async job.
  const identity = { jobId: 'synthetic-sync-policy-adapter', workspaceId: fixture.workspaceId,
    baseId: fixture.baseId, sheetId: fixture.sheetId, actorId: fixture.actorId }
  const authority = createRecoveryArchiveWorkerAuthorization()
  let planChecks = 0
  const policy = {
    recheckAuthority: (query: QueryFn) => authority.recheckAuthority(query, identity),
    preliminaryFullRead: (query: QueryFn) => authority.apply.preliminaryFullRead(query, identity),
    stabilizeAuthorization: (query: QueryFn, context: Parameters<typeof authority.apply.stabilizeAuthorization>[1]) =>
      authority.apply.stabilizeAuthorization(query, context, identity),
    finalLockedFullRead: (query: QueryFn, scope: Parameters<typeof authority.apply.finalLockedFullRead>[1]) =>
      authority.apply.finalLockedFullRead(query, scope, identity),
    evaluatePlanAuthorization: (query: QueryFn, context: Parameters<typeof authority.apply.evaluatePlanAuthorization>[1]) => {
      planChecks += 1
      return authority.apply.evaluatePlanAuthorization(query, context, identity)
    },
  }
  const scope = { kind: 'selected_records' as const, recordIds }
  const preview = await previewRecoveryArchive(transaction, q, runtime, { ...identity, generationId: fixture.generationId,
    mode: 'revert', scope, recheckAuthority: policy.recheckAuthority, evaluatePlanAuthorization: policy.evaluatePlanAuthorization })
  expect({ executable: preview.executable, executionKind: preview.executionKind, blockedReason: preview.blockedReason })
    .toEqual({ executable: true, executionKind: recordCount === 1 ? 'sync' : 'async', blockedReason: null })
  if (!preview.previewIdentity) throw new Error('SA06AQ_REAL_PREVIEW_TOKEN_MISSING')
  const token = preview.previewIdentity
  const events: RecoveryMutationEvent[] = []
  const execute = (bindingFault?: 'query' | 'sheet') => executeRecoveryArchiveSync(transaction, q, runtime, {
    ...identity, previewIdentity: token, scope, auditedReplayHorizonMs: 0, ...policy,
    onMutationApplied: async (query: QueryFn, mutation: ExactAnchorAppliedMutation) => {
      // First mutation facts ONLY originate in the actual successful L8 UPDATE.
      const producerQuery: QueryFn = bindingFault === 'query' ? (statement, params) => query(statement, params) : query
      const event = await enqueueRecoveryMutationEvent(producerQuery,
        bindingFault === 'sheet' ? fixture.sheetId + '_wrong' : fixture.sheetId, fixture.actorId, mutation)
      if (events.length >= 2) throw new Error('SA06AQ_UNEXPECTED_EVENT_COUNT')
      events.push(event)
    },
  })
  return { fixture, fieldId, preservedFieldId, recordId, recordIds, liveData, runtime, token, execute, events, durable, policy,
    facts: () => ({ reads, planChecks }) }
}
type World = Awaited<ReturnType<typeof createWorld>>

async function createAsyncWorld(label: string) {
  const world = await createWorld('async_' + label, 5001)
  const { fixture, runtime } = world
  const identity = { workspaceId: fixture.workspaceId, baseId: fixture.baseId,
    sheetId: fixture.sheetId, actorId: fixture.actorId }
  // The signed preview, frozen object plan and production 5000+1 partition are
  // minted by previewRecoveryArchive, never constructed or resized by this test.
  const job = await acceptFrozenRecoveryArchiveRestoreJob(transaction, runtime.objectStore, runtime.transactionDepth, {
    identity, token: world.token, resumeDeadline: new Date(Date.now() + 300000),
    recheckAuthority: world.policy.recheckAuthority,
  })
  expect(job).toMatchObject({ ...identity, state: 'planned', totalCount: '5001', completedCount: '0' })
  const chunks = () => q(`SELECT chunk_index,record_count::text,state,committed_count::text,operation_id::text
    FROM meta_recovery_archive_job_chunks WHERE job_id=$1::uuid ORDER BY chunk_index`, [job.id]).then(result => result.rows)
  const pendingChunks = [
    { chunk_index: 0, record_count: '5000', state: 'pending', committed_count: null, operation_id: null },
    { chunk_index: 1, record_count: '1', state: 'pending', committed_count: null, operation_id: null },
  ]
  expect(await chunks()).toEqual(pendingChunks)
  const acceptedBurn = () => q(`SELECT to_jsonb(b) AS burn,b.xmin::text AS xid
    FROM meta_recovery_token_burns b JOIN meta_recovery_archive_jobs j ON j.token_sha256=b.token_sha256
    WHERE j.id=$1::uuid`, [job.id]).then(result => result.rows)
  const burn = await acceptedBurn()
  expect(burn).toHaveLength(1)
  const callbacks = createRecoveryArchiveWorkerCallbacks({ query: q, transaction })
  const originals = new WeakSet<ExactAnchorAppliedMutation>()
  let originalQuery: QueryFn | undefined
  let originalIdentity: Parameters<NonNullable<typeof callbacks.apply.onMutationApplied>>[2] | undefined
  const observed = { mutationCalls: 0, mutationReturns: 0, identityMatches: true, queryMatches: true,
    afterCommitCalls: 0, afterCommitReturns: 0, afterCommitOriginals: true, afterCommitCount: 0,
    planChecks: 0, deniedPlans: 0 }
  const workerOwnerId = prefix + '_worker_' + randomUUID()
  const worker = createRecoveryArchiveRestoreWorker({ transaction, query: q, runtime,
    ...callbacks, leaseMs: 240000, replayHorizonMs: 0, maxChunksPerRun: 1, workerOwnerId,
    apply: { ...callbacks.apply,
      evaluatePlanAuthorization: async (query, context, actual) => {
        observed.planChecks += 1
        const allowed = await callbacks.apply.evaluatePlanAuthorization(query, context, actual)
        if (!allowed) observed.deniedPlans += 1
        return allowed
      },
      onMutationApplied: async (query, mutation, actual) => {
        observed.mutationCalls += 1
        originalQuery ??= query
        originalIdentity ??= actual
        observed.queryMatches &&= query === originalQuery
        observed.identityMatches &&= actual === originalIdentity && actual.jobId === job.id
          && actual.workspaceId === identity.workspaceId && actual.baseId === identity.baseId
          && actual.sheetId === identity.sheetId && actual.actorId === identity.actorId
        originals.add(mutation)
        // Observe through the unmodified canonical producer, preserving query,
        // mutation and durable actor identity, and propagating its real failure.
        await callbacks.apply.onMutationApplied!(query, mutation, actual)
        observed.mutationReturns += 1
      },
      afterCommit: async (actual, mutations) => {
        observed.afterCommitCalls += 1
        observed.afterCommitCount += mutations.length
        observed.afterCommitOriginals &&= actual === originalIdentity && mutations.every(mutation => originals.has(mutation))
        await callbacks.apply.afterCommit!(actual, mutations)
        // Production treats this callback as best effort. An outer assertion on
        // this counter still fails our positive test if it throws internally.
        observed.afterCommitReturns += 1
      },
    },
  })
  const state = () => q(`SELECT j.id::text,j.actor_id,j.state,j.total_count::text,j.completed_count::text,
    j.worker_owner_id,j.terminal_operation_id::text,s.recovery_writer_owner_kind,s.recovery_writer_owner_id
    FROM meta_recovery_archive_jobs j JOIN meta_sheets s ON s.id=j.sheet_id WHERE j.id=$1::uuid`, [job.id])
    .then(result => result.rows[0])
  return { ...world, job, worker, workerOwnerId, observed, chunks, pendingChunks, acceptedBurn, burn, state }
}

async function counts(fixture: Fixture) {
  return (await q(`SELECT
    (SELECT count(*)::int FROM meta_record_revisions WHERE sheet_id=$1) AS revisions,
    (SELECT count(*)::int FROM meta_record_history_operations WHERE sheet_id=$1) AS operations,
    (SELECT count(*)::int FROM meta_recovery_token_burns WHERE sheet_id=$1) AS burns,
    (SELECT count(*)::int FROM meta_recovery_archive_sync_receipts WHERE sheet_id=$1) AS receipts,
    (SELECT count(*)::int FROM meta_automation_outbox WHERE payload->>'sheetId'=$1) AS events,
    (SELECT count(*)::int FROM meta_automation_record_after_images WHERE sheet_id=$1) AS images`, [fixture.sheetId])).rows[0]
}
async function stored(world: World) {
  return (await q('SELECT data,version FROM meta_records WHERE sheet_id=$1 AND id=$2',
    [world.fixture.sheetId, world.recordId])).rows[0]
}
async function image(world: World) {
  const result = await q(`SELECT i.*,o.payload,o.event_id AS receipt_event_id,o.event_type AS receipt_event_type,
    o.automation_depth,o.xmin::text AS event_xmin,i.xmin::text AS image_xmin,
    octet_length(i.after_image::text) AS pg_bytes
    FROM meta_automation_record_after_images i JOIN meta_automation_outbox o ON o.id=i.outbox_id
    WHERE i.sheet_id=$1 AND i.record_id=$2`, [world.fixture.sheetId, world.recordId])
  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}
async function condition(world: World, receipt: Record<string, unknown>, value: string) {
  const ruleId = prefix + '_condition_' + randomUUID()
  // The condition primitive fingerprints but never executes this legal action.
  // No webhook dispatcher, read-preview grant, runtime or source IO is invoked.
  await q(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,trigger_config,action_type,action_config,created_by,conditions)
    VALUES($1,$2,'Synthetic recovery condition','record.updated','{}','send_webhook','{}',$3,$4::jsonb)`,
  [ruleId, world.fixture.sheetId, world.fixture.actorId, JSON.stringify({ logic: 'and', conditions: [
    { fieldId: world.fieldId, operator: 'equals', value },
    { fieldId: world.preservedFieldId, operator: 'equals', value: 'unchanged' },
  ] })])
  const conditions = createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })
  return transaction(async query => {
    const trx: TransactionalQueryable = { isTransaction: true, query: async (statement, params) => {
      const result = await query(statement, params)
      return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? null }
    } }
    const locked = await conditions.lock(trx, { actorId: world.fixture.actorId, ruleId,
      sheetId: world.fixture.sheetId, baseId: world.fixture.baseId })
    return conditions.evaluate(trx, locked, { outboxId: String(receipt.outbox_id),
      eventId: String(receipt.event_id), eventType: 'multitable.record.updated' })
  })
}
async function withTrigger(table: 'meta_records' | 'meta_automation_record_after_images', body: string,
  run: () => Promise<void>, timing: 'BEFORE' | 'AFTER' = 'BEFORE') {
  const name = prefix + '_' + randomBytes(4).toString('hex')
  let functionCreated = false
  try {
    await q(`CREATE FUNCTION public.${identifier(name)}() RETURNS trigger LANGUAGE plpgsql AS $function$ ${body} $function$`)
    functionCreated = true
    await q(`CREATE TRIGGER ${identifier(name)} ${timing} ${table === 'meta_records' ? 'UPDATE' : 'INSERT'}
      ON public.${identifier(table)} FOR EACH ROW EXECUTE FUNCTION public.${identifier(name)}()`)
    await run()
  } finally {
    if (functionCreated) {
      try { await q(`DROP TRIGGER IF EXISTS ${identifier(name)} ON public.${identifier(table)}`) }
      finally { await q(`DROP FUNCTION public.${identifier(name)}()`) }
    }
  }
}

describeRealDb('SA06AQ recovery record after-image', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5,
      options: '-c search_path=public -c statement_timeout=8000' })
    const required = ['meta_recovery_archive_jobs', 'meta_recovery_archive_sync_receipts', 'meta_recovery_archives',
      'meta_automation_outbox', 'meta_automation_record_after_images', 'automation_read_material_epochs']
    for (const name of required) {
      if ((await q('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + name])).rows[0]?.present !== true) {
        throw new Error('SA06AQ_FULL_MIGRATION_PREREQUISITE_MISSING')
      }
    }
    process.env.JWT_SECRET = prefix + '_synthetic_preview_signing_secret_1234567890'
    for (const name of flagNames.filter(name => name !== 'JWT_SECRET')) process.env[name] = 'true'
    // Restore the exact prior posture, not a blanket DISABLE at teardown.
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      const row = (await q('SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2',
        ['public.' + table, trigger])).rows[0]
      const restore = ({ O: 'ENABLE', D: 'DISABLE', R: 'ENABLE REPLICA', A: 'ENABLE ALWAYS' } as Record<string, string>)[String(row?.tgenabled)]
      if (!restore) throw new Error('SA06AQ_AUTHORITY_TRIGGER_PREREQUISITE_MISSING')
      triggerPostures.push({ table, trigger, restore })
      await q(`ALTER TABLE public.${identifier(table)} ENABLE TRIGGER ${identifier(trigger)}`)
    }
  }, 30000)

  afterAll(async () => {
    activeObservation = undefined
    const errors: unknown[] = []
    const finish = async (work: () => unknown | Promise<unknown>) => {
      try { await work() } catch (error) { errors.push(error) }
    }
    await finish(cleanupOwnedRows)
    for (const { table, trigger, restore } of [...triggerPostures].reverse()) {
      await finish(() => q(`ALTER TABLE public.${identifier(table)} ${restore} TRIGGER ${identifier(trigger)}`))
    }
    await finish(() => pool?.end())
    for (const [name, value] of previousEnv) {
      await finish(() => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      })
    }
    for (const root of roots) await finish(() => removeOwnedTemporaryRoot(root))
    // Every cleanup is attempted, but none of its failures becomes a green test.
    if (errors.length) throw new AggregateError(errors, 'SA06AQ_TEARDOWN_FAILED')
  }, 30000)

  test('real encrypted sync facades persist actual RETURNING image with atomic xid; live drift cannot replace event image', async () => {
    const world = await createWorld('returning')
    const before = await counts(world.fixture)
    const facts = world.facts()
    await withTrigger('meta_records', `DECLARE held integer; BEGIN
      IF NEW.id='${world.recordId}' AND pg_trigger_depth()=1 THEN
        SELECT count(DISTINCT relation) INTO held FROM pg_locks WHERE pid=pg_backend_pid() AND granted
          AND relation IN ('public.meta_sheets'::regclass,'public.meta_fields'::regclass,'public.plugin_multitable_object_registry'::regclass)
          AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock');
        IF held<>3 THEN RAISE EXCEPTION 'SA06AQ_PRE_DML_SCHEMA_LOCK_MISSING'; END IF;
        NEW.data=jsonb_set(NEW.data,ARRAY['${world.fieldId}'],to_jsonb('actual-returned'::text))
          || jsonb_build_object('_capture_xid',pg_current_xact_id()::text);
        NEW.version=7;
      END IF; RETURN NEW; END`, async () => {
      // PostgreSQL evaluates the outer UPDATE's RETURNING before this secondary
      // write. A producer that rereads the live row sees version 8, not receipt 7.
      await withTrigger('meta_records', `BEGIN
        IF NEW.id='${world.recordId}' AND pg_trigger_depth()=1 THEN
          UPDATE public.meta_records
            SET data=jsonb_set(data,ARRAY['${world.fieldId}'],to_jsonb('after-trigger-live'::text)),version=8
            WHERE id=NEW.id AND sheet_id=NEW.sheet_id;
        END IF; RETURN NEW; END`, async () => {
        expect(await world.execute()).toMatchObject({ ok: true, applied: { reverts: 1, resurrects: 0, deletes: 0 } })
      }, 'AFTER')
    })
    expect(world.facts().reads).toBeGreaterThan(facts.reads)
    expect(world.facts().planChecks).toBeGreaterThan(facts.planChecks)
    expect(world.durable.custodyCalls).toEqual(expect.arrayContaining(['verify', 'unwrap']))
    const evidence = await image(world)
    const row = await stored(world)
    expect(evidence).toMatchObject({ status: 'captured', record_version: '7', record_id: world.recordId,
      sheet_id: world.fixture.sheetId, event_type: 'multitable.record.updated', receipt_event_type: 'multitable.record.updated',
      automation_depth: 0 })
    expect(evidence.after_image).toEqual({ [world.fieldId]: 'actual-returned', [world.preservedFieldId]: 'unchanged',
      _capture_xid: evidence.capture_xid })
    expect(evidence.schema_revision).toEqual(expect.any(String))
    expect(evidence.schema_revision).toBe((await q(`SELECT revision::text FROM automation_read_material_epochs
      WHERE kind='sheet' AND scope=$1::jsonb`, [JSON.stringify({ id: world.fixture.sheetId })])).rows[0]?.revision)
    expect(evidence.event_id).toBe(evidence.receipt_event_id)
    expect(evidence.captured_bytes).toBe(evidence.pg_bytes)
    expect(evidence.payload).toEqual({ _eventId: evidence.event_id, sheetId: world.fixture.sheetId,
      recordId: world.recordId, actorId: world.fixture.actorId, changes: { [world.fieldId]: 'archived' } })
    expect(row).toEqual({ version: 8, data: { [world.fieldId]: 'after-trigger-live', [world.preservedFieldId]: 'unchanged',
      _capture_xid: evidence.capture_xid } })
    const revision = (await q(`SELECT version,patch,snapshot,changed_field_ids,source,actor_id,xmin::text AS xid
      FROM meta_record_revisions WHERE sheet_id=$1 AND record_id=$2`, [world.fixture.sheetId, world.recordId])).rows
    expect(revision).toHaveLength(1)
    expect(revision[0]).toMatchObject({ version: 7, source: 'restore', actor_id: world.fixture.actorId,
      changed_field_ids: [world.fieldId], patch: { [world.fieldId]: 'archived' },
      snapshot: { [world.fieldId]: 'archived', [world.preservedFieldId]: 'unchanged' } })
    const xid = String(BigInt((row.data as Record<string, string>)._capture_xid) % 4294967296n)
    expect(evidence.capture_xid).toBe((row.data as Record<string, string>)._capture_xid)
    const atomic = (await q(`SELECT r.xmin::text AS record_xid,b.xmin::text AS burn_xid,
      s.xmin::text AS receipt_xid,o.xmin::text AS operation_xid
      FROM meta_records r JOIN meta_recovery_token_burns b ON b.sheet_id=r.sheet_id
      JOIN meta_recovery_archive_sync_receipts s ON s.token_sha256=b.token_sha256
      JOIN meta_record_history_operations o ON o.sheet_id=s.sheet_id AND o.operation_id=s.operation_id
      WHERE r.id=$1`, [world.recordId])).rows
    expect(atomic).toEqual([{ record_xid: xid, burn_xid: xid, receipt_xid: xid, operation_xid: xid }])
    expect([revision[0].xid, evidence.event_xmin, evidence.image_xmin]).toEqual([xid, xid, xid])
    expect(await counts(world.fixture)).toEqual(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, Number(value) + 1])))
    expect(await condition(world, evidence, 'actual-returned')).toEqual({ kind: 'match' })
    expect(await condition(world, evidence, 'after-trigger-live')).toEqual({ kind: 'no_match' })
    await q('UPDATE meta_records SET data=jsonb_set(data,ARRAY[$2::text],to_jsonb($3::text)),version=version+1 WHERE id=$1',
      [world.recordId, world.fieldId, 'later-live'])
    expect((await stored(world)).data).toMatchObject({ [world.fieldId]: 'later-live' })
    expect(await condition(world, evidence, 'actual-returned')).toEqual({ kind: 'match' })
    expect(await condition(world, evidence, 'later-live')).toEqual({ kind: 'no_match' })
    const committed = await counts(world.fixture)
    expect(await world.execute()).toMatchObject({ ok: false, reason: 'token-replayed' })
    expect(await counts(world.fixture)).toEqual(committed)
  })

  test('actual image INSERT failure rolls back record revision seal burn receipt event; the same preview can retry', async () => {
    const world = await createWorld('rollback'), before = await counts(world.fixture)
    await withTrigger('meta_automation_record_after_images', `BEGIN
      IF NEW.sheet_id='${world.fixture.sheetId}' THEN RAISE EXCEPTION 'SA06AQ_IMAGE_INSERT_FAILURE'; END IF;
      RETURN NEW; END`, async () => {
      await expect(world.execute()).rejects.toThrow('SA06AQ_IMAGE_INSERT_FAILURE')
    })
    expect(await stored(world)).toEqual({ data: world.liveData, version: 2 })
    expect(await counts(world.fixture)).toEqual(before)
    expect(world.events).toHaveLength(0)
    expect(await world.execute()).toMatchObject({ ok: true })
    expect((await image(world)).status).toBe('captured')
  })

  test('actual RETURN NULL CAS miss remains preview-drift and emits no event or image', async () => {
    const world = await createWorld('zero'), before = await counts(world.fixture)
    const observed = observation()
    try {
      activeObservation = observed
      await withTrigger('meta_records', `BEGIN IF NEW.id='${world.recordId}' THEN RETURN NULL; END IF; RETURN NEW; END`, async () => {
        expect(await world.execute()).toEqual({ ok: false, reason: 'preview-drift' })
      })
    } finally { activeObservation = undefined }
    expect(observed.updates).toBe(1)
    expect(observed.zeroUpdates).toBe(1)
    expect(await counts(world.fixture)).toEqual(before)
    expect(await stored(world)).toEqual({ data: world.liveData, version: 2 })
  })

  test('real schema NOWAIT 55P03 is reached and savepoint-restored; recovery commits but conditions refuse unavailable evidence', async () => {
    const world = await createWorld('nowait'), observed = observation()
    const holder = await database().connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.meta_fields IN SHARE UPDATE EXCLUSIVE MODE')
      activeObservation = observed
      expect(await world.execute()).toMatchObject({ ok: true })
    } finally {
      activeObservation = undefined
      try { await holder.query('ROLLBACK') } finally { holder.release() }
    }
    expect(observed).toMatchObject({ captures: 1, conflicts: 1, savepointRollbacks: 1, updates: 1, zeroUpdates: 0 })
    const evidence = await image(world)
    expect(evidence).toMatchObject({ status: 'captured', schema_revision: null, record_version: '3',
      after_image: { [world.fieldId]: 'archived', [world.preservedFieldId]: 'unchanged' } })
    expect(await condition(world, evidence, 'archived')).toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' })
  })

  test('durable OFF preserves the existing successful recovery and adds no capture outbox or image', async () => {
    const world = await createWorld('off'), before = await counts(world.fixture), observed = observation()
    try {
      process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'false'
      activeObservation = observed
      expect(await world.execute()).toMatchObject({ ok: true })
    } finally { activeObservation = undefined; process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true' }
    expect(observed).toMatchObject({ captures: 0, updates: 1 })
    expect(await stored(world)).toEqual({ version: 3, data: { [world.fieldId]: 'archived', [world.preservedFieldId]: 'unchanged' } })
    const after = await counts(world.fixture)
    expect(after.events).toBe(before.events)
    expect(after.images).toBe(before.images)
    expect(after.revisions).toBe(Number(before.revisions) + 1)
    expect(after.receipts).toBe(Number(before.receipts) + 1)
  })

  test('fresh delta write-permission revocation is denied by the production policy before capture or mutation', async () => {
    const world = await createWorld('denied'), before = await counts(world.fixture), observed = observation()
    const checks = world.facts().planChecks
    await q('UPDATE users SET permissions=$2::jsonb WHERE id=$1',
      [world.fixture.actorId, JSON.stringify(fullPermissions.filter(permission => permission !== 'multitable:write'))])
    try {
      activeObservation = observed
      expect(await world.execute()).toEqual({ ok: false, reason: 'forbidden' })
    } finally { activeObservation = undefined }
    expect(world.facts().planChecks).toBeGreaterThan(checks)
    expect(observed).toMatchObject({ captures: 0, updates: 0 })
    expect(await counts(world.fixture)).toEqual(before)
    expect(await stored(world)).toEqual({ data: world.liveData, version: 2 })
  })

  test.each(['query', 'sheet'] as const)('actual mutation rejects a mismatched %s evidence binding and rolls back', async fault => {
    const world = await createWorld('binding_' + fault), before = await counts(world.fixture)
    await expect(world.execute(fault)).rejects.toThrow('RECOVERY_MUTATION_AFTER_IMAGE_BINDING_INVALID')
    expect(await counts(world.fixture)).toEqual(before)
    expect(await stored(world)).toEqual({ data: world.liveData, version: 2 })
    expect(world.events).toHaveLength(0)
  })

  describe('SA06AR async recovery', () => {
    test('SA06AR async recovery image INSERT failure rolls back the real first chunk but preserves its accepted job and burn', async () => {
      const world = await createAsyncWorld('rollback'), before = await counts(world.fixture), observed = observation()
      try {
        activeObservation = observed
        await withTrigger('meta_automation_record_after_images', `BEGIN
          IF NEW.sheet_id='${world.fixture.sheetId}' THEN RAISE EXCEPTION 'SA06AR_IMAGE_INSERT_FAILURE'; END IF;
          RETURN NEW; END`, async () => {
          expect(await world.worker.runOnce()).toEqual({ kind: 'paused_retryable', swept: 0, chunks: 0 })
        })
      } finally { activeObservation = undefined }
      // This was not a pre-apply refusal: actual UPDATE, derived enqueue and the
      // canonical event producer were reached before the image INSERT failed.
      expect(observed).toMatchObject({ captures: 1, updates: 1, zeroUpdates: 0, imageFailures: 1 })
      expect(world.observed).toMatchObject({ mutationCalls: 1, mutationReturns: 0, identityMatches: true,
        queryMatches: true, afterCommitCalls: 0, afterCommitReturns: 0, deniedPlans: 0 })
      expect(world.observed.planChecks).toBeGreaterThan(0)
      expect(await counts(world.fixture)).toEqual(before)
      expect(await world.acceptedBurn()).toEqual(world.burn)
      expect(await world.chunks()).toEqual(world.pendingChunks)
      expect(await world.state()).toEqual({ id: world.job.id, actor_id: world.fixture.actorId,
        state: 'paused_retryable', total_count: '5001', completed_count: '0', worker_owner_id: null,
        terminal_operation_id: null, recovery_writer_owner_kind: 'restore_job', recovery_writer_owner_id: world.job.id })
      expect((await q(`SELECT count(*)::int AS total,count(*) FILTER (WHERE version=2 AND data=$2::jsonb)::int AS unchanged
        FROM meta_records WHERE sheet_id=$1`, [world.fixture.sheetId, JSON.stringify(world.liveData)])).rows)
        .toEqual([{ total: 5001, unchanged: 5001 }])
      expect((await q('SELECT count(*)::int AS total FROM meta_recovery_archive_derived_effects WHERE job_id=$1::uuid',
        [world.job.id])).rows).toEqual([{ total: 0 }])
      // No automatic retry or manual resume is claimed; the real paused job is
      // retained until the file's narrowly scoped owned-row teardown.
    }, 180000)

    test('SA06AR async recovery accepted job rechecks its actual actor write permission before any mutation', async () => {
      const world = await createAsyncWorld('denied'), before = await counts(world.fixture), observed = observation()
      await q('UPDATE users SET permissions=$2::jsonb WHERE id=$1',
        [world.fixture.actorId, JSON.stringify(fullPermissions.filter(permission => permission !== 'multitable:write'))])
      try {
        activeObservation = observed
        expect(await world.worker.runOnce()).toEqual({ kind: 'abandoned', swept: 0, chunks: 0 })
      } finally { activeObservation = undefined }
      expect(world.observed.planChecks).toBeGreaterThan(0)
      expect(world.observed.deniedPlans).toBeGreaterThan(0)
      expect(world.observed).toMatchObject({ mutationCalls: 0, mutationReturns: 0, afterCommitCalls: 0 })
      expect(observed).toMatchObject({ captures: 0, updates: 0, imageFailures: 0 })
      expect(await counts(world.fixture)).toEqual(before)
      expect(await world.chunks()).toEqual(world.pendingChunks)
      expect(await world.state()).toEqual({ id: world.job.id, actor_id: world.fixture.actorId,
        state: 'abandoned_partial', total_count: '5001', completed_count: '0', worker_owner_id: null,
        terminal_operation_id: null, recovery_writer_owner_kind: null, recovery_writer_owner_id: null })
      const terminalBurn = await world.acceptedBurn()
      expect(terminalBurn).toHaveLength(1)
      expect(terminalBurn[0].burn).toMatchObject({ job_id: world.job.id, burn_kind: 'async', terminal_at: expect.any(String) })
      expect((await q(`SELECT count(*)::int AS total,count(*) FILTER (WHERE version=2 AND data=$2::jsonb)::int AS unchanged
        FROM meta_records WHERE sheet_id=$1`, [world.fixture.sheetId, JSON.stringify(world.liveData)])).rows)
        .toEqual([{ total: 5001, unchanged: 5001 }])
      expect((await q('SELECT count(*)::int AS total FROM meta_recovery_archive_derived_effects WHERE job_id=$1::uuid',
        [world.job.id])).rows).toEqual([{ total: 0 }])
    }, 180000)

    test('SA06AR async recovery real 5001-plan worker preserves RETURNING images, the 256-image budget and atomic first-chunk derived bindings', async () => {
      const world = await createAsyncWorld('returning'), before = await counts(world.fixture), observed = observation()
      const facts = world.facts()
      try {
        activeObservation = observed
        await withTrigger('meta_records', `DECLARE held integer; BEGIN
          IF NEW.id='${world.recordId}' AND pg_trigger_depth()=1 THEN
            SELECT count(DISTINCT relation) INTO held FROM pg_locks WHERE pid=pg_backend_pid() AND granted
              AND relation IN ('public.meta_sheets'::regclass,'public.meta_fields'::regclass,'public.plugin_multitable_object_registry'::regclass)
              AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock');
            IF held<>3 THEN RAISE EXCEPTION 'SA06AR_PRE_DML_SCHEMA_LOCK_MISSING'; END IF;
            NEW.data=jsonb_set(NEW.data,ARRAY['${world.fieldId}'],to_jsonb('actual-returned'::text))
              || jsonb_build_object('_capture_xid',pg_current_xact_id()::text);
          END IF; RETURN NEW; END`, async () => {
          // Change data, NOT version: the authentic async plan must still pass
          // its immutable final live-set version hash (2 -> 3) for all 5000 rows.
          await withTrigger('meta_records', `BEGIN
            IF NEW.id='${world.recordId}' AND pg_trigger_depth()=1 THEN
              UPDATE public.meta_records SET data=jsonb_set(data,ARRAY['${world.fieldId}'],to_jsonb('after-trigger-live'::text))
                WHERE id=NEW.id AND sheet_id=NEW.sheet_id;
            END IF; RETURN NEW; END`, async () => {
            expect(await world.worker.runOnce()).toEqual({ kind: 'yielded', swept: 0, chunks: 1 })
          }, 'AFTER')
        })
      } finally { activeObservation = undefined }
      expect(observed).toMatchObject({ captures: 5000, updates: 5000, zeroUpdates: 0, imageFailures: 0 })
      expect(world.observed).toMatchObject({ mutationCalls: 5000, mutationReturns: 5000,
        identityMatches: true, queryMatches: true, afterCommitCalls: 1, afterCommitReturns: 1,
        afterCommitOriginals: true, afterCommitCount: 5000, deniedPlans: 0 })
      expect(world.observed.planChecks).toBeGreaterThan(0)
      expect(world.facts().reads).toBeGreaterThan(facts.reads)
      expect(world.durable.custodyCalls).toEqual(expect.arrayContaining(['verify', 'unwrap']))
      const evidence = await image(world)
      expect(evidence).toMatchObject({ status: 'captured', record_version: '3', record_id: world.recordId,
        event_type: 'multitable.record.updated', receipt_event_type: 'multitable.record.updated', automation_depth: 0 })
      expect(evidence.schema_revision).toEqual(expect.any(String))
      expect(evidence.after_image).toEqual({ [world.fieldId]: 'actual-returned', [world.preservedFieldId]: 'unchanged',
        _capture_xid: evidence.capture_xid })
      expect(evidence.event_id).toBe(evidence.receipt_event_id)
      expect(evidence.captured_bytes).toBe(evidence.pg_bytes)
      expect(evidence.payload).toEqual({ _eventId: evidence.event_id, sheetId: world.fixture.sheetId,
        recordId: world.recordId, actorId: world.fixture.actorId, changes: { [world.fieldId]: 'archived' } })
      expect(await stored(world)).toEqual({ version: 3, data: { [world.fieldId]: 'after-trigger-live',
        [world.preservedFieldId]: 'unchanged', _capture_xid: evidence.capture_xid } })
      const budget = (await q(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='captured' AND reason IS NULL AND after_image IS NOT NULL)::int AS captured,
        count(*) FILTER (WHERE status='unavailable' AND reason='batch_limits' AND after_image IS NULL AND captured_bytes=0)::int AS limited,
        count(DISTINCT capture_xid)::int AS transactions
        FROM meta_automation_record_after_images WHERE sheet_id=$1`, [world.fixture.sheetId])).rows
      expect(budget).toEqual([{ total: 5000, captured: 256, limited: 4744, transactions: 1 }])
      expect(await world.state()).toEqual({ id: world.job.id, actor_id: world.fixture.actorId, state: 'applying',
        total_count: '5001', completed_count: '5000', worker_owner_id: world.workerOwnerId,
        terminal_operation_id: null, recovery_writer_owner_kind: 'restore_job', recovery_writer_owner_id: world.job.id })
      const chunks = await world.chunks()
      expect(chunks).toEqual([
        { chunk_index: 0, record_count: '5000', state: 'committed', committed_count: '5000', operation_id: expect.any(String) },
        world.pendingChunks[1],
      ])
      expect(await world.acceptedBurn()).toEqual(world.burn)
      const after = await counts(world.fixture)
      expect(after).toEqual({ ...before, revisions: Number(before.revisions) + 5000,
        operations: Number(before.operations) + 1, events: Number(before.events) + 5000, images: Number(before.images) + 5000 })
      const xid = String(BigInt(String(evidence.capture_xid)) % 4294967296n)
      // The worker renews its JOB lease after commit, so latest job xmin is not
      // evidence of source atomicity. Chunk/record/revision/seal/derived/outbox/
      // image tuples below all belong to the actual single apply transaction.
      const atomic = (await q(`SELECT count(*)::int AS total,
        bool_and(r.xmin::text=$3 AND v.xmin::text=$3 AND d.xmin::text=$3 AND o.xmin::text=$3
          AND i.xmin::text=$3 AND c.xmin::text=$3 AND h.xmin::text=$3 AND i.capture_xid::text=$4) AS same_xid,
        bool_and(v.version=3 AND v.source='restore' AND v.actor_id=$5 AND v.changed_field_ids=ARRAY[$6]::text[]
          AND v.patch=$7::jsonb AND v.snapshot=$8::jsonb AND d.field_ids=ARRAY[$6]::text[]
          AND d.link_invalidations='[]'::jsonb AND d.completed_at IS NULL AND d.last_attempt_at IS NULL
          AND o.event_id=i.event_id AND o.event_type=i.event_type AND o.automation_depth=0
          AND o.payload=jsonb_build_object('_eventId',o.event_id,'sheetId',$1::text,'recordId',r.id,'actorId',$5::text,'changes',$7::jsonb)) AS exact_binding
        FROM meta_recovery_archive_derived_effects d JOIN meta_record_revisions v ON v.id=d.revision_id
        JOIN meta_records r ON r.id=d.record_id AND r.sheet_id=v.sheet_id
        JOIN meta_automation_record_after_images i ON i.sheet_id=r.sheet_id AND i.record_id=r.id
        JOIN meta_automation_outbox o ON o.id=i.outbox_id
        JOIN meta_recovery_archive_job_chunks c ON c.job_id=d.job_id AND c.chunk_index=0
        JOIN meta_record_history_operations h ON h.sheet_id=c.sheet_id AND h.operation_id=c.operation_id
        WHERE v.sheet_id=$1 AND d.job_id=$2::uuid`, [world.fixture.sheetId, world.job.id, xid,
        evidence.capture_xid, world.fixture.actorId, world.fieldId, JSON.stringify({ [world.fieldId]: 'archived' }),
        JSON.stringify({ [world.fieldId]: 'archived', [world.preservedFieldId]: 'unchanged' })])).rows
      expect(atomic).toEqual([{ total: 5000, same_xid: true, exact_binding: true }])
      expect((await q(`SELECT r.version,r.data,(SELECT count(*)::int FROM meta_record_revisions v WHERE v.record_id=r.id) AS revisions
        FROM meta_records r WHERE r.sheet_id=$1 AND r.id=$2`, [world.fixture.sheetId, world.recordIds[5000]])).rows)
        .toEqual([{ version: 2, data: world.liveData, revisions: 0 }])
      expect(await condition(world, evidence, 'actual-returned')).toEqual({ kind: 'match' })
      expect(await condition(world, evidence, 'after-trigger-live')).toEqual({ kind: 'no_match' })
      // Only the first chunk ran. No final aggregate seal, completed job, deferred
      // derived-ledger delivery, HTTP approval, or downstream runtime is claimed.
    }, 300000)
  })
})
