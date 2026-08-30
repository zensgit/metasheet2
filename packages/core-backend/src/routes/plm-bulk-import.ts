/**
 * MetaSheet bulk item-property maintenance grid — consumer relay routes.
 *
 * Taskbook (authoritative, merged on Yuantus main):
 *   docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * ## Why the SERVER serializes, not the browser
 *
 * N1 says a declared column the grid fails to serialize is silently deleted from every
 * matched row. If the browser posted a finished CSV, N1 would depend on the correctness of a
 * virtualized Vue grid — the exact place the taskbook says columns go missing (hidden,
 * collapsed, off-viewport, filtered by an export preset).
 *
 * So the client posts ROWS, and these routes fetch the ItemType's declared property list
 * FRESH from PLM (N1-b) on the caller's own credential and serialize through
 * `serializeBulkGridToCsv`. A frontend bug then cannot drop a column: the column set never
 * comes from the client at all. The client's rows are only ever read THROUGH the declared
 * list.
 *
 * ## Gate order (mirrors plm-workbench.ts)
 *
 *   adapter-type guard → operator flag (commit only) → caller credential
 *   → Idempotency-Key (commit only) → request shape → N3-A update-mode refusal
 *   → capabilities pre-check (advisory) → provider
 *
 * The N3-A refusal sits ahead of the capabilities call on purpose: it is a decision about the
 * REQUEST, not about the deployment, so it must not depend on a provider round trip. Its 409
 * reason is distinct from every capability reason, so neither gate can mask the other's tests.
 *
 * ## What the capability manifest is NOT
 *
 * `GET /api/v1/integrations/capabilities` is a UI hint and NEVER an authorization source
 * (§1). The real gates are `is_entitled` on each provider route plus `require_admin_user` on
 * commit. These routes use the manifest only to decide what to render/attempt; the provider
 * stays authoritative, and a caller who is not a Yuantus admin gets the provider's own
 * rejection no matter what this layer believes.
 *
 * ## §8 — per-caller fetch, per-caller render
 *
 * Every response here is authorized for the CALLING credential. Nothing is cached, memoized,
 * or persisted: MetaSheet is a collaborative product, and a shared sheet holding one user's
 * `row_errors` report is a privilege leak by construction that Pact cannot catch, because
 * each individual call is valid. There is deliberately no store, no cache key, and no
 * write-to-document path anywhere in this file.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { Logger } from '../core/logger'
import { authenticate } from '../middleware/auth'
import { getDataSourceManager } from './data-sources'
import type {
  IntegrationCapabilitiesResult,
  IntegrationFeatureCapability,
  PLMItemMetadata,
  PlmBulkImportSubmission,
} from '../data-adapters/PLMAdapter'
import { isFeatureAvailable } from '../data-adapters/PLMAdapter'
import type { QueryResult } from '../data-adapters/BaseAdapter'
import {
  declaredColumnNames,
  normalizeBulkImportReport,
  serializeBulkGridToCsv,
  isValidIdempotencyKey,
  type PlmBulkGridRow,
  type PlmBulkImportReport,
} from '../plm/bulkImportGridSerializer'

const router = Router()
const logger = new Logger('PlmBulkImportAPI')

/**
 * Operator flag for the WRITE half. AGENTS.md red line: "一切外部写默认 OFF, exact-literal
 * 'true' 才开" — every external write defaults OFF and opens only on the exact literal
 * 'true'. Byte-exact, no trim, no case folding, to match the repo's other write gates.
 *
 * The dry-run half is deliberately NOT gated: it never writes (it is the provider's own
 * read-only validation path), and gating it would hide the validation loop that makes the
 * write half safe.
 *
 * Registered in scripts/ops/global-history-flag-manifest.mjs.
 */
export const PLM_BULK_IMPORT_COMMIT_FLAG = 'PLM_BULK_IMPORT_COMMIT_ENABLED'

function isCommitEnabled(): boolean {
  return process.env[PLM_BULK_IMPORT_COMMIT_FLAG] === 'true'
}

