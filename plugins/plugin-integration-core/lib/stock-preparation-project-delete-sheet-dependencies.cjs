'use strict'

const { createHash } = require('node:crypto')

// Some multitable companions deliberately have no FK (notably record trash, history,
// permissions and comments). A recreated project gets the same physical sheet id.
// Scope those companions before removing their owners, including non-FK row metadata on
// shared sheets. Never modify another sheet's references, protected history or audit.
const dedicated = 'r.sheet_id = $1'
const record = `(${dedicated} OR (r.sheet_id, r.record_id) IN (SELECT * FROM affected))`
const comments = `(r.spreadsheet_id = $1 OR (r.spreadsheet_id, r.row_id) IN (SELECT * FROM affected))`
const commentChild = `r.comment_id IN (SELECT r.id FROM meta_comments r WHERE ${comments})`
const targetIds = 'SELECT record_id FROM affected'
const rules = [
  // Children first. Count exact contents before deletion and preserve any history/authority
  // whose owning subsystem forbids partial removal.
  ['meta_record_history_operations', dedicated, 'recovery'],
  ['meta_recovery_archives', dedicated, 'recovery'],
  ['formula_dependencies', 'r.depends_on_sheet_id = $1 AND r.sheet_id <> $1', 'refuse'],
  ['meta_links', `r.foreign_record_id IN (${targetIds}) AND r.record_id NOT IN (${targetIds})`, 'refuse'],
  ['meta_link_tombstones', `r.foreign_record_id IN (${targetIds}) AND r.record_id NOT IN (${targetIds})`, 'refuse'],
  ['multitable_record_approval_submissions', record, 'independent_workflow'],
  ['multitable_ai_bulk_job', dedicated, 'independent_workflow'],
  ['multitable_ai_bulk_job_rows', `EXISTS (SELECT 1 FROM multitable_ai_bulk_job j
      JOIN affected a ON a.sheet_id = j.sheet_id AND a.record_id = r.record_id WHERE j.job_id = r.job_id)`, 'independent_workflow'],
  ['automation_rules', dedicated, 'independent_workflow'],
  ['multitable_automation_suspensions', record + " AND r.status = 'pending'", 'independent_workflow'],
  ['multitable_webhooks', dedicated, 'external_binding'],
  ['multitable_api_tokens', '$1 = ANY(r.sheet_ids) AND r.revoked IS FALSE AND (r.expires_at IS NULL OR r.expires_at >= statement_timestamp())', 'external_binding'],
  ['multitable_attachments', record + ' AND r.blob_purged_at IS NULL', 'attachment'],
  ['meta_recovery_archive_attachment_refs', `r.attachment_id IN (SELECT r.id FROM multitable_attachments r WHERE ${record})`, 'recovery'],
  ['meta_fields', `r.sheet_id <> $1 AND $1 IN (
    r.property->>'foreignSheetId', r.property->>'foreignDatasheetId', r.property->>'datasheetId',
    r.property#>>'{link,foreignSheetId}', r.property#>>'{link,foreignDatasheetId}', r.property#>>'{link,datasheetId}')`, 'refuse'],
  ['attendance_report_projection_anchors', `r.projection_record_id IN (${targetIds})`, 'refuse'],
  ['multitable_attachments', `r.sheet_id IS DISTINCT FROM $1 AND r.field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)`, 'refuse'],
  ['meta_links', `r.field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1) AND r.record_id NOT IN (${targetIds})`, 'refuse'],
  ['meta_comment_reads', commentChild],
  ['meta_comment_reactions', commentChild],
  ['meta_comments', comments],
  ['record_permissions', record],
  ['meta_record_yjs_states', `r.record_id IN (${targetIds})`],
  ['meta_record_yjs_updates', `r.record_id IN (${targetIds})`],
  ['meta_record_subscription_notifications', record],
  ['meta_record_subscriptions', record],
  ['multitable_attachments', record],
  ['multitable_ai_bulk_preview_cache', record],
  ['multitable_button_run_dedup', record],
  ['meta_record_revisions', record, 'history'],
  ['meta_record_version_markers', record, 'history'],
  ['meta_field_value_tombstones', record, 'history'],
  ['meta_link_tombstones', record, 'history'],
  ['meta_config_revisions', dedicated, 'history'],
  // A sibling project's later operation can recover the entire sheet from this checkpoint.
  // Removing even one member would silently change the state reconstructed at that anchor.
  ['meta_history_baselines', record, 'recovery'],
  ['meta_history_trust_checkpoints', dedicated, 'recovery'],
  ['meta_field_retype_conversions', dedicated],
  ['meta_links', `r.record_id IN (${targetIds})`],
  ['formula_dependencies', dedicated],
  ['field_permissions', dedicated],
  ['spreadsheet_permissions', dedicated],
  ['meta_field_auto_number_sequences', dedicated],
  ['multitable_charts', dedicated],
  ['multitable_dashboards', dedicated],
  ['meta_view_permissions', 'r.view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)'],
  ['meta_view_personal_configs', 'r.view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)'],
  ['meta_fields', dedicated],
  ['meta_views', dedicated],
]
const DEPENDENCY_TABLES = [...new Set(rules.map(([table]) => table))]

