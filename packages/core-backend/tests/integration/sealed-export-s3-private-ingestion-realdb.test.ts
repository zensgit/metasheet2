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

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../migrations/068_create_integration_sealed_export_ingestion.sql'),
  'utf8',
)
const DATABASE_URL = process.env.DATABASE_URL
const describeDb = DATABASE_URL ? describe : describe.skip
const SIGNER_KEY_ID = 'sealed-export-s3-realdb-signer'
const SIGNER = generateKeyPairSync('ed25519')
const AUTHORITY = Object.freeze({
  tenantId: 'sealed-export-s3-realdb-tenant',
  workspaceId: 'sealed-export-s3-realdb-workspace',
  tenantDomainBinding: 'sealed-export-s3-realdb-domain',
  systemContentKey: 'sealed-export-s3-realdb-system',
  roleBindingFingerprint: 'sealed-export-s3-realdb-role',
})
const MANIFEST_VERIFIER = createPrivateIngestionManifestVerifier({
  signerKeys: [{
    signerKeyId: SIGNER_KEY_ID,
    publicKey: SIGNER.publicKey,
  }],
})

function digest(label: string): string {
  return createHash('sha256').update(`sealed-export-s3-realdb:${label}`).digest('hex')
}

type TransactionStats = {
  active: number
  maxActive: number
  uniqueViolations: number
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
  stats: TransactionStats,
  beforeTransactionQuery: (text: string) => Promise<void>,
) {
  return {
    async query(text: string, params?: readonly unknown[]) {
      return (await pool.query(text, params ? Array.from(params) : undefined)).rows
    },
    async transaction(callback: (client: {
      query: (text: string, params?: readonly unknown[]) => Promise<unknown[]>
      commit: () => Promise<void>
      rollback: () => Promise<void>
    }) => Promise<unknown>) {
      const client = await pool.connect()
      let settled = false
      let countedActive = false
      const execute = async (text: string, params?: readonly unknown[]) =>
        (await client.query(text, params ? Array.from(params) : undefined)).rows
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
        stats.active += 1
        countedActive = true
        stats.maxActive = Math.max(stats.maxActive, stats.active)
        const guardedExecute = async (text: string, params?: readonly unknown[]) => {
          await beforeTransactionQuery(text)
          return execute(text, params)
        }
        const result = await callback({ query: guardedExecute, commit, rollback })
        await commit()
        return result
      } catch (error) {
        if (
          error
          && typeof error === 'object'
          && 'code' in error
          && error.code === '23505'
        ) {
          stats.uniqueViolations += 1
        }
        await rollback()
        throw error
      } finally {
        if (countedActive) stats.active -= 1
        client.release()
      }
    },
  }
}

function buildFixture(label: string) {
  const chunk = Buffer.from(`sealed-export-s3-realdb-chunk:${label}`, 'utf8')
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const envelope = {
    exportRequestId: `sealed-export-s3-realdb-request-${label}`,
    nonce: `sealed-export-s3-realdb-nonce-${label}`,
    expiry,
    scenarioVersion: 'sealed-export-s3-realdb-scenario-v1',
    bindingVersion: 'sealed-export-s3-realdb-binding-v1',
    roleId: 'sealed-export-s3-realdb-role',
    actionProfileVersion: 'sealed-export-s3-realdb-action-v1',
    roleBindingFingerprint: AUTHORITY.roleBindingFingerprint,
    systemContentKey: AUTHORITY.systemContentKey,
    approvedConfigVersionId: 'sealed-export-s3-realdb-config-v1',
    configContentKey: `sealed-export-s3-realdb-config-${label}`,
    canonicalObjectVersion: 'sealed-export-s3-realdb-object-v1',
    qualificationDigest: digest(`${label}:qualification`),
    executionMode: 'sealed-export-s3-realdb-mode',
    applyProfileVersion: 'sealed-export-s3-realdb-apply-v1',
    queryObjectFilterBindingDigest: digest(`${label}:query-binding`),
    expectedSourceSchemaFieldMapDigest: digest(`${label}:schema`),
    tenantDomainBinding: AUTHORITY.tenantDomainBinding,
    rowBudget: 10,
    byteBudget: 10000,
    chunkBudget: 2,
  }
  const chunkDigest = digests.computeChunkDigest(chunk).digest
  const manifestDraft = {
    exportRequestEnvelopeDigest: contracts.computeExportRequestEnvelopeDigest(envelope),
    sourceCaptureIdentity: `sealed-export-s3-realdb-capture-${label}`,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    agentImplementationVersion: 'sealed-export-s3-realdb-agent-v1',
    agentProtocolVersion: 'sealed-export-s3-realdb-protocol-v1',
    encodingVersion: 'sealed-export-s3-realdb-encoding-v1',
    canonicalizationVersion: codec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    sourceSchemaDigest: envelope.expectedSourceSchemaFieldMapDigest,
    totalRows: 1,
    totalBytes: chunk.length,
    chunks: [{
      chunkIndex: 0,
      chunkDigest,
      byteCount: chunk.length,
    }],
    wholeArtifactByteDigest: digests.computeWholeArtifactByteDigest([chunk]).digest,
    canonicalRowsetMultiplicityDigest:
      digests.computeCanonicalRowsetMultiplicityDigest(
        [{ id: `sealed-export-s3-realdb-row-${label}` }],
        codec,
      ).digest,
    captureCompletionTimestamp: new Date().toISOString(),
    manifestExpiry: expiry,
    signerKeyId: SIGNER_KEY_ID,
    signatureAlgorithm: 'ED25519',
    signature: 'AA==',
  }
  return {
    chunk,
    envelope,
    manifest: {
      ...manifestDraft,
      signature: sign(
        null,
        contracts.computeSignedManifestBytes(manifestDraft),
        SIGNER.privateKey,
      ).toString('base64'),
    },
  }
}

