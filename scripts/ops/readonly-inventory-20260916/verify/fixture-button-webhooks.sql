-- ============================================================================
-- fixture-button-webhooks.sql — synthetic fixture for 06-trg04-button-webhook-totals.sql
-- ============================================================================
-- Loaded by run-verify.mjs into a throwaway schema (inventory_fixture_buttons_<rand>)
-- on a LOCAL/CONTAINER PostgreSQL. NEVER run against a real database.
--
-- No other fixture in this directory creates `meta_fields`, so 06 reports
-- `incomplete reason=missing-columns:meta_fields scope=none` on them (the
-- harness asserts that on an empty schema). Rows b1–b17 are the ones 06 was
-- checked against before it joined the pack. Expected one row of counts,
-- asserted by run-verify.mjs's callers:
--   button_webhooks 14 = url_missing 3 (b5 no url, b6 url 123, b15 blank)
--                      + refused_both 4 (b3 http, b4 10.x, b13 localhost, b16 [::1])
--                      + https_ip_literal 2 (b2, b10 IPv6 with spaces around)
--                      + https_hostname 3 (b1, b12 with userinfo, b17 upper case)
--                      + unclassified 2 (b9 property is a JSON string,
--                        b11 actionConfig is a JSON string)
--   not counted: b7 (send_notification), b8 (type 'string'), b14 (NULL property)
-- Hosts are reserved/documentation names or literals; nothing real.
-- ============================================================================

CREATE TABLE meta_fields (id text PRIMARY KEY, sheet_id text NOT NULL, name text NOT NULL, type text NOT NULL, property jsonb DEFAULT '{}'::jsonb, "order" int NOT NULL DEFAULT 0);
INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES
 ('b1',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://hooks.example.com/x"}}'),
 ('b2',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://203.0.113.5/x"}}'),
 ('b3',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"http://example.com"}}'),
 ('b4',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://10.0.0.5/x"}}'),
 ('b5',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{}}'),
 ('b6',  's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":123}}'),
 ('b7',  's', 'n', 'button', '{"actionType":"send_notification","actionConfig":{"url":"https://hooks.example.com"}}'),
 ('b8',  's', 'n', 'string', '{"actionType":"send_webhook","actionConfig":{"url":"https://hooks.example.com"}}'),
 ('b9',  's', 'n', 'button', to_jsonb('{"actionType":"send_webhook","actionConfig":{"url":"https://hooks.example.com"}}'::text)),
 ('b10', 's', 'n', 'button', '{"actionType":" send_webhook ","actionConfig":{"url":" https://[2001:db8::1]:8443/x "}}'),
 ('b11', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":"{\"url\":\"https://hooks.example.com\"}"}'),
 ('b12', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://u:p@hooks.example.com/"}}'),
 ('b13', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://localhost/"}}'),
 ('b14', 's', 'n', 'button', NULL),
 ('b15', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"   "}}'),
 ('b16', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"https://[::1]/"}}'),
 ('b17', 's', 'n', 'button', '{"actionType":"send_webhook","actionConfig":{"url":"HTTPS://Erp.Example.CN:9443"}}');