// The ordinary cleanup path has one fixed write target per deletable companion.
// Refusal-only dependencies have no delete statement.
const dependencyDeleteStatements = Object.freeze({
  meta_comment_reads: 'DELETE FROM meta_comment_reads r',
  meta_comment_reactions: 'DELETE FROM meta_comment_reactions r',
  meta_comments: 'DELETE FROM meta_comments r',
  meta_record_yjs_states: 'DELETE FROM meta_record_yjs_states r',
  meta_record_yjs_updates: 'DELETE FROM meta_record_yjs_updates r',
  meta_record_subscription_notifications: 'DELETE FROM meta_record_subscription_notifications r',
  meta_record_subscriptions: 'DELETE FROM meta_record_subscriptions r',
  multitable_attachments: 'DELETE FROM multitable_attachments r',
  multitable_ai_bulk_preview_cache: 'DELETE FROM multitable_ai_bulk_preview_cache r',
  multitable_button_run_dedup: 'DELETE FROM multitable_button_run_dedup r',
  meta_record_revisions: 'DELETE FROM meta_record_revisions r',
  meta_record_version_markers: 'DELETE FROM meta_record_version_markers r',
  meta_field_value_tombstones: 'DELETE FROM meta_field_value_tombstones r',
  meta_link_tombstones: 'DELETE FROM meta_link_tombstones r',
  meta_config_revisions: 'DELETE FROM meta_config_revisions r',
  meta_field_retype_conversions: 'DELETE FROM meta_field_retype_conversions r',
  meta_links: 'DELETE FROM meta_links r',
  formula_dependencies: 'DELETE FROM formula_dependencies r',
  meta_field_auto_number_sequences: 'DELETE FROM meta_field_auto_number_sequences r',
  multitable_charts: 'DELETE FROM multitable_charts r',
  multitable_dashboards: 'DELETE FROM multitable_dashboards r',
  meta_view_permissions: 'DELETE FROM meta_view_permissions r',
  meta_view_personal_configs: 'DELETE FROM meta_view_personal_configs r',
  meta_views: 'DELETE FROM meta_views r',
})

function dependencyParams(dedicatedId, selected) {
  const sheetIds = []
  const recordIds = []
  for (const [sheetId, selection] of selected) {
    for (const id of selection.recordIds) {
      sheetIds.push(sheetId)
      recordIds.push(id)
    }
  }
  return [dedicatedId, sheetIds, recordIds]
}

