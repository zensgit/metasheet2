import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

const TABLES = [
  'elearning_offline_training_revisions',
  'elearning_offline_trainings',
  'elearning_offline_training_targets',
  'elearning_offline_training_members',
  'elearning_offline_publish_requests',
  'elearning_offline_qr_challenges',
  'elearning_offline_qr_requests',
  'elearning_offline_attendance_events',
  'elearning_offline_attendance_requests',
  'elearning_offline_training_status_events',
  'elearning_offline_training_status_requests',
] as const

const COLUMNS: Record<(typeof TABLES)[number], readonly string[]> = {
  elearning_offline_training_revisions: [
    'id', 'org_id', 'training_id', 'revision', 'title', 'location', 'attendance_mode',
    'created_by', 'created_at',
  ],
  elearning_offline_trainings: [
    'id', 'org_id', 'status', 'active_revision_id', 'created_by', 'created_at',
  ],
  elearning_offline_training_targets: [
    'id', 'org_id', 'training_id', 'revision_id', 'position', 'title', 'starts_at',
    'ends_at', 'check_in_opens_at', 'check_in_closes_at', 'check_out_opens_at',
    'check_out_closes_at', 'created_at',
  ],
  elearning_offline_training_members: [
    'id', 'org_id', 'training_id', 'revision_id', 'user_id', 'created_at',
  ],
  elearning_offline_publish_requests: [
    'org_id', 'request_id', 'request_hash', 'request_hash_version', 'training_id',
    'revision_id', 'created_at',
  ],
  elearning_offline_qr_challenges: [
    'id', 'org_id', 'training_id', 'revision_id', 'target_id', 'action', 'issued_by',
    'issued_at', 'expires_at', 'superseded_at', 'token_digest',
  ],
  elearning_offline_qr_requests: [
    'org_id', 'request_id', 'request_hash', 'request_hash_version', 'challenge_id',
    'created_at',
  ],
  elearning_offline_attendance_events: [
    'id', 'org_id', 'training_id', 'revision_id', 'target_id', 'user_id', 'action',
    'challenge_id', 'occurred_at',
  ],
  elearning_offline_attendance_requests: [
    'org_id', 'user_id', 'request_id', 'request_hash', 'request_hash_version',
    'event_id', 'created_at',
  ],
  elearning_offline_training_status_events: [
    'id', 'org_id', 'training_id', 'from_status', 'to_status', 'actor_id', 'reason',
    'changed_at',
  ],
  elearning_offline_training_status_requests: [
    'org_id', 'request_id', 'request_hash', 'request_hash_version', 'event_id', 'created_at',
  ],
}

const NULLABLE = new Set(['elearning_offline_qr_challenges.superseded_at'])

const UUID_COLUMNS = new Set([
  'elearning_offline_training_revisions.id',
  'elearning_offline_training_revisions.training_id',
  'elearning_offline_trainings.id',
  'elearning_offline_trainings.active_revision_id',
  'elearning_offline_training_targets.id',
  'elearning_offline_training_targets.training_id',
  'elearning_offline_training_targets.revision_id',
  'elearning_offline_training_members.id',
  'elearning_offline_training_members.training_id',
  'elearning_offline_training_members.revision_id',
  'elearning_offline_publish_requests.request_id',
  'elearning_offline_publish_requests.training_id',
  'elearning_offline_publish_requests.revision_id',
  'elearning_offline_qr_challenges.id',
  'elearning_offline_qr_challenges.training_id',
  'elearning_offline_qr_challenges.revision_id',
  'elearning_offline_qr_challenges.target_id',
  'elearning_offline_qr_requests.request_id',
  'elearning_offline_qr_requests.challenge_id',
  'elearning_offline_attendance_events.id',
  'elearning_offline_attendance_events.training_id',
  'elearning_offline_attendance_events.revision_id',
  'elearning_offline_attendance_events.target_id',
  'elearning_offline_attendance_events.challenge_id',
  'elearning_offline_attendance_requests.request_id',
  'elearning_offline_attendance_requests.event_id',
  'elearning_offline_training_status_events.id',
  'elearning_offline_training_status_events.training_id',
  'elearning_offline_training_status_requests.request_id',
  'elearning_offline_training_status_requests.event_id',
])

const INTEGER_COLUMNS = new Set([
  'elearning_offline_training_revisions.revision',
  'elearning_offline_training_targets.position',
  'elearning_offline_publish_requests.request_hash_version',
  'elearning_offline_qr_requests.request_hash_version',
  'elearning_offline_attendance_requests.request_hash_version',
  'elearning_offline_training_status_requests.request_hash_version',
])

