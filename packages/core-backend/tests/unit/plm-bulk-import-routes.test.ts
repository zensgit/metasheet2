/**
 * MetaSheet bulk item-property grid — consumer relay route tests.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * The behaviours pinned here are the ones the taskbook says silently destroy data or silently
 * defeat the maker-checker property, in the order it ranks them: N1 (server-side serialization
 * from the freshly-fetched declared list), the reject-all 200, N2-a's freshness ritual, N3-A's
 * uniqueness precondition, and the default-OFF write gate.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const dsMocks = vi.hoisted(() => ({ getDataSource: vi.fn() }))

vi.mock('../../src/db/db', () => ({ db: {} }))
vi.mock('../../src/db/pg', () => ({ pool: {}, query: vi.fn() }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1', tenantId: 'tenant-a' } as never
    next()
  },
}))
vi.mock('../../src/routes/data-sources', () => ({
  getDataSourceManager: () => ({ getDataSource: dsMocks.getDataSource }),
}))

import plmBulkImportRouter from '../../src/routes/plm-bulk-import'

const DRY_RUN_URL = '/api/plm-workbench/data-sources/ds-1/bulk-import/dry-run'
const COMMIT_URL = '/api/plm-workbench/data-sources/ds-1/bulk-import/commit'
const SCHEMA_URL = '/api/plm-workbench/data-sources/ds-1/bulk-import/schema/Part'
const CALLER = 'Bearer caller.jwt.token'

const DECLARED = [
  { name: 'item_number', required: true },
  { name: 'name', required: true },
  { name: 'material', required: false },
  { name: 'cost_center', required: false },
]

const manifest = (features: Record<string, Record<string, unknown>>) => ({
  available: true,
  manifest: {
    schema_version: 'v1',
    provider: 'yuantus-plm',
    advisory: true,
    features,
  },
})

const LIT = { supported: true, entitled: true, available: true, packaging: 'paid' }

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    getIntegrationCapabilities: vi.fn().mockResolvedValue(
      manifest({ bulk_import: { ...LIT }, bulk_import_commit: { ...LIT } }),
    ),
    getItemMetadataAsCaller: vi.fn().mockResolvedValue({
      data: [{ id: 'Part', label: 'Part', properties: DECLARED }],
    }),
    bulkImportDryRun: vi.fn().mockResolvedValue({ data: [{ ready: true, row_errors: [], would_create: 1 }] }),
    bulkImportCommit: vi.fn().mockResolvedValue({
      data: [{ ready: true, row_errors: [], created_ids: ['i1'], updated_ids: [] }],
    }),
    ...overrides,
  }
}

const ROWS_BODY = {
  item_type_id: 'Part',
  rows: [{ item_number: 'P-001', name: 'Bracket', material: 'Steel' }],
}

const pinned = usePinnedServer()

describe('PLM bulk-import consumer relay routes', () => {
  const app = express()
  app.use(express.json())
  app.use(plmBulkImportRouter)

  beforeEach(() => {
    dsMocks.getDataSource.mockReset()
    delete process.env.PLM_BULK_IMPORT_COMMIT_ENABLED
    pinned.setApp(app)
  })

  afterEach(() => {
    delete process.env.PLM_BULK_IMPORT_COMMIT_ENABLED
  })

  describe('§2 — the caller credential (Family I)', () => {
    it('refuses dry-run with no X-PLM-Authorization, and calls nothing', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).send(ROWS_BODY)

      expect(res.status).toBe(401)
      expect(res.body.reason).toBe('missing-plm-credential')
      expect(adapter.bulkImportDryRun).not.toHaveBeenCalled()
    })

    it('refuses commit with no X-PLM-Authorization', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(401)
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })

    it('strips the Bearer prefix and forwards the caller token to the adapter', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(adapter.bulkImportDryRun).toHaveBeenCalledWith('caller.jwt.token', expect.anything())
      // §2: the schema read travels on the SAME credential -- one family for the whole grid.
      expect(adapter.getItemMetadataAsCaller).toHaveBeenCalledWith('caller.jwt.token', 'Part')
    })
  })

  describe('N1 — the server serializes from the freshly-fetched declared list', () => {
    it('fetches the declared schema fresh on every submission (N1-b)', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      // Twice, not once: no cached schema can predate a PLM-side ItemType change.
      expect(adapter.getItemMetadataAsCaller).toHaveBeenCalledTimes(2)
    })

    it('serializes EVERY declared column even when the client omits it entirely', async () => {
      // The decisive N1 test. The client posts a row with no `cost_center` at all -- exactly
      // what a hidden/collapsed/virtualized column produces. The submitted CSV must still
      // carry the column, or committing would wholesale-delete it from every matched row.
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      const submission = adapter.bulkImportDryRun.mock.calls[0][1]
      const [header, firstRow] = submission.content.split('\r\n')
      expect(header).toBe('item_number,name,material,cost_center')
      expect(firstRow).toBe('P-001,Bracket,Steel,')
    })

    it('ignores a client-supplied column set entirely (N1 cannot be defeated from the browser)', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url())
        .post(DRY_RUN_URL)
        .set('X-PLM-Authorization', CALLER)
        .send({ ...ROWS_BODY, columns: ['item_number'], declared_columns: ['item_number'] })

      // A client that tries to narrow the column set gets the full declared header anyway.
      const submission = adapter.bulkImportDryRun.mock.calls[0][1]
      expect(submission.content.split('\r\n')[0]).toBe('item_number,name,material,cost_center')
    })

    it('picks up a column added to the ItemType after the grid was loaded', async () => {
      const adapter = makeAdapter({
        getItemMetadataAsCaller: vi.fn().mockResolvedValue({
          data: [{ id: 'Part', properties: [...DECLARED, { name: 'lifecycle_note', required: false }] }],
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      const submission = adapter.bulkImportDryRun.mock.calls[0][1]
      expect(submission.content.split('\r\n')[0]).toContain('lifecycle_note')
    })

    it('fails closed when the schema read fails (never serializes a guessed column set)', async () => {
      const adapter = makeAdapter({
        getItemMetadataAsCaller: vi.fn().mockResolvedValue({ error: new Error('boom') }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(502)
      expect(res.body.reason).toBe('schema-unavailable')
      expect(adapter.bulkImportDryRun).not.toHaveBeenCalled()
    })
  })

  describe('§3 — reject-all is a 200 with ready:false', () => {
    it('relays a totally-rejected dry-run as HTTP 200 carrying ready:false', async () => {
      const adapter = makeAdapter({
        bulkImportDryRun: vi.fn().mockResolvedValue({
          data: [{
            ready: false,
            row_errors: [{ row_number: 1, property_name: 'name', error_code: 'MISSING_REQUIRED_VALUE', message: 'required' }],
          }],
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(200)
      expect(res.body.ready).toBe(false)
      expect(res.body.row_errors).toHaveLength(1)
      expect(res.body.row_errors[0].error_code).toBe('MISSING_REQUIRED_VALUE')
    })

    it('preserves an unrecognized error_code (§3.1: the code set is open)', async () => {
      const adapter = makeAdapter({
        bulkImportDryRun: vi.fn().mockResolvedValue({
          data: [{ ready: false, row_errors: [{ row_number: 3, error_code: 'FUTURE_CODE', message: 'x' }] }],
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.body.row_errors[0].error_code).toBe('FUTURE_CODE')
    })
  })

  describe('N2-a — the freshness ritual is enforced server-side', () => {
    it('re-runs dry-run from the same bytes immediately before committing', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(200)
      expect(adapter.bulkImportDryRun).toHaveBeenCalledTimes(1)
      expect(adapter.bulkImportCommit).toHaveBeenCalledTimes(1)
      // Byte-identical: the run that was validated is the run that is written.
      expect(adapter.bulkImportDryRun.mock.calls[0][1].content)
        .toBe(adapter.bulkImportCommit.mock.calls[0][1].content)
    })

    it('REFUSES to commit when the pre-commit run is not ready, and writes nothing', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter({
        bulkImportDryRun: vi.fn().mockResolvedValue({
          data: [{ ready: false, row_errors: [{ row_number: 1, error_code: 'TYPE_COERCION_FAILED', message: 'bad' }] }],
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('freshness-check-failed')
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })

    it('tells the client to reload rather than trust its local buffer (N2-b/N2-c)', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      dsMocks.getDataSource.mockReturnValue(makeAdapter())
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.body.must_reload).toBe(true)
      // The window is a ritual, never presented as a lock.
      expect(res.body.freshness_window).toBe('one-round-trip')
    })
  })

  describe('N3-A — match_property uniqueness precondition', () => {
    it('refuses update mode when the match value is duplicated in the grid', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(DRY_RUN_URL)
        .set('X-PLM-Authorization', CALLER)
        .send({
          item_type_id: 'Part',
          match_property: 'item_number',
          rows: [
            { item_number: 'P-001', name: 'A' },
            { item_number: 'P-001', name: 'B' },
          ],
        })

      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('match-property-not-unique')
      expect(res.body.duplicate_values).toEqual(['P-001'])
      // Nothing reached the provider: an arbitrary one of the two would have been written.
      expect(adapter.bulkImportDryRun).not.toHaveBeenCalled()
    })

    it('allows update mode when every match value is unique', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(DRY_RUN_URL)
        .set('X-PLM-Authorization', CALLER)
        .send({
          item_type_id: 'Part',
          match_property: 'item_number',
          rows: [{ item_number: 'P-001', name: 'A' }, { item_number: 'P-002', name: 'B' }],
        })

      expect(res.status).toBe(200)
      expect(adapter.bulkImportDryRun.mock.calls[0][1].matchProperty).toBe('item_number')
    })

    it('create-only mode omits match_property entirely', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(adapter.bulkImportDryRun.mock.calls[0][1].matchProperty).toBeUndefined()
    })

    it('the N3 guard also runs on commit, not only on dry-run', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send({
          item_type_id: 'Part',
          match_property: 'item_number',
          rows: [{ item_number: 'D' }, { item_number: 'D' }],
        })

      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('match-property-not-unique')
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })
  })

  describe('operator flag — external writes default OFF, exact literal "true"', () => {
    it('commit is refused when the flag is unset', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(403)
      expect(res.body.reason).toBe('commit-disabled')
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })

    it.each(['TRUE', 'True', '1', 'yes', ' true', 'true '])(
      'commit stays refused for the near-miss value %j (byte-exact only)',
      async (value) => {
        process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = value
        const adapter = makeAdapter()
        dsMocks.getDataSource.mockReturnValue(adapter)
        const res = await request(pinned.url())
          .post(COMMIT_URL)
          .set('X-PLM-Authorization', CALLER)
          .set('Idempotency-Key', 'k-1')
          .send(ROWS_BODY)

        expect(res.status).toBe(403)
        expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
      },
    )

    it('dry-run is NOT gated by the flag (it never writes)', async () => {
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(200)
      expect(adapter.bulkImportDryRun).toHaveBeenCalled()
    })
  })

  describe('§11 — Idempotency-Key', () => {
    it.each([
      ['absent', undefined],
      ['blank', '   '],
      ['over 64 chars', 'x'.repeat(65)],
    ])('commit rejects a %s key before touching the provider', async (_label, key) => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      const req = request(pinned.url()).post(COMMIT_URL).set('X-PLM-Authorization', CALLER)
      if (key !== undefined) req.set('Idempotency-Key', key)
      const res = await req.send(ROWS_BODY)

      expect(res.status).toBe(400)
      expect(res.body.reason).toBe('missing-idempotency-key')
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })

    it('forwards a valid key to the provider', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter()
      dsMocks.getDataSource.mockReturnValue(adapter)
      await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(adapter.bulkImportCommit.mock.calls[0][2]).toBe('k-1')
    })

    it('surfaces the 409 idempotency_conflict as a discriminated reason', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter({
        bulkImportCommit: vi.fn().mockResolvedValue({
          error: Object.assign(new Error('reused'), {
            response: { status: 409, data: { detail: { code: 'idempotency_conflict', message: 'reused' } } },
          }),
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('idempotency_conflict')
      expect(res.body.stage).toBe('commit')
    })
  })

  describe('capability manifest is advisory only', () => {
    it('hides the surface when bulk_import is unsupported', async () => {
      const adapter = makeAdapter({
        getIntegrationCapabilities: vi.fn().mockResolvedValue(manifest({})),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(404)
      expect(res.body.reason).toBe('unsupported')
      expect(adapter.bulkImportDryRun).not.toHaveBeenCalled()
    })

    it('blocks the call when supported but not available (does not query the resource)', async () => {
      const adapter = makeAdapter({
        getIntegrationCapabilities: vi.fn().mockResolvedValue(
          manifest({ bulk_import: { supported: true, entitled: false, available: false, packaging: 'paid' } }),
        ),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(403)
      expect(res.body.reason).toBe('not-entitled')
      expect(adapter.bulkImportDryRun).not.toHaveBeenCalled()
    })

    it('commit checks the SEPARATE bulk_import_commit SKU, not bulk_import', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      const adapter = makeAdapter({
        getIntegrationCapabilities: vi.fn().mockResolvedValue(
          // maker SKU lit, checker SKU dark -> the commit half must still be refused
          manifest({
            bulk_import: { ...LIT },
            bulk_import_commit: { supported: true, entitled: false, available: false, packaging: 'paid' },
          }),
        ),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url())
        .post(COMMIT_URL)
        .set('X-PLM-Authorization', CALLER)
        .set('Idempotency-Key', 'k-1')
        .send(ROWS_BODY)

      expect(res.status).toBe(403)
      expect(res.body.reason).toBe('not-entitled')
      expect(adapter.bulkImportCommit).not.toHaveBeenCalled()
    })

    it('degrades (never 500s) when the capability handshake throws', async () => {
      const adapter = makeAdapter({
        getIntegrationCapabilities: vi.fn().mockRejectedValue(new Error('down')),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(503)
      expect(res.body.reason).toBe('unavailable')
    })
  })

  describe('guards and relays', () => {
    it('404s an unknown data source', async () => {
      dsMocks.getDataSource.mockImplementation(() => {
        throw new Error('nope')
      })
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)
      expect(res.status).toBe(404)
    })

    it('404s an adapter that lacks the bulk-import methods', async () => {
      dsMocks.getDataSource.mockReturnValue({ getIntegrationCapabilities: vi.fn() })
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)
      expect(res.status).toBe(404)
      expect(res.body.reason).toBe('unsupported-mode')
    })

    it('400s a request with no rows[]', async () => {
      dsMocks.getDataSource.mockReturnValue(makeAdapter())
      const res = await request(pinned.url())
        .post(DRY_RUN_URL)
        .set('X-PLM-Authorization', CALLER)
        .send({ item_type_id: 'Part' })
      expect(res.status).toBe(400)
    })

    it('relays a provider 413 as payload-too-large (BULK_IMPORT_MAX_BYTES may be set)', async () => {
      const adapter = makeAdapter({
        bulkImportDryRun: vi.fn().mockResolvedValue({
          error: Object.assign(new Error('too big'), { response: { status: 413 } }),
        }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(413)
      expect(res.body.reason).toBe('payload-too-large')
    })

    it('relays an unreachable provider as 502, never 500', async () => {
      const adapter = makeAdapter({
        bulkImportDryRun: vi.fn().mockResolvedValue({ error: new Error('ECONNREFUSED') }),
      })
      dsMocks.getDataSource.mockReturnValue(adapter)
      const res = await request(pinned.url()).post(DRY_RUN_URL).set('X-PLM-Authorization', CALLER).send(ROWS_BODY)

      expect(res.status).toBe(502)
      expect(res.body.reason).toBe('provider-unavailable')
    })
  })

  describe('schema route', () => {
    it('returns the FULL declared property list plus the commit affordance hint', async () => {
      dsMocks.getDataSource.mockReturnValue(makeAdapter())
      const res = await request(pinned.url()).get(SCHEMA_URL).set('X-PLM-Authorization', CALLER)

      expect(res.status).toBe(200)
      expect(res.body.declared_columns).toEqual(['item_number', 'name', 'material', 'cost_center'])
      expect(res.body.properties).toHaveLength(4)
      // The affordance hint is a UI hint only -- the server re-checks on every commit.
      expect(res.body.commit_enabled).toBe(false)
    })

    it('reports commit_enabled true only under the exact literal flag', async () => {
      process.env.PLM_BULK_IMPORT_COMMIT_ENABLED = 'true'
      dsMocks.getDataSource.mockReturnValue(makeAdapter())
      const res = await request(pinned.url()).get(SCHEMA_URL).set('X-PLM-Authorization', CALLER)
      expect(res.body.commit_enabled).toBe(true)
    })
  })
})
