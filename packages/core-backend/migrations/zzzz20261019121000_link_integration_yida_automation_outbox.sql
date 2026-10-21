-- Private SA06D producer facts. The provider sorts SQL and TS by basename:
-- run AFTER zzzz20260715120000_create_automation_outbox and 097, including on a
-- fresh database. No global producer/consumer activation or external IO.
CREATE TABLE IF NOT EXISTS integration_yida_auto_outbox_links (
  request_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES meta_automation_outbox(id) ON DELETE RESTRICT,
  consumer_key TEXT NOT NULL CHECK (consumer_key='integration-yida-authorized-send'),
  FOREIGN KEY (grant_id,request_id) REFERENCES integration_yida_auto_requests(grant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (outbox_id,consumer_key) REFERENCES meta_automation_outbox_consumer(outbox_id,consumer_key) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION integration_yida_auto_outbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meta_automation_outbox o
    WHERE o.id=NEW.outbox_id AND o.event_type='integration.yida.authorized.requested'
      AND o.event_id='yida-automation:'||NEW.request_id
      AND o.payload=jsonb_build_object('requestId',NEW.request_id)
      AND o.automation_depth=0 AND o.manifest_version=5) THEN
    RAISE EXCEPTION 'YIDA_AUTO_OUTBOX_IDENTITY';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS yida_auto_outbox_identity ON integration_yida_auto_outbox_links;
CREATE TRIGGER yida_auto_outbox_identity BEFORE INSERT ON integration_yida_auto_outbox_links
  FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_outbox_identity();
DROP TRIGGER IF EXISTS yida_auto_immutable ON integration_yida_auto_outbox_links;
CREATE TRIGGER yida_auto_immutable BEFORE UPDATE OR DELETE ON integration_yida_auto_outbox_links
  FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_immutable();
DROP TRIGGER IF EXISTS yida_auto_no_truncate ON integration_yida_auto_outbox_links;
CREATE TRIGGER yida_auto_no_truncate BEFORE TRUNCATE ON integration_yida_auto_outbox_links
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_auto_immutable();
