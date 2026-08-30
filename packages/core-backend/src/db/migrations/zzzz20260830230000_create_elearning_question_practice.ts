import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

const TABLES = [
  'elearning_practice_sets',
  'elearning_practice_sessions',
  'elearning_practice_session_questions',
  'elearning_practice_answers',
  'elearning_wrong_question_events',
] as const

const COLUMNS: Record<(typeof TABLES)[number], readonly string[]> = {
  elearning_practice_sets: [
    'id', 'org_id', 'paper_id', 'title', 'status', 'source_key', 'request_hash',
    'request_hash_version', 'created_by', 'created_at',
  ],
  elearning_practice_sessions: [
    'id', 'org_id', 'user_id', 'practice_set_id', 'mode', 'source_key',
    'request_hash', 'request_hash_version', 'created_at',
  ],
  elearning_practice_session_questions: [
    'id', 'org_id', 'session_id', 'paper_question_id', 'question_id',
    'question_revision_id', 'source_position', 'position', 'points', 'created_at',
  ],
  elearning_practice_answers: [
    'id', 'org_id', 'user_id', 'session_id', 'session_question_id',
    'selected_option_ids', 'correct', 'source_key', 'request_hash',
    'request_hash_version', 'created_at',
  ],
  elearning_wrong_question_events: [
    'id', 'org_id', 'user_id', 'practice_set_id', 'question_id',
    'question_revision_id', 'session_id', 'answer_id', 'event_kind',
    'created_at',
  ],
}

const CONSTRAINTS = [
  'elearning_practice_sets_org_id_id_uniq',
  'elearning_practice_sets_request_uniq',
  'elearning_practice_sets_paper_fk',
  'elearning_practice_sets_actor_fk',
  'elearning_practice_sets_status_chk',
  'elearning_practice_sets_text_chk',
  'elearning_practice_sets_request_hash_version_chk',
  'elearning_practice_sessions_org_id_id_uniq',
  'elearning_practice_sessions_request_uniq',
  'elearning_practice_sessions_set_fk',
  'elearning_practice_sessions_member_fk',
  'elearning_practice_sessions_mode_chk',
  'elearning_practice_sessions_text_chk',
  'elearning_practice_sessions_request_hash_version_chk',
  'elearning_practice_session_questions_org_id_id_uniq',
  'elearning_practice_session_questions_org_session_id_uniq',
  'elearning_practice_session_questions_org_session_position_uniq',
  'elearning_practice_session_questions_org_session_revision_uniq',
  'elearning_practice_session_questions_session_fk',
  'elearning_practice_session_questions_paper_question_fk',
  'elearning_practice_session_questions_revision_fk',
  'elearning_practice_session_questions_position_chk',
  'elearning_practice_session_questions_points_chk',
  'elearning_practice_answers_org_id_id_uniq',
  'elearning_practice_answers_request_uniq',
  'elearning_practice_answers_question_uniq',
  'elearning_practice_answers_session_question_fk',
  'elearning_practice_answers_member_fk',
  'elearning_practice_answers_selected_chk',
  'elearning_practice_answers_text_chk',
  'elearning_practice_answers_request_hash_version_chk',
  'elearning_wrong_question_events_org_id_id_uniq',
  'elearning_wrong_question_events_answer_uniq',
  'elearning_wrong_question_events_answer_fk',
  'elearning_wrong_question_events_revision_fk',
  'elearning_wrong_question_events_member_fk',
  'elearning_wrong_question_events_kind_chk',
] as const

