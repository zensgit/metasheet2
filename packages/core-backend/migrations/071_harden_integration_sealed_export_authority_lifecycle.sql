-- 071_harden_integration_sealed_export_authority_lifecycle.sql
-- Sealed-export S5 signer lifecycle hardening (#4690).
--
-- Migration 069 remains the single current lifecycle authority. This guard
-- prevents an expired or revoked signer key from being re-activated in place.
-- First-party rotation remains possible only by changing signer_key_id.

CREATE OR REPLACE FUNCTION integration_sealed_export_authority_state_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF
    NEW.signer_key_id = OLD.signer_key_id
    AND OLD.signer_status IN ('EXPIRED', 'REVOKED')
    AND NEW.signer_status IS DISTINCT FROM OLD.signer_status
  THEN
    RAISE EXCEPTION 'sealed-export terminal signer key cannot be re-activated'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_authority_state_guard'
      AND tgrelid = 'integration_sealed_export_authority_state'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_authority_state_guard
      BEFORE UPDATE ON integration_sealed_export_authority_state
      FOR EACH ROW
      EXECUTE FUNCTION integration_sealed_export_authority_state_guard();
  END IF;
END $$;