const DEFAULTS = new Map<string, string>([
  ['elearning_offline_training_revisions.id', 'gen_random_uuid()'],
  ['elearning_offline_training_revisions.created_at', 'now()'],
  ['elearning_offline_trainings.status', "'active'::text"],
  ['elearning_offline_trainings.created_at', 'now()'],
  ['elearning_offline_training_targets.id', 'gen_random_uuid()'],
  ['elearning_offline_training_targets.created_at', 'now()'],
  ['elearning_offline_training_members.id', 'gen_random_uuid()'],
  ['elearning_offline_training_members.created_at', 'now()'],
  ['elearning_offline_publish_requests.created_at', 'now()'],
  ['elearning_offline_qr_requests.created_at', 'now()'],
  ['elearning_offline_attendance_requests.created_at', 'now()'],
  ['elearning_offline_training_status_events.changed_at', 'transaction_timestamp()'],
  ['elearning_offline_training_status_requests.created_at', 'now()'],
])

const EXPECTED_CONSTRAINTS = new Map<string, string>([
  ['elearning_offline_attendance_events_action_chk',
    `CHECK (action = ANY (ARRAY['check_in'::text, 'check_out'::text]))`],
  ['elearning_offline_attendance_events_challenge_fk',
    'FOREIGN KEY (org_id, challenge_id, training_id, revision_id, target_id, action) REFERENCES elearning_offline_qr_challenges(org_id, id, training_id, revision_id, target_id, action) ON DELETE RESTRICT'],
  ['elearning_offline_attendance_events_effect_uniq',
    'UNIQUE (org_id, revision_id, target_id, user_id, action)'],
  ['elearning_offline_attendance_events_member_fk',
    'FOREIGN KEY (org_id, revision_id, user_id) REFERENCES elearning_offline_training_members(org_id, revision_id, user_id) ON DELETE RESTRICT'],
  ['elearning_offline_attendance_events_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_attendance_events_org_user_id_uniq', 'UNIQUE (org_id, user_id, id)'],
  ['elearning_offline_attendance_events_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_attendance_requests_event_fk',
    'FOREIGN KEY (org_id, user_id, event_id) REFERENCES elearning_offline_attendance_events(org_id, user_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_attendance_requests_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_attendance_requests_hash_version_chk', 'CHECK (request_hash_version = 1)'],
  ['elearning_offline_attendance_requests_pkey', 'PRIMARY KEY (org_id, user_id, request_id)'],
  ['elearning_offline_status_events_actor_fk',
    'FOREIGN KEY (actor_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_status_events_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_status_events_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_status_events_reason_chk',
    `CHECK (btrim(reason) <> ''::text AND char_length(reason) <= 500)`],
  ['elearning_offline_status_events_training_fk',
    'FOREIGN KEY (org_id, training_id) REFERENCES elearning_offline_trainings(org_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_status_events_transition_chk',
    `CHECK (from_status = 'active'::text AND (to_status = ANY (ARRAY['archived'::text, 'withdrawn'::text])) OR from_status = 'archived'::text AND (to_status = ANY (ARRAY['active'::text, 'withdrawn'::text])) OR from_status = 'withdrawn'::text AND to_status = 'active'::text)`],
  ['elearning_offline_status_events_values_chk',
    `CHECK ((from_status = ANY (ARRAY['active'::text, 'archived'::text, 'withdrawn'::text])) AND (to_status = ANY (ARRAY['active'::text, 'archived'::text, 'withdrawn'::text])))`],
  ['elearning_offline_status_requests_event_fk',
    'FOREIGN KEY (org_id, event_id) REFERENCES elearning_offline_training_status_events(org_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_status_requests_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_status_requests_hash_version_chk', 'CHECK (request_hash_version = 1)'],
  ['elearning_offline_status_requests_pkey', 'PRIMARY KEY (org_id, request_id)'],
  ['elearning_offline_publish_requests_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_publish_requests_hash_version_chk', 'CHECK (request_hash_version = 1)'],
  ['elearning_offline_publish_requests_pkey', 'PRIMARY KEY (org_id, request_id)'],
  ['elearning_offline_publish_requests_revision_fk',
    'FOREIGN KEY (org_id, training_id, revision_id) REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_challenges_action_chk',
    `CHECK (action = ANY (ARRAY['check_in'::text, 'check_out'::text]))`],
  ['elearning_offline_challenges_actor_fk',
    'FOREIGN KEY (issued_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_challenges_context_uniq',
    'UNIQUE (org_id, id, training_id, revision_id, target_id, action)'],
  ['elearning_offline_challenges_digest_chk',
    `CHECK (token_digest ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_challenges_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_challenges_superseded_chk',
    'CHECK (superseded_at IS NULL OR superseded_at >= issued_at)'],
  ['elearning_offline_challenges_target_fk',
    'FOREIGN KEY (org_id, training_id, revision_id, target_id) REFERENCES elearning_offline_training_targets(org_id, training_id, revision_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_challenges_time_chk', 'CHECK (expires_at > issued_at)'],
  ['elearning_offline_challenges_token_digest_key', 'UNIQUE (token_digest)'],
  ['elearning_offline_challenges_ttl_chk',
    `CHECK (expires_at = (issued_at + '00:01:00'::interval))`],
  ['elearning_offline_qr_challenges_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_qr_requests_challenge_fk',
    'FOREIGN KEY (org_id, challenge_id) REFERENCES elearning_offline_qr_challenges(org_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_qr_requests_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_qr_requests_hash_version_chk', 'CHECK (request_hash_version = 1)'],
  ['elearning_offline_qr_requests_pkey', 'PRIMARY KEY (org_id, request_id)'],
  ['elearning_offline_members_member_uniq', 'UNIQUE (org_id, revision_id, user_id)'],
  ['elearning_offline_members_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_members_revision_fk',
    'FOREIGN KEY (org_id, training_id, revision_id) REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_members_user_fk',
    'FOREIGN KEY (user_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_training_members_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_revisions_actor_fk',
    'FOREIGN KEY (created_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_revisions_mode_chk',
    `CHECK (attendance_mode = ANY (ARRAY['training'::text, 'session'::text]))`],
  ['elearning_offline_revisions_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_revisions_org_training_id_uniq', 'UNIQUE (org_id, training_id, id)'],
  ['elearning_offline_revisions_revision_uniq', 'UNIQUE (org_id, training_id, revision)'],
  ['elearning_offline_revisions_text_chk',
    `CHECK (btrim(org_id) <> ''::text AND btrim(title) <> ''::text AND btrim(location) <> ''::text)`],
  ['elearning_offline_training_revisions_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_targets_context_uniq', 'UNIQUE (org_id, training_id, revision_id, id)'],
  ['elearning_offline_targets_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_targets_position_chk', 'CHECK ("position" > 0)'],
  ['elearning_offline_targets_position_uniq', 'UNIQUE (org_id, revision_id, "position")'],
  ['elearning_offline_targets_revision_fk',
    'FOREIGN KEY (org_id, training_id, revision_id) REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_targets_text_chk', `CHECK (btrim(title) <> ''::text)`],
  ['elearning_offline_targets_window_chk',
    'CHECK (ends_at > starts_at AND check_in_closes_at > check_in_opens_at AND check_out_closes_at > check_out_opens_at AND check_out_opens_at >= check_in_opens_at AND check_out_closes_at >= check_in_closes_at)'],
  ['elearning_offline_training_targets_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_trainings_active_revision_fk',
    'FOREIGN KEY (org_id, id, active_revision_id) REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_trainings_actor_fk',
    'FOREIGN KEY (created_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_trainings_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_offline_trainings_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_trainings_status_chk',
    `CHECK (status = ANY (ARRAY['active'::text, 'archived'::text, 'withdrawn'::text]))`],
  ['trg_elearning_offline_publish_authority', 'TRIGGER DEFERRABLE INITIALLY DEFERRED'],
])

const ACTIVE_CHALLENGE_INDEX = 'elearning_offline_challenges_active_uniq'

const TRIGGERS = [
  'trg_elearning_offline_revisions_immutable',
  'trg_elearning_offline_trainings_immutable',
  'trg_elearning_offline_targets_immutable',
  'trg_elearning_offline_members_immutable',
  'trg_elearning_offline_publish_requests_immutable',
  'trg_elearning_offline_qr_challenges_authority',
  'trg_elearning_offline_qr_requests_immutable',
  'trg_elearning_offline_attendance_events_immutable',
  'trg_elearning_offline_attendance_requests_immutable',
  'trg_elearning_offline_status_events_immutable',
  'trg_elearning_offline_status_requests_immutable',
  'trg_elearning_offline_revisions_truncate',
  'trg_elearning_offline_trainings_truncate',
  'trg_elearning_offline_targets_truncate',
  'trg_elearning_offline_members_truncate',
  'trg_elearning_offline_publish_requests_truncate',
  'trg_elearning_offline_qr_challenges_truncate',
  'trg_elearning_offline_qr_requests_truncate',
  'trg_elearning_offline_attendance_events_truncate',
  'trg_elearning_offline_attendance_requests_truncate',
  'trg_elearning_offline_status_events_truncate',
  'trg_elearning_offline_status_requests_truncate',
  'trg_elearning_offline_publish_authority',
  'trg_elearning_offline_attendance_authority',
] as const

const REJECT_CHANGE_BODY = `
BEGIN
  RAISE EXCEPTION 'elearning offline authoritative row is immutable' USING ERRCODE = '23514';
END
`

const CHALLENGE_AUTHORITY_BODY = `
BEGIN
  IF TG_OP <> 'UPDATE'
     OR OLD.superseded_at IS NOT NULL
     OR NEW.superseded_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.training_id IS DISTINCT FROM OLD.training_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest THEN
    RAISE EXCEPTION 'elearning offline challenge mutation rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
`

const TRAINING_HEAD_AUTHORITY_BODY = `
DECLARE
  event_id_text text;
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.active_revision_id IS DISTINCT FROM OLD.active_revision_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'elearning offline training head mutation rejected' USING ERRCODE = '23514';
  END IF;
  event_id_text := current_setting('metasheet.elearning_offline_status_event_id', true);
  IF NULLIF(event_id_text, '') IS NULL OR NOT EXISTS (
    SELECT 1 FROM elearning_offline_training_status_events event
    WHERE event.id = NULLIF(event_id_text, '')::uuid
      AND event.org_id = OLD.org_id
      AND event.training_id = OLD.id
      AND event.from_status = OLD.status
      AND event.to_status = NEW.status
      AND event.changed_at = transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'elearning offline training status authority missing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
`

const PUBLISH_AUTHORITY_BODY = `
DECLARE
  mode_value text;
  target_count integer;
  min_position integer;
  max_position integer;
  member_count integer;
BEGIN
  SELECT revision.attendance_mode,
         count(target.id)::integer,
         min(target.position)::integer,
         max(target.position)::integer
    INTO mode_value, target_count, min_position, max_position
  FROM elearning_offline_training_revisions revision
  LEFT JOIN elearning_offline_training_targets target
    ON target.org_id = revision.org_id AND target.training_id = revision.training_id
   AND target.revision_id = revision.id
  WHERE revision.org_id = NEW.org_id AND revision.training_id = NEW.id
    AND revision.id = NEW.active_revision_id
  GROUP BY revision.attendance_mode;

  SELECT count(*)::integer INTO member_count
  FROM elearning_offline_training_members member
  WHERE member.org_id = NEW.org_id AND member.training_id = NEW.id
    AND member.revision_id = NEW.active_revision_id;

  IF mode_value IS NULL
     OR member_count < 1
     OR target_count < 1
     OR min_position <> 1
     OR max_position <> target_count
     OR (mode_value = 'training' AND target_count <> 1)
     OR (mode_value = 'session' AND target_count > 100) THEN
    RAISE EXCEPTION 'elearning offline publish authority rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
`

const ATTENDANCE_AUTHORITY_BODY = `
DECLARE
  opens_at timestamptz;
  closes_at timestamptz;
BEGIN
  SELECT CASE WHEN NEW.action = 'check_in' THEN target.check_in_opens_at
              ELSE target.check_out_opens_at END,
         CASE WHEN NEW.action = 'check_in' THEN target.check_in_closes_at
              ELSE target.check_out_closes_at END
    INTO opens_at, closes_at
  FROM elearning_offline_qr_challenges challenge
  JOIN elearning_offline_training_targets target
    ON target.org_id = challenge.org_id
   AND target.training_id = challenge.training_id
   AND target.revision_id = challenge.revision_id
   AND target.id = challenge.target_id
  WHERE challenge.org_id = NEW.org_id AND challenge.id = NEW.challenge_id
    AND challenge.training_id = NEW.training_id
    AND challenge.revision_id = NEW.revision_id
    AND challenge.target_id = NEW.target_id
    AND challenge.action = NEW.action
    AND challenge.superseded_at IS NULL
    AND challenge.issued_at <= NEW.occurred_at
    AND challenge.expires_at > NEW.occurred_at
  FOR SHARE OF challenge, target;

  IF opens_at IS NULL OR NEW.occurred_at < opens_at OR NEW.occurred_at >= closes_at THEN
    RAISE EXCEPTION 'elearning offline attendance window rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'check_out' AND NOT EXISTS (
    SELECT 1 FROM elearning_offline_attendance_events prior
    WHERE prior.org_id = NEW.org_id AND prior.revision_id = NEW.revision_id
      AND prior.target_id = NEW.target_id AND prior.user_id = NEW.user_id
      AND prior.action = 'check_in' AND prior.occurred_at <= NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'elearning offline check-in required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
`

const FUNCTION_SOURCES = new Map<string, string>([
  ['elearning_offline_reject_change', REJECT_CHANGE_BODY],
  ['elearning_offline_challenge_authority', CHALLENGE_AUTHORITY_BODY],
  ['elearning_offline_training_head_authority', TRAINING_HEAD_AUTHORITY_BODY],
  ['elearning_offline_publish_authority', PUBLISH_AUTHORITY_BODY],
  ['elearning_offline_attendance_authority', ATTENDANCE_AUTHORITY_BODY],
])

function expectedColumnType(table: string, column: string): string {
  const key = `${table}.${column}`
  if (UUID_COLUMNS.has(key)) return 'uuid'
  if (INTEGER_COLUMNS.has(key)) return 'integer'
  if (column.endsWith('_at')) return 'timestamp with time zone'
  return 'text'
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{
    table_name: string
    column_name: string
    data_type: string
    is_nullable: 'YES' | 'NO'
    column_default: string | null
  }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  for (const table of TABLES) {
    const actual = columns.rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name)
      .sort()
    const expected = [...COLUMNS[table]].sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error('elearning offline training migration drift: column set')
    }
  }
  if (columns.rows.some((row) => {
    const key = `${row.table_name}.${row.column_name}`
    return row.data_type !== expectedColumnType(row.table_name, row.column_name)
      || row.is_nullable !== (NULLABLE.has(key) ? 'YES' : 'NO')
      || row.column_default !== (DEFAULTS.get(key) ?? null)
  })) throw new Error('elearning offline training migration drift: column authority')

  const constraints = await sql<{ conname: string; definition: string; validated: boolean }>`
    SELECT con.conname, pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS validated
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = current_schema()
      AND rel.relname = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  if (
    constraints.rows.length !== EXPECTED_CONSTRAINTS.size
    || constraints.rows.some((row) => (
      !row.validated || EXPECTED_CONSTRAINTS.get(row.conname) !== row.definition
    ))
  ) {
    throw new Error('elearning offline training migration drift: constraint set')
  }

  const indexes = await sql<{
    index_name: string
    constraint_name: string | null
    unique: boolean
    valid: boolean
    ready: boolean
    columns: string[]
    predicate: string | null
  }>`
    SELECT index_relation.relname AS index_name,
           constraint_row.conname AS constraint_name,
           index_row.indisunique AS unique,
           index_row.indisvalid AS valid,
           index_row.indisready AS ready,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = index_row.indrelid
              AND attribute.attnum = key.attnum
             WHERE key.position <= index_row.indnkeyatts
             ORDER BY key.position
           )::text[] AS columns,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
    FROM pg_index index_row
    JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_relation.relnamespace
    LEFT JOIN pg_constraint constraint_row
      ON constraint_row.conindid = index_row.indexrelid
     AND constraint_row.contype IN ('p', 'u')
    WHERE namespace_row.nspname = current_schema()
      AND table_relation.relname = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  const freeIndexes = indexes.rows.filter((row) => row.constraint_name === null)
  const activeIndex = freeIndexes[0]
  if (
    freeIndexes.length !== 1
    || !activeIndex
    || activeIndex.index_name !== ACTIVE_CHALLENGE_INDEX
    || !activeIndex.unique
    || !activeIndex.valid
    || !activeIndex.ready
    || activeIndex.columns.join('\0') !== 'org_id\0revision_id\0target_id\0action'
    || activeIndex.predicate !== '(superseded_at IS NULL)'
    || indexes.rows.some((row) => row.constraint_name !== null && !(
      EXPECTED_CONSTRAINTS.get(row.constraint_name)?.startsWith('PRIMARY KEY')
      || EXPECTED_CONSTRAINTS.get(row.constraint_name)?.startsWith('UNIQUE')
    ))
  ) throw new Error('elearning offline training migration drift: index set')

  const functions = await sql<{
    proname: string
    source: string
    language_name: string
    volatility: string
    kind: string
    leakproof: boolean
  }>`
    SELECT proc.proname, proc.prosrc AS source, language.lanname AS language_name,
           proc.provolatile AS volatility, proc.prokind AS kind,
           proc.proleakproof AS leakproof
    FROM pg_proc proc
    JOIN pg_namespace ns ON ns.oid = proc.pronamespace
    JOIN pg_language language ON language.oid = proc.prolang
    WHERE ns.nspname = current_schema()
      AND proc.proname = ANY(${sql.val([...FUNCTION_SOURCES.keys()])}::text[])
      AND proc.prorettype = 'trigger'::regtype
      AND proc.prosecdef = false
      AND proc.pronargs = 0
  `.execute(db)
  if (functions.rows.length !== FUNCTION_SOURCES.size || functions.rows.some((row) => (
    FUNCTION_SOURCES.get(row.proname) !== row.source
    || row.language_name !== 'plpgsql'
    || row.volatility !== 'v'
    || row.kind !== 'f'
    || row.leakproof
  ))) {
    throw new Error('elearning offline training migration drift: function set')
  }

  const triggers = await sql<{
    tgname: string
    tgenabled: string
    tgqual: unknown
    tgattr: string
    table_name: string
    tgtype: number
    function_name: string
    function_oid: string
    canonical_function_oid: string | null
    is_constraint: boolean
    deferrable: boolean
    initially_deferred: boolean
  }>`
    SELECT tg.tgname, tg.tgenabled, tg.tgqual, tg.tgattr::text,
           rel.relname AS table_name, tg.tgtype, proc.proname AS function_name,
           proc.oid::text AS function_oid,
           to_regprocedure(format('%I.%I()', current_schema(), proc.proname))::oid::text
             AS canonical_function_oid,
           tg.tgconstraint <> 0 AS is_constraint,
           tg.tgdeferrable AS deferrable,
           tg.tginitdeferred AS initially_deferred
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_proc proc ON proc.oid = tg.tgfoid
    WHERE ns.nspname = current_schema()
      AND NOT tg.tgisinternal
      AND rel.relname = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  const expectedTriggers = new Map<string, {
    table: string
    type: number
    fn: string
    constraint?: boolean
    deferrable?: boolean
    initiallyDeferred?: boolean
  }>([
    ['trg_elearning_offline_revisions_immutable', { table: 'elearning_offline_training_revisions', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_trainings_immutable', { table: 'elearning_offline_trainings', type: 27, fn: 'elearning_offline_training_head_authority' }],
    ['trg_elearning_offline_targets_immutable', { table: 'elearning_offline_training_targets', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_members_immutable', { table: 'elearning_offline_training_members', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_publish_requests_immutable', { table: 'elearning_offline_publish_requests', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_qr_challenges_authority', { table: 'elearning_offline_qr_challenges', type: 27, fn: 'elearning_offline_challenge_authority' }],
    ['trg_elearning_offline_qr_requests_immutable', { table: 'elearning_offline_qr_requests', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_attendance_events_immutable', { table: 'elearning_offline_attendance_events', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_attendance_requests_immutable', { table: 'elearning_offline_attendance_requests', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_status_events_immutable', { table: 'elearning_offline_training_status_events', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_status_requests_immutable', { table: 'elearning_offline_training_status_requests', type: 27, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_revisions_truncate', { table: 'elearning_offline_training_revisions', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_trainings_truncate', { table: 'elearning_offline_trainings', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_targets_truncate', { table: 'elearning_offline_training_targets', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_members_truncate', { table: 'elearning_offline_training_members', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_publish_requests_truncate', { table: 'elearning_offline_publish_requests', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_qr_challenges_truncate', { table: 'elearning_offline_qr_challenges', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_qr_requests_truncate', { table: 'elearning_offline_qr_requests', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_attendance_events_truncate', { table: 'elearning_offline_attendance_events', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_attendance_requests_truncate', { table: 'elearning_offline_attendance_requests', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_status_events_truncate', { table: 'elearning_offline_training_status_events', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_status_requests_truncate', { table: 'elearning_offline_training_status_requests', type: 34, fn: 'elearning_offline_reject_change' }],
    ['trg_elearning_offline_publish_authority', {
      table: 'elearning_offline_trainings',
      type: 5,
      fn: 'elearning_offline_publish_authority',
      constraint: true,
      deferrable: true,
      initiallyDeferred: true,
    }],
    ['trg_elearning_offline_attendance_authority', { table: 'elearning_offline_attendance_events', type: 7, fn: 'elearning_offline_attendance_authority' }],
  ])
  if (triggers.rows.length !== TRIGGERS.length || triggers.rows.some((row) => {
    const expected = expectedTriggers.get(row.tgname)
    return !expected
      || row.table_name !== expected.table
      || row.tgtype !== expected.type
      || row.function_name !== expected.fn
      || row.tgenabled !== 'O'
      || row.tgqual !== null
      || row.tgattr !== ''
      || row.function_oid !== row.canonical_function_oid
      || row.is_constraint !== (expected.constraint ?? false)
      || row.deferrable !== (expected.deferrable ?? false)
      || row.initially_deferred !== (expected.initiallyDeferred ?? false)
  })) throw new Error('elearning offline training migration drift: trigger set')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => checkTableExists(db, table)))
  if (existing.some(Boolean)) {
    if (!existing.every(Boolean)) throw new Error('elearning offline training migration drift: table set')
    await assertCanonical(db)
    return
  }
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE elearning_offline_training_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision integer NOT NULL,
      title text NOT NULL,
      location text NOT NULL,
      attendance_mode text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_revisions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_revisions_org_training_id_uniq UNIQUE (org_id, training_id, id),
      CONSTRAINT elearning_offline_revisions_revision_uniq UNIQUE (org_id, training_id, revision),
      CONSTRAINT elearning_offline_revisions_mode_chk CHECK (attendance_mode IN ('training', 'session')),
      CONSTRAINT elearning_offline_revisions_text_chk CHECK (
        btrim(org_id) <> '' AND btrim(title) <> '' AND btrim(location) <> ''
      ),
      CONSTRAINT elearning_offline_revisions_actor_fk FOREIGN KEY (created_by, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_trainings (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      active_revision_id uuid NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_trainings_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_trainings_active_revision_fk
        FOREIGN KEY (org_id, id, active_revision_id)
        REFERENCES elearning_offline_training_revisions(org_id, training_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_trainings_actor_fk FOREIGN KEY (created_by, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_trainings_status_chk CHECK (status IN ('active', 'archived', 'withdrawn'))
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_training_targets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      position integer NOT NULL,
      title text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      check_in_opens_at timestamptz NOT NULL,
      check_in_closes_at timestamptz NOT NULL,
      check_out_opens_at timestamptz NOT NULL,
      check_out_closes_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_targets_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_targets_context_uniq
        UNIQUE (org_id, training_id, revision_id, id),
      CONSTRAINT elearning_offline_targets_position_uniq UNIQUE (org_id, revision_id, position),
      CONSTRAINT elearning_offline_targets_revision_fk
        FOREIGN KEY (org_id, training_id, revision_id)
        REFERENCES elearning_offline_training_revisions(org_id, training_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_targets_position_chk CHECK (position > 0),
      CONSTRAINT elearning_offline_targets_window_chk CHECK (
        ends_at > starts_at
        AND check_in_closes_at > check_in_opens_at
        AND check_out_closes_at > check_out_opens_at
        AND check_out_opens_at >= check_in_opens_at
        AND check_out_closes_at >= check_in_closes_at
      ),
      CONSTRAINT elearning_offline_targets_text_chk CHECK (btrim(title) <> '')
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_training_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_members_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_members_member_uniq UNIQUE (org_id, revision_id, user_id),
      CONSTRAINT elearning_offline_members_revision_fk
        FOREIGN KEY (org_id, training_id, revision_id)
        REFERENCES elearning_offline_training_revisions(org_id, training_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_members_user_fk FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_publish_requests (
      org_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_publish_requests_pkey PRIMARY KEY (org_id, request_id),
      CONSTRAINT elearning_offline_publish_requests_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_offline_publish_requests_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_offline_publish_requests_revision_fk
        FOREIGN KEY (org_id, training_id, revision_id)
        REFERENCES elearning_offline_training_revisions(org_id, training_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_qr_challenges (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      target_id uuid NOT NULL,
      action text NOT NULL,
      issued_by text NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      superseded_at timestamptz,
      token_digest text NOT NULL,
      CONSTRAINT elearning_offline_challenges_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_challenges_context_uniq
        UNIQUE (org_id, id, training_id, revision_id, target_id, action),
      CONSTRAINT elearning_offline_challenges_token_digest_key UNIQUE (token_digest),
      CONSTRAINT elearning_offline_challenges_target_fk
        FOREIGN KEY (org_id, training_id, revision_id, target_id)
        REFERENCES elearning_offline_training_targets(org_id, training_id, revision_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_challenges_actor_fk FOREIGN KEY (issued_by, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_challenges_action_chk CHECK (action IN ('check_in', 'check_out')),
      CONSTRAINT elearning_offline_challenges_time_chk CHECK (expires_at > issued_at),
      CONSTRAINT elearning_offline_challenges_ttl_chk CHECK (expires_at = issued_at + interval '60 seconds'),
      CONSTRAINT elearning_offline_challenges_superseded_chk CHECK (
        superseded_at IS NULL OR superseded_at >= issued_at
      ),
      CONSTRAINT elearning_offline_challenges_digest_chk CHECK (token_digest ~ '^[0-9a-f]{64}$')
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX elearning_offline_challenges_active_uniq
      ON elearning_offline_qr_challenges(org_id, revision_id, target_id, action)
      WHERE superseded_at IS NULL
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_qr_requests (
      org_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      challenge_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_qr_requests_pkey PRIMARY KEY (org_id, request_id),
      CONSTRAINT elearning_offline_qr_requests_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_offline_qr_requests_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_offline_qr_requests_challenge_fk FOREIGN KEY (org_id, challenge_id)
        REFERENCES elearning_offline_qr_challenges(org_id, id) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_attendance_events (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      target_id uuid NOT NULL,
      user_id text NOT NULL,
      action text NOT NULL,
      challenge_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      CONSTRAINT elearning_offline_attendance_events_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_attendance_events_org_user_id_uniq UNIQUE (org_id, user_id, id),
      CONSTRAINT elearning_offline_attendance_events_effect_uniq
        UNIQUE (org_id, revision_id, target_id, user_id, action),
      CONSTRAINT elearning_offline_attendance_events_challenge_fk
        FOREIGN KEY (org_id, challenge_id, training_id, revision_id, target_id, action)
        REFERENCES elearning_offline_qr_challenges(org_id, id, training_id, revision_id, target_id, action)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_attendance_events_member_fk
        FOREIGN KEY (org_id, revision_id, user_id)
        REFERENCES elearning_offline_training_members(org_id, revision_id, user_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_attendance_events_action_chk CHECK (action IN ('check_in', 'check_out'))
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_attendance_requests (
      org_id text NOT NULL,
      user_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      event_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_attendance_requests_pkey PRIMARY KEY (org_id, user_id, request_id),
      CONSTRAINT elearning_offline_attendance_requests_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_offline_attendance_requests_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_offline_attendance_requests_event_fk FOREIGN KEY (org_id, user_id, event_id)
        REFERENCES elearning_offline_attendance_events(org_id, user_id, id) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_training_status_events (
      id uuid NOT NULL,
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      from_status text NOT NULL,
      to_status text NOT NULL,
      actor_id text NOT NULL,
      reason text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT elearning_offline_status_events_pkey PRIMARY KEY (id),
      CONSTRAINT elearning_offline_status_events_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_offline_status_events_training_fk
        FOREIGN KEY (org_id, training_id)
        REFERENCES elearning_offline_trainings(org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_status_events_actor_fk FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_status_events_values_chk CHECK (
        from_status IN ('active', 'archived', 'withdrawn')
        AND to_status IN ('active', 'archived', 'withdrawn')
      ),
      CONSTRAINT elearning_offline_status_events_transition_chk CHECK (
        (from_status = 'active' AND to_status IN ('archived', 'withdrawn'))
        OR (from_status = 'archived' AND to_status IN ('active', 'withdrawn'))
        OR (from_status = 'withdrawn' AND to_status = 'active')
      ),
      CONSTRAINT elearning_offline_status_events_reason_chk CHECK (
        btrim(reason) <> '' AND char_length(reason) <= 500
      )
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_training_status_requests (
      org_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      event_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_status_requests_pkey PRIMARY KEY (org_id, request_id),
      CONSTRAINT elearning_offline_status_requests_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_offline_status_requests_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_offline_status_requests_event_fk FOREIGN KEY (org_id, event_id)
        REFERENCES elearning_offline_training_status_events(org_id, id) ON DELETE RESTRICT
    )
  `.execute(db)

  for (const [name, body] of FUNCTION_SOURCES) {
    await sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger
      LANGUAGE plpgsql AS $fn$${body}$fn$`).execute(db)
  }

  for (const [table, trigger] of [
    ['elearning_offline_training_revisions', 'trg_elearning_offline_revisions_immutable'],
    ['elearning_offline_training_targets', 'trg_elearning_offline_targets_immutable'],
    ['elearning_offline_training_members', 'trg_elearning_offline_members_immutable'],
    ['elearning_offline_publish_requests', 'trg_elearning_offline_publish_requests_immutable'],
    ['elearning_offline_qr_requests', 'trg_elearning_offline_qr_requests_immutable'],
    ['elearning_offline_attendance_events', 'trg_elearning_offline_attendance_events_immutable'],
    ['elearning_offline_attendance_requests', 'trg_elearning_offline_attendance_requests_immutable'],
    ['elearning_offline_training_status_events', 'trg_elearning_offline_status_events_immutable'],
    ['elearning_offline_training_status_requests', 'trg_elearning_offline_status_requests_immutable'],
  ] as const) {
    await sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()`).execute(db)
    await sql.raw(`CREATE TRIGGER ${trigger.replace('_immutable', '_truncate')}
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_offline_reject_change()`).execute(db)
  }
  await sql`
    CREATE TRIGGER trg_elearning_offline_trainings_immutable
    BEFORE UPDATE OR DELETE ON elearning_offline_trainings
    FOR EACH ROW EXECUTE FUNCTION elearning_offline_training_head_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_offline_trainings_truncate
    BEFORE TRUNCATE ON elearning_offline_trainings
    FOR EACH STATEMENT EXECUTE FUNCTION elearning_offline_reject_change()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_offline_qr_challenges_authority
    BEFORE UPDATE OR DELETE ON elearning_offline_qr_challenges
    FOR EACH ROW EXECUTE FUNCTION elearning_offline_challenge_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_offline_qr_challenges_truncate
    BEFORE TRUNCATE ON elearning_offline_qr_challenges
    FOR EACH STATEMENT EXECUTE FUNCTION elearning_offline_reject_change()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_elearning_offline_publish_authority
    AFTER INSERT ON elearning_offline_trainings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION elearning_offline_publish_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_offline_attendance_authority
    BEFORE INSERT ON elearning_offline_attendance_events
    FOR EACH ROW EXECUTE FUNCTION elearning_offline_attendance_authority()
  `.execute(db)
  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => checkTableExists(db, table)))
  if (!existing.some(Boolean)) return
  if (!existing.every(Boolean)) throw new Error('elearning offline training rollback drift: table set')
  const counts = await sql<{ occupied: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM elearning_offline_training_revisions
      UNION ALL SELECT 1 FROM elearning_offline_trainings
      UNION ALL SELECT 1 FROM elearning_offline_training_targets
      UNION ALL SELECT 1 FROM elearning_offline_training_members
      UNION ALL SELECT 1 FROM elearning_offline_publish_requests
      UNION ALL SELECT 1 FROM elearning_offline_qr_challenges
      UNION ALL SELECT 1 FROM elearning_offline_qr_requests
      UNION ALL SELECT 1 FROM elearning_offline_attendance_events
      UNION ALL SELECT 1 FROM elearning_offline_attendance_requests
      UNION ALL SELECT 1 FROM elearning_offline_training_status_events
      UNION ALL SELECT 1 FROM elearning_offline_training_status_requests
    ) AS occupied
  `.execute(db)
  if (counts.rows[0]?.occupied) throw new Error('elearning offline training rollback refused: authoritative rows exist')
  for (const table of [...TABLES].reverse()) {
    await sql.raw(`DROP TABLE ${table}`).execute(db)
  }
  for (const name of [...FUNCTION_SOURCES.keys()].reverse()) {
    await sql.raw(`DROP FUNCTION ${name}()`).execute(db)
  }
}
