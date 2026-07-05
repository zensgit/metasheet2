/**
 * Personal (per-user) view config overlay — Slice 1 data model.
 *
 * Ratified design: docs/development/multitable-personal-views-design-lock-20260705.md
 *
 * §7 Q1 (LOCKED per review): v1 data model is a NEW table, FK to `meta_views(id)`, UNIQUE
 * `(view_id, user_id)`. `user_id` is ALWAYS the authenticated actor (see
 * `../../multitable/personal-view-config.ts`) — NEVER sourced from a client-supplied
 * body/query/header value.
 *
 * Anti-precedent (§7 Q1 / §8, explicit NON-GOAL): this is NOT an extension of the legacy
 * `views` / `view_states` / `kanban` state. Those routes resolve the target user via a
 * client-supplied `x-user-id` header (`routes/kanban.ts:25`) and an `|| 0` default
 * (`routes/views.ts:273,298`) — a direct violation of the actor-scoped isolation rule
 * (§1-B). Personal views MUST NOT reuse or extend `view_states`; this new table is the
 * only storage for the per-user presentation overlay on the current `meta_views` system.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_view_personal_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      view_id text NOT NULL REFERENCES meta_views(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT meta_view_personal_configs_unique UNIQUE (view_id, user_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_meta_view_personal_configs_view ON meta_view_personal_configs(view_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_meta_view_personal_configs_user ON meta_view_personal_configs(user_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_view_personal_configs CASCADE`.execute(db)
}
