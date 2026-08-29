import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export const ELEARNING_CONTENT_RUNTIME_TABLES = [
  'elearning_content_revisions',
  'elearning_content_revision_requests',
  'elearning_content_course_publish_requests',
  'elearning_open_completion_events',
  'elearning_open_completion_requests',
] as const

const CONTENT_IMMUTABLE_FUNCTION = 'elearning_content_reject_immutable_write'
const COMPLETION_IMMUTABLE_FUNCTION = 'elearning_completion_evidence_deny_mutation'
const COURSE_STATE_FUNCTION = 'elearning_course_versions_state_guard'
const COURSE_STATE_TRIGGER = 'trg_elearning_course_versions_state_guard'

export const CONTENT_IMMUTABLE_ROW_TRIGGERS = [
  { table: 'elearning_content_revisions', name: 'trg_elearning_content_revisions_immutable', fn: CONTENT_IMMUTABLE_FUNCTION },
  { table: 'elearning_content_revision_requests', name: 'trg_elearning_content_revision_requests_immutable', fn: CONTENT_IMMUTABLE_FUNCTION },
  { table: 'elearning_content_course_publish_requests', name: 'trg_elearning_content_course_publish_requests_immutable', fn: CONTENT_IMMUTABLE_FUNCTION },
  { table: 'elearning_open_completion_events', name: 'trg_elearning_open_completion_events_immutable', fn: CONTENT_IMMUTABLE_FUNCTION },
  { table: 'elearning_open_completion_requests', name: 'trg_elearning_open_completion_requests_immutable', fn: CONTENT_IMMUTABLE_FUNCTION },
  { table: 'elearning_completion_evidence', name: 'trg_elearning_completion_evidence_deny_mutation', fn: COMPLETION_IMMUTABLE_FUNCTION },
] as const

export const CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS = [
  { table: 'elearning_content_revisions', name: 'trg_elearning_content_revisions_no_truncate' },
  { table: 'elearning_content_revision_requests', name: 'trg_elearning_content_revision_requests_no_truncate' },
  { table: 'elearning_content_course_publish_requests', name: 'trg_elearning_content_course_publish_requests_no_truncate' },
  { table: 'elearning_open_completion_events', name: 'trg_elearning_open_completion_events_no_truncate' },
  { table: 'elearning_open_completion_requests', name: 'trg_elearning_open_completion_requests_no_truncate' },
  { table: 'elearning_completion_evidence', name: 'trg_elearning_completion_evidence_no_truncate' },
] as const

const NEW_ITEM_COLUMNS = [
  'article_revision_id',
  'external_link_revision_id',
  'canonical_content_revision_id',
] as const

const NEW_EVIDENCE_COLUMNS = [
  'item_type',
  'content_revision_id',
  'open_event_id',
  'completion_assurance',
] as const

function ownedColumn(
  table: string,
  name: string,
  type: string,
  notNull: boolean,
  expression: string | null = null,
  generated = '',
) {
  return { table, name, type, notNull, generated, expression }
}

const OWNED_COLUMN_DEFINITIONS = [
  ownedColumn('elearning_course_version_items', 'article_revision_id', 'uuid', false),
  ownedColumn('elearning_course_version_items', 'external_link_revision_id', 'uuid', false),
  ownedColumn(
    'elearning_course_version_items',
    'canonical_content_revision_id',
    'uuid',
    false,
    `CASE
      WHEN item_type = 'article'::text THEN article_revision_id
      WHEN item_type = 'external_link'::text THEN external_link_revision_id
      ELSE NULL::uuid
    END`,
    's',
  ),
  ownedColumn('elearning_completion_evidence', 'item_type', 'text', true),
  ownedColumn('elearning_completion_evidence', 'content_revision_id', 'uuid', false),
  ownedColumn('elearning_completion_evidence', 'open_event_id', 'uuid', false),
  ownedColumn('elearning_completion_evidence', 'completion_assurance', 'text', false),

  ownedColumn('elearning_content_revisions', 'id', 'uuid', true),
  ownedColumn('elearning_content_revisions', 'org_id', 'text', true),
  ownedColumn('elearning_content_revisions', 'item_type', 'text', true),
  ownedColumn('elearning_content_revisions', 'title', 'text', true),
  ownedColumn('elearning_content_revisions', 'article_html', 'text', false),
  ownedColumn('elearning_content_revisions', 'external_url', 'text', false),
  ownedColumn('elearning_content_revisions', 'content_digest', 'text', true),
  ownedColumn('elearning_content_revisions', 'created_by', 'text', true),
  ownedColumn('elearning_content_revisions', 'created_at', 'timestamp with time zone', true, 'now()'),

  ownedColumn('elearning_content_revision_requests', 'id', 'uuid', true),
  ownedColumn('elearning_content_revision_requests', 'org_id', 'text', true),
  ownedColumn('elearning_content_revision_requests', 'source_key', 'uuid', true),
  ownedColumn('elearning_content_revision_requests', 'request_hash', 'text', true),
  ownedColumn('elearning_content_revision_requests', 'request_hash_version', 'smallint', true),
  ownedColumn('elearning_content_revision_requests', 'content_revision_id', 'uuid', true),
  ownedColumn('elearning_content_revision_requests', 'actor_id', 'text', true),
  ownedColumn('elearning_content_revision_requests', 'created_at', 'timestamp with time zone', true, 'now()'),

  ownedColumn('elearning_content_course_publish_requests', 'id', 'uuid', true),
  ownedColumn('elearning_content_course_publish_requests', 'org_id', 'text', true),
  ownedColumn('elearning_content_course_publish_requests', 'source_key', 'uuid', true),
  ownedColumn('elearning_content_course_publish_requests', 'request_hash', 'text', true),
  ownedColumn('elearning_content_course_publish_requests', 'request_hash_version', 'smallint', true),
  ownedColumn('elearning_content_course_publish_requests', 'course_id', 'uuid', true),
  ownedColumn('elearning_content_course_publish_requests', 'course_version_id', 'uuid', true),
  ownedColumn('elearning_content_course_publish_requests', 'item_count', 'integer', true),
  ownedColumn('elearning_content_course_publish_requests', 'actor_id', 'text', true),
  ownedColumn('elearning_content_course_publish_requests', 'created_at', 'timestamp with time zone', true, 'now()'),

  ownedColumn('elearning_open_completion_events', 'id', 'uuid', true),
  ownedColumn('elearning_open_completion_events', 'org_id', 'text', true),
  ownedColumn('elearning_open_completion_events', 'user_id', 'text', true),
  ownedColumn('elearning_open_completion_events', 'course_version_id', 'uuid', true),
  ownedColumn('elearning_open_completion_events', 'course_version_item_id', 'uuid', true),
  ownedColumn('elearning_open_completion_events', 'item_type', 'text', true),
  ownedColumn('elearning_open_completion_events', 'content_revision_id', 'uuid', true),
  ownedColumn('elearning_open_completion_events', 'event_kind', 'text', true),
  ownedColumn('elearning_open_completion_events', 'event_digest', 'text', true),
  ownedColumn('elearning_open_completion_events', 'server_received_at', 'timestamp with time zone', true),
  ownedColumn('elearning_open_completion_events', 'created_at', 'timestamp with time zone', true, 'now()'),

  ownedColumn('elearning_open_completion_requests', 'id', 'uuid', true),
  ownedColumn('elearning_open_completion_requests', 'org_id', 'text', true),
  ownedColumn('elearning_open_completion_requests', 'user_id', 'text', true),
  ownedColumn('elearning_open_completion_requests', 'source_key', 'uuid', true),
  ownedColumn('elearning_open_completion_requests', 'course_version_item_id', 'uuid', true),
  ownedColumn('elearning_open_completion_requests', 'request_hash', 'text', true),
  ownedColumn('elearning_open_completion_requests', 'request_hash_version', 'smallint', true),
  ownedColumn('elearning_open_completion_requests', 'event_id', 'uuid', true),
  ownedColumn('elearning_open_completion_requests', 'completion_evidence_id', 'uuid', true),
  ownedColumn('elearning_open_completion_requests', 'created_at', 'timestamp with time zone', true, 'now()'),
] as const

