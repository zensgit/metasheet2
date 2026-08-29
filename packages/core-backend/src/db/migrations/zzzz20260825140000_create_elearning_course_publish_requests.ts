import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning V0.1 course-publish request ledger.
 *
 * requestId is an org-scoped idempotency source key, never the course PK.
 * UNIQUE(org_id, source_key) plus request_hash/request_hash_version store the
 * command identity. Result refs are parent-consistent same-org composite FKs
 * onto course / version / typed items / exam, all ON DELETE RESTRICT.
 * video_item_id and exam_item_id are distinct and bound to item_type; exam_id
 * must equal the exam attached to exam_item_id.
 */
export const ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE = 'elearning_course_publish_requests'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_SOURCE_KEY_UNIQ =
  'elearning_course_publish_requests_org_source_key_uniq'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK =
  'elearning_course_publish_requests_course_fk'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK =
  'elearning_course_publish_requests_version_fk'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK =
  'elearning_course_publish_requests_video_item_fk'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK =
  'elearning_course_publish_requests_exam_item_fk'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK =
  'elearning_course_publish_requests_exam_fk'
export const ELEARNING_COURSE_PUBLISH_REQUESTS_ITEM_ROLES_DISTINCT_CHK =
  'elearning_course_publish_requests_item_roles_distinct_chk'
export const ELEARNING_COURSE_VERSION_ITEMS_ORG_VERSION_ID_TYPE_UNIQ =
  'elearning_course_version_items_org_version_id_type_uniq'
export const ELEARNING_COURSE_VERSION_ITEMS_ORG_VERSION_ID_TYPE_EXAM_UNIQ =
  'elearning_course_version_items_org_version_id_type_exam_uniq'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_version_items_org_version_id_type_uniq'
           AND conrelid = 'elearning_course_version_items'::regclass
      ) THEN
        ALTER TABLE elearning_course_version_items
          ADD CONSTRAINT elearning_course_version_items_org_version_id_type_uniq
          UNIQUE (org_id, course_version_id, id, item_type);
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_version_items_org_version_id_type_exam_uniq'
           AND conrelid = 'elearning_course_version_items'::regclass
      ) THEN
        ALTER TABLE elearning_course_version_items
          ADD CONSTRAINT elearning_course_version_items_org_version_id_type_exam_uniq
          UNIQUE (org_id, course_version_id, id, item_type, exam_id);
      END IF;
    END $$
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_course_publish_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      course_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      video_item_id uuid NOT NULL,
      exam_item_id uuid NOT NULL,
      exam_id uuid NOT NULL,
      video_item_type text NOT NULL DEFAULT 'video',
      exam_item_type text NOT NULL DEFAULT 'exam',
      question_count integer NOT NULL,
      total_score bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_course_publish_requests_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_course_publish_requests_org_source_key_uniq UNIQUE (org_id, source_key),
      CONSTRAINT elearning_course_publish_requests_source_key_nonempty_chk
        CHECK (btrim(source_key) <> ''),
      CONSTRAINT elearning_course_publish_requests_request_hash_nonempty_chk
        CHECK (btrim(request_hash) <> ''),
      CONSTRAINT elearning_course_publish_requests_request_hash_version_chk
        CHECK (request_hash_version >= 1),
      CONSTRAINT elearning_course_publish_requests_question_count_chk
        CHECK (question_count >= 1),
      CONSTRAINT elearning_course_publish_requests_total_score_chk
        CHECK (total_score >= 1),
      CONSTRAINT elearning_course_publish_requests_video_item_type_chk
        CHECK (video_item_type = 'video'),
      CONSTRAINT elearning_course_publish_requests_exam_item_type_chk
        CHECK (exam_item_type = 'exam'),
      CONSTRAINT elearning_course_publish_requests_item_roles_distinct_chk
        CHECK (video_item_id <> exam_item_id),
      CONSTRAINT elearning_course_publish_requests_course_fk
        FOREIGN KEY (org_id, course_id)
        REFERENCES elearning_courses (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_publish_requests_version_fk
        FOREIGN KEY (org_id, course_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, course_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_publish_requests_video_item_fk
        FOREIGN KEY (org_id, course_version_id, video_item_id, video_item_type)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id, item_type)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_publish_requests_exam_item_fk
        FOREIGN KEY (org_id, course_version_id, exam_item_id, exam_item_type, exam_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id, item_type, exam_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_course_publish_requests_exam_fk
        FOREIGN KEY (org_id, exam_id)
        REFERENCES elearning_exams (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'elearning_course_publish_requests'::regclass
           AND attname = 'video_item_type'
           AND NOT attisdropped
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD COLUMN video_item_type text NOT NULL DEFAULT 'video';
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'elearning_course_publish_requests'::regclass
           AND attname = 'exam_item_type'
           AND NOT attisdropped
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD COLUMN exam_item_type text NOT NULL DEFAULT 'exam';
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_video_item_type_chk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_video_item_type_chk
          CHECK (video_item_type = 'video');
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_exam_item_type_chk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_exam_item_type_chk
          CHECK (exam_item_type = 'exam');
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_item_roles_distinct_chk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_item_roles_distinct_chk
          CHECK (video_item_id <> exam_item_id);
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_course_fk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_course_fk
          FOREIGN KEY (org_id, course_id)
          REFERENCES elearning_courses (org_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_version_fk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_version_fk
          FOREIGN KEY (org_id, course_id, course_version_id)
          REFERENCES elearning_course_versions (org_id, course_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `.execute(db)

  await sql`
    ALTER TABLE elearning_course_publish_requests
      DROP CONSTRAINT IF EXISTS elearning_course_publish_requests_video_item_fk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_publish_requests
      ADD CONSTRAINT elearning_course_publish_requests_video_item_fk
      FOREIGN KEY (org_id, course_version_id, video_item_id, video_item_type)
      REFERENCES elearning_course_version_items (org_id, course_version_id, id, item_type)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    ALTER TABLE elearning_course_publish_requests
      DROP CONSTRAINT IF EXISTS elearning_course_publish_requests_exam_item_fk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_publish_requests
      ADD CONSTRAINT elearning_course_publish_requests_exam_item_fk
      FOREIGN KEY (org_id, course_version_id, exam_item_id, exam_item_type, exam_id)
      REFERENCES elearning_course_version_items (org_id, course_version_id, id, item_type, exam_id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'elearning_course_publish_requests_exam_fk'
           AND conrelid = 'elearning_course_publish_requests'::regclass
      ) THEN
        ALTER TABLE elearning_course_publish_requests
          ADD CONSTRAINT elearning_course_publish_requests_exam_fk
          FOREIGN KEY (org_id, exam_id)
          REFERENCES elearning_exams (org_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS elearning_course_publish_requests`.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT IF EXISTS elearning_course_version_items_org_version_id_type_exam_uniq
  `.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT IF EXISTS elearning_course_version_items_org_version_id_type_uniq
  `.execute(db)
}
