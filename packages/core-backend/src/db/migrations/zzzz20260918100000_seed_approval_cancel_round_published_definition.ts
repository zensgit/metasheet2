/**
 * Approval change-request design lock v5.9 §4 — first-slice DDL/seed, item 2 of 3 (WI-2/WI-14,
 * impl-taskbook-C-change-request-20260918.md): the "专用「撤销审批」已发布定义" seed chain.
 *
 * Inserts exactly one `approval_templates` row, one `approval_template_versions` row, and one
 * `approval_published_definitions` row — the fixture the cancel-round creation path (WI-4,
 * `ApprovalCancelRoundService.ts` — a different work item, not this migration) points
 * `approval_instances.published_definition_id` at. `approval_published_definitions.template_id` /
 * `template_version_id` are `NOT NULL` (`zzzz20260411120100_approval_templates_and_instance_extensions.ts:42-43`),
 * so the three rows must land in template -> version -> published-definition order.
 *
 * Content (graph shape, `RuntimePolicy`, node config) lives in
 * `../seeds/approval-cancel-round-published-definition.ts` — pure data, no DB access — so this
 * migration and any later test fixture helper share one definition instead of two hand-copied
 * JSON literals drifting apart. See that module's doc comment for the lock citations behind each
 * pinned value (`allowRevoke`, absent `revokeBeforeNodeKeys`, explicit `commentRequired`,
 * `approvalMode: 'all'`, the `requester_choice` assignee-source design choice).
 *
 * Idempotent by fixed literal id (`ON CONFLICT (id) DO NOTHING`, mirroring the fixed-`roles.id`
 * precedent in `zzzz20260826140000_add_elearning_role_templates.ts`) — safe to re-run against an
 * environment that already carries this migration's effects. Like that precedent, `up()` ends
 * with a read-back that verifies the fixed ids actually hold THIS content: `ON CONFLICT DO
 * NOTHING` alone would silently leave a pre-existing row with different content in place (a
 * dev DB that already used one of these low-collision-odds-but-not-zero ids, or a partially
 * hand-edited re-run) and report success while the cancel round quietly runs on the wrong graph.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import {
  buildCancelRoundApprovalGraph,
  buildCancelRoundFormSchema,
  buildCancelRoundRuntimeGraph,
  CANCEL_ROUND_PUBLISHED_DEFINITION_ID,
  CANCEL_ROUND_TEMPLATE_DESCRIPTION,
  CANCEL_ROUND_TEMPLATE_ID,
  CANCEL_ROUND_TEMPLATE_KEY,
  CANCEL_ROUND_TEMPLATE_NAME,
  CANCEL_ROUND_TEMPLATE_VERSION_ID,
} from '../seeds/approval-cancel-round-published-definition'

/**
 * Recursively sorts object keys (array element order is left untouched) so two structurally
 * equal values produce identical `JSON.stringify` output regardless of key insertion order.
 * Needed because Postgres's `jsonb` storage does NOT preserve the original key order of an
 * inserted object — reading a `jsonb` column back reorders keys by (length, then lexicographic),
 * confirmed empirically against `metasheet2_lock_c_u1` (`edges`/`nodes`/`policy` came back
 * alphabetically; `key`/`name`/`type`/`config` came back length-then-lexicographic) — so a plain
 * `JSON.stringify(insertedObject) === JSON.stringify(readBackObject)` comparison would fail on
 * every correct round trip, not just a genuine mismatch.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const expectedRuntimeGraph = buildCancelRoundRuntimeGraph()
  const approvalGraphJson = JSON.stringify(buildCancelRoundApprovalGraph())
  const formSchemaJson = JSON.stringify(buildCancelRoundFormSchema())
  const runtimeGraphJson = JSON.stringify(expectedRuntimeGraph)

  await sql`
    INSERT INTO approval_templates (id, key, name, description, status)
    VALUES (
      ${CANCEL_ROUND_TEMPLATE_ID},
      ${CANCEL_ROUND_TEMPLATE_KEY},
      ${CANCEL_ROUND_TEMPLATE_NAME},
      ${CANCEL_ROUND_TEMPLATE_DESCRIPTION},
      'published'
    )
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    INSERT INTO approval_template_versions (id, template_id, version, status, form_schema, approval_graph)
    VALUES (
      ${CANCEL_ROUND_TEMPLATE_VERSION_ID},
      ${CANCEL_ROUND_TEMPLATE_ID},
      1,
      'published',
      ${formSchemaJson}::jsonb,
      ${approvalGraphJson}::jsonb
    )
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await sql`
    UPDATE approval_templates
       SET active_version_id = ${CANCEL_ROUND_TEMPLATE_VERSION_ID},
           latest_version_id = ${CANCEL_ROUND_TEMPLATE_VERSION_ID},
           updated_at = now()
     WHERE id = ${CANCEL_ROUND_TEMPLATE_ID}
       AND (active_version_id IS DISTINCT FROM ${CANCEL_ROUND_TEMPLATE_VERSION_ID}
         OR latest_version_id IS DISTINCT FROM ${CANCEL_ROUND_TEMPLATE_VERSION_ID})
  `.execute(db)

  await sql`
    INSERT INTO approval_published_definitions (id, template_id, template_version_id, runtime_graph, is_active, published_at)
    VALUES (
      ${CANCEL_ROUND_PUBLISHED_DEFINITION_ID},
      ${CANCEL_ROUND_TEMPLATE_ID},
      ${CANCEL_ROUND_TEMPLATE_VERSION_ID},
      ${runtimeGraphJson}::jsonb,
      TRUE,
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `.execute(db)

  await verifySeedRowsMatchExpected(db, { runtimeGraph: expectedRuntimeGraph })
}

/**
 * Read-back guard (mirrors `lockCanonicalRoles`'s post-insert check in
 * `zzzz20260826140000_add_elearning_role_templates.ts:70-86`): `ON CONFLICT (id) DO NOTHING`
 * makes the three inserts above idempotent, but idempotent-and-silent is not the same as
 * idempotent-and-correct — a pre-existing row at one of these fixed ids with DIFFERENT content
 * would let the inserts no-op and this migration report success while the cancel-round creation
 * path is pointed at the wrong graph. Fail loudly instead of leaving that undetectable.
 */
