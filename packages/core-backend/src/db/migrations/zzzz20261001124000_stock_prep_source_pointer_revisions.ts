import { sql, type Kysely } from 'kysely'

/**
 * Private action -> external-system scope revisions, including deletion tombstones.
 * 079 remains the human-facing pointer store. This mirror is NOT a tenant/owner
 * proof or a second pointer writer. The 079 trigger records pointer changes;
 * direct generic-CRUD mirror writes are forced to current 079 facts with a fresh
 * nonce, never a caller-supplied former revision. They can invalidate a grant,
 * but cannot forge its previous pointer or clear scope history.
 * A scope that has never existed has no mirror row; reads must not manufacture
 * one. Once touched, even an absent pointer retains a nonce to prevent absent ->
 * inserted -> deleted -> absent from reviving a prior Automation authorization.
 *
 * Migration/replay is maintenance-only, inside the caller's migration transaction.
 * Every relation lock uses NOWAIT; contention requires rollback, never waiting in
 * a reverse lock order against a live EXT -> 079 writer or Automation reader.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      pointer_table REGCLASS := pg_catalog.to_regclass('integration_stock_prep_source_binding');
      pointer_schema TEXT;
      revision_table REGCLASS;
      column_names TEXT[];
      column_types TEXT[];
      column_required BOOLEAN[];
      inconsistent BOOLEAN;
    BEGIN
      IF pointer_table IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_PREREQUISITE_REQUIRED';
      END IF;
      SELECT n.nspname INTO STRICT pointer_schema
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = pointer_table AND c.relkind = 'r';
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', pointer_table);
      revision_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_stock_prep_source_pointer_revisions', pointer_schema));
      IF revision_table IS NULL THEN
        EXECUTE pg_catalog.format($ddl$
          CREATE TABLE %I.integration_stock_prep_source_pointer_revisions (
            tenant_id TEXT NOT NULL,
            workspace_key TEXT NOT NULL,
            action_id TEXT NOT NULL,
            revision UUID NOT NULL,
            binding_id TEXT,
            external_system_id TEXT,
            CONSTRAINT stock_prep_source_pointer_scope PRIMARY KEY (tenant_id, workspace_key, action_id),
            CONSTRAINT stock_prep_source_pointer_pair CHECK ((binding_id IS NULL) = (external_system_id IS NULL))
          )
        $ddl$, pointer_schema);
        revision_table := pg_catalog.format('%I.integration_stock_prep_source_pointer_revisions', pointer_schema)::pg_catalog.regclass;
      END IF;
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', revision_table);

      -- A replay may retain our exact prior table, never silently accept an old
      -- partial candidate or a same-named, incompatible replacement. No nonce is
      -- defaulted or rewritten to make incompatible historical rows look valid.
      SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum),
        pg_catalog.array_agg(pg_catalog.format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum),
        pg_catalog.array_agg(a.attnotnull ORDER BY a.attnum)
        INTO column_names, column_types, column_required
        FROM pg_catalog.pg_attribute a WHERE a.attrelid = revision_table AND a.attnum > 0 AND NOT a.attisdropped;
      IF column_names IS DISTINCT FROM ARRAY['tenant_id','workspace_key','action_id','revision','binding_id','external_system_id']::text[]
        OR column_types IS DISTINCT FROM ARRAY['text','text','text','uuid','text','text']::text[]
        OR column_required IS DISTINCT FROM ARRAY[TRUE,TRUE,TRUE,TRUE,FALSE,FALSE]::boolean[]
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
          WHERE c.oid = revision_table AND c.relkind = 'r' AND NOT c.relrowsecurity)
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = revision_table AND c.contype = 'p' AND c.convalidated
            AND c.conkey = ARRAY[1,2,3]::smallint[])
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = revision_table AND c.contype = 'c' AND c.convalidated
            AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin, c.conrelid), '[[:space:]()]', '', 'g')
              = 'binding_idISNULL=external_system_idISNULL') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_SCHEMA_INVALID';
      END IF;

      -- Both relations are locked. Missing mirror scopes may be backfilled, but
      -- any existing positive/tombstone disagreement must stop the migration.
      EXECUTE pg_catalog.format($check$
        SELECT EXISTS (
          SELECT 1 FROM %s r LEFT JOIN %s b
            ON b.tenant_id = r.tenant_id AND COALESCE(b.workspace_id, '') = r.workspace_key AND b.action_id = r.action_id
          WHERE r.binding_id IS DISTINCT FROM b.id OR r.external_system_id IS DISTINCT FROM b.external_system_id
        )
      $check$, revision_table, pointer_table) INTO inconsistent;
      IF inconsistent THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_STATE_INCONSISTENT';
      END IF;
      EXECUTE pg_catalog.format($backfill$
        INSERT INTO %s (tenant_id, workspace_key, action_id, revision, binding_id, external_system_id)
        SELECT b.tenant_id, COALESCE(b.workspace_id, ''), b.action_id, pg_catalog.gen_random_uuid(), b.id, b.external_system_id
          FROM %s b LEFT JOIN %s r
            ON r.tenant_id = b.tenant_id AND r.workspace_key = COALESCE(b.workspace_id, '') AND r.action_id = b.action_id
          WHERE r.tenant_id IS NULL
      $backfill$, revision_table, pointer_table, revision_table);

      -- The integration_ prefix is reachable by the generic scoped database API.
      -- A helper-only convention is therefore insufficient: ordinary DML cannot
      -- impersonate an old revision, move its scope, or erase a tombstone. No GUC
      -- or trigger-depth value distinguishes a supposedly trusted caller here.
      -- Replays above insert missing scopes only; an already-installed guard
      -- never rewrites an existing nonce during migration backfill.
      EXECUTE 'CREATE OR REPLACE FUNCTION ' || pg_catalog.quote_ident(pointer_schema)
        || '.stock_prep_source_pointer_epoch_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS '
        || pg_catalog.quote_literal($function$
        DECLARE
          current_count BIGINT;
          current_binding TEXT;
          current_system TEXT;
        BEGIN
          IF TG_OP = 'TRUNCATE' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_TRUNCATE_FORBIDDEN';
          END IF;
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_HISTORY_DELETE_FORBIDDEN';
          END IF;
          IF TG_OP = 'UPDATE' AND ROW(NEW.tenant_id, NEW.workspace_key, NEW.action_id)
            IS DISTINCT FROM ROW(OLD.tenant_id, OLD.workspace_key, OLD.action_id) THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_SCOPE_UPDATE_FORBIDDEN';
          END IF;
          -- Generic epoch writes must cross the SAME 079 write fence, including
          -- insertion into a scope with no row to lock. The source row trigger
          -- already owns this table mode. NOWAIT refuses an epoch -> 079 reverse
          -- wait rather than deadlocking a reader that holds 079 -> epoch.
          EXECUTE pg_catalog.format(
            'LOCK TABLE %I.integration_stock_prep_source_binding IN ROW EXCLUSIVE MODE NOWAIT', TG_TABLE_SCHEMA);
          EXECUTE pg_catalog.format(
            'SELECT count(*), min(id), min(external_system_id) FROM %I.integration_stock_prep_source_binding '
            || 'WHERE tenant_id = $1 AND COALESCE(workspace_id, '''') = $2 AND action_id = $3', TG_TABLE_SCHEMA)
            INTO current_count, current_binding, current_system
            USING NEW.tenant_id, NEW.workspace_key, NEW.action_id;
          IF current_count > 1 THEN
            RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_STATE_INCONSISTENT';
          END IF;
          NEW.binding_id := current_binding;
          NEW.external_system_id := current_system;
          NEW.revision := pg_catalog.gen_random_uuid();
          RETURN NEW;
        EXCEPTION WHEN lock_not_available THEN
          RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_SOURCE_POINTER_EPOCH_WRITE_BUSY';
        END;
        $function$);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_epoch_guard ON %s', revision_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER stock_prep_source_pointer_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON %s '
        || 'FOR EACH ROW EXECUTE FUNCTION %I.stock_prep_source_pointer_epoch_guard()', revision_table, pointer_schema);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_epoch_truncate_guard ON %s', revision_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER stock_prep_source_pointer_epoch_truncate_guard BEFORE TRUNCATE ON %s '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION %I.stock_prep_source_pointer_epoch_guard()', revision_table, pointer_schema);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_truncate_guard ON %s', pointer_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER stock_prep_source_pointer_truncate_guard BEFORE TRUNCATE ON %s '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION %I.stock_prep_source_pointer_epoch_guard()', pointer_table, pointer_schema);

      -- quote_literal preserves this function's own format placeholders. Every
      -- runtime relation is schema-qualified from the owning trigger table, not
      -- from a writer's search_path. No row-derived identifier becomes SQL text.
      EXECUTE 'CREATE OR REPLACE FUNCTION ' || pg_catalog.quote_ident(pointer_schema)
        || '.stock_prep_source_pointer_revision() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS '
        || pg_catalog.quote_literal($function$
        DECLARE
          old_tenant TEXT;
          old_workspace TEXT;
          old_action TEXT;
          new_tenant TEXT;
          new_workspace TEXT;
          new_action TEXT;
          changed_scope RECORD;
          current_count BIGINT;
          current_binding TEXT;
          current_system TEXT;
        BEGIN
          IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.action_id, NEW.external_system_id)
            IS NOT DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.action_id, OLD.external_system_id) THEN
            RETURN NEW;
          END IF;
          IF TG_OP <> 'INSERT' THEN
            old_tenant := OLD.tenant_id;
            old_workspace := COALESCE(OLD.workspace_id, '');
            old_action := OLD.action_id;
          END IF;
          IF TG_OP <> 'DELETE' THEN
            new_tenant := NEW.tenant_id;
            new_workspace := COALESCE(NEW.workspace_id, '');
            new_action := NEW.action_id;
          END IF;
          -- Deduplicate null <-> empty workspace changes to one scope but still
          -- mint a new nonce: the UPDATE comparison above uses RAW workspace.
          -- C ordering is deterministic for both old/new scope moves.
          FOR changed_scope IN
            SELECT scopes.tenant_id, scopes.workspace_key, scopes.action_id
            FROM (SELECT old_tenant AS tenant_id, old_workspace AS workspace_key, old_action AS action_id
              UNION SELECT new_tenant, new_workspace, new_action) scopes
            WHERE scopes.tenant_id IS NOT NULL
            ORDER BY scopes.tenant_id COLLATE "C", scopes.workspace_key COLLATE "C", scopes.action_id COLLATE "C"
          LOOP
            EXECUTE pg_catalog.format(
              'SELECT count(*), min(id), min(external_system_id) FROM %I.integration_stock_prep_source_binding '
              || 'WHERE tenant_id = $1 AND COALESCE(workspace_id, '''') = $2 AND action_id = $3', TG_TABLE_SCHEMA)
              INTO current_count, current_binding, current_system
              USING changed_scope.tenant_id, changed_scope.workspace_key, changed_scope.action_id;
            IF current_count > 1 THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_STATE_INCONSISTENT';
            END IF;
            EXECUTE pg_catalog.format(
              'INSERT INTO %I.integration_stock_prep_source_pointer_revisions '
              || '(tenant_id, workspace_key, action_id, revision, binding_id, external_system_id) '
              || 'VALUES ($1, $2, $3, pg_catalog.gen_random_uuid(), $4, $5) '
              || 'ON CONFLICT (tenant_id, workspace_key, action_id) DO UPDATE SET '
              || 'revision = EXCLUDED.revision, binding_id = EXCLUDED.binding_id, external_system_id = EXCLUDED.external_system_id',
              TG_TABLE_SCHEMA)
              USING changed_scope.tenant_id, changed_scope.workspace_key, changed_scope.action_id, current_binding, current_system;
          END LOOP;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
        $function$);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_revision ON %s', pointer_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER stock_prep_source_pointer_revision AFTER INSERT OR UPDATE OR DELETE ON %s '
        || 'FOR EACH ROW EXECUTE FUNCTION %I.stock_prep_source_pointer_revision()', pointer_table, pointer_schema);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_SOURCE_POINTER_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $migration$
    DECLARE
      pointer_table REGCLASS := pg_catalog.to_regclass('integration_stock_prep_source_binding');
      pointer_schema TEXT;
      revision_table REGCLASS;
      grant_table REGCLASS;
      has_history BOOLEAN;
    BEGIN
      IF pointer_table IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_PREREQUISITE_REQUIRED';
      END IF;
      SELECT n.nspname INTO STRICT pointer_schema
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = pointer_table AND c.relkind = 'r';
      EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', pointer_table);
      revision_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_stock_prep_source_pointer_revisions', pointer_schema));
      grant_table := pg_catalog.to_regclass(pg_catalog.format('%I.integration_automation_read_grants', pointer_schema));
      IF revision_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', revision_table);
      END IF;
      IF grant_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE NOWAIT', grant_table);
        EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s)', grant_table) INTO has_history;
        IF has_history THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AUTOMATION_SOURCE_POINTER_HISTORY_ROLLBACK_FORBIDDEN';
        END IF;
      END IF;
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_revision ON %s', pointer_table);
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_truncate_guard ON %s', pointer_table);
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.stock_prep_source_pointer_revision()', pointer_schema);
      IF revision_table IS NOT NULL THEN
        EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_epoch_guard ON %s', revision_table);
        EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS stock_prep_source_pointer_epoch_truncate_guard ON %s', revision_table);
        EXECUTE pg_catalog.format('DROP TABLE %s', revision_table);
      END IF;
      EXECUTE pg_catalog.format('DROP FUNCTION IF EXISTS %I.stock_prep_source_pointer_epoch_guard()', pointer_schema);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'AUTOMATION_SOURCE_POINTER_MIGRATION_BUSY';
    END;
    $migration$;
  `.execute(db)
}
