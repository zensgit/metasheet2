import { sql, type Kysely } from 'kysely'

/**
 * Immutable personal line/ECO intent.
 * Identity is owner + source + kind + client-key digest. Generation, binding, person, and origin are not the key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plm_personal_bom_write_intents (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL REFERENCES users(id),
      data_source_id text NOT NULL REFERENCES data_sources(id),
      operation_kind text NOT NULL,
      client_key_sha256 text NOT NULL,
      actor_meta_tenant_id text,
      source_meta_tenant_id text,
      workspace_id text,
      scope_kind text NOT NULL,
      target_origin text NOT NULL,
      connection_id text NOT NULL,
      yuantus_tenant_id text NOT NULL,
      yuantus_org_id text NOT NULL,
      subject_id text NOT NULL,
      purpose text NOT NULL DEFAULT 'bom_write',
      part_id text NOT NULL,
      bom_line_id text,
      if_match text,
      request_body text NOT NULL,
      payload_fingerprint text NOT NULL,
      provider_idempotency_key text NOT NULL,
      binding_id uuid NOT NULL,
      outcome text NOT NULL DEFAULT 'frozen',
      saw_unknown boolean NOT NULL DEFAULT false,
      confirmed_response text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, data_source_id, operation_kind, client_key_sha256),
      CHECK (operation_kind IN ('line', 'eco-intent')),
      CHECK (purpose = 'bom_write'),
      CHECK (scope_kind IN ('legacy_private', 'private', 'workspace')),
      CHECK (outcome IN ('frozen', 'accepted', 'unknown', 'denied')),
      CHECK (client_key_sha256 ~ '^[0-9a-f]{64}$'),
      CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
      CHECK (provider_idempotency_key ~ '^[0-9a-f]{64}$'),
      CHECK (char_length(part_id) >= 1),
      CHECK (char_length(connection_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_tenant_id) BETWEEN 1 AND 128),
      CHECK (char_length(yuantus_org_id) BETWEEN 1 AND 128),
      CHECK (char_length(target_origin) BETWEEN 8 AND 300),
      CHECK (target_origin ~ '^https://'),
      CHECK (subject_id ~ '^[1-9][0-9]{0,17}$'),
      CHECK (actor_meta_tenant_id IS NULL OR char_length(actor_meta_tenant_id) BETWEEN 1 AND 128),
      CHECK (source_meta_tenant_id IS NULL OR char_length(source_meta_tenant_id) BETWEEN 1 AND 128),
      CHECK (if_match IS NULL OR char_length(if_match) BETWEEN 1 AND 128),
      CHECK (
        (
          operation_kind = 'line'
          AND bom_line_id IS NOT NULL
          AND char_length(bom_line_id) >= 1
          AND left(request_body, 1) = '{'
        )
        OR (
          operation_kind = 'eco-intent'
          AND bom_line_id IS NULL
          AND if_match IS NULL
          AND request_body = 'null'
        )
      )
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`LOCK TABLE plm_personal_bom_write_intents IN ACCESS EXCLUSIVE MODE NOWAIT`.execute(trx)
    await sql`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM plm_personal_bom_write_intents) THEN
          RAISE EXCEPTION 'plm_personal_bom_write_intent_evidence_present';
        END IF;
      END $$
    `.execute(trx)
    await sql`DROP TABLE plm_personal_bom_write_intents`.execute(trx)
  })
}