const CONTENT_CHECK_DEFINITIONS = [
  {
    table: 'elearning_content_revisions',
    name: 'elearning_content_revisions_item_type_chk',
    definition: `CHECK (
      item_type = ANY (ARRAY['article'::text, 'external_link'::text])
    )`,
  },
  {
    table: 'elearning_content_revisions',
    name: 'elearning_content_revisions_title_chk',
    definition: `CHECK (btrim(title) <> ''::text AND char_length(title) <= 200)`,
  },
  {
    table: 'elearning_content_revisions',
    name: 'elearning_content_revisions_shape_chk',
    definition: `CHECK (
      item_type = 'article'::text
      AND article_html IS NOT NULL
      AND btrim(article_html) <> ''::text
      AND char_length(article_html) <= 1000000
      AND external_url IS NULL
      OR item_type = 'external_link'::text
      AND article_html IS NULL
      AND external_url IS NOT NULL
      AND btrim(external_url) <> ''::text
      AND char_length(external_url) <= 2048
    )`,
  },
  {
    table: 'elearning_content_revisions',
    name: 'elearning_content_revisions_digest_chk',
    definition: `CHECK (content_digest ~ '^[0-9a-f]{64}$'::text)`,
  },
  {
    table: 'elearning_content_revisions',
    name: 'elearning_content_revisions_created_by_chk',
    definition: `CHECK (btrim(created_by) <> ''::text)`,
  },
  {
    table: 'elearning_content_revision_requests',
    name: 'elearning_content_revision_requests_hash_chk',
    definition: `CHECK (
      request_hash ~ '^[0-9a-f]{64}$'::text AND request_hash_version > 0
    )`,
  },
  {
    table: 'elearning_content_revision_requests',
    name: 'elearning_content_revision_requests_actor_chk',
    definition: `CHECK (btrim(actor_id) <> ''::text)`,
  },
  {
    table: 'elearning_content_course_publish_requests',
    name: 'elearning_content_course_publish_requests_hash_chk',
    definition: `CHECK (
      request_hash ~ '^[0-9a-f]{64}$'::text AND request_hash_version > 0
    )`,
  },
  {
    table: 'elearning_content_course_publish_requests',
    name: 'elearning_content_course_publish_requests_item_count_chk',
    definition: `CHECK (item_count >= 1 AND item_count <= 10000)`,
  },
  {
    table: 'elearning_content_course_publish_requests',
    name: 'elearning_content_course_publish_requests_actor_chk',
    definition: `CHECK (btrim(actor_id) <> ''::text)`,
  },
  {
    table: 'elearning_course_version_items',
    name: 'elearning_course_version_items_item_type_chk',
    definition: `CHECK (
      item_type = ANY (
        ARRAY['video'::text, 'exam'::text, 'article'::text, 'external_link'::text]
      )
    )`,
  },
  {
    table: 'elearning_course_version_items',
    name: 'elearning_course_version_items_item_shape_chk',
    definition: `CHECK (
      item_type = 'video'::text
      AND media_id IS NOT NULL
      AND exam_id IS NULL
      AND article_revision_id IS NULL
      AND external_link_revision_id IS NULL
      OR item_type = 'exam'::text
      AND media_id IS NULL
      AND exam_id IS NOT NULL
      AND article_revision_id IS NULL
      AND external_link_revision_id IS NULL
      OR item_type = 'article'::text
      AND media_id IS NULL
      AND exam_id IS NULL
      AND article_revision_id IS NOT NULL
      AND external_link_revision_id IS NULL
      OR item_type = 'external_link'::text
      AND media_id IS NULL
      AND exam_id IS NULL
      AND article_revision_id IS NULL
      AND external_link_revision_id IS NOT NULL
    )`,
  },
  {
    table: 'elearning_course_version_items',
    name: 'elearning_course_version_items_position_chk',
    definition: `CHECK ("position" >= 1 AND "position" <= 10000)`,
  },
  {
    table: 'elearning_course_version_items',
    name: 'elearning_course_version_items_completion_policy_chk',
    definition: `CHECK (
      item_type = 'video'::text
      AND completion_policy_version IS NOT NULL
      AND completion_policy_version = 'video-v1-90pct'::text
      AND completion_threshold_bps IS NOT NULL
      AND completion_threshold_bps = 9000
      OR item_type = 'exam'::text
      AND completion_policy_version IS NULL
      AND completion_threshold_bps IS NULL
      OR item_type = 'article'::text
      AND completion_policy_version IS NOT NULL
      AND completion_policy_version = 'article-open-v1'::text
      AND completion_threshold_bps IS NULL
      OR item_type = 'external_link'::text
      AND completion_policy_version IS NOT NULL
      AND completion_policy_version = 'external-link-launch-v1'::text
      AND completion_threshold_bps IS NULL
    )`,
  },
  {
    table: 'elearning_open_completion_events',
    name: 'elearning_open_completion_events_user_chk',
    definition: `CHECK (btrim(user_id) <> ''::text)`,
  },
  {
    table: 'elearning_open_completion_events',
    name: 'elearning_open_completion_events_digest_chk',
    definition: `CHECK (event_digest ~ '^[0-9a-f]{64}$'::text)`,
  },
  {
    table: 'elearning_open_completion_events',
    name: 'elearning_open_completion_events_shape_chk',
    definition: `CHECK (
      item_type = 'article'::text AND event_kind = 'article_open'::text
      OR item_type = 'external_link'::text AND event_kind = 'external_link_launch'::text
    )`,
  },
  {
    table: 'elearning_completion_evidence',
    name: 'elearning_completion_evidence_item_type_shape_chk',
    definition: `CHECK (
      item_type = 'video'::text
      AND completion_policy_version = 'video-v1-90pct'::text
      AND completion_threshold_bps = 9000
      AND media_duration_ms IS NOT NULL
      AND media_duration_ms > 0
      AND effective_ms IS NOT NULL
      AND effective_ms >= 0
      AND max_position_ms IS NOT NULL
      AND max_position_ms >= 0
      AND content_revision_id IS NULL
      AND open_event_id IS NULL
      AND completion_assurance IS NULL
      OR item_type = 'article'::text
      AND completion_policy_version = 'article-open-v1'::text
      AND completion_threshold_bps IS NULL
      AND media_duration_ms IS NULL
      AND effective_ms IS NULL
      AND max_position_ms IS NULL
      AND content_revision_id IS NOT NULL
      AND open_event_id IS NOT NULL
      AND completion_assurance = 'weak_server_recorded_open'::text
      OR item_type = 'external_link'::text
      AND completion_policy_version = 'external-link-launch-v1'::text
      AND completion_threshold_bps IS NULL
      AND media_duration_ms IS NULL
      AND effective_ms IS NULL
      AND max_position_ms IS NULL
      AND content_revision_id IS NOT NULL
      AND open_event_id IS NOT NULL
      AND completion_assurance = 'weak_server_recorded_launch'::text
    )`,
  },
  {
    table: 'elearning_open_completion_requests',
    name: 'elearning_open_completion_requests_hash_chk',
    definition: `CHECK (
      request_hash ~ '^[0-9a-f]{64}$'::text AND request_hash_version > 0
    )`,
  },
  {
    table: 'elearning_open_completion_requests',
    name: 'elearning_open_completion_requests_user_chk',
    definition: `CHECK (btrim(user_id) <> ''::text)`,
  },
] as const

