import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const SEALED_EXPORT_LIB = resolve(
  __dirname,
  '../../../../plugins/plugin-integration-core/lib/sealed-export',
)
const PLUGIN_LIB = resolve(
  __dirname,
  '../../../../plugins/plugin-integration-core/lib',
)
const { createDb } = requireCjs(join(PLUGIN_LIB, 'db.cjs'))
const codec = requireCjs(join(SEALED_EXPORT_LIB, 'canonical-json.cjs'))
const contracts = requireCjs(join(SEALED_EXPORT_LIB, 'contracts.cjs'))
const digests = requireCjs(join(SEALED_EXPORT_LIB, 'digests.cjs'))
const {
  createGenerationStore,
} = requireCjs(join(SEALED_EXPORT_LIB, 'generation-store.cjs'))
const {
  createSealedExportGenerationKernelCore,
  LEASE_DURATION_MS,
  ROW_BATCH_SIZE,
} = requireCjs(join(SEALED_EXPORT_LIB, 'generation-kernel.cjs'))
const {
  createPrivateIngestionMetadataStore,
} = requireCjs(join(SEALED_EXPORT_LIB, 'private-ingestion-metadata-store.cjs'))
const {
  createPrivateIngestionBlobStore,
} = requireCjs(join(SEALED_EXPORT_LIB, 'private-ingestion-blob-store.cjs'))
// UNBRANDED CORES + the inert verifier projection. The publicly-exported
// `…ForTests` verifier grant these suites used to call is DELETED (#4636
// residual); `verify()` behaviour is unchanged.
const {
  createPrivateIngestionManifestVerifier,
} = requireCjs(join(SEALED_EXPORT_LIB, 'private-ingestion-manifest-verifier.cjs'))
const {
  createPrivateIngestionServiceCore,
} = requireCjs(join(SEALED_EXPORT_LIB, 'private-ingestion-service.cjs'))

const MIGRATION_068_SQL = readFileSync(
  resolve(__dirname, '../../migrations/068_create_integration_sealed_export_ingestion.sql'),
  'utf8',
)
const MIGRATION_069_SQL = readFileSync(
  resolve(__dirname, '../../migrations/069_create_integration_sealed_export_generation_kernel.sql'),
  'utf8',
)
const DATABASE_URL = process.env.DATABASE_URL
const describeDb = DATABASE_URL ? describe : describe.skip
const SIGNER_KEY_ID = 'sealed-export-s4-realdb-signer'
const SIGNER = generateKeyPairSync('ed25519')
const AUTHORITY = Object.freeze({
  tenantId: 'sealed-export-s4-realdb-tenant',
  workspaceId: 'sealed-export-s4-realdb-workspace',
  tenantDomainBinding: 'sealed-export-s4-realdb-domain',
  systemContentKey: 'sealed-export-s4-realdb-system',
  roleBindingFingerprint: 'sealed-export-s4-realdb-role',
})
const QUALIFICATION_DIGEST = digest('qualification')
const CANONICAL_OBJECT_VERSION = 'sealed-export-s4-realdb-object-v1'
const EVIDENCE_KEY = createHash('sha256').update('sealed-export-s4-realdb-evidence').digest()
const MANIFEST_VERIFIER = createPrivateIngestionManifestVerifier({
  signerKeys: [{
    signerKeyId: SIGNER_KEY_ID,
    publicKey: SIGNER.publicKey,
  }],
})

function digest(label: string): string {
  return createHash('sha256').update(`sealed-export-s4-realdb:${label}`).digest('hex')
}

function createBarrier(parties: number) {
  let arrived = 0
  let release: (() => void) | null = null
  const open = new Promise<void>((resolveOpen) => { release = resolveOpen })
  return async () => {
    arrived += 1
    if (arrived === parties) release?.()
    await open
  }
}