interface PlmBulkImportAdapter {
  getIntegrationCapabilities(): Promise<IntegrationCapabilitiesResult>
  getItemMetadataAsCaller(callerToken: string, itemType: string): Promise<QueryResult<PLMItemMetadata>>
  bulkImportDryRun(
    callerToken: string,
    submission: PlmBulkImportSubmission,
  ): Promise<QueryResult<PlmBulkImportReport>>
  bulkImportCommit(
    callerToken: string,
    submission: PlmBulkImportSubmission,
    idempotencyKey: string,
  ): Promise<QueryResult<PlmBulkImportReport>>
}

function isPlmBulkImportAdapter(adapter: unknown): adapter is PlmBulkImportAdapter {
  const candidate = adapter as PlmBulkImportAdapter | null
  return (
    typeof candidate?.getIntegrationCapabilities === 'function'
    && typeof candidate?.getItemMetadataAsCaller === 'function'
    && typeof candidate?.bulkImportDryRun === 'function'
    && typeof candidate?.bulkImportCommit === 'function'
  )
}

/**
 * The caller's OWN Yuantus credential (§2, Family I).
 *
 * Carried on a DEDICATED header, never MetaSheet's own `Authorization` (which holds the
 * MetaSheet session and is a different identity in a different system). Requiring it
 * per-request is what keeps the write on the human's identity rather than the data source's
 * shared service account — see the block comment on PLMAdapter.bulkImportCommit.
 *
 * Where a MetaSheet user obtains this credential is a Family-I product decision reserved to
 * the owner (taskbook §12.1); this route only defines the seam and refuses without it.
 */
function readCallerPlmCredential(req: Request): string {
  const raw = req.header('X-PLM-Authorization') || ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
}

function resolveAdapter(dataSourceId: string): unknown | null {
  try {
    return getDataSourceManager().getDataSource(dataSourceId)
  } catch {
    return null
  }
}

type FeatureKey = 'bulk_import' | 'bulk_import_commit'

/**
 * Advisory manifest pre-check. Returns an error payload to send, or null to continue.
 * Never 500s. Deliberately mirrors plm-workbench.ts's unsupported/not-entitled split.
 */
async function precheckCapability(
  adapter: PlmBulkImportAdapter,
  dataSourceId: string,
  featureKey: FeatureKey,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  let capabilities: IntegrationCapabilitiesResult
  try {
    capabilities = await adapter.getIntegrationCapabilities()
  } catch {
    return {
      status: 503,
      body: { error: 'PLM capabilities unavailable', data_source_id: dataSourceId, reason: 'unavailable' },
    }
  }
  // The two bulk-import descriptors are not (yet) named fields on IntegrationCapabilityManifest's
  // typed `features`, so index through the shared IntegrationFeatureCapability shape rather than
  // re-declaring a local one -- isFeatureAvailable is the single affordance-visibility judgment
  // and must not be re-derived here.
  const features = (capabilities.available ? capabilities.manifest?.features : undefined) as
    | Record<string, IntegrationFeatureCapability>
    | undefined
  const feature = features ? features[featureKey] : undefined
  if (!feature || feature.supported !== true) {
    return {
      status: 404,
      body: { error: `${featureKey} is not supported`, data_source_id: dataSourceId, reason: 'unsupported' },
    }
  }
  if (!isFeatureAvailable(feature)) {
    // supported but not available (unentitled, non-base) -> do not call the resource
    return {
      status: 403,
      body: { error: `${featureKey} is not entitled`, data_source_id: dataSourceId, reason: 'not-entitled' },
    }
  }
  return null
}

/** Normalize the client's row payload. Values stay `unknown`; the serializer coerces. */
function normalizeRows(body: unknown): PlmBulkGridRow[] | null {
  const source = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!Array.isArray(source.rows)) return null
  return source.rows.map((row) => (row && typeof row === 'object' ? (row as PlmBulkGridRow) : {}))
}

/**
 * Relay a provider error. NOTE the deliberate absence of a `ready`-bearing branch here: a
 * total rejection is HTTP 200 and never reaches this function. Only genuine transport/HTTP
 * failures do.
 */