const CONTENT_IMMUTABLE_BODY = `
BEGIN
  RAISE EXCEPTION 'ELEARNING_CONTENT_IMMUTABLE';
END;
`.trim()

export const ELEARNING_CONTENT_COURSE_STATE_BODY = `
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'elearning_course_versions must be inserted as draft';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'elearning_course_versions cannot be deleted after publish';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION 'elearning_course_versions identity fields are immutable';
  END IF;

  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'elearning_course_versions audit fields are immutable';
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    IF OLD.status = 'draft' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'elearning_course_versions in status % are immutable', OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM elearning_course_version_items
       WHERE org_id = NEW.org_id
         AND course_version_id = NEW.id
      HAVING (
        count(*) = 2
        AND count(*) FILTER (WHERE item_type = 'video') = 1
        AND count(*) FILTER (WHERE item_type = 'exam') = 1
      ) OR (
        count(*) >= 1
        AND count(*) FILTER (
          WHERE item_type IN ('article', 'external_link')
        ) = count(*)
      )
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: unsupported item family';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM elearning_course_version_items i
        LEFT JOIN elearning_media m
          ON m.org_id = i.org_id AND m.id = i.media_id
       WHERE i.org_id = NEW.org_id
         AND i.course_version_id = NEW.id
         AND i.item_type = 'video'
         AND m.status IS DISTINCT FROM 'ready'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: video items require media status ready';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM elearning_course_version_items i
        LEFT JOIN elearning_exams e
          ON e.org_id = i.org_id AND e.id = i.exam_id
       WHERE i.org_id = NEW.org_id
         AND i.course_version_id = NEW.id
         AND i.item_type = 'exam'
         AND e.status IS DISTINCT FROM 'published'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: exam items require exam status published';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM elearning_course_version_items i
        LEFT JOIN elearning_content_revisions r
          ON r.org_id = i.org_id
         AND r.id = i.article_revision_id
         AND r.item_type = i.item_type
       WHERE i.org_id = NEW.org_id
         AND i.course_version_id = NEW.id
         AND i.item_type = 'article'
         AND r.id IS NULL
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: article items require verified revisions';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM elearning_course_version_items i
        LEFT JOIN elearning_content_revisions r
          ON r.org_id = i.org_id
         AND r.id = i.external_link_revision_id
         AND r.item_type = i.item_type
       WHERE i.org_id = NEW.org_id
         AND i.course_version_id = NEW.id
         AND i.item_type = 'external_link'
         AND r.id IS NULL
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: external link items require verified revisions';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' AND NEW.status = 'retired' THEN
    IF NEW.title IS DISTINCT FROM OLD.title THEN
      RAISE EXCEPTION 'cannot mutate published course version content when retiring';
    END IF;
    PERFORM 1
      FROM elearning_courses
     WHERE org_id = NEW.org_id
       AND id = NEW.course_id
     FOR UPDATE;
    IF EXISTS (
      SELECT 1
        FROM elearning_courses
       WHERE org_id = NEW.org_id
         AND id = NEW.course_id
         AND active_version_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'cannot retire course version while it is the course active_version_id';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'elearning_course_versions illegal status transition: % -> %', OLD.status, NEW.status;
END;
`.trim()

const LEGACY_COURSE_STATE_BODY = `
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'elearning_course_versions must be inserted as draft';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'elearning_course_versions cannot be deleted after publish';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION 'elearning_course_versions identity fields are immutable';
  END IF;

  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'elearning_course_versions audit fields are immutable';
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    IF OLD.status = 'draft' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'elearning_course_versions in status % are immutable', OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM elearning_course_version_items
       WHERE org_id = NEW.org_id AND course_version_id = NEW.id AND item_type = 'video'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: at least one video item is required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM elearning_course_version_items
       WHERE org_id = NEW.org_id AND course_version_id = NEW.id AND item_type = 'exam'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: at least one exam item is required';
    END IF;
    IF EXISTS (
      SELECT 1 FROM elearning_course_version_items i
      LEFT JOIN elearning_media m ON m.org_id = i.org_id AND m.id = i.media_id
       WHERE i.org_id = NEW.org_id AND i.course_version_id = NEW.id
         AND i.item_type = 'video' AND m.status IS DISTINCT FROM 'ready'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: video items require media status ready';
    END IF;
    IF EXISTS (
      SELECT 1 FROM elearning_course_version_items i
      LEFT JOIN elearning_exams e ON e.org_id = i.org_id AND e.id = i.exam_id
       WHERE i.org_id = NEW.org_id AND i.course_version_id = NEW.id
         AND i.item_type = 'exam' AND e.status IS DISTINCT FROM 'published'
    ) THEN
      RAISE EXCEPTION 'cannot publish course version: exam items require exam status published';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' AND NEW.status = 'retired' THEN
    IF NEW.title IS DISTINCT FROM OLD.title THEN
      RAISE EXCEPTION 'cannot mutate published course version content when retiring';
    END IF;
    PERFORM 1 FROM elearning_courses
     WHERE org_id = NEW.org_id AND id = NEW.course_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM elearning_courses
       WHERE org_id = NEW.org_id AND id = NEW.course_id AND active_version_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'cannot retire course version while it is the course active_version_id';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'elearning_course_versions illegal status transition: % -> %', OLD.status, NEW.status;
END;
`.trim()

function canonicalizeDefinition(value: string): string {
  let result = ''
  let inLiteral = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "'") {
      result += character
      if (inLiteral && value[index + 1] === "'") {
        result += value[index + 1]
        index += 1
      } else {
        inLiteral = !inLiteral
      }
    } else if (inLiteral) {
      result += character
    } else if (!/\s/.test(character)) {
      result += character.toLowerCase()
    }
  }
  return result
}

function drift(detail: string): never {
  throw new Error(`elearning content runtime migration drift: ${detail}`)
}

async function tableSet(db: Kysely<unknown>): Promise<Set<string>> {
  const result = await sql<{ name: string }>`
    SELECT table_name AS name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY(${sql.val([...ELEARNING_CONTENT_RUNTIME_TABLES])}::text[])
  `.execute(db)
  return new Set(result.rows.map((row) => row.name))
}