function createDatabaseBinding(
  pool: Pool,
  beforeQuery: (text: string) => Promise<void>,
) {
  return {
    async query(text: string, params?: readonly unknown[]) {
      await beforeQuery(text)
      return (await pool.query(text, params ? Array.from(params) : undefined)).rows
    },
    async transaction(callback: (client: {
      query: (text: string, params?: readonly unknown[]) => Promise<unknown[]>
      commit: () => Promise<void>
      rollback: () => Promise<void>
    }) => Promise<unknown>) {
      const client = await pool.connect()
      let settled = false
      const execute = async (text: string, params?: readonly unknown[]) => {
        await beforeQuery(text)
        return (await client.query(text, params ? Array.from(params) : undefined)).rows
      }
      const commit = async () => {
        if (settled) return
        await client.query('COMMIT')
        settled = true
      }
      const rollback = async () => {
        if (settled) return
        await client.query('ROLLBACK')
        settled = true
      }
      try {
        await client.query('BEGIN')
        const result = await callback({ query: execute, commit, rollback })
        await commit()
        return result
      } catch (error) {
        await rollback()
        throw error
      } finally {
        client.release()
      }
    },
  }
}

function splitArtifact(artifact: Buffer): Buffer[] {
  const unicode = artifact.indexOf(Buffer.from('值', 'utf8'))
  const first = unicode >= 0 ? unicode + 1 : Math.floor(artifact.length / 3)
  const second = Math.max(first + 1, Math.floor((artifact.length * 2) / 3))
  return [
    Buffer.from(artifact.subarray(0, first)),
    Buffer.from(artifact.subarray(first, second)),
    Buffer.from(artifact.subarray(second)),
  ]
}

function buildFixture(label: string, rowCount: number, nowMs: number) {
  const expiry = new Date(nowMs + 60 * 60 * 1000).toISOString()
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: index,
    marker: index === Math.floor(rowCount / 2)
      ? `sealed-export-s4-${label}-值`
      : `sealed-export-s4-${label}-${index % 5}`,
  }))
  const artifact = Buffer.from(
    `${rows.map((row) => codec.tryCanonicalJson(row).text).join('\n')}\n`,
    'utf8',
  )
  const chunks = splitArtifact(artifact)
  const envelope = {
    exportRequestId: `sealed-export-s4-${label}-request`,
    nonce: `sealed-export-s4-${label}-nonce`,
    expiry,
    scenarioVersion: 'sealed-export-s4-realdb-scenario-v1',
    bindingVersion: 'sealed-export-s4-realdb-binding-v1',
    roleId: 'sealed-export-s4-realdb-role',
    actionProfileVersion: 'sealed-export-s4-realdb-action-v1',
    roleBindingFingerprint: AUTHORITY.roleBindingFingerprint,
    systemContentKey: AUTHORITY.systemContentKey,
    approvedConfigVersionId: 'sealed-export-s4-realdb-config-v1',
    configContentKey: digest(`${label}:config`),
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    qualificationDigest: QUALIFICATION_DIGEST,
    executionMode: 'sealed-export-s4-realdb-mode',
    applyProfileVersion: 'sealed-export-s4-realdb-apply-v1',
    queryObjectFilterBindingDigest: digest(`${label}:query-binding`),
    expectedSourceSchemaFieldMapDigest: digest(`${label}:schema`),
    tenantDomainBinding: AUTHORITY.tenantDomainBinding,
    rowBudget: rowCount + 10,
    byteBudget: artifact.length + 100,
    chunkBudget: chunks.length,
  }
  const descriptors = chunks.map((bytes, chunkIndex) => ({
    chunkIndex,
    chunkDigest: digests.computeChunkDigest(bytes).digest,
    byteCount: bytes.length,
  }))
  const manifestDraft = {
    exportRequestEnvelopeDigest: contracts.computeExportRequestEnvelopeDigest(envelope),
    sourceCaptureIdentity: `sealed-export-s4-${label}-capture`,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    agentImplementationVersion: 'sealed-export-s4-realdb-agent-v1',
    agentProtocolVersion: 'sealed-export-s4-realdb-protocol-v1',
    encodingVersion: 'sealed-export-s4-realdb-jsonl-v1',
    canonicalizationVersion: codec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: envelope.expectedSourceSchemaFieldMapDigest,
    totalRows: rows.length,
    totalBytes: artifact.length,
    chunks: descriptors,
    wholeArtifactByteDigest: digests.computeWholeArtifactByteDigest(chunks).digest,
    canonicalRowsetMultiplicityDigest:
      digests.computeCanonicalRowsetMultiplicityDigest(rows, codec).digest,
    captureCompletionTimestamp: new Date(nowMs).toISOString(),
    manifestExpiry: expiry,
    signerKeyId: SIGNER_KEY_ID,
    signatureAlgorithm: 'ED25519',
    signature: 'AA==',
  }
  return {
    chunks,
    envelope,
    manifest: {
      ...manifestDraft,
      signature: sign(
        null,
        contracts.computeSignedManifestBytes(manifestDraft),
        SIGNER.privateKey,
      ).toString('base64'),
    },
    rows,
  }
}