const scope = 'WITH target_sheet AS (SELECT $1::text), affected(sheet_id, record_id) AS (SELECT * FROM unnest($2::text[], $3::text[]))'
const inventory = rules.map(([table, where, mode], index) => {
  const blocked = mode === 'history' ? "to_jsonb(r)->>'operation_id' IS NOT NULL" : mode ? 'true' : 'false'
  // Bound the aggregation to one digest per row, irrespective of record or attachment size.
  const rowHash = mode && mode !== 'history' ? "''::text" :
    "encode(sha256(convert_to(r.xmin::text || ':' || to_jsonb(r)::text, 'UTF8')), 'hex')"
  return `SELECT ${index} AS rule, count(*)::integer AS n, bool_or(deny) AS blocked,
         encode(sha256(convert_to(coalesce(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') AS hash
    FROM (SELECT ${rowHash} AS h, ${blocked} AS deny FROM ${table} r WHERE ${where}) digests`
}).join('\nUNION ALL\n')

async function planSheetDependencies(tx, dedicatedId, selected) {
  let count = 0
  const present = []
  const fingerprint = createHash('sha256')
  if (selected.size) {
    const params = dependencyParams(dedicatedId, selected)
    // A recycle-bin snapshot's record_id is not unique. A surviving live row or another
    // project's trash snapshot may reuse it. Its permissions, links and files must survive.
    const live = [...selected.values()].flatMap(selection => selection.live)
    const trash = [...selected.values()].flatMap(selection => selection.trash)
    const collision = await tx.query(
      `SELECT 1 FROM meta_records WHERE id = ANY($1::text[]) AND NOT id = ANY($2::text[])
       UNION ALL SELECT 1 FROM meta_records_trash WHERE record_id = ANY($1::text[]) AND NOT id = ANY($3::uuid[])
       LIMIT 1`, [params[2], live, trash],
    )
    if (collision.length) throw Object.assign(new Error('A record identity has multiple owners.'), {
      code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS', status: 409,
    })
    const rows = await tx.query(`${scope} ${inventory} ORDER BY rule`, params)
    for (const row of rows) {
      if (!row.n) continue
      if (row.blocked) {
        const mode = rules[row.rule][2]
        const reason = mode === 'history' ? 'recovery' : mode
        if (mode === 'refuse') throw Object.assign(new Error('The dependency crosses project boundaries.'), {
          code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS', status: 409,
        })
        throw Object.assign(new Error('A sheet dependency requires independent handling.'), {
          code: 'STOCK_PREPARATION_PROJECT_DELETE_DEPENDENCY', status: 409, details: { reason },
        })
      }
      count += row.n
      present.push({ rule: row.rule, count: row.n })
      fingerprint.update(row.rule + ':' + row.hash + '\n')
    }
  }
  return { count, present, hash: fingerprint.digest('hex') }
}

async function deleteSheetDependencies(tx, dedicatedId, selected, plan, sheetWrites) {
  const params = dependencyParams(dedicatedId, selected)
  for (const { rule, count } of plan.present) {
    const [table, where, mode] = rules[rule] || []
    if (!table || (mode && mode !== 'history')) throw Object.assign(new Error('Sheet dependencies changed.'), {
      code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409,
    })
    if (['record_permissions', 'field_permissions', 'spreadsheet_permissions', 'meta_fields'].includes(table)) {
      if (await sheetWrites.deleteDependency(table) !== count) throw Object.assign(new Error('Sheet dependencies changed.'), {
        code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409,
      })
      continue
    }
    const statement = dependencyDeleteStatements[table]
    if (!statement) throw Object.assign(new Error('Sheet dependencies changed.'), {
      code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409,
    })
    const historyFilter = mode === 'history' ? " AND to_jsonb(r)->>'operation_id' IS NULL" : ''
    const [deleted] = await tx.query(`${scope}, removed AS (${statement} WHERE (${where})${historyFilter} RETURNING 1)
      SELECT count(*)::integer AS n FROM removed`, params)
    if (deleted.n !== count) throw Object.assign(new Error('Sheet dependencies changed.'), {
      code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', status: 409,
    })
  }
}

module.exports = { DEPENDENCY_TABLES, planSheetDependencies, deleteSheetDependencies }
