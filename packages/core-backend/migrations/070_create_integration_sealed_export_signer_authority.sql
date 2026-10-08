-- 070_create_integration_sealed_export_signer_authority.sql
-- Sealed-export S5 public verification material only (#4690).
--
-- Lifecycle authority is migration 069's
-- integration_sealed_export_authority_state (signer_key_id, signer_status,
-- signer_expires_at). This table MUST NOT duplicate status/expiry: S4
-- generation-kernel and S5 sign/verify consult the same 069 lifecycle row.
--
-- This table stores PUBLIC SPKI verification material only, scoped to align
-- with 069 authority scope + signer_key_id. Private signing keys MUST NOT
-- appear here.

CREATE TABLE IF NOT EXISTS integration_sealed_export_signer_public_keys (
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  signer_key_id              TEXT NOT NULL,
  signature_algorithm        TEXT NOT NULL CHECK (
    signature_algorithm = 'ED25519'
  ),
  public_key_spki_der        BYTEA NOT NULL,
  public_key_spki_sha256     TEXT NOT NULL,
  enrolled_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    tenant_id,
    workspace_scope_key,
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    signer_key_id
  ),
  CHECK (char_length(signer_key_id) = 64),
  CHECK (char_length(public_key_spki_sha256) = 64),
  CHECK (signer_key_id = public_key_spki_sha256),
  CHECK (octet_length(public_key_spki_der) > 0),
  CHECK (octet_length(public_key_spki_der) <= 4096)
);

-- Lookup by the same scope coordinates S4 uses for authority_state, plus key id.
CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_signer_public_keys_lookup
  ON integration_sealed_export_signer_public_keys (
    tenant_id,
    workspace_scope_key,
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    signer_key_id
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_signer_public_keys_updated_at'
      AND tgrelid = 'integration_sealed_export_signer_public_keys'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_signer_public_keys_updated_at
      BEFORE UPDATE ON integration_sealed_export_signer_public_keys
      FOR EACH ROW
      EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