async function columnSet(
  db: Kysely<unknown>,
  table: string,
  names: readonly string[],
): Promise<Set<string>> {
  const result = await sql<{ name: string }>`
    SELECT column_name AS name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${table}
       AND column_name = ANY(${sql.val([...names])}::text[])
  `.execute(db)
  return new Set(result.rows.map((row) => row.name))
}

async function assertOwnedColumns(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    table: string
    name: string
    type: string
    not_null: boolean
    generated: string
    expression: string | null
  }>`
    SELECT table_row.relname AS table,
           attribute.attname AS name,
           format_type(attribute.atttypid, attribute.atttypmod) AS type,
           attribute.attnotnull AS not_null,
           attribute.attgenerated::text AS generated,
           pg_get_expr(default_row.adbin, default_row.adrelid, true) AS expression
      FROM pg_attribute attribute
      JOIN pg_class table_row ON table_row.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_attrdef default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
     WHERE namespace.nspname = current_schema()
       AND NOT attribute.attisdropped
       AND (table_row.relname, attribute.attname) IN (
         SELECT * FROM unnest(
           ${sql.val(OWNED_COLUMN_DEFINITIONS.map((row) => row.table))}::text[],
           ${sql.val(OWNED_COLUMN_DEFINITIONS.map((row) => row.name))}::text[]
         )
       )
  `.execute(db)
  for (const required of OWNED_COLUMN_DEFINITIONS) {
    const matches = result.rows.filter((row) => (
      row.table === required.table && row.name === required.name
    ))
    const actual = matches[0]
    if (
      matches.length !== 1
      || !actual
      || actual.type !== required.type
      || actual.not_null !== required.notNull
      || actual.generated !== required.generated
      || (actual.expression === null) !== (required.expression === null)
      || (
        actual.expression !== null
        && required.expression !== null
        && canonicalizeDefinition(actual.expression)
          !== canonicalizeDefinition(required.expression)
      )
    ) drift(`${required.table}.${required.name}`)
  }
}

async function assertConstraintColumns(
  db: Kysely<unknown>,
  input: {
    table: string
    name: string
    type: 'f' | 'p' | 'u'
    columns: string[]
    referencedTable?: string
    referencedColumns?: string[]
  },
): Promise<void> {
  const result = await sql<{
    type: string
    columns: string[]
    referenced_table: string | null
    referenced_columns: string[] | null
    validated: boolean
    delete_action: string
    update_action: string
    match_type: string
    deferrable: boolean
    deferred: boolean
  }>`
    SELECT
      constraint_row.contype::text AS type,
      ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] AS columns,
      referenced_table.relname AS referenced_table,
      CASE WHEN constraint_row.confkey IS NULL THEN NULL ELSE ARRAY(
        SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key.attnum
         ORDER BY key.position
      )::text[] END AS referenced_columns,
      constraint_row.convalidated AS validated,
      constraint_row.confdeltype::text AS delete_action,
      constraint_row.confupdtype::text AS update_action,
      constraint_row.confmatchtype::text AS match_type,
      constraint_row.condeferrable AS deferrable,
      constraint_row.condeferred AS deferred
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = ${input.table}
       AND constraint_row.conname = ${input.name}
  `.execute(db)
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || row.type !== input.type
    || row.columns.join('\0') !== input.columns.join('\0')
    || row.referenced_table !== (input.referencedTable ?? null)
    || (row.referenced_columns ?? []).join('\0')
      !== (input.referencedColumns ?? []).join('\0')
    || !row.validated
    || row.deferrable
    || row.deferred
    || (input.type === 'f' && (
      row.delete_action !== 'r'
      || row.update_action !== 'a'
      || row.match_type !== 's'
    ))
  ) drift(input.name)
}

async function assertNamedChecks(
  db: Kysely<unknown>,
  expected: readonly { table: string; name: string; definition: string }[],
): Promise<void> {
  const result = await sql<{
    table: string
    name: string
    validated: boolean
    definition: string
  }>`
    SELECT table_row.relname AS table,
           constraint_row.conname AS name,
           constraint_row.convalidated AS validated,
           pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
     WHERE namespace.nspname = current_schema()
       AND constraint_row.contype = 'c'
       AND (table_row.relname, constraint_row.conname) IN (
         SELECT * FROM unnest(
           ${sql.val(expected.map((row) => row.table))}::text[],
           ${sql.val(expected.map((row) => row.name))}::text[]
         )
       )
  `.execute(db)
  for (const required of expected) {
    const matches = result.rows.filter((row) => (
      row.table === required.table && row.name === required.name
    ))
    const actual = matches[0]
    if (
      matches.length !== 1
      || !actual
      || !actual.validated
      || canonicalizeDefinition(actual.definition)
        !== canonicalizeDefinition(required.definition)
    ) drift(required.name)
  }
}

async function assertFunction(
  db: Kysely<unknown>,
  name: string,
  body: string,
): Promise<void> {
  const result = await sql<{
    language: string
    result_type: string
    source: string
    security_definer: boolean
  }>`
    SELECT language_row.lanname AS language,
           function_row.prorettype::regtype::text AS result_type,
           function_row.prosrc AS source,
           function_row.prosecdef AS security_definer
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace.nspname = current_schema()
       AND function_row.proname = ${name}
       AND function_row.pronargs = 0
  `.execute(db)
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || row.language !== 'plpgsql'
    || row.result_type !== 'trigger'
    || row.security_definer
    || canonicalizeDefinition(row.source) !== canonicalizeDefinition(body)
  ) drift(`${name} function`)
}

async function assertTriggers(db: Kysely<unknown>): Promise<void> {
  const expected = [
    ...CONTENT_IMMUTABLE_ROW_TRIGGERS.map((row) => ({ ...row, type: 27 })),
    ...CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS.map((row) => ({
      ...row,
      fn: CONTENT_IMMUTABLE_FUNCTION,
      type: 34,
    })),
  ]
  const result = await sql<{
    table: string
    name: string
    type: number
    enabled: string
    attr: string
    has_qualifier: boolean
    function_name: string
    function_in_schema: boolean
  }>`
    SELECT table_row.relname AS table,
           trigger_row.tgname AS name,
           trigger_row.tgtype::int AS type,
           trigger_row.tgenabled AS enabled,
           trigger_row.tgattr::text AS attr,
           trigger_row.tgqual IS NOT NULL AS has_qualifier,
           function_row.proname AS function_name,
           function_row.pronamespace = namespace.oid AS function_in_schema
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = current_schema()
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgname = ANY(${sql.val(expected.map((row) => row.name))}::text[])
     ORDER BY table_row.relname, trigger_row.tgname
  `.execute(db)
  const actual = result.rows.map((row) => ({
    attr: row.attr,
    enabled: row.enabled,
    fn: row.function_name,
    functionInSchema: row.function_in_schema,
    hasQualifier: row.has_qualifier,
    name: row.name,
    table: row.table,
    type: row.type,
  }))
  const required = expected
    .map((row) => ({
      attr: '',
      enabled: 'O',
      fn: row.fn,
      functionInSchema: true,
      hasQualifier: false,
      name: row.name,
      table: row.table,
      type: row.type,
    }))
    .sort((left, right) => `${left.table}:${left.name}`.localeCompare(`${right.table}:${right.name}`))
  if (JSON.stringify(actual) !== JSON.stringify(required)) drift('immutable triggers')
}

