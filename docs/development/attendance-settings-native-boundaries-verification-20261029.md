# Settings native boundaries - Draft/HOLD

Base: #6638 `260d590872a0287e45fd22a4770766bafef4ebb2`. Two already registered native integration files gain independent fixture descriptions; all old test bytes are preserved as prefixes. Runtime, migrations, workflow registrations, settings-source policy, flags, scanners, exclusions and budgets are unchanged.

Six distinct new cases have bounded actual HTTP/PG evidence:

- Actual prepareLivePunch uses a persisted 17-minute tail. The inclusive cutoff and cutoff +1ms use different fresh subjects, producing different native work dates and exact stored absolute/attribution windows. Historical synthetic dates preserve the existing future-punch guard.
- Actual missed-check-in approval with no original record and no published assignment reaches prepareRelatedRecordContext's no-shift branch and stores the exact 17-minute attribution window and record projection.
- Anonymous, ordinary reader, and a real signed token claiming admin all fail settings PUT with exact 401/403 shapes. Stored settings, eight scoped durable business/audit tables and administrator-visible cached settings remain identical. Only the existing outbox's four delivery-bookkeeping fields are excluded from its business-row comparison.
- A reader with a persisted admin permission first writes successfully, then genuinely waits at the held organization prefix. Removing only that permission while membership stays active produces fresh 403, no source/business delta and unchanged cache. Restoring the permission permits the same payload. This is distinct from the existing membership-revocation proof.

## Actual phases

| Phase | Actual reporter result |
| --- | --- |
| Initial four authorization cases | 2 passed, 2 warmup-harness failures, 32 old cases filtered |
| Only two failed reader cases continued | 2 passed, 34 filtered; the earlier two green cases retained |
| First tail attempt | Suite beforeAll failed; 2 new cases pending/unexecuted, 75 old cases filtered |
| Correct text-column projection | Related-record case passed; live case refused by existing future-punch guard; 75 filtered |
| Only live case with historical fixture date | 1 passed, 76 filtered; the other five green cases retained |
| Live loader default120 fault | 1 matching failure, 76 filtered, at SETTINGS_TAIL_LIVE_NATIVE_WINDOW |
| Related no-shift loader default120 fault | 1 matching failure, 76 filtered, at SETTINGS_TAIL_RELATED_NATIVE_WINDOW |
| Fresh permission-guard bypass fault | 1 matching failure, 35 filtered, at SETTINGS_PERMISSION_FRESH_REFUSAL |

The final count is six distinct passing cases, not a sum of retries. Prior existing whole75/whole32, global settings positive/conflict, membership revocation and unit-writer receipts were not rerun. Vitest JSON calls name-filtered cases skipped; they are not passes. Three fixture failures remain raw history and give no mutation credit: GET settings requires admin, system_configs.value is text (the query needs an explicit jsonb cast), and online punch preserves its Date.now future-time guard. Only those setup/date details changed; no assertion or runtime guard was relaxed.

Validation used the existing vitest.integration.config.ts, verbose and JSON reporters, and name filters SETTINGS_AUTH_REFUSAL, SETTINGS_PERMISSION_REVOKED, SETTINGS_TAIL_LIVE and SETTINGS_TAIL_RELATED. Each fault selected only its matching new case. Database values stay outside this note. The same owned production-migrated PG16 data was retained; each terminal controller stopped only its own postmaster. No migration or install reran.

Both mutated production files were restored byte-exact: timezone runtime SHA256 bc7ecf62ee57621394126d241502b5f1c0ff4b5d7b758969e3d7faccd2e5ef13, plugin index SHA256 52ef58e2c4c6e435499fd5f3c36ea144aca742de516d8b334c020b0fd47707a3. Fault and raw-log hashes are retained with source pins.

Incremental quality: authorization AST lint baseline/current 0/0; runtime 1/1 existing diagnostic, introduced0. A targeted no-emit comparison of the two test-root files has baseline334/current334 existing diagnostics and introduced0; the original baseline was retained through candidate-only corrections, with quoted-literal union display ordering canonicalized only for comparison. This is not whole-backend typecheck-zero, typed-lint-zero or fresh validate-all.

Raw reports, all original failures, fixture-correction dispositions, exact source hashes and main-agent source/log audit are retained under artifacts/attendance-settings-native-boundaries-20261029/. No independent-review credit is claimed. Actual automatically created CI on the stacked target is recorded separately; an uncreated main/develop-only native job gets no execution credit.

## Remaining scope

These bounded cells do not attest every settings endpoint, permission provider/race, full transitive query census or whole MUT06 parent denominator. Other requester/financial/EP01 contracts, owner decisions, human browser/native/soak/performance/live-provider and production acceptance remain open. All Draft/HOLD; no merge, deployment, R71, tag/release, target migration or external-write enablement.
