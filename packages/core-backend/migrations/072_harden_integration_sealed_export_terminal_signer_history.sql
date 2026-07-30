-- 072_harden_integration_sealed_export_terminal_signer_history.sql
-- Sealed-export S5 terminal signer history (#4690).
--
-- Migration 069 remains the current lifecycle authority. This append-only
-- table remembers signer keys that reached EXPIRED or REVOKED so rotating away,
-- deleting the current authority row, or rotating back cannot reactivate them.

CREATE TABLE IF NOT EXISTS integration_sealed_export_terminal_signer_keys (
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  signer_key_id              TEXT NOT NULL,
  terminal_status            TEXT NOT NULL CHECK (
    terminal_status IN ('EXPIRED', 'REVOKED')
  ),
  terminal_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    tenant_id,
    workspace_scope_key,
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    signer_key_id
  ),
  CHECK (char_length(signer_key_id) = 64)
);

INSERT INTO integration_sealed_export_terminal_signer_keys (
  tenant_id,
  workspace_id,
  tenant_domain_binding,
  system_content_key,
  role_binding_fingerprint,
  signer_key_id,
  terminal_status
)
SELECT
  tenant_id,
  workspace_id,
  tenant_domain_binding,
  system_content_key,
  role_binding_fingerprint,
  signer_key_id,
  signer_status
FROM integration_sealed_export_authority_state
WHERE signer_status IN ('EXPIRED', 'REVOKED')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION integration_sealed_export_terminal_signer_keys_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sealed-export terminal signer history is immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_terminal_signer_keys_immutable'
      AND tgrelid = 'integration_sealed_export_terminal_signer_keys'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_terminal_signer_keys_immutable
      BEFORE UPDATE OR DELETE ON integration_sealed_export_terminal_signer_keys
      FOR EACH ROW
      EXECUTE FUNCTION integration_sealed_export_terminal_signer_keys_immutable();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION integration_sealed_export_authority_state_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF
    TG_OP IN ('UPDATE', 'DELETE')
    AND OLD.signer_status IN ('EXPIRED', 'REVOKED')
  THEN
    INSERT INTO integration_sealed_export_terminal_signer_keys (
      tenant_id,
      workspace_id,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      signer_key_id,
      terminal_status
    ) VALUES (
      OLD.tenant_id,
      OLD.workspace_id,
      OLD.tenant_domain_binding,
      OLD.system_content_key,
      OLD.role_binding_fingerprint,
      OLD.signer_key_id,
      OLD.signer_status
    )
    ON CONFLICT DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF
    TG_OP = 'UPDATE'
    AND NEW.signer_key_id = OLD.signer_key_id
    AND OLD.signer_status IN ('EXPIRED', 'REVOKED')
    AND NEW.signer_status IS DISTINCT FROM OLD.signer_status
  THEN
    RAISE EXCEPTION 'sealed-export terminal signer key cannot change lifecycle state'
      USING ERRCODE = '55000';
  END IF;

  IF
    NEW.signer_status = 'ACTIVE'
    AND EXISTS (
      SELECT 1
      FROM integration_sealed_export_terminal_signer_keys AS terminal
      WHERE terminal.tenant_id = NEW.tenant_id
        AND terminal.workspace_scope_key = COALESCE(NEW.workspace_id, '')
        AND terminal.tenant_domain_binding = NEW.tenant_domain_binding
        AND terminal.system_content_key = NEW.system_content_key
        AND terminal.role_binding_fingerprint = NEW.role_binding_fingerprint
        AND terminal.signer_key_id = NEW.signer_key_id
    )
  THEN
    RAISE EXCEPTION 'sealed-export terminal signer key cannot be re-activated'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.signer_status IN ('EXPIRED', 'REVOKED') THEN
    INSERT INTO integration_sealed_export_terminal_signer_keys (
      tenant_id,
      workspace_id,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      signer_key_id,
      terminal_status
    ) VALUES (
      NEW.tenant_id,
      NEW.workspace_id,
      NEW.tenant_domain_binding,
      NEW.system_content_key,
      NEW.role_binding_fingerprint,
      NEW.signer_key_id,
      NEW.signer_status
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_integration_sealed_export_authority_state_guard
  ON integration_sealed_export_authority_state;

CREATE TRIGGER trg_integration_sealed_export_authority_state_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_sealed_export_authority_state
  FOR EACH ROW
  EXECUTE FUNCTION integration_sealed_export_authority_state_guard();
