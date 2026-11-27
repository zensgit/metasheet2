import { sql, type Kysely } from 'kysely'

// Cleanup takes exclusive *logical* sheet keys. DML takes shared keys until commit. Ordinary
// writers never conflict with each other on this protocol. NOWAIT on both sides prevents an
// old INSERT from waiting for a cleanup and then landing in the surviving shared sheet.
const lockFn = 'public.stock_prep_project_delete_fence'
const triggers: Record<string, string[]> = {
  sheet: [
    'meta_records', 'meta_record_history_operations', 'meta_recovery_archives',
    'multitable_record_approval_submissions', 'multitable_ai_bulk_job', 'automation_rules',
    'multitable_automation_suspensions', 'multitable_webhooks', 'record_permissions',
    'meta_record_subscription_notifications', 'meta_record_subscriptions', 'multitable_ai_bulk_preview_cache',
    'multitable_button_run_dedup', 'meta_record_revisions', 'meta_record_version_markers',
    'meta_field_value_tombstones', 'meta_config_revisions', 'meta_history_baselines',
    'meta_history_trust_checkpoints', 'meta_field_retype_conversions', 'field_permissions',
    'spreadsheet_permissions', 'meta_field_auto_number_sequences', 'multitable_charts',
    'multitable_dashboards', 'meta_views',
  ],
  sheetId: ['meta_sheets'], registry: ['plugin_multitable_object_registry'], target: ['integration_stock_prep_project_target'],
  trash: ['meta_records_trash'], formula: ['formula_dependencies'], link: ['meta_links'], linkTombstone: ['meta_link_tombstones'],
  token: ['multitable_api_tokens'], field: ['meta_fields'], attachment: ['multitable_attachments'],
  archiveAttachment: ['meta_recovery_archive_attachment_refs'], attendance: ['attendance_report_projection_anchors'],
  comment: ['meta_comments'], commentChild: ['meta_comment_reads', 'meta_comment_reactions'],
  viewChild: ['meta_view_permissions', 'meta_view_personal_configs'], jobChild: ['multitable_ai_bulk_job_rows'],
}

// Generate statically typed OLD/NEW column projections. No request-controlled SQL or full-row JSON
// conversion on the ordinary grid path. Only foreign-reference writers need indexed parent lookups.
function pair(column: string) { return `ARRAY[OLD.${column}, NEW.${column}]::text[]` }
function fromParent(table: string, column: string, keys: string, sheet = 'sheet_id') {
  return `ARRAY(SELECT p.${sheet} FROM public.${table} p WHERE p.${column} = ANY(${keys}))`
}
function recordSheets(keys: string) {
  return `${fromParent('meta_records', 'id', keys)} || ${fromParent('meta_records_trash', 'record_id', keys)}`
}
const sheet = pair('sheet_id')
const fieldSheets = fromParent('meta_fields', 'id', pair('field_id'))
const linkedRecords = `${pair('record_id')} || ${pair('foreign_record_id')}`
const fieldReferences = ['foreignSheetId', 'foreignDatasheetId', 'datasheetId'].flatMap(key =>
  ['OLD', 'NEW'].flatMap(row => [`${row}.property->>'${key}'`, `${row}.property#>>'{link,${key}}'`]))
