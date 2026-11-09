-- SA05 internal persistence only. This is a CREATE reservation for the exact
-- tenant/workspace/target_ref/business_key_digest tuple, not a trusted business
-- identity producer, sender, grant, or external exactly-once guarantee.
-- Every status retains its reservation, including not_sent. Credentials,
-- revisions, owner, operation and row identity cannot split that reservation.
DO $yida_create_fence$
DECLARE
  namespace_oid oid;
  ledger_oid oid;
  fence_oid oid;
  fence_name constant text := 'uniq_integration_yida_delivery_create_business';
  schema_name text := current_schema();
  fence record;
  has_duplicates boolean;
  text_ops_oid oid;
  column_collations text;
BEGIN
  SELECT oid INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname = schema_name;
  SELECT oid INTO ledger_oid FROM pg_catalog.pg_class
    WHERE relnamespace = namespace_oid AND relname = 'integration_yida_delivery_ledger' AND relkind = 'r';
  IF ledger_oid IS NULL THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CREATE_FENCE_INVALID';
  END IF;

  -- Same lock mode as ordinary CREATE INDEX: no writes can slip between the
  -- duplicate preflight and index creation. The surrounding DO is atomic.
  EXECUTE format('LOCK TABLE %I.integration_yida_delivery_ledger IN SHARE MODE', schema_name);
  SELECT oid INTO fence_oid FROM pg_catalog.pg_class
    WHERE relnamespace = namespace_oid AND relname = fence_name;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE connamespace = namespace_oid AND (conname = fence_name OR conindid = fence_oid)) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CREATE_FENCE_INVALID';
  END IF;

  IF fence_oid IS NULL THEN
    -- Never discard or choose among historical evidence. The fixed error has
    -- no DETAIL containing tenant, target or business-key material.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.integration_yida_delivery_ledger WHERE intent = ''create'' '
      || 'GROUP BY tenant_id, COALESCE(workspace_id, ''''), target_ref, business_key_digest HAVING count(*) > 1)', schema_name)
      INTO has_duplicates;
    IF has_duplicates THEN
      RAISE EXCEPTION 'YIDA_DELIVERY_BUSINESS_CONFLICT' USING ERRCODE = '23505';
    END IF;
    BEGIN
      EXECUTE format('CREATE UNIQUE INDEX %I ON %I.integration_yida_delivery_ledger '
        || '(tenant_id, COALESCE(workspace_id, ''''), target_ref, business_key_digest) WHERE intent = ''create''',
        fence_name, schema_name);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'YIDA_DELIVERY_BUSINESS_CONFLICT' USING ERRCODE = '23505';
    END;
    SELECT oid INTO fence_oid FROM pg_catalog.pg_class
      WHERE relnamespace = namespace_oid AND relname = fence_name;
  END IF;

  -- IF NOT EXISTS alone could silently endorse a non-unique, invalid, wrong
  -- table or weakened-predicate object. Verify the actual PG14 index contract.
  SELECT i.*, c.relkind, a.amname INTO fence
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_am a ON a.oid = c.relam WHERE i.indexrelid = fence_oid;
  IF NOT FOUND THEN RAISE EXCEPTION 'YIDA_DELIVERY_CREATE_FENCE_INVALID'; END IF;
  SELECT o.oid INTO text_ops_oid FROM pg_catalog.pg_opclass o
    JOIN pg_catalog.pg_am a ON a.oid = o.opcmethod
    WHERE o.opcnamespace = 'pg_catalog'::regnamespace AND o.opcname = 'text_ops'
      AND o.opcintype = 'text'::regtype AND o.opcdefault AND a.amname = 'btree';
  SELECT string_agg(a.attcollation::text, ' ' ORDER BY wanted.position) INTO column_collations
    FROM unnest(ARRAY['tenant_id', 'workspace_id', 'target_ref', 'business_key_digest'])
      WITH ORDINALITY AS wanted(name, position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ledger_oid AND a.attname = wanted.name AND NOT a.attisdropped;
  IF fence.relkind <> 'i' OR fence.amname <> 'btree' OR fence.indrelid <> ledger_oid
    OR NOT fence.indisunique OR NOT fence.indisvalid OR NOT fence.indisready OR NOT fence.indislive
    OR NOT fence.indimmediate OR fence.indisprimary OR fence.indisexclusion
    OR fence.indnatts <> 4 OR fence.indnkeyatts <> 4
    OR text_ops_oid IS NULL
    OR EXISTS (SELECT 1 FROM unnest(fence.indclass::oid[]) AS classes(oid) WHERE classes.oid <> text_ops_oid)
    OR fence.indcollation::text IS DISTINCT FROM column_collations
    OR fence.indoption::text IS DISTINCT FROM '0 0 0 0'
    OR ARRAY(SELECT pg_catalog.pg_get_indexdef(fence_oid, key_position.n, false)
      FROM generate_series(1, 4) AS key_position(n)) IS DISTINCT FROM
      ARRAY['tenant_id', 'COALESCE(workspace_id, ''''::text)', 'target_ref', 'business_key_digest']
    OR pg_catalog.pg_get_expr(fence.indpred, fence.indrelid, false) IS DISTINCT FROM '(intent = ''create''::text)' THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CREATE_FENCE_INVALID';
  END IF;
END;
$yida_create_fence$;