describeDb('sealed-export S3 private ingestion (real PostgreSQL, isolated schema)', () => {
  let adminPool: Pool
  let testPool: Pool
  let schema: string
  let rootDir: string
  let service: ReturnType<typeof createPrivateIngestionServiceCore>
  let transactionStats: TransactionStats
  let transactionQueryHook: ((text: string) => Promise<void>) | null

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL })
    schema = `sealed_export_s3_${randomUUID().replace(/-/g, '')}`
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
    await testPool.query(MIGRATION_SQL)
    rootDir = await mkdtemp(join(tmpdir(), 'sealed-export-s3-realdb-'))
    transactionStats = { active: 0, maxActive: 0, uniqueViolations: 0 }
    transactionQueryHook = null
    const metadataStore = createPrivateIngestionMetadataStore({
      db: createDb({
        database: createDatabaseBinding(
          testPool,
          transactionStats,
          async (text) => {
            if (transactionQueryHook) await transactionQueryHook(text)
          },
        ),
      }),
    })
    service = createPrivateIngestionServiceCore({
      metadataStore,
      blobStore: createPrivateIngestionBlobStore({ rootDir }),
      manifestVerifier: MANIFEST_VERIFIER,
      authority: AUTHORITY,
    })
  })

  afterEach(async () => {
    await testPool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('concurrent retries create one authoritative session row', async () => {
    const data = buildFixture('concurrent-create')
    const beforeInsert = createBarrier(12)
    transactionQueryHook = async (text) => {
      if (/^INSERT INTO "integration_sealed_export_ingestion_sessions"/.test(text)) {
        await beforeInsert()
      }
    }
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.createSession({
          envelope: data.envelope,
          manifest: data.manifest,
        })),
    )

    expect(new Set(attempts.map((attempt) => attempt.sessionId)).size).toBe(1)
    expect(transactionStats.maxActive).toBeGreaterThan(1)
    expect(transactionStats.uniqueViolations).toBeGreaterThan(0)
    const count = await testPool.query(
      'SELECT count(*)::int AS count FROM integration_sealed_export_ingestion_sessions',
    )
    expect(count.rows[0].count).toBe(1)
  })

  it('relation-scoped triggers freeze anchors and the composite FK rejects receipt scope drift', async () => {
    const data = buildFixture('database-invariants')
    const created = await service.createSession({
      envelope: data.envelope,
      manifest: data.manifest,
    })
    const initial = await testPool.query(
      `SELECT updated_at, manifest_digest
       FROM integration_sealed_export_ingestion_sessions
       WHERE session_id = $1`,
      [created.sessionId],
    )
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    const touched = await testPool.query(
      `UPDATE integration_sealed_export_ingestion_sessions
       SET status = status
       WHERE session_id = $1
       RETURNING updated_at`,
      [created.sessionId],
    )
    expect(touched.rows[0].updated_at.getTime())
      .toBeGreaterThan(initial.rows[0].updated_at.getTime())

    await expect(testPool.query(
      `UPDATE integration_sealed_export_ingestion_sessions
       SET expires_at = expires_at + interval '1 second'
       WHERE session_id = $1`,
      [created.sessionId],
    )).rejects.toMatchObject({ code: '55000' })

    await expect(testPool.query(
      `INSERT INTO integration_sealed_export_ingestion_receipts (
         session_id,
         tenant_id,
         workspace_id,
         tenant_domain_binding,
         system_content_key,
         role_binding_fingerprint,
         manifest_digest,
         chunk_index,
         chunk_digest,
         byte_count,
         accepted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NOW())`,
      [
        created.sessionId,
        AUTHORITY.tenantId,
        AUTHORITY.workspaceId,
        'sealed-export-s3-realdb-wrong-domain',
        AUTHORITY.systemContentKey,
        AUTHORITY.roleBindingFingerprint,
        initial.rows[0].manifest_digest,
        data.manifest.chunks[0].chunkDigest,
        data.chunk.length,
      ],
    )).rejects.toMatchObject({
      code: '23503',
      constraint: 'fk_integration_sealed_export_ingestion_receipt_scope',
    })

    const siblingSchema = `sealed_export_s3_${randomUUID().replace(/-/g, '')}`
    let siblingPool: Pool | null = null
    try {
      await adminPool.query(`CREATE SCHEMA "${siblingSchema}"`)
      siblingPool = new Pool({
        connectionString: DATABASE_URL,
        options: `-c search_path=${siblingSchema}`,
      })
      await siblingPool.query(`
        CREATE FUNCTION integration_set_updated_at()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END
        $$;
      `)
      await siblingPool.query(MIGRATION_SQL)
      const triggerCount = await siblingPool.query(`
        SELECT count(*)::int AS count
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = 'integration_sealed_export_ingestion_sessions'
          AND t.tgname IN (
            'trg_integration_sealed_export_ingestion_sessions_anchors_immutable',
            'trg_integration_sealed_export_ingestion_sessions_updated_at'
          )
      `, [siblingSchema])
      expect(triggerCount.rows[0].count).toBe(2)
    } finally {
      if (siblingPool) await siblingPool.end()
      await adminPool.query(`DROP SCHEMA IF EXISTS "${siblingSchema}" CASCADE`)
    }
  })

  it('receipt failure rolls back its session transition and restart recovery commits one receipt', async () => {
    const data = buildFixture('receipt-rollback')
    const created = await service.createSession({
      envelope: data.envelope,
      manifest: data.manifest,
    })
    await testPool.query(`
      CREATE FUNCTION reject_s3_receipt()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic receipt refusal';
      END
      $$;
      CREATE TRIGGER reject_s3_receipt
      BEFORE INSERT ON integration_sealed_export_ingestion_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_s3_receipt();
    `)

    await expect(service.submitChunk({
      sessionId: created.sessionId,
      chunkIndex: 0,
      bytes: data.chunk,
    })).rejects.toMatchObject({ reason: 'SEALED_EXPORT_INTERNAL_ERROR' })

    const afterRollback = await testPool.query(
      `SELECT status, accepted_chunk_count
       FROM integration_sealed_export_ingestion_sessions
       WHERE session_id = $1`,
      [created.sessionId],
    )
    expect(afterRollback.rows).toEqual([{
      status: 'CHUNK_WRITING',
      accepted_chunk_count: 0,
    }])
    expect(
      Number((
        await testPool.query(
          'SELECT count(*) AS count FROM integration_sealed_export_ingestion_receipts',
        )
      ).rows[0].count),
    ).toBe(0)

    await testPool.query('DROP TRIGGER reject_s3_receipt ON integration_sealed_export_ingestion_receipts')
    const resumed = await service.resumeSession({ sessionId: created.sessionId })
    expect(resumed).toMatchObject({
      status: 'UPLOADING',
      acceptedChunkCount: 1,
      acceptedChunkIndexes: [0],
    })
    const recovered = await testPool.query(
      `SELECT status, accepted_chunk_count
       FROM integration_sealed_export_ingestion_sessions
       WHERE session_id = $1`,
      [created.sessionId],
    )
    expect(recovered.rows).toEqual([{
      status: 'UPLOADING',
      accepted_chunk_count: 1,
    }])
    expect(
      Number((
        await testPool.query(
          'SELECT count(*) AS count FROM integration_sealed_export_ingestion_receipts',
        )
      ).rows[0].count),
    ).toBe(1)
  })
})
