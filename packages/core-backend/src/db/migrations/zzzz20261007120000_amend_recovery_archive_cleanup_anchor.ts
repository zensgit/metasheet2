import { sql, type Kysely } from 'kysely'

/** Preserve future-anchor provenance across the existing higher cleanup-owner transition. */
const predecessor = `
    BEGIN
      -- Reservation arm needs no operation lock (parent is still future). The
      -- compatibility arm KEY SHAREs sheet/op/seq so a parent that appears after
      -- BEFORE INSERT cannot be deleted out from under COMMIT.
      IF EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = NEW.generation_id
           AND reservation.sheet_id = NEW.sheet_id
           AND reservation.source_vector_hash = NEW.source_vector_hash
           AND reservation.owner_kind = NEW.owner_kind
           AND reservation.owner_id = NEW.owner_id
           AND reservation.owner_fence = NEW.owner_fence
           AND reservation.ordinal = 10
           AND reservation.reservation_kind = 'archive_snapshot'
           AND reservation.operation_id = NEW.anchor_operation_id
           AND reservation.endpoint_seq = NEW.anchor_seq
      ) THEN
        RETURN NULL;
      END IF;

      PERFORM 1
        FROM public.meta_record_history_operations operation
       WHERE operation.sheet_id = NEW.sheet_id
         AND operation.operation_id = NEW.anchor_operation_id
         AND operation.endpoint_seq = NEW.anchor_seq
       FOR KEY SHARE;

      IF FOUND THEN
        RETURN NULL;
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'recovery_archive_binding_invalid';
    END
    `
const cleanupArm = `      -- Cleanup ownership is mutable; the reserved future anchor remains bound to its
      -- immutable original producer. This is referential integrity, not authorization.
      IF NEW.state = 'building' AND NEW.build_status = 'abandoned'
         AND NEW.coverage_status = 'incomplete' AND NEW.owner_kind = 'archive_cleanup'
         AND NEW.owner_fence > 1 AND NEW.owner_id IS NOT NULL
         AND length(btrim(NEW.owner_id)) > 0 AND NEW.lease_expires_at > clock_timestamp()
         AND EXISTS (
           SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
            WHERE r.generation_id = NEW.generation_id
            GROUP BY r.generation_id
           HAVING count(*) = 10
              AND array_agg(r.ordinal ORDER BY r.ordinal) = ARRAY[1,2,3,4,5,6,7,8,9,10]
              AND count(DISTINCT r.operation_id) = 10
              AND bool_and(r.sheet_id = NEW.sheet_id AND r.source_vector_hash = NEW.source_vector_hash
                AND r.owner_kind = 'archive_builder' AND r.owner_id = NEW.generation_id::text
                AND r.owner_fence = 1 AND r.created_at = NEW.created_at AND r.endpoint_seq > 0)
              AND count(DISTINCT r.reservation_kind) FILTER (WHERE r.ordinal < 10) = 1
              AND bool_and(r.reservation_kind IN ('section_bootstrap','section_checkpoint')) FILTER (WHERE r.ordinal < 10)
              AND array_agg(r.section_kind ORDER BY r.ordinal) FILTER (WHERE r.ordinal < 10)
                = ARRAY['schema','records','links','field_value_tombstones','link_tombstones',
                  'auto_number','attachments_index','permission_evidence','views_config']::text[]
              AND bool_and(r.endpoint_seq < NEW.anchor_seq) FILTER (WHERE r.ordinal < 10)
              AND bool_and(r.reservation_kind = 'archive_snapshot' AND r.section_kind IS NULL
                AND r.operation_id = NEW.anchor_operation_id AND r.endpoint_seq = NEW.anchor_seq)
                FILTER (WHERE r.ordinal = 10)
         ) THEN
        RETURN NULL;
      END IF;

`
const replacement = predecessor.replace('      PERFORM 1\n        FROM public.meta_record_history_operations operation',
  cleanupArm + '      PERFORM 1\n        FROM public.meta_record_history_operations operation')