function relayProviderError(
  error: Error & { response?: { status?: number; data?: unknown } },
  dataSourceId: string,
): { status: number; body: Record<string, unknown> } {
  const status = error.response?.status
  const payload = error.response?.data as { detail?: { code?: string } } | undefined
  const code = typeof payload?.detail?.code === 'string' ? payload.detail.code : undefined

  if (status === 409) {
    return {
      status: 409,
      body: {
        error: error.message || 'Bulk import conflict',
        data_source_id: dataSourceId,
        reason: code ?? 'provider-rejected',
      },
    }
  }
  if (status === 413) {
    return {
      status: 413,
      body: { error: 'Grid exceeds the provider size limit', data_source_id: dataSourceId, reason: 'payload-too-large' },
    }
  }
  if (status && [400, 401, 403, 404, 422].includes(status)) {
    return {
      status,
      body: { error: error.message || 'Bulk import rejected', data_source_id: dataSourceId, reason: 'provider-rejected' },
    }
  }
  return {
    status: 502,
    body: { error: error.message || 'PLM unavailable', data_source_id: dataSourceId, reason: 'provider-unavailable' },
  }
}

/**
 * Fetch the declared property list FRESH (N1-b) on the caller's credential, and serialize
 * the submitted rows through it (N1-a/N1-c).
 */
interface BuiltSubmission {
  /** Present only on success. */
  submission?: PlmBulkImportSubmission
  declaredColumns?: string[]
  /** Present only on failure. Callers check THIS, not a boolean discriminant: this package
   *  compiles with `strict: false`, where narrowing a `{ok:true}|{ok:false}` union does not
   *  work and every field access on the union errors. */
  failure?: { status: number; body: Record<string, unknown> }
}

async function buildSubmission(
  adapter: PlmBulkImportAdapter,
  callerToken: string,
  itemTypeId: string,
  rows: PlmBulkGridRow[],
  matchProperty: string | undefined,
): Promise<BuiltSubmission> {
  const metadata = await adapter.getItemMetadataAsCaller(callerToken, itemTypeId)
  if (metadata.error || !metadata.data || !metadata.data[0]) {
    const status = (metadata.error as (Error & { response?: { status?: number } }) | undefined)?.response?.status
    return {
      failure: {
        status: status === 403 || status === 404 ? status : 502,
        body: {
          error: 'Could not read the ItemType schema from PLM',
          reason: 'schema-unavailable',
        },
      },
    }
  }
  const declared = metadata.data[0].properties || []
  const declaredColumns = declaredColumnNames(declared)
  if (declaredColumns.length === 0) {
    return {
      failure: {
        status: 502,
        body: { error: 'PLM declared no properties for this ItemType', reason: 'schema-empty' },
      },
    }
  }
  // Serializing HERE, from the freshly-fetched declared list, is what makes N1 structural:
  // no client-supplied column set participates.
  const content = serializeBulkGridToCsv(declared, rows)
  return {
    declaredColumns,
    submission: {
      itemTypeId,
      ...(matchProperty ? { matchProperty } : {}),
      fileName: 'metasheet-bulk-grid.csv',
      content,
    },
  }
}

/**
 * N3-A (§6) — UPDATE MODE IS REFUSED. This consumer ships **create-only**.
 *
 * ## Why, precisely
 *
 * The provider's update-target lookup is a bare `.first()` with no `is_current` and no state
 * filter, so a `match_property` value shared by two items writes to an ARBITRARY one, and a
 * superseded/Released generation is a fully eligible target. Neither hazard raises anything:
 * `would_update` reads 1 and the commit reports success.
 *
 * N3-A therefore requires a `match_property` "whose uniqueness is established **for that
 * ItemType in that tenant**". This consumer **cannot establish that**, by any of the three
 * routes the taskbook leaves open:
 *
 *  - **No provider declaration to read.** `GET /api/v1/aml/metadata/{itemType}` returns
 *    `name/label/type/required/length/default` and nothing else — there is no uniqueness flag
 *    on the wire, and none on the provider's Property model to expose
 *    (yuantus `src/yuantus/meta_engine/web/router.py`, `get_metadata`).
 *  - **No tenant-population scan available.** Checking whether the tenant already holds two
 *    items sharing a value means probing existence for every match value in the grid. §7
 *    accepts the single-probe dry-run oracle but explicitly refuses to let a consumer amplify
 *    it: "a bulk existence check ... turns a per-probe oracle into an enumeration tool. Out of
 *    scope; do not build it." Doing it through a different read route is the same feature.
 *  - **N3-B is not authorized.** §6/§12.2 reserve the `is_current` prefix filter to the owner,
 *    and §6 says in terms: "Do not build the update mode on the assumption that N3-B will
 *    land."
 *
 * So the answer is N3-A's own fallback clause, applied verbatim: "the grid runs **create-only**
 * (no `match_property`), and update mode is disabled with a visible reason."
 *
 * ## Why REFUSE rather than silently strip
 *
 * Dropping `match_property` from a submission that asked for update mode turns every intended
 * update into a **create** — duplicate items instead of a wrong-row write. That is the same
 * class of silent damage, merely pointed the other way. A caller that asks to update is told
 * no, with a machine-readable reason, and nothing reaches the provider.
 *
 * This is a disposition, not a finished feature: when the owner rules on N3 (§12.2) this is the
 * single function that changes. `findDuplicateMatchValues` in the serializer is the parked
 * intra-grid half of the eventual check and has no live caller until then.
 */
