/**
 * Transfer MVP — T1 (service), Canonical Org & Provider Transfer v1 sequencing plan §2 row T1;
 * API/data model per `provider-org-transfer-development-plan-20260709.md` §6.3 + §7.
 *
 * Lifecycle skeleton over `provider_org_transfers` / `provider_org_transfer_decisions`. Scan and
 * apply are FAIL-CLOSED when no binding adapter is registered for the transfer's provider:
 * production never falls back to a silent no-op. The exported `noopOrgTransferAdapter` exists
 * only for explicit test registration (see `registerOrgTransferAdapter` /
 * `unregisterOrgTransferAdapter`); T3/T4 register real adapters through the same seam. The T1
 * suite registers the no-op for happy-path lifecycle proofs and pins that apply writes NOTHING
 * to any `directory_*` table (fingerprint test).
 *
 * State machine (no stuck absorbing non-terminal state):
 *
 *   create → 'draft'
 *   scan:    'draft' | 'scanned' | 'failed' → 'scanned'   (idempotent re-scan; 'failed' → scan
 *            is the recovery edge that keeps 'failed' non-absorbing; wipes + regenerates the
 *            decision set and INVALIDATES any prior dry-run: dry_run_at ← NULL)
 *            Missing adapter → 409 ORG_TRANSFER_ADAPTER_UNAVAILABLE; row unchanged
 *   dry-run: 'scanned' → 'scanned'                        (pure read + stats write; sets dry_run_at)
 *   apply:   'scanned' + dry_run_at IS NOT NULL + zero undecided decisions → 'applied'
 *            ('applying' is in the status domain for T3+'s multi-transaction apply; with the
 *            test-registered no-op, apply commits 'scanned' → 'applied' in one transaction, so
 *            'applying' is never observable here)
 *            Missing adapter → 409 ORG_TRANSFER_ADAPTER_UNAVAILABLE; row unchanged
 *   cancel:  any non-terminal ('draft' | 'scanned' | 'applying' | 'failed') → 'cancelled'
 *
 * Every transition runs in ONE transaction with `SELECT … FOR UPDATE` on the transfer row —
 * write-point enforcement, not check-then-write (the PB4-2 doctrine): a concurrent
 * apply/apply or apply/cancel pair linearizes on the row lock and the loser gets a clean 409.
 *
 * Like `local-directory-org.ts`, every function takes explicit ids; org identity is NEVER a
 * caller input — the transfer's `org_id` is derived server-side from the two integration rows
 * (which must agree), and the schema's composite FKs make a cross-org or provider-mismatched
 * row impossible to INSERT even if this validation were bypassed.
 */

import { query, transaction } from '../db/pg'

export class OrgTransferValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgTransferValidationError'
  }
}

export class OrgTransferNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgTransferNotFoundError'
  }
}

/** 409-mapped conflicts carry a stable machine code the route layer surfaces verbatim. */
export class OrgTransferConflictError extends Error {
  readonly code: OrgTransferConflictCode
  constructor(code: OrgTransferConflictCode, message: string) {
    super(message)
    this.name = 'OrgTransferConflictError'
    this.code = code
  }
}

export type OrgTransferConflictCode =
  | 'ORG_TRANSFER_ACTIVE_EXISTS'
  | 'ORG_TRANSFER_INVALID_STATE'
  | 'ORG_TRANSFER_DRY_RUN_REQUIRED'
  | 'ORG_TRANSFER_DECISIONS_PENDING'
  | 'ORG_TRANSFER_ADAPTER_UNAVAILABLE'

export type OrgTransferStatus = 'draft' | 'scanned' | 'applying' | 'applied' | 'cancelled' | 'failed'

const NON_TERMINAL_STATUSES: readonly OrgTransferStatus[] = ['draft', 'scanned', 'applying', 'failed']
const SCANNABLE_STATUSES: readonly OrgTransferStatus[] = ['draft', 'scanned', 'failed']

export interface OrgTransferSummary {
  id: string
  orgId: string
  provider: string
  sourceIntegrationId: string
  targetIntegrationId: string
  status: OrgTransferStatus
  freezeSourceSync: boolean
  dryRunStats: Record<string, unknown>
  dryRunAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  scannedAt: string | null
  appliedAt: string | null
  cancelledAt: string | null
  lastError: string | null
}

