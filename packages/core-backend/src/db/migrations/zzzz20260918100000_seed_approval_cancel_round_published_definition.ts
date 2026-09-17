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
 * environment that already carries this migration's effects.
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

export async function up(db: Kysely<unknown>): Promise<void> {
  const approvalGraphJson = JSON.stringify(buildCancelRoundApprovalGraph())
  const formSchemaJson = JSON.stringify(buildCancelRoundFormSchema())
  const runtimeGraphJson = JSON.stringify(buildCancelRoundRuntimeGraph())

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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM approval_published_definitions WHERE id = ${CANCEL_ROUND_PUBLISHED_DEFINITION_ID}`.execute(db)
  // Deleting the version row auto-nulls approval_templates.active_version_id/latest_version_id
  // via the existing ON DELETE SET NULL FKs (approval_templates_active_version_fk /
  // approval_templates_latest_version_fk, zzzz20260411120100:71-90) -- no separate UPDATE needed.
  await sql`DELETE FROM approval_template_versions WHERE id = ${CANCEL_ROUND_TEMPLATE_VERSION_ID}`.execute(db)
  await sql`DELETE FROM approval_templates WHERE id = ${CANCEL_ROUND_TEMPLATE_ID}`.execute(db)
}
