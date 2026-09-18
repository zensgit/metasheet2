/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 service layer.
 *
 * Owns every write to `approval_template_groups` / `approval_template_group_links` (§2 DDL,
 * `zzzz20260918090000_create_approval_template_groups.ts`). Every exported function takes `orgId`
 * as an explicit, required, caller-supplied parameter — same convention as
 * `directory/local-directory-org.ts` — this module never reads `req` and never defaults the org;
 * the route layer resolves `orgId` from `req.authenticatedTenantId` ONLY (§2 "org 从哪来" / A‴)
 * and this file trusts whatever it is handed.
 *
 * Lock order (§2 锁序表), enforced by which statements each function issues and in what order:
 *   L0 = pg_advisory_xact_lock(hashtext('atg:' || org)); L1 = approval_template_groups row FOR
 *   UPDATE; L2 = approval_template_group_links row (upsert / UPDATE, implicit).
 *   create: L0. rename: L0→L1. archive: L0→L1→L2 (batch). unarchive: L0→L1. link: L1→L2 (no L0 —
 *   only-read-for-uniqueness/sort-order paths take L0, and linking does neither). unlink: L2 only
 *   (independent UPDATE, primary-key row lock suffices).
 *
 * `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` is the FIRST statement after BEGIN in every
 * L0-taking transaction (§2: a later SET aborts the transaction under a REPEATABLE READ default
 * pool with 25001; a bare RR snapshot taken by the advisory-lock SELECT itself would still see a
 * stale MAX(sort_order) after waiting on the lock — RACE-B2 in the lock's verification history).
 *
 * The seven error codes this lock introduces are ALL raised here (as `ServiceError`, imported from
 * `ApprovalBridgeService.ts` — the SAME class `routes/approvals.ts`'s `handleApprovalsError` /
 * `sendServiceError` already special-case) except `ORG_ID_NOT_ACCEPTED` / `SESSION_ORG_REQUIRED`,
 * which are pure request-shape concerns the route layer owns before it ever calls into this file:
 *   GROUP_NOT_FOUND (404) · GROUP_ARCHIVED (409) · GROUP_NAME_TAKEN (409) · GROUP_NOT_ARCHIVED
 *   (409) · GROUP_SORT_CONFLICT (500, §2 DEFERRABLE side effect ③ — a COMMIT-time 23505 on
 *   `atg_sort_unique`, not a statement-time one). "ALL" above means all of the lock's ratified
 *   domain codes; `requireName` below also raises `GROUP_NAME_REQUIRED` (400), an implementer's
 *   input-shape validation (same footing as this router's `APPROVAL_GROUP_ID_REQUIRED` /
 *   `APPROVAL_ACTOR_REQUIRED`), not an eighth ratified outcome.
 *
 * `GROUP_ARCHIVED` on re-archiving an already-archived group is this implementer's choice, not
 * lock text: the lock defines archive-of-an-already-archived-group behaviour nowhere and no
 * acceptance row exercises it. Reusing the SAME code the lock already assigns to the link-time
 * "this group is archived" case (rather than inventing an eighth code) reads correctly for both
 * the link-time and archive-time occurrences of the same underlying fact.
 *
 * `GROUP_NAME_UNSUPPORTED` (400, added in the design-gate-A3 回流修复 round, 2026-09-18) is
 * likewise an implementer's request-shape mapping, not a ninth ratified code — see
 * `mapGroupConstraintError`'s doc comment. It exists ONLY because the ratified §2 non-blank CHECKs
 * reject non-ASCII input; it does not widen, and must not be read as widening, what those CHECKs
 * accept.
 */

import { randomUUID } from 'node:crypto'
import { query, transaction } from '../db/pg'
import { ServiceError } from './ApprovalBridgeService'

export interface ApprovalTemplateGroupRow {
  id: string
  orgId: string
  name: string
  sortOrder: number | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface ApprovalTemplateGroupLinkRow {
  orgId: string
  templateId: string
  groupId: string | null
  linkedBy: string
  linkedAt: string
  unlinkedAt: string | null
}

interface RawGroupRow {
  id: string
  org_id: string
  name: string
  sort_order: number | string | null
  created_by: string
  created_at: string | Date
  updated_at: string | Date
  archived_at: string | Date | null
}

interface RawLinkRow {
  org_id: string
  template_id: string
  group_id: string | null
  linked_by: string
  linked_at: string | Date
  unlinked_at: string | Date | null
}

const GROUP_COLUMNS = 'id, org_id, name, sort_order, created_by, created_at, updated_at, archived_at'
const LINK_COLUMNS = 'org_id, template_id, group_id, linked_by, linked_at, unlinked_at'

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value)
}