interface OrgTransferRow {
  id: string
  org_id: string
  provider: string
  source_integration_id: string
  target_integration_id: string
  status: OrgTransferStatus
  freeze_source_sync: boolean
  dry_run_stats: Record<string, unknown>
  dry_run_at: Date | string | null
  created_by: string | null
  created_at: Date | string
  updated_at: Date | string
  scanned_at: Date | string | null
  applied_at: Date | string | null
  cancelled_at: Date | string | null
  last_error: string | null
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toSummary(row: OrgTransferRow): OrgTransferSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    sourceIntegrationId: row.source_integration_id,
    targetIntegrationId: row.target_integration_id,
    status: row.status,
    freezeSourceSync: row.freeze_source_sync,
    dryRunStats: row.dry_run_stats ?? {},
    dryRunAt: toIso(row.dry_run_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
    scannedAt: toIso(row.scanned_at),
    appliedAt: toIso(row.applied_at),
    cancelledAt: toIso(row.cancelled_at),
    lastError: row.last_error,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

const TRANSFER_COLUMNS =
  'id, org_id, provider, source_integration_id, target_integration_id, status, freeze_source_sync, ' +
  'dry_run_stats, dry_run_at, created_by, created_at, updated_at, scanned_at, applied_at, cancelled_at, last_error'

// ---------------------------------------------------------------------------------------------
// Binding adapter seam (T3/T4 register provider adapters)
// ---------------------------------------------------------------------------------------------

/** A provider binding surfaced by scan — becomes one decision row. */
export interface ScannedOrgTransferBinding {
  bindingKind: string
  sourceAnchorType: string
  sourceAnchorId: string
  /** Masked provider metadata ONLY — never raw secrets (§7.2). */
  sourceHandle: Record<string, unknown>
}

export interface OrgTransferBindingAdapter {
  /** Enumerate the source integration's bindings that a transfer must decide on. */
  scanBindings(transfer: OrgTransferSummary): Promise<ScannedOrgTransferBinding[]>
  /**
   * Apply decided decisions. The explicit test-registered no-op performs no writes; T3/T4
   * implementations receive the transfer and do their own per-decision transactional work.
   */
  applyDecisions(transfer: OrgTransferSummary): Promise<{ applied: number }>
}

/**
 * Explicit no-op — scan finds nothing, apply touches nothing.
 * NOT a production fallback: only reachable via `registerOrgTransferAdapter` (tests / future
 * deliberate wiring). Production scan/apply on an unregistered provider fails closed with
 * `ORG_TRANSFER_ADAPTER_UNAVAILABLE`.
 */
export const noopOrgTransferAdapter: OrgTransferBindingAdapter = {
  async scanBindings(): Promise<ScannedOrgTransferBinding[]> {
    return []
  },
  async applyDecisions(): Promise<{ applied: number }> {
    return { applied: 0 }
  },
}

const adapterRegistry = new Map<string, OrgTransferBindingAdapter>()

/** T3/T4 (and tests) register adapters per provider. There is no silent no-op fallback. */
export function registerOrgTransferAdapter(provider: string, adapter: OrgTransferBindingAdapter): void {
  adapterRegistry.set(provider, adapter)
}

/**
 * Remove a previously registered adapter. Tests MUST call this in deterministic cleanup
 * (afterEach / afterAll) so registry state cannot leak across suites.
 */
export function unregisterOrgTransferAdapter(provider: string): void {
  adapterRegistry.delete(provider)
}

/**
 * Resolve the binding adapter for a provider. Fail-closed: missing registration throws a typed
 * conflict so scan/apply leave the transfer row, decisions, and success audits untouched.
 */
function adapterFor(provider: string): OrgTransferBindingAdapter {
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new OrgTransferConflictError(
      'ORG_TRANSFER_ADAPTER_UNAVAILABLE',
      `no org-transfer binding adapter is registered for provider ${provider}`
    )
  }
  return adapter
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

export interface CreateOrgTransferInput {
  provider: string
  sourceIntegrationId: string
  targetIntegrationId: string
  createdBy: string
}

interface IntegrationEndRow {
  id: string
  org_id: string
  provider: string
  corp_id: string | null
}

export async function createOrgTransfer(input: CreateOrgTransferInput): Promise<OrgTransferSummary> {
  const provider = input.provider.trim()
  if (provider.length === 0) {
    throw new OrgTransferValidationError('provider is required')
  }
  if (provider === 'local') {
    throw new OrgTransferValidationError('a transfer moves between external provider tenants; provider cannot be local')
  }
  if (input.sourceIntegrationId === input.targetIntegrationId) {
    throw new OrgTransferValidationError('source and target integrations must differ')
  }

  const ends = await query<IntegrationEndRow>(
    `SELECT id, org_id, provider, corp_id FROM directory_integrations WHERE id = ANY($1::uuid[])`,
    [[input.sourceIntegrationId, input.targetIntegrationId]]
  )
  const source = ends.rows.find((r) => r.id === input.sourceIntegrationId)
  const target = ends.rows.find((r) => r.id === input.targetIntegrationId)
  if (!source) throw new OrgTransferNotFoundError('source integration not found')
  if (!target) throw new OrgTransferNotFoundError('target integration not found')
  if (source.provider !== provider || target.provider !== provider) {
    throw new OrgTransferValidationError('both integrations must belong to the requested provider')
  }
  if (source.org_id !== target.org_id) {
    throw new OrgTransferValidationError('source and target integrations must belong to the same org')
  }

  try {
    const inserted = await query<OrgTransferRow>(
      `INSERT INTO provider_org_transfers
         (org_id, provider, source_integration_id, target_integration_id, source_tenant_key, target_tenant_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${TRANSFER_COLUMNS}`,
      [source.org_id, provider, source.id, target.id, source.corp_id, target.corp_id, input.createdBy]
    )
    return toSummary(inserted.rows[0])
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_ACTIVE_EXISTS',
        'an active transfer already exists for this source integration'
      )
    }
    throw error
  }
}