export const MATCH_PROPERTY_REFUSAL_REASON = 'match-property-uniqueness-unestablished'

function n3RefuseUpdateMode(
  matchProperty: string | undefined,
): { status: number; body: Record<string, unknown> } | null {
  if (!matchProperty) return null
  return {
    status: 409,
    body: {
      error:
        `Update mode is disabled: the uniqueness of match_property "${matchProperty}" cannot be `
        + 'established for this ItemType in this tenant, and PLM would write to an arbitrary one '
        + 'of the matching items (a superseded generation included). Resubmit in create-only '
        + 'mode by omitting match_property.',
      reason: MATCH_PROPERTY_REFUSAL_REASON,
      match_property: matchProperty,
      // Deliberately explicit: the caller must not read this as a transient failure to retry.
      create_only: true,
    },
  }
}

/**
 * Declared-schema read for the grid's column set. Separate from submission so the UI can
 * render columns before anything is typed — but note the UI's copy is only ever for DISPLAY:
 * the serializer re-fetches at submission time (N1-b), so a schema change mid-session cannot
 * produce a short grid.
 */
router.get(
  '/api/plm-workbench/data-sources/:id/bulk-import/schema/:itemTypeId',
  authenticate,
  async (req: Request, res: Response) => {
    const dataSourceId = req.params.id
    const itemTypeId = req.params.itemTypeId
    const adapter = resolveAdapter(dataSourceId)
    if (!adapter) {
      return res.status(404).json({ error: 'Data source not found', data_source_id: dataSourceId })
    }
    if (!isPlmBulkImportAdapter(adapter)) {
      return res.status(404).json({
        error: 'Bulk import is not supported for this data source',
        data_source_id: dataSourceId,
        reason: 'unsupported-mode',
      })
    }
    const callerToken = readCallerPlmCredential(req)
    if (!callerToken) {
      return res.status(401).json({
        error: 'A caller PLM credential (X-PLM-Authorization) is required',
        data_source_id: dataSourceId,
        reason: 'missing-plm-credential',
      })
    }
    const precheck = await precheckCapability(adapter, dataSourceId, 'bulk_import')
    if (precheck) return res.status(precheck.status).json(precheck.body)

    const metadata = await adapter.getItemMetadataAsCaller(callerToken, itemTypeId)
    if (metadata.error || !metadata.data?.[0]) {
      return res.status(502).json({
        error: 'Could not read the ItemType schema from PLM',
        data_source_id: dataSourceId,
        reason: 'schema-unavailable',
      })
    }
    const properties = metadata.data[0].properties ?? []
    return res.json({
      data_source_id: dataSourceId,
      item_type_id: itemTypeId,
      // The FULL declared set. The UI may hide columns visually but must never drop one from
      // a submission -- and structurally cannot, since it does not serialize.
      properties,
      declared_columns: declaredColumnNames(properties),
      // N3-A: EMPTY, deliberately -- not "we forgot to fill it in". No declared property's
      // uniqueness can be established for this ItemType in this tenant from the consumer side
      // (see n3RefuseUpdateMode), so the grid offers create-only and nothing else. Offering
      // every declared column here, as an earlier revision did, advertised an update mode whose
      // precondition was never checked against the tenant's items at all.
      match_property_candidates: [],
      match_property_reason: MATCH_PROPERTY_REFUSAL_REASON,
      commit_enabled: isCommitEnabled(),
    })
  },
)