const CRITICAL_CONSTRAINT_DEFINITIONS = new Map<string, string>([
  ['elearning_practice_sets_request_uniq', 'UNIQUE (org_id, source_key)'],
  ['elearning_practice_sets_paper_fk', 'FOREIGN KEY (org_id, paper_id) REFERENCES elearning_papers(org_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_sets_actor_fk', 'FOREIGN KEY (created_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_practice_sessions_request_uniq', 'UNIQUE (org_id, user_id, source_key)'],
  ['elearning_practice_sessions_set_fk', 'FOREIGN KEY (org_id, practice_set_id) REFERENCES elearning_practice_sets(org_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_sessions_member_fk', 'FOREIGN KEY (user_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_practice_session_questions_org_session_position_uniq', 'UNIQUE (org_id, session_id, "position")'],
  ['elearning_practice_session_questions_org_session_revision_uniq', 'UNIQUE (org_id, session_id, question_revision_id)'],
  ['elearning_practice_session_questions_session_fk', 'FOREIGN KEY (org_id, session_id) REFERENCES elearning_practice_sessions(org_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_session_questions_paper_question_fk', 'FOREIGN KEY (org_id, paper_question_id) REFERENCES elearning_paper_questions(org_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_session_questions_revision_fk', 'FOREIGN KEY (org_id, question_id, question_revision_id) REFERENCES elearning_question_revisions(org_id, question_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_answers_request_uniq', 'UNIQUE (org_id, user_id, source_key)'],
  ['elearning_practice_answers_question_uniq', 'UNIQUE (org_id, session_id, session_question_id)'],
  ['elearning_practice_answers_session_question_fk', 'FOREIGN KEY (org_id, session_id, session_question_id) REFERENCES elearning_practice_session_questions(org_id, session_id, id) ON DELETE RESTRICT'],
  ['elearning_practice_answers_member_fk', 'FOREIGN KEY (user_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_wrong_question_events_answer_uniq', 'UNIQUE (org_id, answer_id)'],
  ['elearning_wrong_question_events_answer_fk', 'FOREIGN KEY (org_id, answer_id) REFERENCES elearning_practice_answers(org_id, id) ON DELETE RESTRICT'],
  ['elearning_wrong_question_events_revision_fk', 'FOREIGN KEY (org_id, question_id, question_revision_id) REFERENCES elearning_question_revisions(org_id, question_id, id) ON DELETE RESTRICT'],
  ['elearning_wrong_question_events_member_fk', 'FOREIGN KEY (user_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
])

const FUNCTION_DIGESTS = new Map<string, string>([
  ['elearning_practice_sets_authority', '0d0b02a878ebad09c6a52e1aeb9952db'],
  ['elearning_practice_sessions_immutable', '09d82caf8fc6eaeccf1fd332a60cb100'],
  ['elearning_practice_session_questions_authority', '6117cdbf75ba84de265df42e5afaf8ae'],
  ['elearning_practice_answers_authority', '1aa331ec7f603756967fbb59605804e5'],
  ['elearning_wrong_question_events_authority', 'ccf6808964247da00f6954dd70945bd4'],
])

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{
    table_name: string
    column_name: string
    is_nullable: 'YES' | 'NO'
  }>`
    SELECT table_name, column_name, is_nullable
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
    if (actual.length !== expected.length
      || actual.some((column, index) => column !== expected[index])) {
      throw new Error('elearning practice migration drift: column set')
    }
  }
  if (columns.rows.some((row) => row.is_nullable !== 'NO')) {
    throw new Error('elearning practice migration drift: column nullability')
  }

  const constraints = await sql<{ conname: string; definition: string }>`
    SELECT con.conname, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = current_schema()
      AND rel.relname = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  const names = new Set(constraints.rows.map((row) => row.conname))
  if (CONSTRAINTS.some((name) => !names.has(name))) {
    throw new Error('elearning practice migration drift: constraint set')
  }
  if (constraints.rows.some((row) => {
    const expected = CRITICAL_CONSTRAINT_DEFINITIONS.get(row.conname)
    return expected !== undefined && row.definition !== expected
  })) {
    throw new Error('elearning practice migration drift: constraint definition')
  }

  const functions = await sql<{ function_name: string; source_digest: string }>`
    SELECT proc.proname AS function_name, md5(proc.prosrc) AS source_digest
    FROM pg_proc proc
    JOIN pg_namespace ns ON ns.oid = proc.pronamespace
    WHERE ns.nspname = current_schema()
      AND proc.proname = ANY(${sql.val([...FUNCTION_DIGESTS.keys()])}::text[])
      AND proc.prorettype = 'trigger'::regtype
      AND proc.prosecdef = false
      AND proc.pronargs = 0
  `.execute(db)
  if (functions.rows.length !== FUNCTION_DIGESTS.size || functions.rows.some((row) => (
    FUNCTION_DIGESTS.get(row.function_name) !== row.source_digest
  ))) {
    throw new Error('elearning practice migration drift: function definition')
  }

  const triggers = await sql<{
    tgname: string
    table_name: string
    tgtype: number
    tgenabled: string
    tgqual: unknown
    tgattr: string
    function_name: string
  }>`
    SELECT tg.tgname, rel.relname AS table_name, tg.tgtype, tg.tgenabled,
           tg.tgqual, tg.tgattr::text,
           function_rel.proname AS function_name
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_proc function_rel ON function_rel.oid = tg.tgfoid
    WHERE ns.nspname = current_schema()
      AND NOT tg.tgisinternal
      AND tg.tgname = ANY(${sql.val([
        'trg_elearning_practice_sets_authority',
        'trg_elearning_practice_sessions_immutable',
        'trg_elearning_practice_session_questions_authority',
        'trg_elearning_practice_answers_authority',
        'trg_elearning_wrong_question_events_authority',
      ])}::text[])
  `.execute(db)
  const expectedTriggers = new Map<string, { table: string; type: number; fn: string }>([
    ['trg_elearning_practice_sets_authority', {
      table: 'elearning_practice_sets', type: 31, fn: 'elearning_practice_sets_authority',
    }],
    ['trg_elearning_practice_sessions_immutable', {
      table: 'elearning_practice_sessions', type: 27, fn: 'elearning_practice_sessions_immutable',
    }],
    ['trg_elearning_practice_session_questions_authority', {
      table: 'elearning_practice_session_questions', type: 31,
      fn: 'elearning_practice_session_questions_authority',
    }],
    ['trg_elearning_practice_answers_authority', {
      table: 'elearning_practice_answers', type: 31, fn: 'elearning_practice_answers_authority',
    }],
    ['trg_elearning_wrong_question_events_authority', {
      table: 'elearning_wrong_question_events', type: 31,
      fn: 'elearning_wrong_question_events_authority',
    }],
  ])
  if (triggers.rows.length !== expectedTriggers.size || triggers.rows.some((row) => {
    const expected = expectedTriggers.get(row.tgname)
    return !expected
      || row.table_name !== expected.table
      || row.tgtype !== expected.type
      || row.function_name !== expected.fn
      || row.tgenabled !== 'O'
      || row.tgqual !== null
      || row.tgattr !== ''
  })) {
    throw new Error('elearning practice migration drift: trigger set')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => checkTableExists(db, table)))
  if (existing.some(Boolean)) {
    if (!existing.every(Boolean)) throw new Error('elearning practice migration drift: table set')
    await assertCanonical(db)
    return
  }

  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE elearning_practice_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      paper_id uuid NOT NULL,
      title text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_practice_sets_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_practice_sets_request_uniq UNIQUE (org_id, source_key),
      CONSTRAINT elearning_practice_sets_status_chk CHECK (status = 'active'),
      CONSTRAINT elearning_practice_sets_text_chk CHECK (
        btrim(org_id) <> '' AND btrim(title) <> '' AND btrim(source_key) <> ''
        AND btrim(created_by) <> '' AND request_hash ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT elearning_practice_sets_request_hash_version_chk
        CHECK (request_hash_version = 1),
      CONSTRAINT elearning_practice_sets_paper_fk FOREIGN KEY (org_id, paper_id)
        REFERENCES elearning_papers (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_practice_sets_actor_fk FOREIGN KEY (created_by, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_practice_sessions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      practice_set_id uuid NOT NULL,
      mode text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_practice_sessions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_practice_sessions_request_uniq UNIQUE (org_id, user_id, source_key),
      CONSTRAINT elearning_practice_sessions_mode_chk CHECK (mode IN ('sequential', 'random', 'wrong_book')),
      CONSTRAINT elearning_practice_sessions_text_chk CHECK (
        btrim(org_id) <> '' AND btrim(user_id) <> '' AND btrim(source_key) <> ''
        AND request_hash ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT elearning_practice_sessions_request_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_practice_sessions_set_fk FOREIGN KEY (org_id, practice_set_id)
        REFERENCES elearning_practice_sets (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_practice_sessions_member_fk FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_practice_session_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      session_id uuid NOT NULL,
      paper_question_id uuid NOT NULL,
      question_id uuid NOT NULL,
      question_revision_id uuid NOT NULL,
      source_position integer NOT NULL,
      position integer NOT NULL,
      points integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_practice_session_questions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_practice_session_questions_org_session_id_uniq UNIQUE (org_id, session_id, id),
      CONSTRAINT elearning_practice_session_questions_org_session_position_uniq UNIQUE (org_id, session_id, position),
      CONSTRAINT elearning_practice_session_questions_org_session_revision_uniq UNIQUE (org_id, session_id, question_revision_id),
      CONSTRAINT elearning_practice_session_questions_position_chk CHECK (source_position >= 1 AND position >= 1),
      CONSTRAINT elearning_practice_session_questions_points_chk CHECK (points >= 0),
      CONSTRAINT elearning_practice_session_questions_session_fk FOREIGN KEY (org_id, session_id)
        REFERENCES elearning_practice_sessions (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_practice_session_questions_paper_question_fk FOREIGN KEY (org_id, paper_question_id)
        REFERENCES elearning_paper_questions (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_practice_session_questions_revision_fk FOREIGN KEY (org_id, question_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, question_id, id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_practice_answers (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      session_id uuid NOT NULL,
      session_question_id uuid NOT NULL,
      selected_option_ids jsonb NOT NULL,
      correct boolean NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_practice_answers_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_practice_answers_request_uniq UNIQUE (org_id, user_id, source_key),
      CONSTRAINT elearning_practice_answers_question_uniq UNIQUE (org_id, session_id, session_question_id),
      CONSTRAINT elearning_practice_answers_selected_chk CHECK (jsonb_typeof(selected_option_ids) = 'array'),
      CONSTRAINT elearning_practice_answers_text_chk CHECK (
        btrim(org_id) <> '' AND btrim(user_id) <> '' AND btrim(source_key) <> ''
        AND request_hash ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT elearning_practice_answers_request_hash_version_chk CHECK (request_hash_version = 1),
      CONSTRAINT elearning_practice_answers_session_question_fk FOREIGN KEY (org_id, session_id, session_question_id)
        REFERENCES elearning_practice_session_questions (org_id, session_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_practice_answers_member_fk FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_wrong_question_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      practice_set_id uuid NOT NULL,
      question_id uuid NOT NULL,
      question_revision_id uuid NOT NULL,
      session_id uuid NOT NULL,
      answer_id uuid NOT NULL,
      event_kind text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_wrong_question_events_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_wrong_question_events_answer_uniq UNIQUE (org_id, answer_id),
      CONSTRAINT elearning_wrong_question_events_kind_chk CHECK (event_kind IN ('wrong', 'resolved')),
      CONSTRAINT elearning_wrong_question_events_answer_fk FOREIGN KEY (org_id, answer_id)
        REFERENCES elearning_practice_answers (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_wrong_question_events_revision_fk FOREIGN KEY (org_id, question_id, question_revision_id)
        REFERENCES elearning_question_revisions (org_id, question_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_wrong_question_events_member_fk FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_wrong_question_events_latest
      ON elearning_wrong_question_events
      (org_id, user_id, practice_set_id, question_revision_id, created_at DESC, id DESC)
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_practice_sets_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE paper_status text; item_count integer; min_position integer; max_position integer; objective_count integer;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'elearning_practice_sets is immutable';
      END IF;
      SELECT status INTO paper_status FROM elearning_papers
       WHERE org_id = NEW.org_id AND id = NEW.paper_id FOR SHARE;
      IF paper_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'elearning practice paper must be published';
      END IF;
      SELECT count(*), min(pq.position), max(pq.position),
             count(*) FILTER (WHERE qr.question_type IN ('single_choice','multiple_choice','true_false'))
        INTO item_count, min_position, max_position, objective_count
        FROM elearning_paper_questions pq
        JOIN elearning_question_revisions qr
          ON qr.org_id = pq.org_id AND qr.id = pq.question_revision_id
       WHERE pq.org_id = NEW.org_id AND pq.paper_id = NEW.paper_id;
      IF item_count < 1 OR min_position IS DISTINCT FROM 1
         OR max_position IS DISTINCT FROM item_count OR objective_count IS DISTINCT FROM item_count THEN
        RAISE EXCEPTION 'elearning practice requires a dense objective paper';
      END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_practice_sets_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_practice_sets
      FOR EACH ROW EXECUTE FUNCTION elearning_practice_sets_authority()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_practice_sessions_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'elearning_practice_sessions is immutable';
    END $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_practice_sessions_immutable
      BEFORE UPDATE OR DELETE ON elearning_practice_sessions
      FOR EACH ROW EXECUTE FUNCTION elearning_practice_sessions_immutable()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_practice_session_questions_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE binding_ok boolean;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'elearning_practice_session_questions is immutable';
      END IF;
      SELECT true INTO binding_ok
      FROM elearning_practice_sessions session
      JOIN elearning_practice_sets practice
        ON practice.org_id = session.org_id AND practice.id = session.practice_set_id
      JOIN elearning_paper_questions item
        ON item.org_id = practice.org_id AND item.paper_id = practice.paper_id
       AND item.id = NEW.paper_question_id
       AND item.question_id = NEW.question_id
       AND item.question_revision_id = NEW.question_revision_id
       AND item.position = NEW.source_position
       AND item.points = NEW.points
      WHERE session.org_id = NEW.org_id AND session.id = NEW.session_id
      FOR SHARE OF session, practice, item;
      IF binding_ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'elearning practice session question binding unavailable';
      END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_practice_session_questions_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_practice_session_questions
      FOR EACH ROW EXECUTE FUNCTION elearning_practice_session_questions_authority()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_practice_answers_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE owner_ok boolean;
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'elearning_practice_answers is immutable'; END IF;
      SELECT true INTO owner_ok
      FROM elearning_practice_sessions session
      JOIN elearning_practice_session_questions item
        ON item.org_id = session.org_id AND item.session_id = session.id AND item.id = NEW.session_question_id
      WHERE session.org_id = NEW.org_id AND session.id = NEW.session_id AND session.user_id = NEW.user_id
      FOR SHARE OF session, item;
      IF owner_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'elearning practice answer binding unavailable'; END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_practice_answers_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_practice_answers
      FOR EACH ROW EXECUTE FUNCTION elearning_practice_answers_authority()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_wrong_question_events_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE answer_ok boolean;
    BEGIN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'elearning_wrong_question_events is immutable'; END IF;
      SELECT true INTO answer_ok
      FROM elearning_practice_answers answer
      JOIN elearning_practice_sessions session
        ON session.org_id = answer.org_id AND session.id = answer.session_id
      JOIN elearning_practice_session_questions item
        ON item.org_id = answer.org_id AND item.id = answer.session_question_id
      WHERE answer.org_id = NEW.org_id AND answer.id = NEW.answer_id
        AND answer.user_id = NEW.user_id AND answer.session_id = NEW.session_id
        AND session.practice_set_id = NEW.practice_set_id
        AND item.question_id = NEW.question_id AND item.question_revision_id = NEW.question_revision_id
        AND ((answer.correct = false AND NEW.event_kind = 'wrong')
          OR (answer.correct = true AND NEW.event_kind = 'resolved'))
      FOR SHARE OF answer, session, item;
      IF answer_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'elearning wrong event binding unavailable'; END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_wrong_question_events_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_wrong_question_events
      FOR EACH ROW EXECUTE FUNCTION elearning_wrong_question_events_authority()
  `.execute(db)

  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    if (!(await checkTableExists(db, table))) continue
    const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(table)}`.execute(db)
    if (count.rows[0]?.count !== '0') {
      throw new Error('elearning practice down refused: authoritative rows exist')
    }
  }
  await sql`DROP TABLE IF EXISTS elearning_wrong_question_events`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_practice_answers`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_practice_session_questions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_practice_sessions`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_practice_sets`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_wrong_question_events_authority()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_practice_answers_authority()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_practice_session_questions_authority()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_practice_sessions_immutable()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_practice_sets_authority()`.execute(db)
}
