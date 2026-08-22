/**
 * SPIKE 3 — External key registry: pure-function prototype (DESIGN SPIKE, not wired).
 *
 * Baseline: main @ c5a4a94f7 (2026-08-20). This file is NOT imported by any
 * production code path. It illustrates the core normalization / classification
 * / collapse-detection logic that `meta_record_external_keys` (see
 * spike3-registry-migration.draft.sql) is built around, so the shapes below
 * mirror the columns of that draft table 1:1 — no DB access, no I/O.
 *
 * Context this was grounded against:
 *   - packages/core-backend/migrations/057_create_integration_core_tables.sql:1-14
 *     documents that K3 WISE / Yuantus PLM external-system identifiers
 *     (org_id, account_set_id, ...) live in `integration_external_systems.config`
 *     JSONB rather than dedicated columns — the same "don't special-case one
 *     ERP" posture is followed here: normalization is versioned and pluggable,
 *     not schema-baked per source system.
 *   - packages/core-backend/src/multitable/provisioning.ts:130-136 `stableMetaId`
 *     — precedent for deterministic, prefix-tagged, truncated-hash TEXT ids
 *     used elsewhere in this codebase; `newExternalKeyId` below follows the
 *     same shape for consistency (registry ids are still DB-generated in the
 *     real implementation — see ADR "id generation").
 *   - packages/core-backend/src/attendance/w4c0-fingerprints.ts:37-82
 *     `canonicalAttendanceJsonV1` — precedent in this codebase for a strict,
 *     versioned canonical-form + domain-separated sha256 digest pattern.
 *     `normalizedKeyHash` below follows the same "hash the canonical form,
 *     never the raw form" discipline.
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types — mirror meta_record_external_keys columns (see migration .draft.sql)
// ---------------------------------------------------------------------------

/** Normalization rule-set version. Closed enumeration — see ADR "versioning". */
export type NormalizationVersion = 'v1' | 'v2'

export const KNOWN_NORMALIZATION_VERSIONS: readonly NormalizationVersion[] = ['v1', 'v2']

export interface ExternalKeyRow {
  /** meta_record_external_keys.id */
  id: string
  /** meta_record_external_keys.record_id -> meta_records.id */
  recordId: string
  /** meta_record_external_keys.canonical_key */
  canonicalKey: string
  /** meta_record_external_keys.normalized_key_hash (sha256 hex of canonicalKey) */
  normalizedKeyHash: string
  /** meta_record_external_keys.normalization_version */
  normalizationVersion: NormalizationVersion
  /** meta_record_external_keys.state */
  state: 'active' | 'superseded' | 'collapsed' | 'conflict' | 'retired'
}

export type UpsertClassification =
  | { kind: 'new' }
  | { kind: 'match'; existing: ExternalKeyRow }
  | { kind: 'collision'; existing: ExternalKeyRow }

export interface CollapseGroup {
  newCanonical: string
  /** distinct record_ids whose OLD active rows collapse onto newCanonical */
  recordIds: string[]
  /** ids of the OLD rows that collapse into this group */
  sourceRowIds: string[]
}

export interface CollapseReport {
  /** groups where exactly one distinct record_id landed on the new canonical — safe, auto-migratable */
  safe: CollapseGroup[]
  /** groups where 2+ distinct record_ids landed on the SAME new canonical — must block the generation switch */
  conflicts: CollapseGroup[]
}

// ---------------------------------------------------------------------------
// normalizeKey — pure, versioned, deterministic
// ---------------------------------------------------------------------------

/**
 * v1 rules (initial rollout; matches the M0 "just stop the obvious dupes" bar):
 *   1. NFKC unicode normalize (full-width digits/letters from CJK-locale ERP
 *      clients — e.g. "０００７" — collapse to their half-width form first,
 *      otherwise every later rule silently no-ops on them).
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse any internal whitespace run to a single ASCII space.
 *   4. Uppercase (ASCII + full common Unicode case folding via toUpperCase).
 *
 * v1 deliberately does NOT strip leading zeros — see v2. Splitting that out
 * as its own version is what lets detectCollapse() below demonstrate a real
 * upgrade-induced collapse: "PN-0007" and "PN-7" are DISTINCT under v1 and
 * COLLAPSE to the same v2 canonical key.
 */
function normalizeV1(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase()
}

/**
 * v2 rules = v1 rules, PLUS: strip leading zeros from every maximal run of
 * ASCII digits, keeping at least one digit (e.g. "0007" -> "7",
 * "PN-007B" -> "PN-7B", "0" -> "0", "00" -> "0"). This is the K3 WISE /
 * Yuantus "物料编码前导零" normalization the 057 migration header alludes to
 * (external-system id quirks live in config JSONB, not in this schema — but
 * the NORMALIZATION RULE for them lives here, versioned).
 */
function normalizeV2(raw: string): string {
  const v1 = normalizeV1(raw)
  return v1.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''))
}

/**
 * normalizeKey(raw, version) -> canonical key string.
 *
 * Throws on an unrecognized version rather than silently falling back — a
 * typo'd or future version string must fail loud, not quietly produce a
 * canonical key with unintended rules (which would corrupt uniqueness).
 */