/**
 * MAKER half — validate. Never writes. Authenticated + `is_entitled("bulk_import")` on the
 * provider; NO admin dependency, so an engineer can iterate the error loop alone.
 */
router.post(
  '/api/plm-workbench/data-sources/:id/bulk-import/dry-run',
  authenticate,
  async (req: Request, res: Response) => {
    const dataSourceId = req.params.id
    const adapter = resolveAdapter(dataSourceId)
    if (!adapter) {
      return res.status(404).json({ error: 'Data source not found', data_source_id: dataSourceId })
    }
    if (!isPlmBulkImportAdapter(adapter)) {
      return res.status(404).json({
        error: 'Bulk import is not supported for this data source',
        data_source_id: dataSourceId,
        reason: 'unsupported-mode',
      })
    }
    const callerToken = readCallerPlmCredential(req)
    if (!callerToken) {
      return res.status(401).json({
        error: 'A caller PLM credential (X-PLM-Authorization) is required',
        data_source_id: dataSourceId,
        reason: 'missing-plm-credential',
      })
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const itemTypeId = typeof body.item_type_id === 'string' ? body.item_type_id.trim() : ''
    if (!itemTypeId) {
      return res.status(400).json({ error: 'item_type_id is required', data_source_id: dataSourceId, reason: 'invalid-request' })
    }
    const rows = normalizeRows(body)
    if (!rows) {
      return res.status(400).json({ error: 'rows[] is required', data_source_id: dataSourceId, reason: 'invalid-request' })
    }
    const matchProperty = typeof body.match_property === 'string' && body.match_property.trim()
      ? body.match_property.trim()
      : undefined

    // N3-A: update mode is refused outright, on the READ half too. Refusing here as well as on
    // commit is what keeps the maker loop honest -- an engineer must not be able to iterate a
    // grid to `ready: true` in a mode the checker half will then reject.
    const n3 = n3RefuseUpdateMode(matchProperty)
    if (n3) return res.status(n3.status).json({ ...n3.body, data_source_id: dataSourceId })

    const precheck = await precheckCapability(adapter, dataSourceId, 'bulk_import')
    if (precheck) return res.status(precheck.status).json(precheck.body)

    const built = await buildSubmission(adapter, callerToken, itemTypeId, rows, matchProperty)
    if (built.failure) {
      return res.status(built.failure.status).json({ ...built.failure.body, data_source_id: dataSourceId })
    }

    const result = await adapter.bulkImportDryRun(callerToken, built.submission)
    if (result.error) {
      const relayed = relayProviderError(result.error as Error & { response?: { status?: number; data?: unknown } }, dataSourceId)
      return res.status(relayed.status).json(relayed.body)
    }
    const report = normalizeBulkImportReport(result.data?.[0])
    return res.json({
      data_source_id: dataSourceId,
      // `ready` is the ONLY success discriminator (§3). This is a 200 whether or not the grid
      // was totally rejected -- the client branches on `ready`, never on the status code.
      ...report,
      declared_columns: built.declaredColumns,
      commit_enabled: isCommitEnabled(),
    })
  },
)

/**
 * CHECKER half — write. `require_admin_user` FIRST on the provider, then
 * `is_entitled("bulk_import_commit")`. The admin gate is satisfied by the CALLER's own
 * Yuantus identity; there is no service-account path here and no "submit for approval" queue
 * that would auto-commit (§10: no admin bypass, in any form).
 *
 * ## N2-a — the freshness ritual is enforced HERE, not merely suggested in the UI
 *
 * The provider accepts no `If-Match` and performs no staleness comparison, so a grid loaded
 * at T0 and committed at T2 silently overwrites whatever changed at T1. This route therefore
 * re-runs `/dry-run` from the SAME serialized bytes it is about to commit and refuses unless
 * that run returns `ready: true`. That does not make the commit atomic with the check — it
 * narrows the window from "however long the grid was open" to one round trip. It is a
 * ritual, not a lock, and the response says so.
 */
router.post(
  '/api/plm-workbench/data-sources/:id/bulk-import/commit',
  authenticate,
  async (req: Request, res: Response) => {
    const dataSourceId = req.params.id
    const adapter = resolveAdapter(dataSourceId)
    if (!adapter) {
      return res.status(404).json({ error: 'Data source not found', data_source_id: dataSourceId })
    }
    if (!isPlmBulkImportAdapter(adapter)) {
      return res.status(404).json({
        error: 'Bulk import is not supported for this data source',
        data_source_id: dataSourceId,
        reason: 'unsupported-mode',
      })
    }
    // Operator flag: external writes default OFF, exact literal 'true' only.
    if (!isCommitEnabled()) {
      return res.status(403).json({
        error: 'PLM bulk-import commit is disabled in this deployment',
        data_source_id: dataSourceId,
        reason: 'commit-disabled',
      })
    }
    const callerToken = readCallerPlmCredential(req)
    if (!callerToken) {
      return res.status(401).json({
        error: 'A caller PLM credential (X-PLM-Authorization) is required',
        data_source_id: dataSourceId,
        reason: 'missing-plm-credential',
      })
    }
    const idempotencyKey = (req.header('Idempotency-Key') || '').trim()
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({
        error: 'Idempotency-Key header is required (non-blank, at most 64 characters)',
        data_source_id: dataSourceId,
        reason: 'missing-idempotency-key',
      })
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const itemTypeId = typeof body.item_type_id === 'string' ? body.item_type_id.trim() : ''
    if (!itemTypeId) {
      return res.status(400).json({ error: 'item_type_id is required', data_source_id: dataSourceId, reason: 'invalid-request' })
    }
    const rows = normalizeRows(body)
    if (!rows) {
      return res.status(400).json({ error: 'rows[] is required', data_source_id: dataSourceId, reason: 'invalid-request' })
    }
    const matchProperty = typeof body.match_property === 'string' && body.match_property.trim()
      ? body.match_property.trim()
      : undefined

    const n3 = n3RefuseUpdateMode(matchProperty)
    if (n3) return res.status(n3.status).json({ ...n3.body, data_source_id: dataSourceId })

    const precheck = await precheckCapability(adapter, dataSourceId, 'bulk_import_commit')
    if (precheck) return res.status(precheck.status).json(precheck.body)

    const built = await buildSubmission(adapter, callerToken, itemTypeId, rows, matchProperty)
    if (built.failure) {
      return res.status(built.failure.status).json({ ...built.failure.body, data_source_id: dataSourceId })
    }

    // N2-a: freshness ritual, from the SAME bytes about to be committed.
    const freshness = await adapter.bulkImportDryRun(callerToken, built.submission)
    if (freshness.error) {
      const relayed = relayProviderError(
        freshness.error as Error & { response?: { status?: number; data?: unknown } },
        dataSourceId,
      )
      return res.status(relayed.status).json({ ...relayed.body, stage: 'freshness-dry-run' })
    }
    const freshnessReport = normalizeBulkImportReport(freshness.data?.[0])
    if (!freshnessReport.ready) {
      // Refuse to commit. Nothing was written. The client must fix the grid and, because a
      // cell changed, mint a NEW Idempotency-Key (§11).
      return res.status(409).json({
        data_source_id: dataSourceId,
        error: 'The pre-commit validation run did not return ready; nothing was committed',
        reason: 'freshness-check-failed',
        stage: 'freshness-dry-run',
        ...freshnessReport,
      })
    }

    const result = await adapter.bulkImportCommit(callerToken, built.submission, idempotencyKey)
    if (result.error) {
      const relayed = relayProviderError(result.error as Error & { response?: { status?: number; data?: unknown } }, dataSourceId)
      logger.warn('PLM bulk-import commit rejected', { dataSourceId, reason: relayed.body.reason })
      return res.status(relayed.status).json({ ...relayed.body, stage: 'commit' })
    }
    const report = normalizeBulkImportReport(result.data?.[0])
    return res.json({
      data_source_id: dataSourceId,
      // Still `ready`-discriminated: a reject-all commit is a 200 that wrote NOTHING.
      ...report,
      stage: 'commit',
      // N2-b/N2-c: the client must reload from PLM rather than trust its local buffer. Say so
      // explicitly so a consumer cannot mistake this response for authoritative row state.
      must_reload: true,
      freshness_window: 'one-round-trip',
    })
  },
)

export default router