async function assertCourseStateAuthority(db: Kysely<unknown>): Promise<void> {
  await assertFunction(db, COURSE_STATE_FUNCTION, ELEARNING_CONTENT_COURSE_STATE_BODY)
  const result = await sql<{
    type: number
    enabled: string
    attr: string
    has_qualifier: boolean
    function_name: string
    function_in_schema: boolean
  }>`
    SELECT trigger_row.tgtype::int AS type,
           trigger_row.tgenabled AS enabled,
           trigger_row.tgattr::text AS attr,
           trigger_row.tgqual IS NOT NULL AS has_qualifier,
           function_row.proname AS function_name,
           function_row.pronamespace = namespace.oid AS function_in_schema
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace.nspname = current_schema()
       AND table_row.relname = 'elearning_course_versions'
       AND trigger_row.tgname = ${COURSE_STATE_TRIGGER}
       AND NOT trigger_row.tgisinternal
  `.execute(db)
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || row.type !== 31
    || row.enabled !== 'O'
    || row.attr !== ''
    || row.has_qualifier
    || row.function_name !== COURSE_STATE_FUNCTION
    || !row.function_in_schema
  ) drift('course state trigger')
}

async function assertSchema(db: Kysely<unknown>): Promise<void> {
  const tables = await tableSet(db)
  if (ELEARNING_CONTENT_RUNTIME_TABLES.some((table) => !tables.has(table))) {
    drift('object set')
  }
  const itemColumns = await columnSet(db, 'elearning_course_version_items', NEW_ITEM_COLUMNS)
  const evidenceColumns = await columnSet(db, 'elearning_completion_evidence', NEW_EVIDENCE_COLUMNS)
  if (
    NEW_ITEM_COLUMNS.some((column) => !itemColumns.has(column))
    || NEW_EVIDENCE_COLUMNS.some((column) => !evidenceColumns.has(column))
  ) drift('amended columns')
  await assertOwnedColumns(db)

  for (const constraint of [
    {
      table: 'elearning_content_revisions',
      name: 'elearning_content_revisions_pkey',
      type: 'p' as const,
      columns: ['id'],
    },
    {
      table: 'elearning_content_revisions',
      name: 'elearning_content_revisions_org_id_id_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id'],
    },
    {
      table: 'elearning_content_revisions',
      name: 'elearning_content_revisions_org_id_id_type_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_content_revision_requests',
      name: 'elearning_content_revision_requests_pkey',
      type: 'p' as const,
      columns: ['id'],
    },
    {
      table: 'elearning_content_revision_requests',
      name: 'elearning_content_revision_requests_org_id_id_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id'],
    },
    {
      table: 'elearning_content_revision_requests',
      name: 'elearning_content_revision_requests_org_source_uniq',
      type: 'u' as const,
      columns: ['org_id', 'source_key'],
    },
    {
      table: 'elearning_content_course_publish_requests',
      name: 'elearning_content_course_publish_requests_pkey',
      type: 'p' as const,
      columns: ['id'],
    },
    {
      table: 'elearning_content_course_publish_requests',
      name: 'elearning_content_course_publish_requests_org_id_id_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id'],
    },
    {
      table: 'elearning_content_course_publish_requests',
      name: 'elearning_content_course_publish_requests_org_source_uniq',
      type: 'u' as const,
      columns: ['org_id', 'source_key'],
    },
    {
      table: 'elearning_course_version_items',
      name: 'elearning_course_version_items_org_version_id_type_uniq',
      type: 'u' as const,
      columns: ['org_id', 'course_version_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_course_version_items',
      name: 'elearning_course_version_items_content_revision_identity_uniq',
      type: 'u' as const,
      columns: [
        'org_id', 'course_version_id', 'id', 'item_type',
        'canonical_content_revision_id',
      ],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_pkey',
      type: 'p' as const,
      columns: ['id'],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_org_id_id_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id'],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_org_id_id_identity_uniq',
      type: 'u' as const,
      columns: [
        'org_id', 'id', 'user_id', 'course_version_id',
        'course_version_item_id', 'item_type', 'content_revision_id',
      ],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_effect_uniq',
      type: 'u' as const,
      columns: ['org_id', 'user_id', 'course_version_item_id'],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_request_identity_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id', 'user_id', 'course_version_item_id'],
    },
    {
      table: 'elearning_open_completion_requests',
      name: 'elearning_open_completion_requests_pkey',
      type: 'p' as const,
      columns: ['id'],
    },
    {
      table: 'elearning_open_completion_requests',
      name: 'elearning_open_completion_requests_org_id_id_uniq',
      type: 'u' as const,
      columns: ['org_id', 'id'],
    },
    {
      table: 'elearning_open_completion_requests',
      name: 'elearning_open_completion_requests_org_user_source_uniq',
      type: 'u' as const,
      columns: ['org_id', 'user_id', 'source_key'],
    },
  ]) await assertConstraintColumns(db, constraint)

  for (const constraint of [
    {
      table: 'elearning_content_revision_requests',
      name: 'elearning_content_revision_requests_revision_fk',
      type: 'f' as const,
      columns: ['org_id', 'content_revision_id'],
      referencedTable: 'elearning_content_revisions',
      referencedColumns: ['org_id', 'id'],
    },
    {
      table: 'elearning_content_course_publish_requests',
      name: 'elearning_content_course_publish_requests_course_fk',
      type: 'f' as const,
      columns: ['org_id', 'course_id'],
      referencedTable: 'elearning_courses',
      referencedColumns: ['org_id', 'id'],
    },
    {
      table: 'elearning_content_course_publish_requests',
      name: 'elearning_content_course_publish_requests_version_fk',
      type: 'f' as const,
      columns: ['org_id', 'course_id', 'course_version_id'],
      referencedTable: 'elearning_course_versions',
      referencedColumns: ['org_id', 'course_id', 'id'],
    },
    {
      table: 'elearning_course_version_items',
      name: 'elearning_course_version_items_article_revision_fk',
      type: 'f' as const,
      columns: ['org_id', 'article_revision_id', 'item_type'],
      referencedTable: 'elearning_content_revisions',
      referencedColumns: ['org_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_course_version_items',
      name: 'elearning_course_version_items_external_revision_fk',
      type: 'f' as const,
      columns: ['org_id', 'external_link_revision_id', 'item_type'],
      referencedTable: 'elearning_content_revisions',
      referencedColumns: ['org_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_item_fk',
      type: 'f' as const,
      columns: [
        'org_id', 'course_version_id', 'course_version_item_id',
        'item_type', 'content_revision_id',
      ],
      referencedTable: 'elearning_course_version_items',
      referencedColumns: [
        'org_id', 'course_version_id', 'id', 'item_type',
        'canonical_content_revision_id',
      ],
    },
    {
      table: 'elearning_open_completion_events',
      name: 'elearning_open_completion_events_revision_fk',
      type: 'f' as const,
      columns: ['org_id', 'content_revision_id', 'item_type'],
      referencedTable: 'elearning_content_revisions',
      referencedColumns: ['org_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_completion_evidence',
      name: 'elearning_completion_evidence_item_version_type_fk',
      type: 'f' as const,
      columns: ['org_id', 'course_version_id', 'course_version_item_id', 'item_type'],
      referencedTable: 'elearning_course_version_items',
      referencedColumns: ['org_id', 'course_version_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_completion_evidence',
      name: 'elearning_completion_evidence_content_revision_fk',
      type: 'f' as const,
      columns: ['org_id', 'content_revision_id', 'item_type'],
      referencedTable: 'elearning_content_revisions',
      referencedColumns: ['org_id', 'id', 'item_type'],
    },
    {
      table: 'elearning_completion_evidence',
      name: 'elearning_completion_evidence_open_event_fk',
      type: 'f' as const,
      columns: [
        'org_id', 'open_event_id', 'user_id', 'course_version_id',
        'course_version_item_id', 'item_type', 'content_revision_id',
      ],
      referencedTable: 'elearning_open_completion_events',
      referencedColumns: [
        'org_id', 'id', 'user_id', 'course_version_id',
        'course_version_item_id', 'item_type', 'content_revision_id',
      ],
    },
    {
      table: 'elearning_open_completion_requests',
      name: 'elearning_open_completion_requests_event_fk',
      type: 'f' as const,
      columns: ['org_id', 'event_id', 'user_id', 'course_version_item_id'],
      referencedTable: 'elearning_open_completion_events',
      referencedColumns: ['org_id', 'id', 'user_id', 'course_version_item_id'],
    },
    {
      table: 'elearning_open_completion_requests',
      name: 'elearning_open_completion_requests_evidence_fk',
      type: 'f' as const,
      columns: [
        'org_id', 'completion_evidence_id', 'user_id', 'course_version_item_id',
      ],
      referencedTable: 'elearning_completion_evidence',
      referencedColumns: ['org_id', 'id', 'user_id', 'course_version_item_id'],
    },
  ]) await assertConstraintColumns(db, constraint)

  await assertNamedChecks(db, CONTENT_CHECK_DEFINITIONS)
  await assertFunction(db, CONTENT_IMMUTABLE_FUNCTION, CONTENT_IMMUTABLE_BODY)
  await assertFunction(
    db,
    COMPLETION_IMMUTABLE_FUNCTION,
    `BEGIN
      RAISE EXCEPTION 'elearning_completion_evidence is append-only: % is not permitted', TG_OP;
    END;`,
  )
  await assertTriggers(db)
  await assertCourseStateAuthority(db)
}

async function createImmutableTriggers(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
    CREATE OR REPLACE FUNCTION ${CONTENT_IMMUTABLE_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    ${CONTENT_IMMUTABLE_BODY}
    $fn$
  `).execute(db)
  for (const trigger of CONTENT_IMMUTABLE_ROW_TRIGGERS) {
    if (trigger.fn !== CONTENT_IMMUTABLE_FUNCTION) continue
    await sql.raw(`
      CREATE TRIGGER ${trigger.name}
        BEFORE UPDATE OR DELETE ON ${trigger.table}
        FOR EACH ROW
        EXECUTE FUNCTION ${CONTENT_IMMUTABLE_FUNCTION}()
    `).execute(db)
  }
  for (const trigger of CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS) {
    await sql.raw(`
      CREATE TRIGGER ${trigger.name}
        BEFORE TRUNCATE ON ${trigger.table}
        FOR EACH STATEMENT
        EXECUTE FUNCTION ${CONTENT_IMMUTABLE_FUNCTION}()
    `).execute(db)
  }
}

async function replaceCourseStateFunction(
  db: Kysely<unknown>,
  body: string,
): Promise<void> {
  await sql.raw(`
    CREATE OR REPLACE FUNCTION ${COURSE_STATE_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    ${body}
    $fn$
  `).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await tableSet(db)
  const itemColumns = await columnSet(db, 'elearning_course_version_items', NEW_ITEM_COLUMNS)
  const evidenceColumns = await columnSet(db, 'elearning_completion_evidence', NEW_EVIDENCE_COLUMNS)
  const anyOwnedObject = tables.size > 0 || itemColumns.size > 0 || evidenceColumns.size > 0
  if (anyOwnedObject) {
    await assertSchema(db)
    return
  }

  await sql`LOCK TABLE elearning_courses IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_course_versions IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_course_version_items IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_completion_evidence IN ACCESS EXCLUSIVE MODE`.execute(db)

  await sql`
    CREATE TABLE elearning_content_revisions (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      item_type text NOT NULL,
      title text NOT NULL,
      article_html text,
      external_url text,
      content_digest text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_content_revisions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_content_revisions_org_id_id_type_uniq
        UNIQUE (org_id, id, item_type),
      CONSTRAINT elearning_content_revisions_item_type_chk
        CHECK (item_type IN ('article', 'external_link')),
      CONSTRAINT elearning_content_revisions_title_chk
        CHECK (btrim(title) <> '' AND char_length(title) <= 200),
      CONSTRAINT elearning_content_revisions_shape_chk
        CHECK (
          (item_type = 'article'
            AND article_html IS NOT NULL
            AND btrim(article_html) <> ''
            AND char_length(article_html) <= 1000000
            AND external_url IS NULL)
          OR
          (item_type = 'external_link'
            AND article_html IS NULL
            AND external_url IS NOT NULL
            AND btrim(external_url) <> ''
            AND char_length(external_url) <= 2048)
        ),
      CONSTRAINT elearning_content_revisions_digest_chk
        CHECK (content_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_content_revisions_created_by_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_content_revision_requests (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      source_key uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      content_revision_id uuid NOT NULL,
      actor_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_content_revision_requests_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_content_revision_requests_org_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_content_revision_requests_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_content_revision_requests_actor_chk
        CHECK (btrim(actor_id) <> ''),
      CONSTRAINT elearning_content_revision_requests_revision_fk
        FOREIGN KEY (org_id, content_revision_id)
        REFERENCES elearning_content_revisions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_content_course_publish_requests (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      source_key uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      course_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      item_count integer NOT NULL,
      actor_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_content_course_publish_requests_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_content_course_publish_requests_org_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_content_course_publish_requests_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_content_course_publish_requests_item_count_chk
        CHECK (item_count >= 1 AND item_count <= 10000),
      CONSTRAINT elearning_content_course_publish_requests_actor_chk
        CHECK (btrim(actor_id) <> ''),
      CONSTRAINT elearning_content_course_publish_requests_course_fk
        FOREIGN KEY (org_id, course_id)
        REFERENCES elearning_courses (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_content_course_publish_requests_version_fk
        FOREIGN KEY (org_id, course_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, course_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_course_version_items
      ADD COLUMN article_revision_id uuid,
      ADD COLUMN external_link_revision_id uuid,
      ADD COLUMN canonical_content_revision_id uuid
        GENERATED ALWAYS AS (
          CASE
            WHEN item_type = 'article' THEN article_revision_id
            WHEN item_type = 'external_link' THEN external_link_revision_id
            ELSE NULL::uuid
          END
        ) STORED
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT elearning_course_version_items_item_type_chk,
      DROP CONSTRAINT elearning_course_version_items_position_chk,
      DROP CONSTRAINT elearning_course_version_items_item_shape_chk,
      DROP CONSTRAINT elearning_course_version_items_completion_policy_chk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      ADD CONSTRAINT elearning_course_version_items_item_type_chk
        CHECK (item_type IN ('video', 'exam', 'article', 'external_link')),
      ADD CONSTRAINT elearning_course_version_items_position_chk
        CHECK (position >= 1 AND position <= 10000),
      ADD CONSTRAINT elearning_course_version_items_item_shape_chk
        CHECK (
          (item_type = 'video' AND media_id IS NOT NULL AND exam_id IS NULL
            AND article_revision_id IS NULL AND external_link_revision_id IS NULL)
          OR
          (item_type = 'exam' AND media_id IS NULL AND exam_id IS NOT NULL
            AND article_revision_id IS NULL AND external_link_revision_id IS NULL)
          OR
          (item_type = 'article' AND media_id IS NULL AND exam_id IS NULL
            AND article_revision_id IS NOT NULL AND external_link_revision_id IS NULL)
          OR
          (item_type = 'external_link' AND media_id IS NULL AND exam_id IS NULL
            AND article_revision_id IS NULL AND external_link_revision_id IS NOT NULL)
        ),
      ADD CONSTRAINT elearning_course_version_items_completion_policy_chk
        CHECK (
          (item_type = 'video'
            AND completion_policy_version IS NOT NULL
            AND completion_policy_version = 'video-v1-90pct'
            AND completion_threshold_bps IS NOT NULL
            AND completion_threshold_bps = 9000)
          OR
          (item_type = 'exam'
            AND completion_policy_version IS NULL
            AND completion_threshold_bps IS NULL)
          OR
          (item_type = 'article'
            AND completion_policy_version IS NOT NULL
            AND completion_policy_version = 'article-open-v1'
            AND completion_threshold_bps IS NULL)
          OR
          (item_type = 'external_link'
            AND completion_policy_version IS NOT NULL
            AND completion_policy_version = 'external-link-launch-v1'
            AND completion_threshold_bps IS NULL)
        ),
      ADD CONSTRAINT elearning_course_version_items_article_revision_fk
        FOREIGN KEY (org_id, article_revision_id, item_type)
        REFERENCES elearning_content_revisions (org_id, id, item_type)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_course_version_items_external_revision_fk
        FOREIGN KEY (org_id, external_link_revision_id, item_type)
        REFERENCES elearning_content_revisions (org_id, id, item_type)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_course_version_items_content_revision_identity_uniq
        UNIQUE (
          org_id, course_version_id, id, item_type,
          canonical_content_revision_id
        )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_open_completion_events (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      item_type text NOT NULL,
      content_revision_id uuid NOT NULL,
      event_kind text NOT NULL,
      event_digest text NOT NULL,
      server_received_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_open_completion_events_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_open_completion_events_org_id_id_identity_uniq
        UNIQUE (
          org_id, id, user_id, course_version_id, course_version_item_id,
          item_type, content_revision_id
        ),
      CONSTRAINT elearning_open_completion_events_request_identity_uniq
        UNIQUE (org_id, id, user_id, course_version_item_id),
      CONSTRAINT elearning_open_completion_events_effect_uniq
        UNIQUE (org_id, user_id, course_version_item_id),
      CONSTRAINT elearning_open_completion_events_user_chk CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_open_completion_events_digest_chk
        CHECK (event_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_open_completion_events_shape_chk
        CHECK (
          (item_type = 'article' AND event_kind = 'article_open')
          OR
          (item_type = 'external_link' AND event_kind = 'external_link_launch')
        ),
      CONSTRAINT elearning_open_completion_events_item_fk
        FOREIGN KEY (
          org_id, course_version_id, course_version_item_id,
          item_type, content_revision_id
        ) REFERENCES elearning_course_version_items (
          org_id, course_version_id, id, item_type,
          canonical_content_revision_id
        )
        ON DELETE RESTRICT,
      CONSTRAINT elearning_open_completion_events_revision_fk
        FOREIGN KEY (org_id, content_revision_id, item_type)
        REFERENCES elearning_content_revisions (org_id, id, item_type)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_completion_evidence
      ADD COLUMN item_type text,
      ADD COLUMN content_revision_id uuid,
      ADD COLUMN open_event_id uuid,
      ADD COLUMN completion_assurance text
  `.execute(db)
  await sql`
    UPDATE elearning_completion_evidence evidence
       SET item_type = item.item_type
      FROM elearning_course_version_items item
     WHERE item.org_id = evidence.org_id
       AND item.course_version_id = evidence.course_version_id
       AND item.id = evidence.course_version_item_id
  `.execute(db)
  await sql`ALTER TABLE elearning_completion_evidence ALTER COLUMN item_type SET NOT NULL`.execute(db)
  await sql`
    ALTER TABLE elearning_completion_evidence
      ALTER COLUMN completion_threshold_bps DROP NOT NULL,
      ALTER COLUMN media_duration_ms DROP NOT NULL,
      ALTER COLUMN effective_ms DROP NOT NULL,
      ALTER COLUMN max_position_ms DROP NOT NULL,
      DROP CONSTRAINT elearning_completion_evidence_threshold_bps_chk,
      DROP CONSTRAINT elearning_completion_evidence_media_duration_ms_nonneg_chk,
      DROP CONSTRAINT elearning_completion_evidence_effective_ms_nonneg_chk,
      DROP CONSTRAINT elearning_completion_evidence_max_position_ms_nonneg_chk,
      DROP CONSTRAINT elearning_completion_evidence_item_version_fk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_completion_evidence
      ADD CONSTRAINT elearning_completion_evidence_item_type_shape_chk
        CHECK (
          (item_type = 'video'
            AND completion_policy_version = 'video-v1-90pct'
            AND completion_threshold_bps = 9000
            AND media_duration_ms IS NOT NULL AND media_duration_ms > 0
            AND effective_ms IS NOT NULL AND effective_ms >= 0
            AND max_position_ms IS NOT NULL AND max_position_ms >= 0
            AND content_revision_id IS NULL
            AND open_event_id IS NULL
            AND completion_assurance IS NULL)
          OR
          (item_type = 'article'
            AND completion_policy_version = 'article-open-v1'
            AND completion_threshold_bps IS NULL
            AND media_duration_ms IS NULL
            AND effective_ms IS NULL
            AND max_position_ms IS NULL
            AND content_revision_id IS NOT NULL
            AND open_event_id IS NOT NULL
            AND completion_assurance = 'weak_server_recorded_open')
          OR
          (item_type = 'external_link'
            AND completion_policy_version = 'external-link-launch-v1'
            AND completion_threshold_bps IS NULL
            AND media_duration_ms IS NULL
            AND effective_ms IS NULL
            AND max_position_ms IS NULL
            AND content_revision_id IS NOT NULL
            AND open_event_id IS NOT NULL
            AND completion_assurance = 'weak_server_recorded_launch')
        ),
      ADD CONSTRAINT elearning_completion_evidence_org_id_id_user_item_uniq
        UNIQUE (org_id, id, user_id, course_version_item_id),
      ADD CONSTRAINT elearning_completion_evidence_item_version_type_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id, item_type)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id, item_type)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_completion_evidence_content_revision_fk
        FOREIGN KEY (org_id, content_revision_id, item_type)
        REFERENCES elearning_content_revisions (org_id, id, item_type)
        ON DELETE RESTRICT,
      ADD CONSTRAINT elearning_completion_evidence_open_event_fk
        FOREIGN KEY (
          org_id, open_event_id, user_id, course_version_id,
          course_version_item_id, item_type, content_revision_id
        ) REFERENCES elearning_open_completion_events (
          org_id, id, user_id, course_version_id,
          course_version_item_id, item_type, content_revision_id
        ) ON DELETE RESTRICT
  `.execute(db)

  await sql`
    CREATE TABLE elearning_open_completion_requests (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      source_key uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version smallint NOT NULL,
      event_id uuid NOT NULL,
      completion_evidence_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_open_completion_requests_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_open_completion_requests_org_user_source_uniq
        UNIQUE (org_id, user_id, source_key),
      CONSTRAINT elearning_open_completion_requests_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0),
      CONSTRAINT elearning_open_completion_requests_user_chk CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_open_completion_requests_event_fk
        FOREIGN KEY (org_id, event_id, user_id, course_version_item_id)
        REFERENCES elearning_open_completion_events
          (org_id, id, user_id, course_version_item_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_open_completion_requests_evidence_fk
        FOREIGN KEY (org_id, completion_evidence_id, user_id, course_version_item_id)
        REFERENCES elearning_completion_evidence
          (org_id, id, user_id, course_version_item_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await createImmutableTriggers(db)
  await replaceCourseStateFunction(db, ELEARNING_CONTENT_COURSE_STATE_BODY)
  await assertSchema(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = await tableSet(db)
  if (tables.size === 0) return
  await assertSchema(db)

  await sql`LOCK TABLE elearning_courses IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_course_versions IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_course_version_items IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_completion_evidence IN ACCESS EXCLUSIVE MODE`.execute(db)
  for (const table of ELEARNING_CONTENT_RUNTIME_TABLES) {
    await sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`).execute(db)
  }

  const used = await sql<{ used: string }>`
    SELECT (
      (SELECT count(*) FROM elearning_content_revisions)
      + (SELECT count(*) FROM elearning_content_revision_requests)
      + (SELECT count(*) FROM elearning_content_course_publish_requests)
      + (SELECT count(*) FROM elearning_open_completion_events)
      + (SELECT count(*) FROM elearning_open_completion_requests)
      + (SELECT count(*) FROM elearning_course_version_items
          WHERE item_type IN ('article', 'external_link'))
      + (SELECT count(*) FROM elearning_completion_evidence
          WHERE item_type IN ('article', 'external_link'))
    )::text AS used
  `.execute(db)
  if (used.rows[0]?.used !== '0') throw new Error('ELEARNING_CONTENT_RUNTIME_DOWN_IN_USE')

  for (const trigger of CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS) {
    await sql.raw(`DROP TRIGGER ${trigger.name} ON ${trigger.table}`).execute(db)
  }
  for (const trigger of CONTENT_IMMUTABLE_ROW_TRIGGERS) {
    if (trigger.fn !== CONTENT_IMMUTABLE_FUNCTION) continue
    await sql.raw(`DROP TRIGGER ${trigger.name} ON ${trigger.table}`).execute(db)
  }

  await sql`DROP TABLE elearning_open_completion_requests`.execute(db)
  await sql`
    ALTER TABLE elearning_completion_evidence
      DROP CONSTRAINT elearning_completion_evidence_open_event_fk,
      DROP CONSTRAINT elearning_completion_evidence_content_revision_fk,
      DROP CONSTRAINT elearning_completion_evidence_item_version_type_fk,
      DROP CONSTRAINT elearning_completion_evidence_org_id_id_user_item_uniq,
      DROP CONSTRAINT elearning_completion_evidence_item_type_shape_chk
  `.execute(db)
  await sql`DROP TABLE elearning_open_completion_events`.execute(db)

  await sql`
    ALTER TABLE elearning_completion_evidence
      DROP COLUMN completion_assurance,
      DROP COLUMN open_event_id,
      DROP COLUMN content_revision_id,
      DROP COLUMN item_type,
      ALTER COLUMN completion_threshold_bps SET NOT NULL,
      ALTER COLUMN media_duration_ms SET NOT NULL,
      ALTER COLUMN effective_ms SET NOT NULL,
      ALTER COLUMN max_position_ms SET NOT NULL,
      ADD CONSTRAINT elearning_completion_evidence_threshold_bps_chk
        CHECK (completion_threshold_bps >= 1 AND completion_threshold_bps <= 10000),
      ADD CONSTRAINT elearning_completion_evidence_media_duration_ms_nonneg_chk
        CHECK (media_duration_ms >= 0),
      ADD CONSTRAINT elearning_completion_evidence_effective_ms_nonneg_chk
        CHECK (effective_ms >= 0),
      ADD CONSTRAINT elearning_completion_evidence_max_position_ms_nonneg_chk
        CHECK (max_position_ms >= 0),
      ADD CONSTRAINT elearning_completion_evidence_item_version_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id)
        ON DELETE RESTRICT
  `.execute(db)

  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT elearning_course_version_items_content_revision_identity_uniq,
      DROP CONSTRAINT elearning_course_version_items_external_revision_fk,
      DROP CONSTRAINT elearning_course_version_items_article_revision_fk,
      DROP CONSTRAINT elearning_course_version_items_completion_policy_chk,
      DROP CONSTRAINT elearning_course_version_items_item_shape_chk,
      DROP CONSTRAINT elearning_course_version_items_position_chk,
      DROP CONSTRAINT elearning_course_version_items_item_type_chk,
      DROP COLUMN canonical_content_revision_id,
      DROP COLUMN external_link_revision_id,
      DROP COLUMN article_revision_id
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      ADD CONSTRAINT elearning_course_version_items_item_type_chk
        CHECK (item_type IN ('video', 'exam')),
      ADD CONSTRAINT elearning_course_version_items_position_chk CHECK (position >= 1),
      ADD CONSTRAINT elearning_course_version_items_item_shape_chk
        CHECK (
          (item_type = 'video' AND media_id IS NOT NULL AND exam_id IS NULL)
          OR
          (item_type = 'exam' AND exam_id IS NOT NULL AND media_id IS NULL)
        ),
      ADD CONSTRAINT elearning_course_version_items_completion_policy_chk
        CHECK (
          (item_type = 'video'
            AND completion_policy_version IS NOT NULL
            AND btrim(completion_policy_version) <> ''
            AND completion_threshold_bps IS NOT NULL
            AND completion_threshold_bps >= 1
            AND completion_threshold_bps <= 10000)
          OR
          (item_type = 'exam'
            AND completion_policy_version IS NULL
            AND completion_threshold_bps IS NULL)
        )
  `.execute(db)

  await sql`DROP TABLE elearning_content_course_publish_requests`.execute(db)
  await sql`DROP TABLE elearning_content_revision_requests`.execute(db)
  await sql`DROP TABLE elearning_content_revisions`.execute(db)
  await sql.raw(`DROP FUNCTION ${CONTENT_IMMUTABLE_FUNCTION}()`).execute(db)
  await replaceCourseStateFunction(db, LEGACY_COURSE_STATE_BODY)
}