const protectedFunctions = {
  'meta_recovery_archive_snapshot_reservation_guard_row': '11ea7f155ed57f3b0bb3d50f55ef8603',
  'meta_recovery_archive_snapshot_reservation_guard_set': 'fc90b6e6779b04e5fcfdc3897f0f13d5',
  'meta_recovery_archive_snapshot_reservation_guard_truncate': '48e046503ae96b2ae0cb4c9d54e00c71',
  'meta_recovery_archives_claim_anchor_guard_row': '1c5962ba357fa0bebaae23cd258b7bc5',
  'meta_recovery_archive_abandoned_cleanup_claim_guard_row': '2d446528a66f041caf10c112c24b0751',
  'meta_recovery_archives_claim_anchor_operation_delete_guard': '3b4da1ee807a3bb87e7a2c425367bda6',
} as const
const protectedTriggers = [
  ['meta_recovery_archives', 'trg_meta_recovery_archives_claim_anchor_reservation_guard', 'meta_recovery_archives_claim_anchor_reservation_guard', 21, true],
  ['meta_recovery_archive_snapshot_reservations', 'trg_mrasr_guard_row', 'meta_recovery_archive_snapshot_reservation_guard_row', 31, false],
  ['meta_recovery_archive_snapshot_reservations', 'trg_mrasr_guard_set', 'meta_recovery_archive_snapshot_reservation_guard_set', 5, true],
  ['meta_recovery_archive_snapshot_reservations', 'trg_mrasr_guard_truncate', 'meta_recovery_archive_snapshot_reservation_guard_truncate', 34, false],
  ['meta_recovery_archives', 'trg_meta_recovery_archives_claim_anchor_guard_row', 'meta_recovery_archives_claim_anchor_guard_row', 31, false],
  ['meta_recovery_archives', 'trg_meta_recovery_archive_abandoned_cleanup_claim_guard_row', 'meta_recovery_archive_abandoned_cleanup_claim_guard_row', 23, false],
  ['meta_record_history_operations', 'trg_mrho_claim_anchor_delete_guard', 'meta_recovery_archives_claim_anchor_operation_delete_guard', 11, false],
] as const

async function audit(db: Kysely<unknown>, expected: string): Promise<void> {
  const functions = [[ 'meta_recovery_archives_claim_anchor_reservation_guard', expected ],
    ...Object.entries(protectedFunctions)]
  for (const [name, body] of functions) {
    const result = await sql<{ valid: boolean }>`SELECT count(*)=1 AND bool_and(
      p.prorettype='trigger'::regtype AND p.pronargs=0 AND p.prokind='f'
      AND p.provolatile='v' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
      AND p.proparallel='u' AND p.provariadic=0 AND p.pronargdefaults=0
      AND p.proargtypes=''::oidvector AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
      AND CASE WHEN p.proname='meta_recovery_archives_claim_anchor_reservation_guard'
        THEN p.prosrc=${body} ELSE md5(p.prosrc)=${body} END) AS valid
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=${name}`.execute(db)
    if (result.rows[0]?.valid !== true) throw new Error('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_SCHEMA_DRIFT')
  }
  for (const [table, name, fn, kind, deferred] of protectedTriggers) {
    const result = await sql<{ valid: boolean }>`SELECT count(*)=1 AND bool_and(
      t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=${kind}
      AND t.tgdeferrable=${deferred} AND t.tginitdeferred=${deferred}
      AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgnargs=0 AND octet_length(t.tgargs)=0
      AND t.tgfoid=('public.'||${fn}||'()')::regprocedure
      AND CASE WHEN ${deferred} THEN t.tgconstraint<>0 ELSE t.tgconstraint=0 END) AS valid
      FROM pg_trigger t WHERE t.tgrelid=('public.'||${table})::regclass AND t.tgname=${name}`.execute(db)
    if (result.rows[0]?.valid !== true) throw new Error('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_SCHEMA_DRIFT')
  }
}

async function replace(db: Kysely<unknown>, body: string): Promise<void> {
  await sql.raw(`CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_reservation_guard()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, public AS $cleanup_anchor$${body}$cleanup_anchor$`).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE public.meta_recovery_archives, public.meta_recovery_archive_snapshot_reservations
    IN ACCESS EXCLUSIVE MODE`.execute(db)
  await audit(db, predecessor)
  await replace(db, replacement)
  await audit(db, replacement)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE public.meta_recovery_archives, public.meta_recovery_archive_snapshot_reservations
    IN ACCESS EXCLUSIVE MODE`.execute(db)
  await audit(db, replacement)
  const result = await sql<{ incompatible: boolean }>`SELECT EXISTS(
    SELECT 1 FROM public.meta_recovery_archives a WHERE NOT EXISTS(
      SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
      WHERE r.generation_id=a.generation_id AND r.sheet_id=a.sheet_id AND r.source_vector_hash=a.source_vector_hash
        AND r.owner_kind=a.owner_kind AND r.owner_id=a.owner_id AND r.owner_fence=a.owner_fence
        AND r.ordinal=10 AND r.reservation_kind='archive_snapshot'
        AND r.operation_id=a.anchor_operation_id AND r.endpoint_seq=a.anchor_seq)
    AND NOT EXISTS(SELECT 1 FROM public.meta_record_history_operations o
      WHERE o.sheet_id=a.sheet_id AND o.operation_id=a.anchor_operation_id AND o.endpoint_seq=a.anchor_seq)
  ) AS incompatible`.execute(db)
  if (result.rows[0]?.incompatible !== false) throw new Error('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_IN_USE')
  await replace(db, predecessor)
  await audit(db, predecessor)
}