function mapGroupRow(row: RawGroupRow): ApprovalTemplateGroupRow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archivedAt: toIsoOrNull(row.archived_at),
  }
}

function mapLinkRow(row: RawLinkRow): ApprovalTemplateGroupLinkRow {
  return {
    orgId: row.org_id,
    templateId: row.template_id,
    groupId: row.group_id,
    linkedBy: row.linked_by,
    linkedAt: toIso(row.linked_at),
    unlinkedAt: toIsoOrNull(row.unlinked_at),
  }
}

function newGroupId(): string {
  return `atg_${randomUUID()}`
}

/**
 * Design-gate A-3 (`design-gate-A3-phase2-20260918.md`, P1-3, real-DB-measured M5): the lock's §2
 * non-blank CHECKs (`atg_name_nonblank`, `atg_org_nonblank`, `atgl_org_nonblank`) are
 * `CHECK (col ~ '[!-~]')` — printable-ASCII-only, copied verbatim from
 * `zzzz20260715210000_create_approval_attachments.ts:22-25`, where it guards two IDENTIFIER
 * columns, never a human-typed display name. Applied to `name` it rejects every pure-CJK group
 * name (`'人事' ~ '[!-~]'` = false; measured), which is the product's OWN placeholder text
 * (`TemplateAuthoringView.vue:221`: "如 请假 / 采购 / 报销") — so unmapped, this was a raw
 * `DatabaseError` (code 23514, statusCode undefined) reaching `handleApprovalsError`'s generic-500
 * fallback (it only special-cases `ServiceError`), on the exact endpoint this row's create handler
 * serves. `org_id`'s two occurrences are defense-in-depth only — the route layer already 403s a
 * blank `req.authenticatedTenantId` before any call into this file (§2 "org 从哪来" / A‴) — mapped
 * anyway so any other caller of these exported functions gets a typed 400, not a DB leak.
 */
const NONBLANK_CHECK_CONSTRAINTS = new Set(['atg_name_nonblank', 'atg_org_nonblank', 'atgl_org_nonblank'])

/**
 * Maps raw PostgreSQL constraint violations onto the lock's typed `ServiceError`s:
 *  - 23505 (unique_violation) — whether raised at statement time (the IMMEDIATE
 *    `uq_atg_org_name_active` partial index) or at COMMIT time (the DEFERRABLE
 *    `atg_sort_unique`). `error.constraint` (not just `error.code`) is the discriminator: a
 *    same-name concurrent write can hit the immediate name index first even when the caller's
 *    intent was a sort-order collision (§2 / acceptance E, "同名行会先撞立即唯一索引").
 *  - 23514 (check_violation) on one of `NONBLANK_CHECK_CONSTRAINTS` — see the block comment above.
 *    This is a REQUEST-SHAPE mapping, not a loosening of the CHECK: the constraint itself is a
 *    RATIFIED §2 clause and only an owner-approved lock erratum can widen it (this slice's
 *    verification MD carries the "owner 勘误请示": `CHECK (btrim(name) <> '')`). Until that lands,
 *    a pure-CJK (or otherwise non-printable-ASCII) name still cannot be created — this function's
 *    only job is to stop the raw DB error from leaking through as an undifferentiated 500.
 * Anything else (including an already-typed `ServiceError` thrown deeper in the same transaction,
 * e.g. GROUP_NOT_FOUND/GROUP_ARCHIVED) passes through unchanged.
 */
function mapGroupConstraintError(error: unknown): unknown {
  if (error instanceof ServiceError) return error
  const pgErr = error as { code?: unknown; constraint?: unknown } | null
  if (pgErr && typeof pgErr === 'object' && pgErr.code === '23505') {
    if (pgErr.constraint === 'uq_atg_org_name_active') {
      return new ServiceError('An active group with this name already exists', 409, 'GROUP_NAME_TAKEN')
    }
    if (pgErr.constraint === 'atg_sort_unique') {
      return new ServiceError('Group sort order conflict', 500, 'GROUP_SORT_CONFLICT')
    }
  }
  if (
    pgErr
    && typeof pgErr === 'object'
    && pgErr.code === '23514'
    && typeof pgErr.constraint === 'string'
    && NONBLANK_CHECK_CONSTRAINTS.has(pgErr.constraint)
  ) {
    return new ServiceError(
      '当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误',
      400,
      'GROUP_NAME_UNSUPPORTED',
      { constraint: pgErr.constraint },
    )
  }
  return error
}

