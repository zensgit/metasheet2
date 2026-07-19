/**
 * FWB §11 Q6 — durable confirmation records (identifiers only).
 *
 * Server generates a fingerprint of the normalized {template id+version, target base/sheet,
 * complete mapping identifiers}. The configurer must explicitly acknowledge a challenge; the
 * resulting row is the only authority for "confirmed". Values never stored. A fingerprint
 * mismatch (any mapping/target/template-version change) invalidates the confirmation.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS meta_fwb_confirmations (
      id                   text PRIMARY KEY,
      sheet_id             text NOT NULL
                             CONSTRAINT fwb_confirm_sheet_nonblank CHECK (sheet_id ~ '[!-~]'),
      configurer_user_id   text NOT NULL
                             CONSTRAINT fwb_confirm_user_nonblank CHECK (configurer_user_id ~ '[!-~]'),
      fingerprint          text NOT NULL
                             CONSTRAINT fwb_confirm_fp_nonblank CHECK (fingerprint ~ '[!-~]'),
      template_id          text NOT NULL,
      template_version_id  text NOT NULL,
      target_base_id       text,
      target_sheet_id      text NOT NULL,
      mapping_json         jsonb NOT NULL,
      challenge_nonce      text NOT NULL,
      confirmed_at         timestamptz,
      confirmed_by         text,
      created_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fwb_confirm_ack_paired CHECK (
        (confirmed_at IS NULL AND confirmed_by IS NULL)
        OR (confirmed_at IS NOT NULL AND confirmed_by ~ '[!-~]')
      )
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_fwb_confirmations_fp
    ON meta_fwb_confirmations (fingerprint, configurer_user_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_fwb_confirmations`.execute(db)
}