const sheets: Record<string, string> = {
  sheet, sheetId: pair('id'), registry: sheet, target: sheet,
  trash: `${sheet} || ${recordSheets(pair('record_id'))}`,
  formula: `${sheet} || ${pair('depends_on_sheet_id')}`,
  link: `${fieldSheets} || ${recordSheets(linkedRecords)}`,
  linkTombstone: `${sheet} || ${recordSheets(pair('foreign_record_id'))}`,
  token: "coalesce(OLD.sheet_ids, '{}'::text[]) || coalesce(NEW.sheet_ids, '{}'::text[])",
  field: `${sheet} || ARRAY[${fieldReferences.join(',')}]`,
  attachment: `${sheet} || ${fieldSheets}`,
  archiveAttachment: fromParent('multitable_attachments', 'id', 'ARRAY[OLD.attachment_id, NEW.attachment_id]'),
  attendance: recordSheets(pair('projection_record_id')),
  comment: pair('spreadsheet_id'),
  commentChild: fromParent('meta_comments', 'id', 'ARRAY[OLD.comment_id, NEW.comment_id]', 'spreadsheet_id'),
  viewChild: fromParent('meta_views', 'id', pair('view_id')),
  jobChild: fromParent('multitable_ai_bulk_job', 'job_id', 'ARRAY[OLD.job_id, NEW.job_id]'),
}
const triggerName = 'stock_prep_project_delete_scoped_write'
const functionName = (kind: string) => 'public.stock_prep_project_delete_write_' + kind.toLowerCase()

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`CREATE FUNCTION ${lockFn}(keys text[], shared boolean) RETURNS void
    LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
    DECLARE k text; acquired boolean;
    BEGIN
      FOR k IN SELECT DISTINCT v FROM unnest(keys) v WHERE v IS NOT NULL ORDER BY v LOOP
        IF shared THEN acquired := pg_try_advisory_xact_lock_shared(16991, hashtext(k));
        ELSE acquired := pg_try_advisory_xact_lock(16991, hashtext(k)); END IF;
        IF NOT acquired THEN RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'stock preparation project busy'; END IF;
      END LOOP;
    END $fn$`).execute(db)
  for (const [kind, tables] of Object.entries(triggers)) {
    const projectKey = (row: string) => "'registry-target:[' || to_json(" + row + ".tenant_id)::text || ',' || to_json(" + row + ".project_no)::text || ']'"
    const extraKeys = kind === 'registry' ? " || ARRAY['stage:' || OLD.project_id, 'stage:' || NEW.project_id]"
      : kind === 'target' ? ` || ARRAY[${projectKey('OLD')}, ${projectKey('NEW')}]` : ''
    // Fast path for the frequently written rows. Only record identity creation/moves need to
    // probe trash for an older owner of the same id, exactly as the cleanup collision check does.
    const collisions = kind === 'sheet' ? `IF TG_TABLE_NAME = 'meta_records' AND TG_OP <> 'DELETE' THEN
      IF TG_OP = 'INSERT' OR NEW.id IS DISTINCT FROM OLD.id THEN
        PERFORM ${lockFn}(ARRAY['sheet:' || r.sheet_id], true) FROM public.meta_records_trash r
          WHERE r.record_id = NEW.id ORDER BY r.sheet_id;
      END IF;
    END IF;` : ''
    const scopedLocks = kind === 'sheet' ? `IF TG_OP = 'DELETE' THEN sheet_id := OLD.sheet_id;
      ELSIF TG_OP = 'INSERT' OR OLD.sheet_id IS NOT DISTINCT FROM NEW.sheet_id THEN sheet_id := NEW.sheet_id;
      ELSE
        PERFORM ${lockFn}(ARRAY['sheet:' || OLD.sheet_id, 'sheet:' || NEW.sheet_id], true);
        RETURN NEW;
      END IF;
      IF sheet_id IS NOT NULL AND NOT pg_try_advisory_xact_lock_shared(16991, hashtext('sheet:' || sheet_id)) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'stock preparation project busy';
      END IF;` : `PERFORM ${lockFn}(ARRAY(SELECT 'sheet:' || s FROM unnest(${sheets[kind]}) s)${extraKeys}, true);`
    await sql.raw(`CREATE FUNCTION ${functionName(kind)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog SET row_security = off AS $fn$
      ${kind === 'sheet' ? 'DECLARE sheet_id text;' : ''}
      BEGIN
        IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME NOT IN (${tables.map(t => `'${t}'`).join(', ')}) THEN
          RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'invalid project fence trigger context';
        END IF;
        ${collisions}
        ${scopedLocks}
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
      END $fn$`).execute(db)
    // Private trigger functions inspect dependency keys as the migration role. A writer with
    // column-only INSERT/UPDATE rights needs no new reads, and cannot attach a definer trigger
    // to an attacker-chosen composite row type. The lock helper itself is invoker-only.
    await sql.raw(`REVOKE ALL ON FUNCTION ${functionName(kind)}() FROM PUBLIC`).execute(db)
    for (const table of tables) {
      await sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE OR DELETE ON public.${table}
        FOR EACH ROW EXECUTE FUNCTION ${functionName(kind)}()`).execute(db)
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [kind, tables] of Object.entries(triggers)) {
    for (const table of tables) await sql.raw(`DROP TRIGGER ${triggerName} ON public.${table}`).execute(db)
    await sql.raw(`DROP FUNCTION ${functionName(kind)}()`).execute(db)
  }
  await sql.raw(`DROP FUNCTION ${lockFn}(text[], boolean)`).execute(db)
}