// BEGIN → SET TRANSACTION ISOLATION LEVEL READ COMMITTED (first statement, unconditionally) →
// pg_advisory_xact_lock(hashtext('atg:' + org)) (L0) → caller body. Issued as the first two
// statements inside each L0-taking function's own `transaction(...)` call below (inlined at each
// call site — same convention as `directory/local-directory-org.ts`'s reparent transaction, which
// does not factor this pair out into a shared wrapper either — so each call site's statement
// ORDER is visible at the call site itself). See file header for why the SET's position is
// load-bearing, not decorative.

function requireName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) {
    throw new ServiceError('name is required', 400, 'GROUP_NAME_REQUIRED')
  }
  return trimmed
}

/** Read-only — no lock taken (§2 锁序表: "只读路径不取 L0"). */
export async function listApprovalTemplateGroups(orgId: string): Promise<ApprovalTemplateGroupRow[]> {
  const result = await query<RawGroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM approval_template_groups
      WHERE org_id = $1
      ORDER BY (archived_at IS NOT NULL), sort_order NULLS LAST, archived_at DESC NULLS LAST, name`,
    [orgId],
  )
  return result.rows.map(mapGroupRow)
}

/** L0 only. sort_order = COALESCE(MAX(sort_order), 0) + 1 within the org (archived rows are NULL, MAX ignores them). */
export async function createApprovalTemplateGroup(
  orgId: string,
  name: string,
  createdBy: string,
): Promise<ApprovalTemplateGroupRow> {
  const trimmedName = requireName(name)
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const maxRow = await client.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM approval_template_groups WHERE org_id = $1`,
        [orgId],
      )
      const nextSortOrder = Number((maxRow.rows[0] as { next: number | string })?.next ?? 1)
      const id = newGroupId()
      const inserted = await client.query(
        `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${GROUP_COLUMNS}`,
        [id, orgId, trimmedName, nextSortOrder, createdBy],
      )
      return mapGroupRow(inserted.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/** L0→L1 (§2 v2.5 P1: renaming must take L0, not just L1 — see RACE-C in the lock's history). */
export async function renameApprovalTemplateGroup(
  orgId: string,
  groupId: string,
  name: string,
): Promise<ApprovalTemplateGroupRow> {
  const trimmedName = requireName(name)
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const locked = await client.query(
        `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      const updated = await client.query(
        `UPDATE approval_template_groups SET name = $3, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING ${GROUP_COLUMNS}`,
        [orgId, groupId, trimmedName],
      )
      return mapGroupRow(updated.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L0→L1→L2 (batch). Transactional per I2: lock the group row, unlink every member (an UPDATE,
 * never a DELETE — I2′), THEN clear sort_order and set archived_at. Concurrent link/re-link
 * attempts block on the SAME group row's FOR UPDATE (their own L1 acquire in
 * `linkApprovalTemplateToGroup`) and re-check `archived_at` after this commits (acceptance B).
 */
export async function archiveApprovalTemplateGroup(orgId: string, groupId: string): Promise<ApprovalTemplateGroupRow> {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const locked = await client.query(
        `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      if ((locked.rows[0] as RawGroupRow).archived_at !== null) {
        throw new ServiceError('Group is already archived', 409, 'GROUP_ARCHIVED')
      }

      // I2 / I2′: unlink (UPDATE, not DELETE) every member of this group before archiving it.
      // org_id = $1 is carried here too (every other write/read in this file does — §2 "SELECT
      // 必须带 org 谓词"), even though `atg_<uuid>` ids are already globally unique and the
      // composite `atgl_group_fk` makes a cross-org link row for this exact groupId impossible
      // today: correctness should rest on this predicate, not on an invariant enforced elsewhere.
      await client.query(
        `UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now() WHERE org_id = $1 AND group_id = $2`,
        [orgId, groupId],
      )

      const updated = await client.query(
        `UPDATE approval_template_groups SET archived_at = now(), sort_order = NULL, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING ${GROUP_COLUMNS}`,
        [orgId, groupId],
      )
      return mapGroupRow(updated.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L0→L1 (I8). Members do NOT come back (archiving already unlinked them and there is no history
 * column to restore from — this is Q4's ratified "no" answer, not an oversight). A same-org active
 * name conflict is checked explicitly BEFORE the UPDATE so it surfaces as a clean 409
 * `GROUP_NAME_TAKEN` *before* attempting a write that would fail anyway — the failure mode the
 * lock's G row names for removing this check (an unmapped 500 raw-23505 leak) does NOT reproduce
 * against this file's `mapGroupConstraintError`: that mapper is generic across every caller
 * (create/rename/unarchive), so the immediate `uq_atg_org_name_active` violation this UPDATE would
 * itself raise is caught and mapped to the SAME 409 `GROUP_NAME_TAKEN` regardless (confirmed by
 * mutation-testing this block out — no observable change; the mutation that DOES falsify the 409
 * is removing `mapGroupConstraintError`'s `uq_atg_org_name_active` branch itself, shared with A's
 * own mutation proof). This check therefore is not the SOLE guard, but IS still load-bearing for
 * not attempting a doomed write inside the L0 critical section.
 */
export async function unarchiveApprovalTemplateGroup(orgId: string, groupId: string): Promise<ApprovalTemplateGroupRow> {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const locked = await client.query(
        `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      const row = locked.rows[0] as RawGroupRow
      if (row.archived_at === null) {
        throw new ServiceError('Group is not archived', 409, 'GROUP_NOT_ARCHIVED')
      }

      const conflict = await client.query(
        `SELECT 1 FROM approval_template_groups WHERE org_id = $1 AND name = $2 AND archived_at IS NULL AND id <> $3`,
        [orgId, row.name, groupId],
      )
      if ((conflict.rowCount ?? 0) > 0) {
        throw new ServiceError('An active group with this name already exists', 409, 'GROUP_NAME_TAKEN')
      }

      const maxRow = await client.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM approval_template_groups WHERE org_id = $1`,
        [orgId],
      )
      const nextSortOrder = Number((maxRow.rows[0] as { next: number | string })?.next ?? 1)

      const updated = await client.query(
        `UPDATE approval_template_groups SET archived_at = NULL, sort_order = $3, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING ${GROUP_COLUMNS}`,
        [orgId, groupId, nextSortOrder],
      )
      return mapGroupRow(updated.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L1→L2. First-and-re-link is ONE atomic upsert (v2.3 — a bare UPDATE affects 0 rows on first
 * link with no error; SELECT-then-branch races two concurrent first-links into different groups
 * into a double INSERT 23505). The group row's FOR UPDATE (L1) is taken BEFORE the upsert so a
 * concurrent archive (which also takes L1 on the same row) serializes against this: whichever
 * commits first wins, and the loser's `archived_at IS NULL` check (if it is this function) or its
 * own read of a since-archived row (if it is the archiver reading a since-added link — not
 * possible here since archive runs its unlink UPDATE only after re-checking under its OWN lock)
 * observes the fresh state (acceptance B). No L0: this path neither writes `name` nor assigns
 * `sort_order` (§2 锁序表 invariant).
 */
export async function linkApprovalTemplateToGroup(
  orgId: string,
  templateId: string,
  groupId: string,
  linkedBy: string,
): Promise<ApprovalTemplateGroupLinkRow> {
  try {
    return await transaction(async (client) => {
      const locked = await client.query(
        `SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      if ((locked.rows[0] as { archived_at: string | Date | null }).archived_at !== null) {
        throw new ServiceError('Group is archived', 409, 'GROUP_ARCHIVED')
      }

      const upserted = await client.query(
        `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (org_id, template_id) DO UPDATE SET
           group_id = EXCLUDED.group_id,
           unlinked_at = NULL,
           linked_by = EXCLUDED.linked_by,
           linked_at = EXCLUDED.linked_at
         RETURNING ${LINK_COLUMNS}`,
        [orgId, templateId, groupId, linkedBy],
      )
      return mapLinkRow(upserted.rows[0] as RawLinkRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L2 only — an independent UPDATE, NEVER routed through the upsert (§2: passing `group_id = NULL`
 * into the upsert would hit `atgl_state_check` 23514). Idempotent: 0 rows affected (already
 * unlinked, or never linked at all) is success, not an error (acceptance H).
 */
export async function unlinkApprovalTemplateFromGroup(
  orgId: string,
  templateId: string,
): Promise<{ changed: boolean }> {
  const result = await query(
    `UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now()
       WHERE org_id = $1 AND template_id = $2 AND group_id IS NOT NULL`,
    [orgId, templateId],
  )
  return { changed: (result.rowCount ?? 0) > 0 }
}