async function verifySeedRowsMatchExpected(
  db: Kysely<unknown>,
  expected: { runtimeGraph: unknown },
): Promise<void> {
  const result = await sql<{
    template_key: string
    template_status: string
    active_version_id: string | null
    latest_version_id: string | null
    published_template_id: string
    published_template_version_id: string
    is_active: boolean
    runtime_graph: unknown
  }>`
    SELECT
      t.key AS template_key,
      t.status AS template_status,
      t.active_version_id,
      t.latest_version_id,
      pd.template_id AS published_template_id,
      pd.template_version_id AS published_template_version_id,
      pd.is_active,
      pd.runtime_graph
    FROM approval_published_definitions pd
    JOIN approval_templates t ON t.id = pd.template_id
    WHERE pd.id = ${CANCEL_ROUND_PUBLISHED_DEFINITION_ID}
  `.execute(db)

  const row = result.rows[0]
  const ok =
    row !== undefined &&
    row.template_key === CANCEL_ROUND_TEMPLATE_KEY &&
    row.template_status === 'published' &&
    row.active_version_id === CANCEL_ROUND_TEMPLATE_VERSION_ID &&
    row.latest_version_id === CANCEL_ROUND_TEMPLATE_VERSION_ID &&
    row.published_template_id === CANCEL_ROUND_TEMPLATE_ID &&
    row.published_template_version_id === CANCEL_ROUND_TEMPLATE_VERSION_ID &&
    row.is_active === true &&
    canonicalJson(row.runtime_graph) === canonicalJson(expected.runtimeGraph)

  if (!ok) {
    throw new Error(
      'approval cancel-round published-definition seed identifier conflict: ' +
        `fixed id ${CANCEL_ROUND_PUBLISHED_DEFINITION_ID} (or a row it references) already holds ` +
        'content different from this migration\'s expected seed — aborting rather than running ' +
        'the cancel round against an unknown graph',
    )
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM approval_published_definitions WHERE id = ${CANCEL_ROUND_PUBLISHED_DEFINITION_ID}`.execute(db)
  // Deleting the version row auto-nulls approval_templates.active_version_id/latest_version_id
  // via the existing ON DELETE SET NULL FKs (approval_templates_active_version_fk /
  // approval_templates_latest_version_fk, zzzz20260411120100:71-90) -- no separate UPDATE needed.
  await sql`DELETE FROM approval_template_versions WHERE id = ${CANCEL_ROUND_TEMPLATE_VERSION_ID}`.execute(db)
  await sql`DELETE FROM approval_templates WHERE id = ${CANCEL_ROUND_TEMPLATE_ID}`.execute(db)
}