export interface OrgTransferDetail {
  transfer: OrgTransferSummary
  decisionCounts: { total: number; pending: number }
}

export async function getOrgTransfer(transferId: string): Promise<OrgTransferDetail> {
  const result = await query<OrgTransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM provider_org_transfers WHERE id = $1`,
    [transferId]
  )
  if (result.rows.length === 0) throw new OrgTransferNotFoundError('transfer not found')
  const counts = await query<{ total: string; pending: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE decision = 'pending')::text AS pending
       FROM provider_org_transfer_decisions WHERE transfer_id = $1`,
    [transferId]
  )
  return {
    transfer: toSummary(result.rows[0]),
    decisionCounts: {
      total: Number(counts.rows[0].total),
      pending: Number(counts.rows[0].pending),
    },
  }
}

/** Locks the transfer row inside the caller's transaction; 404s when missing. */
async function lockTransfer(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  transferId: string
): Promise<OrgTransferRow> {
  const result = await client.query(
    `SELECT ${TRANSFER_COLUMNS} FROM provider_org_transfers WHERE id = $1 FOR UPDATE`,
    [transferId]
  )
  const rows = result.rows as OrgTransferRow[]
  if (rows.length === 0) throw new OrgTransferNotFoundError('transfer not found')
  return rows[0]
}

export interface ScanOrgTransferResult {
  transfer: OrgTransferSummary
  decisionCounts: { total: number; pending: number }
}