export function normalizeKey(raw: string, version: NormalizationVersion): string {
  if (raw == null) throw new TypeError('normalizeKey: raw key must not be null/undefined')
  switch (version) {
    case 'v1':
      return normalizeV1(raw)
    case 'v2':
      return normalizeV2(raw)
    default: {
      const exhaustive: never = version
      throw new RangeError(`normalizeKey: unknown normalization_version ${String(exhaustive)}`)
    }
  }
}

/** sha256 hex of the canonical key. This is the DB index bucket, never the uniqueness proof by itself — see classifyUpsert. */
export function hashCanonicalKey(canonicalKey: string): string {
  return createHash('sha256').update(canonicalKey, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// classifyUpsert — decide new / match / collision for one incoming key
// ---------------------------------------------------------------------------

/**
 * classifyUpsert(existingActiveRows, incomingCanonical, incomingRecordId)
 *
 * `existingActiveRows` is expected to already be scoped to the target
 * registry_generation_id (the real caller does
 * `WHERE registry_generation_id = ? AND state = 'active'` — see migration
 * .draft.sql UNIQUE index comment). This function does NOT trust the hash
 * alone: it always re-derives the hash from the canonical key it's given and
 * then does a full string compare against every row sharing that hash bucket,
 * so two rows that merely COLLIDE on sha256 but have different canonical
 * strings are correctly told apart (acceptance: "hash collision — two
 * distinct canonicals coexist & are distinguishable").
 */
export function classifyUpsert(
  existingActiveRows: readonly ExternalKeyRow[],
  incomingCanonical: string,
  incomingRecordId: string,
): UpsertClassification {
  const incomingHash = hashCanonicalKey(incomingCanonical)

  // Full compare, not hash-only: this is what makes hash collisions safe.
  const exactMatch = existingActiveRows.find(
    (row) => row.normalizedKeyHash === incomingHash && row.canonicalKey === incomingCanonical,
  )

  if (!exactMatch) return { kind: 'new' }
  if (exactMatch.recordId === incomingRecordId) return { kind: 'match', existing: exactMatch }
  return { kind: 'collision', existing: exactMatch }
}

// ---------------------------------------------------------------------------
// detectCollapse — offline rebuild-time analysis for a normalization upgrade
// ---------------------------------------------------------------------------

export interface OldRowForCollapseCheck {
  id: string
  recordId: string
  /** the ORIGINAL raw key as ingested from the source system, not the old canonical form */
  rawKey: string
}

/**
 * detectCollapse(oldRows, newVersion)
 *
 * Simulates rebuilding the registry under `newVersion` WITHOUT touching the
 * database: re-normalizes every old row's rawKey under the candidate
 * normalizer and groups the results by new canonical key. Used by the
 * "freeze old gen -> rebuild -> detect collapse/conflict -> migration report
 * -> atomic switch" upgrade flow (ADR §Decision) to produce the migration
 * report BEFORE any generation-switch DDL/DML runs.
 *
 * A group is a `conflict` when 2+ DISTINCT record_ids collapse onto the same
 * new canonical key (two previously-independent records would now compete
 * for one active-key slot — this MUST block the atomic switch and needs
 * human resolution). A group is `safe` when only one distinct record_id is
 * involved, even if that record had multiple old key rows collapsing
 * together (e.g. a record with two historical/superseded keys that both
 * happen to normalize to the same new canonical — harmless merge).
 */
export function detectCollapse(
  oldRows: readonly OldRowForCollapseCheck[],
  newVersion: NormalizationVersion,
): CollapseReport {
  const groups = new Map<string, CollapseGroup>()

  for (const row of oldRows) {
    const newCanonical = normalizeKey(row.rawKey, newVersion)
    let group = groups.get(newCanonical)
    if (!group) {
      group = { newCanonical, recordIds: [], sourceRowIds: [] }
      groups.set(newCanonical, group)
    }
    if (!group.recordIds.includes(row.recordId)) group.recordIds.push(row.recordId)
    group.sourceRowIds.push(row.id)
  }

  const safe: CollapseGroup[] = []
  const conflicts: CollapseGroup[] = []
  for (const group of groups.values()) {
    if (group.recordIds.length > 1) conflicts.push(group)
    else safe.push(group)
  }

  return { safe, conflicts }
}

// ---------------------------------------------------------------------------
// Id generation helper (illustrative only — real impl generates in SQL/app layer)
// ---------------------------------------------------------------------------

/**
 * Deterministic id shape matching the `stableMetaId` precedent at
 * provisioning.ts:130-136 (prefix_<24-hex-char-sha1>, capped at 50 chars).
 * NOT used for the primary key of meta_record_external_keys in the draft
 * migration (that uses gen_random_uuid()::text, matching meta_records.id at
 * zzz20251231_create_meta_schema.ts:46) — included here only to show how a
 * caller could derive a stable per-(binding, canonical) id for idempotent
 * client-side retries, which the ADR "open questions" section flags as an
 * unresolved question for the real implementation.
 */
export function stableExternalKeyId(bindingId: string, registryGenerationId: string, canonicalKey: string): string {
  const digest = createHash('sha1').update([bindingId, registryGenerationId, canonicalKey].join(':')).digest('hex').slice(0, 24)
  return `xkey_${digest}`.slice(0, 50)
}
