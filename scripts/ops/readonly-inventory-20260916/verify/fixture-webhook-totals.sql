-- ============================================================================
-- fixture-webhook-totals.sql — synthetic fixture for 05-trg04-webhook-target-totals.sql
-- ============================================================================
-- Loaded by run-verify.mjs into a throwaway schema (inventory_fixture_totals_<rand>)
-- on a LOCAL/CONTAINER PostgreSQL. NEVER run against a real database.
--
-- WHY A SEPARATE FIXTURE: 05 needs `automation_rules.enabled`, which the
-- hand-authored subset in fixture-modern.sql does not have (05 reports
-- `incomplete reason=missing-columns:automation_rules` there, and the harness
-- asserts exactly that). Its rows are also tuned for 02's assertions, so mixing
-- them in would change numbers neither file was written for. These rows are the
-- same ones 05 was checked against before it ran on site (rules r1–r16, no
-- r10; webhooks w1–w6); expected output, asserted by run-verify.mjs:
--   rules     enabled t: 10 rules, 10 targets = 3 url_missing (r11 r15 r16)
--                        + 3 not_https (r1 r7 r14) + 3 https_internal_literal
--                        (r2 r4 r9) + 1 https_other (r3)
--             enabled f:  2 rules (r5, r6 NULL), 3 targets = 1 url_missing (r6
--                        legacy) + 1 not_https (r5 ftp) + 0 + 1 https_other (r5)
--             no target: r8 (not send_webhook), r12 (malformed branches),
--                        r13 (non-empty actions win over the legacy column)
--   webhooks  active t:   4 = 0 + 1 not_https (w1) + 2 internal (w2 w6) + 1 other (w3)
--             active f:   2 = 1 url_missing (w5) + 0 + 1 internal (w4) + 0
-- Hosts are reserved/placeholder names or internal literals; nothing real.
-- ============================================================================

-- Synthetic schema mirroring the two migrations' columns, plus one row per bucket / edge case.
CREATE TABLE automation_rules (
  id text PRIMARY KEY, sheet_id text NOT NULL, name text, trigger_type text NOT NULL,
  trigger_config jsonb DEFAULT '{}'::jsonb, action_type text NOT NULL, action_config jsonb DEFAULT '{}'::jsonb,
  enabled boolean DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text, conditions jsonb, actions jsonb
);
CREATE TABLE multitable_webhooks (
  id text PRIMARY KEY, name text NOT NULL, url text NOT NULL, secret text, events jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz, last_delivered_at timestamptz, failure_count integer NOT NULL DEFAULT 0, max_retries integer NOT NULL DEFAULT 3
);

INSERT INTO automation_rules (id, sheet_id, trigger_type, action_type, action_config, enabled, actions) VALUES
 ('r1',  's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":"http://example.com/h"}}]'),
 ('r2',  's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":"https://10.1.2.3/x"}}]'),
 ('r3',  's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":"https://erp.example.cn/x"}},{"type":"send_notification","config":{"url":"http://ignored"}}]'),
 ('r4',  's', 'record.created', 'send_webhook', '{"url":"https://oa.corp.local/h"}', true, '[]'),
 ('r5',  's', 'record.created', 'condition_branch', '{}', false,
   '[{"type":"condition_branch","config":{"branches":[{"key":"a","actions":[{"type":"send_webhook","config":{"url":"  HTTPS://hooks.example.com/a "}}]}],"defaultBranch":{"actions":[{"type":"send_webhook","config":{"url":"ftp://x"}}]}}}]'),
 ('r6',  's', 'record.created', 'send_webhook', '{}', NULL,  NULL),
 ('r7',  's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":123}}]'),
 ('r8',  's', 'record.created', 'update_record', '{}', true, '[{"type":"update_record","config":{"url":"http://x"}}]'),
 ('r9',  's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":"https:\\\\192.168.1.5\\x"}}]'),
 ('r11', 's', 'record.created', 'send_webhook', '{}', true,  '[5,{"type":"send_webhook"}]'),
 ('r12', 's', 'record.created', 'condition_branch', '{}', true, '[{"type":"condition_branch","config":{"branches":{"not":"array"},"defaultBranch":{"actions":"nope"}}}]'),
 ('r13', 's', 'record.created', 'send_webhook', '{"url":"http://legacy-ignored"}', true, '[{"type":"send_notification","config":{}}]'),
 ('r14', 's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":["http://10.0.0.1/h"]}}]'),
 ('r15', 's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":null}}]'),
 ('r16', 's', 'record.created', 'send_webhook', '{}', true,  '[{"type":"send_webhook","config":{"url":"   "}}]');

INSERT INTO multitable_webhooks (id, name, url, active, created_by) VALUES
 ('w1', 'n', 'http://example.com', true, 'u'),
 ('w2', 'n', 'https://172.20.0.1:8443/x', true, 'u'),
 ('w3', 'n', 'https://hooks.example.com', true, 'u'),
 ('w4', 'n', 'https://[::1]/x', false, 'u'),
 ('w5', 'n', '', false, 'u'),
 ('w6', 'n', ' https://localhost/ ', true, 'u');