export async function scanOrgTransfer(transferId: string): Promise<ScanOrgTransferResult> {
  return transaction(async (client) => {
    const row = await lockTransfer(client, transferId)
    if (!SCANNABLE_STATUSES.includes(row.status)) {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_INVALID_STATE',
        `transfer cannot be scanned from status ${row.status}`
      )
    }

    const bindings = await adapterFor(row.provider).scanBindings(toSummary(row))

    // Regenerate the decision set atomically with the status flip; a re-scan invalidates any
    // earlier dry-run (dry_run_at ← NULL) so apply's §12.3 guard is scan-relative.
    await client.query(`DELETE FROM provider_org_transfer_decisions WHERE transfer_id = $1`, [transferId])
    for (const binding of bindings) {
      await client.query(
        `INSERT INTO provider_org_transfer_decisions
           (transfer_id, binding_kind, source_anchor_type, source_anchor_id, source_handle)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [transferId, binding.bindingKind, binding.sourceAnchorType, binding.sourceAnchorId, JSON.stringify(binding.sourceHandle)]
      )
    }

    const updated = await client.query(
      `UPDATE provider_org_transfers
          SET status = 'scanned', scanned_at = now(), dry_run_stats = '{}'::jsonb, dry_run_at = NULL,
              last_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${TRANSFER_COLUMNS}`,
      [transferId]
    )
    return {
      transfer: toSummary((updated.rows as OrgTransferRow[])[0]),
      decisionCounts: { total: bindings.length, pending: bindings.length },
    }
  })
}

export interface DryRunOrgTransferResult {
  transfer: OrgTransferSummary
  stats: { bindings: number; decisions: number; pending: number }
}

export async function dryRunOrgTransfer(transferId: string): Promise<DryRunOrgTransferResult> {
  return transaction(async (client) => {
    const row = await lockTransfer(client, transferId)
    if (row.status !== 'scanned') {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_INVALID_STATE',
        `transfer cannot be dry-run from status ${row.status}`
      )
    }

    const counts = await client.query(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE decision = 'pending')::text AS pending
         FROM provider_org_transfer_decisions WHERE transfer_id = $1`,
      [transferId]
    )
    const countRow = (counts.rows as Array<{ total: string; pending: string }>)[0]
    const stats = {
      bindings: Number(countRow.total),
      decisions: Number(countRow.total),
      pending: Number(countRow.pending),
    }

    const updated = await client.query(
      `UPDATE provider_org_transfers
          SET dry_run_stats = $2::jsonb, dry_run_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING ${TRANSFER_COLUMNS}`,
      [transferId, JSON.stringify(stats)]
    )
    return { transfer: toSummary((updated.rows as OrgTransferRow[])[0]), stats }
  })
}

export async function applyOrgTransfer(transferId: string): Promise<OrgTransferSummary> {
  return transaction(async (client) => {
    const row = await lockTransfer(client, transferId)
    if (row.status !== 'scanned') {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_INVALID_STATE',
        `transfer cannot be applied from status ${row.status}`
      )
    }
    // §12.3: dry-run required, and scan-relative (scan clears dry_run_at).
    if (row.dry_run_at === null) {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_DRY_RUN_REQUIRED',
        'a dry-run is required after the latest scan before apply'
      )
    }
    const undecided = await client.query(
      `SELECT count(*)::text AS pending
         FROM provider_org_transfer_decisions
        WHERE transfer_id = $1 AND decision = 'pending'`,
      [transferId]
    )
    if (Number((undecided.rows as Array<{ pending: string }>)[0].pending) > 0) {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_DECISIONS_PENDING',
        'all scanned bindings must be decided before apply'
      )
    }

    // With a registered no-op, apply commits zero decisions and writes nothing; 'applying' never
    // becomes observable because the flip to 'applied' commits in this same transaction (see header).
    // Missing adapter throws before this write — state stays scanned.
    await adapterFor(row.provider).applyDecisions(toSummary(row))

    const updated = await client.query(
      `UPDATE provider_org_transfers
          SET status = 'applied', applied_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${TRANSFER_COLUMNS}`,
      [transferId]
    )
    return toSummary((updated.rows as OrgTransferRow[])[0])
  })
}

export async function cancelOrgTransfer(transferId: string): Promise<OrgTransferSummary> {
  return transaction(async (client) => {
    const row = await lockTransfer(client, transferId)
    if (!NON_TERMINAL_STATUSES.includes(row.status)) {
      throw new OrgTransferConflictError(
        'ORG_TRANSFER_INVALID_STATE',
        `transfer cannot be cancelled from terminal status ${row.status}`
      )
    }
    const updated = await client.query(
      `UPDATE provider_org_transfers
          SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING ${TRANSFER_COLUMNS}`,
      [transferId]
    )
    return toSummary((updated.rows as OrgTransferRow[])[0])
  })
}
