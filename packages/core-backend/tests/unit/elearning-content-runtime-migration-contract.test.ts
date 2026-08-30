import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  ELEARNING_CONTENT_RUNTIME_TABLES,
  ELEARNING_CONTENT_COURSE_STATE_BODY,
  CONTENT_IMMUTABLE_ROW_TRIGGERS,
  CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS,
} from '../../src/db/migrations/zzzz20260829213000_create_elearning_content_revisions'

const MIGRATION_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/zzzz20260829213000_create_elearning_content_revisions.ts',
)

describe('elearning content runtime migration contract', () => {
  it('owns one immutable content/event/request substrate without a second completion table', () => {
    expect(ELEARNING_CONTENT_RUNTIME_TABLES).toEqual([
      'elearning_content_revisions',
      'elearning_content_revision_requests',
      'elearning_content_course_publish_requests',
      'elearning_open_completion_events',
      'elearning_open_completion_requests',
    ])
    expect(CONTENT_IMMUTABLE_ROW_TRIGGERS).toHaveLength(6)
    expect(CONTENT_IMMUTABLE_TRUNCATE_TRIGGERS).toHaveLength(6)
    expect(ELEARNING_CONTENT_RUNTIME_TABLES).not.toContain(
      'elearning_content_completion_evidence',
    )
  })

  it('allows complete assessment or content item families with per-type readiness', async () => {
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain(
      'unsupported item family',
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain(
      "count(*) FILTER (WHERE item_type = 'video') >= 1",
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain(
      "count(*) FILTER (WHERE item_type = 'exam') >= 1",
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain(
      "count(*) FILTER (WHERE item_type IN ('video', 'exam')) = count(*)",
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain(
      "item_type IN ('article', 'external_link')",
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain("i.item_type = 'article'")
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).toContain("i.item_type = 'external_link'")
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).not.toContain(
      'at least one video item is required',
    )
    expect(ELEARNING_CONTENT_COURSE_STATE_BODY).not.toContain(
      'at least one exam item is required',
    )
  })

  it('uses a strict discriminated completion shape without zero-valued content metrics', async () => {
    const source = await fs.readFile(MIGRATION_SOURCE, 'utf8')
    expect(source).toContain('elearning_completion_evidence_item_type_shape_chk')
    expect(source).toContain('completion_threshold_bps IS NULL')
    expect(source).toContain('media_duration_ms IS NULL')
    expect(source).toContain('effective_ms IS NULL')
    expect(source).toContain('max_position_ms IS NULL')
    expect(source).not.toContain('COALESCE(media_duration_ms, 0)')
    expect(source).toContain('canonical_content_revision_id')
    expect(source).toContain('elearning_open_completion_events_item_fk')
  })

  it('uses pg_catalog semantics for checks, immutable functions, and triggers', async () => {
    const source = await fs.readFile(MIGRATION_SOURCE, 'utf8')
    for (const token of [
      'pg_get_constraintdef',
      'pg_get_expr',
      'pg_attribute',
      'attnotnull',
      'attgenerated',
      'pg_proc',
      'pg_trigger',
      'prosecdef',
      'tgtype',
      'tgattr',
      'tgqual',
      'tgfoid',
      'tgenabled',
    ]) expect(source).toContain(token)
  })
})
