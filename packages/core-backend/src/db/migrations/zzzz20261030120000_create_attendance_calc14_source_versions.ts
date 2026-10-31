import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// Input provenance only. No calculation context, result or derived FSER status.
// Deliberately empty on upgrade: current rows do not establish prehistory.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE attendance_calc14_source_versions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      org_id text NOT NULL CHECK (btrim(org_id) <> ''),
      source_kind text NOT NULL CHECK (source_kind IN ('group','desired','shift','rule','rule_set','members','publication','user_publication')),
      source_id text NOT NULL CHECK (btrim(source_id) <> ''),
      business_effective_date date,
      payload jsonb,
      event_kind text NOT NULL CHECK (event_kind IN ('version','unversioned_change')),
      actor_id text,
      correlation_id text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((event_kind='version' AND business_effective_date IS NOT NULL)
        OR (event_kind='unversioned_change' AND business_effective_date IS NULL AND payload IS NULL)),
      UNIQUE (org_id, source_kind, source_id, business_effective_date)
    );
    CREATE INDEX attendance_calc14_source_lookup ON attendance_calc14_source_versions
      (org_id, source_kind, source_id, business_effective_date DESC);
    CREATE FUNCTION attendance_calc14_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ATTENDANCE_CALC14_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
    END; $$;
    CREATE TRIGGER attendance_calc14_immutable BEFORE UPDATE OR DELETE ON attendance_calc14_source_versions
      FOR EACH ROW EXECUTE FUNCTION attendance_calc14_immutable();
    CREATE TRIGGER attendance_calc14_immutable_truncate BEFORE TRUNCATE ON attendance_calc14_source_versions
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_calc14_immutable();
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_calc14_source_payload(p_org text, p_kind text, p_source text)
    RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
    DECLARE v_payload jsonb;
    BEGIN
      CASE p_kind
        WHEN 'group' THEN
          SELECT jsonb_build_object('id',id,'org_id',org_id,'attendance_type',attendance_type,
            'timezone',timezone,'rule_set_id',rule_set_id) INTO v_payload
            FROM attendance_groups WHERE org_id=p_org AND id::text=p_source;
        WHEN 'desired' THEN
          SELECT jsonb_build_object('shift_id',shift_id,'start_date',start_date,'end_date',end_date,
            'revision',revision) INTO v_payload
            FROM attendance_group_fixed_schedule_configs WHERE org_id=p_org AND group_id::text=p_source;
        WHEN 'shift' THEN
          SELECT (to_jsonb(s) - ARRAY['created_at','updated_at']) || jsonb_build_object('segments',
            COALESCE((SELECT jsonb_agg(to_jsonb(g) - ARRAY['id','created_at','updated_at'] ORDER BY g.segment_index)
              FROM attendance_shift_segments g WHERE g.org_id=p_org AND g.shift_id=s.id),'[]'::jsonb))
            INTO v_payload FROM attendance_shifts s WHERE s.org_id=p_org AND s.id::text=p_source;
        WHEN 'rule' THEN
          IF (SELECT count(*) FROM attendance_rules WHERE org_id=p_org AND is_default=true) <> 1 THEN
            v_payload := NULL;
          ELSE
            SELECT (to_jsonb(r) - ARRAY['created_at','updated_at','name','timezone_version','id'])
              || jsonb_build_object(
                'calc14_holidays',COALESCE((SELECT jsonb_agg(to_jsonb(h)-ARRAY['created_at','updated_at'] ORDER BY h.holiday_date,h.id)
                  FROM attendance_holidays h WHERE h.org_id=p_org),'[]'::jsonb),
                'calc14_settings',(SELECT to_jsonb(c.value) FROM system_configs c WHERE c.key='attendance.settings'),
                'calc14_timezone_policy',COALESCE((SELECT jsonb_build_object('enabled',p.enabled,'version',p.version)
                  FROM attendance_timezone_policies p WHERE p.org_id=p_org),'{"enabled":false,"version":0}'::jsonb))
              INTO v_payload FROM attendance_rules r WHERE org_id=p_org AND is_default=true;
          END IF;
        WHEN 'rule_set' THEN
          SELECT jsonb_build_object('id',id,'org_id',org_id,'config',config,'is_default',is_default)
            INTO v_payload FROM attendance_rule_sets WHERE org_id=p_org AND id::text=p_source;
        WHEN 'members' THEN
          SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',user_id) ORDER BY user_id),'[]'::jsonb)
            INTO v_payload FROM attendance_group_members WHERE org_id=p_org AND group_id::text=p_source;
        WHEN 'user_publication' THEN
          SELECT jsonb_build_object(
            'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'group_id',m.group_id,
              'effective_from',m.effective_from,'effective_to',m.effective_to) ORDER BY m.id)
              FROM attendance_calculation_group_memberships m WHERE m.org_id=p_org AND m.user_id::text=p_source),'[]'::jsonb),
            'assignments',COALESCE((SELECT jsonb_agg(to_jsonb(a)-ARRAY['created_at','updated_at'] ORDER BY a.id)
              FROM attendance_shift_assignments a WHERE a.org_id=p_org AND a.user_id::text=p_source
                AND COALESCE(a.is_active,true)=true),'[]'::jsonb),
            'rotations',COALESCE((SELECT jsonb_agg(to_jsonb(r)-ARRAY['created_at','updated_at'] ORDER BY r.id)
              FROM attendance_rotation_assignments r WHERE r.org_id=p_org AND r.user_id::text=p_source
                AND COALESCE(r.is_active,true)=true),'[]'::jsonb)) INTO v_payload;
        WHEN 'publication' THEN
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'org_id',org_id,'user_id',user_id,
            'shift_id',shift_id,'start_date',start_date,'end_date',end_date,'publish_status',publish_status,
            'producer_key',producer_key,'producer_type',producer_type,'producer_ref_id',producer_ref_id,
            'slot_index',slot_index,'is_active',is_active) ORDER BY id),'[]'::jsonb)
            INTO v_payload FROM attendance_shift_assignments WHERE org_id=p_org
              AND producer_type='attendance_group_fixed_schedule' AND producer_ref_id::text=p_source
              AND COALESCE(is_active,true)=true;
      END CASE;
      RETURN v_payload;
    END; $$;
    CREATE FUNCTION attendance_calc14_capture_source(p_org text, p_kind text, p_source text)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE
      v_payload jsonb;
      v_prior attendance_calc14_source_versions%ROWTYPE;
      v_date date;
      v_date_text text := nullif(current_setting('metasheet.calc14_business_effective_date', true), '');
      v_bound_org text := nullif(current_setting('metasheet.calc14_org', true), '');
    BEGIN
      -- The application takes the existing org source lock before this capture.
      -- Deferred triggers observe the final parent + segment/member/publication state.
      v_payload := attendance_calc14_source_payload(p_org,p_kind,p_source);
      SELECT * INTO v_prior FROM attendance_calc14_source_versions
        WHERE org_id=p_org AND source_kind=p_kind AND source_id=p_source ORDER BY id DESC LIMIT 1;
      IF v_prior.event_kind='version' AND v_prior.payload IS NOT DISTINCT FROM v_payload THEN RETURN; END IF;
      IF current_setting('metasheet.calc14_date_required',true) IS DISTINCT FROM 'true' THEN
        -- Virgin legacy/OFF has no retained provenance to invalidate. Existing
        -- history needs a gap marker, never a business date inferred from now.
        IF v_prior.id IS NULL OR v_prior.event_kind='unversioned_change' THEN RETURN; END IF;
        INSERT INTO attendance_calc14_source_versions (org_id,source_kind,source_id,event_kind,correlation_id)
          VALUES (p_org,p_kind,p_source,'unversioned_change',txid_current()::text);
        RETURN;
      END IF;
      IF v_date_text IS NULL THEN
        RAISE EXCEPTION 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED' USING ERRCODE='23514';
      END IF;
      IF v_bound_org IS DISTINCT FROM p_org THEN
        RAISE EXCEPTION 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID' USING ERRCODE='23514';
      END IF;
      v_date := v_date_text::date;
      IF EXISTS (SELECT 1 FROM attendance_calc14_source_versions WHERE org_id=p_org
          AND source_kind=p_kind AND source_id=p_source AND business_effective_date >= v_date) THEN
        RAISE EXCEPTION 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' USING ERRCODE='23514';
      END IF;
      INSERT INTO attendance_calc14_source_versions
        (org_id,source_kind,source_id,business_effective_date,payload,event_kind,actor_id,correlation_id)
        VALUES (p_org,p_kind,p_source,v_date,v_payload,'version',
          nullif(current_setting('metasheet.calc14_actor',true),''),txid_current()::text);
    END; $$;
    CREATE FUNCTION attendance_calc14_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v_row jsonb; v_old jsonb; v_kind text; v_source text; v_old_source text; v_org text;
    BEGIN
      v_row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
      IF TG_OP='UPDATE' THEN v_old := to_jsonb(OLD); END IF;
      IF TG_TABLE_NAME='system_configs' THEN
        IF v_row->>'key' IS DISTINCT FROM 'attendance.settings' THEN RETURN NULL; END IF;
        -- The existing settings document is global. Its undated change cannot
        -- create per-org valid time: invalidate only initialized rule sources.
        FOR v_org IN SELECT DISTINCT org_id FROM attendance_calc14_source_versions WHERE source_kind='rule' LOOP
          INSERT INTO attendance_calc14_source_versions (org_id,source_kind,source_id,event_kind,correlation_id)
            SELECT v_org,'rule',v_org,'unversioned_change',txid_current()::text
            WHERE (SELECT v.event_kind='version' AND v.payload IS DISTINCT FROM attendance_calc14_source_payload(v_org,'rule',v_org)
              FROM attendance_calc14_source_versions v WHERE v.org_id=v_org AND v.source_kind='rule'
                AND v.source_id=v_org ORDER BY v.id DESC LIMIT 1);
        END LOOP;
        RETURN NULL;
      END IF;
      CASE TG_TABLE_NAME
        WHEN 'attendance_groups' THEN v_kind:='group'; v_source:=v_row->>'id';
        WHEN 'attendance_group_fixed_schedule_configs' THEN v_kind:='desired'; v_source:=v_row->>'group_id';
        WHEN 'attendance_shifts' THEN v_kind:='shift'; v_source:=v_row->>'id';
        WHEN 'attendance_shift_segments' THEN v_kind:='shift'; v_source:=v_row->>'shift_id';
        WHEN 'attendance_rules' THEN v_kind:='rule'; v_source:=v_row->>'org_id';
        WHEN 'attendance_holidays' THEN v_kind:='rule'; v_source:=v_row->>'org_id';
        WHEN 'attendance_timezone_policies' THEN v_kind:='rule'; v_source:=v_row->>'org_id';
        WHEN 'attendance_rule_sets' THEN v_kind:='rule_set'; v_source:=v_row->>'id';
        WHEN 'attendance_group_members' THEN v_kind:='members'; v_source:=v_row->>'group_id';
        WHEN 'attendance_rotation_assignments' THEN v_kind:=NULL;
        WHEN 'attendance_calculation_group_memberships' THEN v_kind:=NULL;
        WHEN 'attendance_shift_assignments' THEN
          v_kind:='publication';
          IF v_row->>'producer_type'='attendance_group_fixed_schedule' THEN v_source:=v_row->>'producer_ref_id'; END IF;
          IF v_old->>'producer_type'='attendance_group_fixed_schedule' THEN v_old_source:=v_old->>'producer_ref_id'; END IF;
      END CASE;
      IF v_old_source IS NOT NULL AND v_old_source IS DISTINCT FROM v_source THEN
        PERFORM attendance_calc14_capture_source(v_old->>'org_id',v_kind,v_old_source);
      END IF;
      IF v_source IS NOT NULL THEN PERFORM attendance_calc14_capture_source(v_row->>'org_id',v_kind,v_source); END IF;
      IF TG_TABLE_NAME IN ('attendance_shift_assignments','attendance_rotation_assignments','attendance_calculation_group_memberships') THEN
        PERFORM attendance_calc14_capture_source(v_row->>'org_id','user_publication',v_row->>'user_id');
        IF v_old->>'user_id' IS NOT NULL AND (v_old->>'user_id' IS DISTINCT FROM v_row->>'user_id') THEN
          PERFORM attendance_calc14_capture_source(v_old->>'org_id','user_publication',v_old->>'user_id');
        END IF;
      END IF;
      RETURN NULL;
    END; $$;
  `.execute(db)
  for (const table of [
    'attendance_groups', 'attendance_group_fixed_schedule_configs', 'attendance_shifts',
    'attendance_shift_segments', 'attendance_rules', 'attendance_rule_sets', 'attendance_group_members', 'attendance_shift_assignments',
    'attendance_rotation_assignments', 'attendance_calculation_group_memberships',
    'attendance_holidays', 'attendance_timezone_policies', 'system_configs',
  ]) {
    await sql.raw(`CREATE CONSTRAINT TRIGGER calc14_capture_${table}
      AFTER INSERT OR UPDATE OR DELETE ON ${table} DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_calc14_source_changed()`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Retained input provenance must be exported/preserved by a separately approved
  // operation before rollback. Never silently erase business history.
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM attendance_calc14_source_versions) THEN
      RAISE EXCEPTION 'ATTENDANCE_CALC14_ROLLBACK_BLOCKED' USING ERRCODE='55000';
    END IF;
  END; $$`.execute(db)
  for (const table of [
    'attendance_groups', 'attendance_group_fixed_schedule_configs', 'attendance_shifts',
    'attendance_shift_segments', 'attendance_rules', 'attendance_rule_sets', 'attendance_group_members', 'attendance_shift_assignments',
    'attendance_rotation_assignments', 'attendance_calculation_group_memberships',
    'attendance_holidays', 'attendance_timezone_policies', 'system_configs',
  ]) {
    await sql.raw(`DROP TRIGGER calc14_capture_${table} ON ${table}`).execute(db)
  }
  await sql`DROP FUNCTION attendance_calc14_source_changed();
    DROP FUNCTION attendance_calc14_capture_source(text,text,text);
    DROP FUNCTION attendance_calc14_source_payload(text,text,text);
    DROP TABLE attendance_calc14_source_versions;
    DROP FUNCTION attendance_calc14_immutable()`.execute(db)
}