describeDb('sealed-export S4 generation kernel (real PostgreSQL, isolated schema)', () => {
  let adminPool: Pool
  let testPool: Pool
  let schema: string
  let rootDir: string
  let nowMs: number
  let queryHook: ((text: string) => Promise<void>) | null
  let service: ReturnType<typeof createPrivateIngestionServiceCore>
  let generationStore: ReturnType<typeof createGenerationStore>
  let kernel: ReturnType<typeof createSealedExportGenerationKernelCore>

  async function prepare(label: string, rowCount: number) {
    const data = buildFixture(label, rowCount, nowMs)
    const sessionId = await completeUpload(data)
    const sealed = await kernel.stageAndSeal({ sessionId })
    return { data, generationId: sealed.generationId, sessionId }
  }

  async function completeUpload(data: ReturnType<typeof buildFixture>) {
    const created = await service.createSession({
      envelope: data.envelope,
      manifest: data.manifest,
    })
    for (let index = 0; index < data.chunks.length; index += 1) {
      await service.submitChunk({
        sessionId: created.sessionId,
        chunkIndex: index,
        bytes: data.chunks[index],
      })
    }
    await service.completeSession({ sessionId: created.sessionId })
    return created.sessionId
  }

  async function verify(generationId: string) {
    const lease = await kernel.beginApply({ generationId })
    let result = await kernel.applyNextChunk({ lease })
    while (result.status === 'APPLYING') {
      result = await kernel.applyNextChunk({ lease })
    }
    expect(result.status).toBe('VERIFIED')
    return result
  }

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL })
    schema = `sealed_export_s4_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 20,
    })
    await testPool.query(`
      CREATE FUNCTION integration_set_updated_at()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END
      $$;
    `)
    await testPool.query(MIGRATION_068_SQL)
    await testPool.query(MIGRATION_069_SQL)
    await testPool.query(MIGRATION_068_SQL)
    await testPool.query(MIGRATION_069_SQL)
    rootDir = await mkdtemp(join(tmpdir(), 'sealed-export-s4-realdb-'))
    nowMs = Date.now()
    queryHook = null
    const db = createDb({
      database: createDatabaseBinding(testPool, async (text) => {
        if (queryHook) await queryHook(text)
      }),
    })
    const metadataStore = createPrivateIngestionMetadataStore({ db })
    service = createPrivateIngestionServiceCore({
      metadataStore,
      blobStore: createPrivateIngestionBlobStore({ rootDir }),
      manifestVerifier: MANIFEST_VERIFIER,
      authority: AUTHORITY,
      clock: () => new Date(nowMs),
    })
    generationStore = createGenerationStore({ db })
    kernel = createSealedExportGenerationKernelCore({
      generationStore,
      ingestionSource: service,
      authority: AUTHORITY,
      evidenceKey: EVIDENCE_KEY,
      clock: () => new Date(nowMs),
    })
    const expiresAt = new Date(nowMs + 60 * 60 * 1000)
    await testPool.query(
      `INSERT INTO integration_sealed_export_authority_state (
         tenant_id, workspace_id, tenant_domain_binding, system_content_key,
         role_binding_fingerprint, signer_key_id, signer_status, signer_expires_at,
         binding_current, binding_expires_at, qualification_digest,
         qualification_current, qualification_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, TRUE, $7, $8, TRUE, $7)`,
      [
        AUTHORITY.tenantId,
        AUTHORITY.workspaceId,
        AUTHORITY.tenantDomainBinding,
        AUTHORITY.systemContentKey,
        AUTHORITY.roleBindingFingerprint,
        SIGNER_KEY_ID,
        expiresAt,
        QUALIFICATION_DIGEST,
      ],
    )
  })

  afterEach(async () => {
    await testPool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('replays migration and exposes rows only after two-chunk apply plus pointer CAS', async () => {
    const prepared = await prepare('visibility', ROW_BATCH_SIZE + 1)
    expect(await kernel.readActiveRows({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      offset: 0,
      limit: 2,
    })).toEqual([])

    const lease = await kernel.beginApply({ generationId: prepared.generationId })
    expect(await kernel.applyNextChunk({ lease })).toMatchObject({
      status: 'APPLYING',
      appliedRowCount: ROW_BATCH_SIZE,
      externalWrite: false,
    })
    expect(await kernel.readActiveRows({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      offset: 0,
      limit: 2,
    })).toEqual([])

    expect(await kernel.applyNextChunk({ lease })).toMatchObject({
      status: 'VERIFIED',
      appliedRowCount: ROW_BATCH_SIZE + 1,
      externalWrite: false,
    })
    expect(await kernel.readActiveRows({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      offset: 0,
      limit: 2,
    })).toEqual([])

    expect(await kernel.activate({
      generationId: prepared.generationId,
      expectedActiveGenerationId: null,
    })).toMatchObject({
      status: 'ACTIVE',
      rowCount: ROW_BATCH_SIZE + 1,
      pointerVersion: 1,
      externalWrite: false,
    })
    expect(await kernel.readActiveRows({
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      offset: 0,
      limit: 2,
    })).toEqual(prepared.data.rows.slice(0, 2))

    const audit = await testPool.query(
      `SELECT event_type, reason, external_write
       FROM integration_sealed_export_generation_audit
       WHERE generation_id = $1
       ORDER BY event_type`,
      [prepared.generationId],
    )
    expect(audit.rows).toEqual([
      { event_type: 'ACTIVE', reason: null, external_write: false },
      { event_type: 'SEALED', reason: null, external_write: false },
      { event_type: 'VERIFIED', reason: null, external_write: false },
    ])
    await expect(testPool.query(
      `UPDATE integration_sealed_export_generations
       SET manifest_digest = $2
       WHERE generation_id = $1`,
      [prepared.generationId, digest('rewritten-manifest')],
    )).rejects.toMatchObject({ code: '55000' })
    await expect(testPool.query(
      `UPDATE integration_sealed_export_generation_audit
       SET row_count = row_count + 1
       WHERE generation_id = $1`,
      [prepared.generationId],
    )).rejects.toMatchObject({ code: '55000' })
    await expect(testPool.query(
      `DELETE FROM integration_sealed_export_generation_audit
       WHERE generation_id = $1`,
      [prepared.generationId],
    )).rejects.toMatchObject({ code: '55000' })
    await expect(testPool.query(
      `UPDATE integration_sealed_export_generation_rows
       SET row_digest = $2
       WHERE generation_id = $1 AND row_index = 0`,
      [prepared.generationId, digest('rewritten-row')],
    )).rejects.toMatchObject({ code: '55000' })
    await expect(testPool.query(
      `DELETE FROM integration_sealed_export_generation_rows
       WHERE generation_id = $1 AND row_index = 0`,
      [prepared.generationId],
    )).rejects.toMatchObject({ code: '55000' })
    await expect(testPool.query(
      `INSERT INTO integration_sealed_export_generation_rows (
         generation_id, tenant_id, workspace_id, tenant_domain_binding,
         system_content_key, role_binding_fingerprint, manifest_digest,
         row_index, canonical_row_text, row_sort_key, row_digest, apply_fence
       )
       SELECT generation_id, tenant_id, workspace_id, tenant_domain_binding,
              system_content_key, role_binding_fingerprint, manifest_digest,
              applied_row_count, '{}', convert_to('{}', 'UTF8'), $2, lease_fence
       FROM integration_sealed_export_generations
       WHERE generation_id = $1`,
      [prepared.generationId, digest('inserted-row')],
    )).rejects.toMatchObject({ code: '55000' })
  })

  it('fences cleanup against a generation claim with one real overlapping winner', async () => {
    const data = buildFixture('claim-cleanup', 1, nowMs)
    const created = await service.createSession({
      envelope: data.envelope,
      manifest: data.manifest,
    })
    for (let index = 0; index < data.chunks.length; index += 1) {
      await service.submitChunk({
        sessionId: created.sessionId,
        chunkIndex: index,
        bytes: data.chunks[index],
      })
    }
    await service.completeSession({ sessionId: created.sessionId })

    const meet = createBarrier(2)
    queryHook = async (text) => {
      if (
        /^UPDATE "integration_sealed_export_ingestion_sessions"/.test(text)
        && /"generation_claim_id"/.test(text)
      ) {
        await meet()
      }
    }
    const [claim, cleanup] = await Promise.allSettled([
      service.claimCompletedSessionForGeneration({ sessionId: created.sessionId }),
      service.cleanupSession({ sessionId: created.sessionId }),
    ])
    queryHook = null

    expect([claim.status, cleanup.status].filter((status) => status === 'fulfilled').length)
      .toBeGreaterThanOrEqual(1)
    const session = await testPool.query(
      `SELECT status, generation_claim_id
       FROM integration_sealed_export_ingestion_sessions
       WHERE session_id = $1`,
      [created.sessionId],
    )
    const tombstone = await testPool.query(
      `SELECT count(*)::int AS count
       FROM integration_sealed_export_ingestion_tombstones
       WHERE session_id = $1`,
      [created.sessionId],
    )
    if (claim.status === 'fulfilled') {
      expect(cleanup).toMatchObject({
        status: 'fulfilled',
        value: { outcome: 'RETAINED_ACTIVE' },
      })
      expect(session.rows).toEqual([{
        status: 'UPLOAD_COMPLETE',
        generation_claim_id: claim.value.generationId,
      }])
      expect(tombstone.rows[0].count).toBe(0)
    } else {
      expect(cleanup).toMatchObject({
        status: 'fulfilled',
        value: { outcome: 'CLEANED' },
      })
      expect(session.rows).toEqual([])
      expect(tombstone.rows[0].count).toBe(1)
    }
  })

  it('persists one generation and one lease winner under real overlapping claims', async () => {
    const data = buildFixture('concurrent-generation', 3, nowMs)
    const sessionId = await completeUpload(data)
    const meetGenerationInsert = createBarrier(2)
    queryHook = async (text) => {
      if (/^INSERT INTO "integration_sealed_export_generations"/.test(text)) {
        await meetGenerationInsert()
      }
    }
    const creators = await Promise.allSettled([
      kernel.stageAndSeal({ sessionId }),
      kernel.stageAndSeal({ sessionId }),
    ])
    queryHook = null

    expect(creators.some((entry) => entry.status === 'fulfilled')).toBe(true)
    const durable = await testPool.query(
      `SELECT generation_id, status
       FROM integration_sealed_export_generations
       WHERE session_id = $1`,
      [sessionId],
    )
    expect(durable.rows).toHaveLength(1)
    expect(durable.rows[0].status).toBe('SEALED')
    for (const creator of creators) {
      if (creator.status === 'fulfilled') {
        expect(creator.value.generationId).toBe(durable.rows[0].generation_id)
      }
    }

    const meetLeaseUpdate = createBarrier(2)
    queryHook = async (text) => {
      if (
        /^UPDATE "integration_sealed_export_generations"/.test(text)
        && /"status" = \$1/.test(text)
        && /"lease_token" = \$2/.test(text)
      ) {
        await meetLeaseUpdate()
      }
    }
    const leases = await Promise.allSettled([
      kernel.beginApply({ generationId: durable.rows[0].generation_id }),
      kernel.beginApply({ generationId: durable.rows[0].generation_id }),
    ])
    queryHook = null
    expect(leases.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(leases.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    const leaseWinner = leases.find((entry) => entry.status === 'fulfilled')
    if (!leaseWinner || leaseWinner.status !== 'fulfilled') {
      throw new Error('expected one fulfilled S4 lease')
    }
    expect(await kernel.applyNextChunk({
      lease: leaseWinner.value,
    })).toMatchObject({ status: 'VERIFIED' })
  })

  it('rolls back row insert with its checkpoint and fences an expired lease writer', async () => {
    const rollback = await prepare('apply-rollback', 4)
    const rollbackLease = await kernel.beginApply({ generationId: rollback.generationId })
    await testPool.query(`
      CREATE FUNCTION reject_s4_generation_row()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic generation row refusal';
      END
      $$;
      CREATE TRIGGER reject_s4_generation_row
      BEFORE INSERT ON integration_sealed_export_generation_rows
      FOR EACH ROW EXECUTE FUNCTION reject_s4_generation_row();
    `)
    await expect(kernel.applyNextChunk({ lease: rollbackLease }))
      .rejects.toMatchObject({ reason: 'SEALED_EXPORT_APPLY_INCOMPLETE' })
    const rolledBack = await testPool.query(
      `SELECT applied_row_count,
              (SELECT count(*)::int
               FROM integration_sealed_export_generation_rows
               WHERE generation_id = $1) AS persisted_rows
       FROM integration_sealed_export_generations
       WHERE generation_id = $1`,
      [rollback.generationId],
    )
    expect(rolledBack.rows).toEqual([{
      applied_row_count: 0,
      persisted_rows: 0,
    }])
    await testPool.query(
      'DROP TRIGGER reject_s4_generation_row ON integration_sealed_export_generation_rows',
    )
    expect(await kernel.applyNextChunk({ lease: rollbackLease }))
      .toMatchObject({ status: 'VERIFIED' })

    const stale = await prepare('stale-lease', 3)
    const staleLease = await kernel.beginApply({ generationId: stale.generationId })
    nowMs += LEASE_DURATION_MS + 1
    const currentLease = await kernel.beginApply({ generationId: stale.generationId })
    await expect(kernel.applyNextChunk({ lease: staleLease }))
      .rejects.toMatchObject({ reason: 'SEALED_EXPORT_APPLY_INCOMPLETE' })
    expect(await kernel.applyNextChunk({ lease: currentLease }))
      .toMatchObject({ status: 'VERIFIED' })

    const expired = await prepare('expired-final-write', 2)
    await kernel.beginApply({ generationId: expired.generationId })
    await testPool.query(
      `UPDATE integration_sealed_export_generations
       SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE generation_id = $1`,
      [expired.generationId],
    )
    const expiredGeneration = await generationStore.readGeneration(
      AUTHORITY,
      expired.generationId,
    )
    const staging = await generationStore.listStagingRows(
      expired.generationId,
      ['row_index', 'ASC'],
      1,
      0,
    )
    await expect(generationStore.appendGenerationRows(
      expiredGeneration,
      {
        token: expiredGeneration.lease_token,
        fence: Number(expiredGeneration.lease_fence),
      },
      0,
      [{
        generation_id: expiredGeneration.generation_id,
        tenant_id: expiredGeneration.tenant_id,
        workspace_id: expiredGeneration.workspace_id,
        tenant_domain_binding: expiredGeneration.tenant_domain_binding,
        system_content_key: expiredGeneration.system_content_key,
        role_binding_fingerprint: expiredGeneration.role_binding_fingerprint,
        manifest_digest: expiredGeneration.manifest_digest,
        row_index: 0,
        canonical_row_text: staging[0].canonical_row_text,
        row_sort_key: staging[0].row_sort_key,
        row_digest: staging[0].row_digest,
        apply_fence: Number(expiredGeneration.lease_fence),
        created_at: new Date(nowMs).toISOString(),
      }],
    )).rejects.toMatchObject({ reason: 'SEALED_EXPORT_APPLY_INCOMPLETE' })
    const expiredResidue = await testPool.query(
      `SELECT applied_row_count,
              (SELECT count(*)::int
               FROM integration_sealed_export_generation_rows
               WHERE generation_id = $1) AS persisted_rows
       FROM integration_sealed_export_generations
       WHERE generation_id = $1`,
      [expired.generationId],
    )
    expect(expiredResidue.rows).toEqual([{
      applied_row_count: 0,
      persisted_rows: 0,
    }])
  })

  it('quarantines revoked authority after lease expiry without losing the active generation', async () => {
    const initial = await prepare('expired-quarantine-initial', 2)
    await verify(initial.generationId)
    await kernel.activate({
      generationId: initial.generationId,
      expectedActiveGenerationId: null,
    })

    const candidate = await prepare('expired-quarantine-candidate', 2)
    await kernel.beginApply({ generationId: candidate.generationId })
    const leased = await testPool.query(
      `SELECT lease_fence
       FROM integration_sealed_export_generations
       WHERE generation_id = $1`,
      [candidate.generationId],
    )
    await testPool.query(
      `UPDATE integration_sealed_export_generations
       SET lease_expires_at = $2
       WHERE generation_id = $1`,
      [candidate.generationId, new Date(Date.now() - 1000)],
    )
    await testPool.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'REVOKED'
       WHERE tenant_id = $1`,
      [AUTHORITY.tenantId],
    )

    await expect(kernel.beginApply({ generationId: candidate.generationId }))
      .rejects.toMatchObject({ reason: 'SEALED_EXPORT_SIGNER_REVOKED' })
    const quarantined = await testPool.query(
      `SELECT status, lease_token, lease_fence
       FROM integration_sealed_export_generations
       WHERE generation_id = $1`,
      [candidate.generationId],
    )
    expect(quarantined.rows).toEqual([{
      status: 'QUARANTINED',
      lease_token: null,
      lease_fence: (BigInt(leased.rows[0].lease_fence) + 1n).toString(),
    }])
    const active = await testPool.query(
      'SELECT active_generation_id FROM integration_sealed_export_active_pointers',
    )
    expect(active.rows).toEqual([{
      active_generation_id: initial.generationId,
    }])
    await testPool.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'ACTIVE'
       WHERE tenant_id = $1`,
      [AUTHORITY.tenantId],
    )
  })

  it('revalidates revocation and gives two overlapping activation transactions one winner', async () => {
    const initial = await prepare('initial-active', 2)
    await verify(initial.generationId)
    await kernel.activate({
      generationId: initial.generationId,
      expectedActiveGenerationId: null,
    })

    const revoked = await prepare('revoked-before-activation', 2)
    await verify(revoked.generationId)
    await testPool.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'REVOKED'
       WHERE tenant_id = $1`,
      [AUTHORITY.tenantId],
    )
    await expect(kernel.activate({
      generationId: revoked.generationId,
      expectedActiveGenerationId: initial.generationId,
    })).rejects.toMatchObject({ reason: 'SEALED_EXPORT_SIGNER_REVOKED' })
    const unchanged = await testPool.query(
      `SELECT active_generation_id
       FROM integration_sealed_export_active_pointers`,
    )
    expect(unchanged.rows[0].active_generation_id).toBe(initial.generationId)
    await testPool.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'ACTIVE'
       WHERE tenant_id = $1`,
      [AUTHORITY.tenantId],
    )

    const concurrentRevoked = await prepare('concurrent-revocation', 2)
    await verify(concurrentRevoked.generationId)
    const revoker = await testPool.connect()
    let authorityReadStartedResolve: (() => void) | null = null
    let pointerWriteStartedResolve: (() => void) | null = null
    const authorityReadStarted = new Promise<void>((resolveStarted) => {
      authorityReadStartedResolve = resolveStarted
    })
    const pointerWriteStarted = new Promise<void>((resolveStarted) => {
      pointerWriteStartedResolve = resolveStarted
    })
    try {
      await revoker.query('BEGIN')
      await revoker.query(
        `UPDATE integration_sealed_export_authority_state
         SET signer_status = 'REVOKED'
         WHERE tenant_id = $1`,
        [AUTHORITY.tenantId],
      )
      queryHook = async (text) => {
        if (
          /^SELECT \* FROM "integration_sealed_export_authority_state"/.test(text)
        ) {
          authorityReadStartedResolve?.()
        }
        if (/^UPDATE "integration_sealed_export_active_pointers"/.test(text)) {
          pointerWriteStartedResolve?.()
        }
      }
      const activation = kernel.activate({
        generationId: concurrentRevoked.generationId,
        expectedActiveGenerationId: initial.generationId,
      })
      await authorityReadStarted
      const beforeRevocationCommit = await Promise.race([
        pointerWriteStarted.then(() => 'POINTER_WRITE'),
        new Promise<string>((resolveWaiting) => {
          setTimeout(() => resolveWaiting('AUTHORITY_LOCKED'), 75)
        }),
      ])
      await revoker.query('COMMIT')
      const activationOutcome = await Promise.allSettled([activation])
      expect(beforeRevocationCommit).toBe('AUTHORITY_LOCKED')
      expect(activationOutcome[0]).toMatchObject({
        status: 'rejected',
        reason: {
          reason: 'SEALED_EXPORT_SIGNER_REVOKED',
        },
      })
    } finally {
      queryHook = null
      try {
        await revoker.query('ROLLBACK')
      } finally {
        revoker.release()
      }
    }
    const afterConcurrentRevocation = await testPool.query(
      'SELECT active_generation_id FROM integration_sealed_export_active_pointers',
    )
    expect(afterConcurrentRevocation.rows[0].active_generation_id)
      .toBe(initial.generationId)
    await testPool.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'ACTIVE'
       WHERE tenant_id = $1`,
      [AUTHORITY.tenantId],
    )

    const left = await prepare('cas-left', 2)
    const right = await prepare('cas-right', 2)
    await verify(left.generationId)
    await verify(right.generationId)

    const meet = createBarrier(2)
    queryHook = async (text) => {
      if (
        /^SELECT COUNT\(\*\)::int AS count FROM "integration_sealed_export_generation_rows"/.test(text)
      ) {
        await meet()
      }
    }
    const contenders = await Promise.allSettled([
      kernel.activate({
        generationId: left.generationId,
        expectedActiveGenerationId: initial.generationId,
      }),
      kernel.activate({
        generationId: right.generationId,
        expectedActiveGenerationId: initial.generationId,
      }),
    ])
    queryHook = null

    expect(contenders.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    expect(contenders.find((entry) => entry.status === 'rejected'))
      .toMatchObject({
        reason: {
          reason: 'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
        },
      })
    const active = await testPool.query(
      'SELECT active_generation_id, pointer_version FROM integration_sealed_export_active_pointers',
    )
    expect([left.generationId, right.generationId]).toContain(
      active.rows[0].active_generation_id,
    )
    expect(Number(active.rows[0].pointer_version)).toBe(2)
  })
})
