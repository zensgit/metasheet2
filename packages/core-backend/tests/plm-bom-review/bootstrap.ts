import { up as listenerUp } from '../../src/db/migrations/zzzz20261015010000_add_plm_change_listeners'
import { up as changeDispatch } from '../../src/db/migrations/zzzz20261014080000_dispatch_plm_change_events'
import { up as changeInbox } from '../../src/db/migrations/zzzz20261014070000_add_plm_change_inbox'
import type { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBaseTestDb } from './base-bootstrap'
import { up as config } from '../../src/db/migrations/zzzz20260624120000_create_meta_config_revisions'
import { up as configSource } from '../../src/db/migrations/zzzz20260624200000_add_config_revision_source'
import { up as subscriptions } from '../../src/db/migrations/zzzz20260505103000_create_meta_record_subscriptions'
import { up as subscriptionMessage } from '../../src/db/migrations/zzzz20260616120000_add_meta_record_subscription_notification_message'
import { up as bom } from '../../src/db/migrations/zzzz20261002010000_create_plm_bom_reviews'
import { up as ownerView } from '../../src/db/migrations/zzzz20261002020000_add_plm_bom_owner_view_initialized'
import { up as reviewStates } from '../../src/db/migrations/zzzz20261014010000_add_plm_bom_review_states'
import { up as webhooks } from '../../src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks'
import { up as webhookRetry } from '../../src/db/migrations/zzzz20260611130000_add_webhook_retry_policy'
import { up as completion } from '../../src/db/migrations/zzzz20261014020000_add_plm_bom_completion_events'
import { up as statusViews } from '../../src/db/migrations/zzzz20261014030000_add_plm_bom_status_views_initialized'
import { up as rowCompletionEvents } from '../../src/db/migrations/zzzz20261014040000_add_plm_bom_row_completion_events'
import { up as completionIntents } from '../../src/db/migrations/zzzz20261014050000_add_plm_bom_completion_intents'
import { up as completionAttempts } from '../../src/db/migrations/zzzz20261014060000_add_plm_bom_completion_attempts'
// Isolated fixture only: minimal predecessor catalog and actual feature migrations, not full install-chain evidence.
export async function bootstrapPlmBomReviewTestDb(pool: Pool): Promise<void> {
  await bootstrapPlmBaseTestDb(pool)
  await pool.query(`
  ALTER TABLE meta_bases ADD COLUMN name text;
  ALTER TABLE meta_sheets ADD COLUMN name text, ADD COLUMN description text;
  ALTER TABLE meta_fields ADD COLUMN name text, ADD COLUMN "order" integer;
  CREATE TABLE meta_views(id text PRIMARY KEY,sheet_id text REFERENCES meta_sheets(id),name text,type text,filter_info jsonb,sort_info jsonb,group_info jsonb,hidden_field_ids jsonb,config jsonb,created_at timestamptz,deleted_at timestamptz);
  CREATE TABLE data_sources(id text PRIMARY KEY,name text,type text,config jsonb,owner_id text,is_active boolean,deleted_at timestamptz,workspace_id text,tenant_id text,scope_kind text);
  `)
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  for (const up of [config, configSource, subscriptions, subscriptionMessage, webhooks, webhookRetry, bom, ownerView, reviewStates, completion, statusViews, rowCompletionEvents, completionIntents, completionAttempts, changeInbox, changeDispatch, listenerUp])
    await up(db)
}
