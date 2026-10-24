# W6 shift reference-authoring capability fidelity — 2026-10-25

Status: current-user-authorized bounded Draft/HOLD repair, base8a426818804897a20f7674c39c56b3a445909c3a. Historical W6 ratification/owner-ledger gaps are unchanged. No flag, calculator, writer authorization, merge, deployment, R71, provider, real-UAT or business50004 work.

## Contract and deliberate disposition

Current source explicitly records that admitted orgs still receive a closed authoring hint because buildShiftCapabilities has no request-scoped posture read. The authoritative calculator's implementation constant remains false; reference admission does not make it implemented.

The only admitted-org DTO difference is segmentCalculation.multiSegmentAuthoring = 'enabled' when the canonical read port returns referenceSegments strictly true. enabled, defaultEnabled and authoritativeResults remain false; the existing flag literal, every other shift field, validation, permissions and writer decisions remain unchanged. The existing frontend preview badge remains preview-only while authoritativeResults is false. Clarify the public OpenAPI prose to distinguish reference authoring from calculation availability; no new field or enum.

Read the canonical reference posture once per response request, using its narrow query-only read seam on a genuine single-connection read-only transaction. Do not re-read env in the plugin, fabricate canonical writer markers, derive a second policy, or cache an admitted boolean across orgs. Service callback receives the real DB facade plus the same orgId used for shift data access; no HTTP selectors. The existing query-only schedule-reference port is reused; its historical timezone name does not change its declared schedule-reference contract.

For list, resolve at most once per nonempty page. Detail-not-found makes no capability read. Create/update resolve after existing pre-transaction checks and BEFORE their write transaction, so display metadata never introduces rollout-lock acquisition after a shift row lock. Close the read transaction before the writer begins. Row-dependent validation remains inside the existing locked writer transaction; do not move or duplicate it. Such a later-rejected request can perform the extra readonly hint read, but its original response and writer guards remain unchanged. The hint is a request-time read, not write authorization; existing writers independently keep their canonical checks. Delete has no shift DTO and remains untouched.

Missing port/method and unavailable hint retain the exact closed projection and response availability. A present read resolver failure downgrades only this non-authoritative display hint; it must not leak errors, introduce a response failure, bypass writer validation/authorization, or be reused as a writer decision. The readonly transaction must rollback/release on failure before returning closed. This explicit fail-closed hint disposition does not change how unrelated shift queries or writers fail.

Disabled, unknown-org and unavailable cases preserve exact JSON shape/order/bytes. No effectiveState, member IDs, secrets or arbitrary exception details enter the capability object.

## Gates

1. Original real-service DTO reproduction: admitted synthetic org still says preview_only, with closed/no-row positive controls. Product source stays baseline for red.
2. Detail/list/create/update response coverage; correct actor org, one read per page/request, no cross-request/cross-org cache, no query/body capability selector, not-found and delete unchanged.
3. Read seam uses a genuine same-client transaction and SET TRANSACTION READ ONLY before the port; real isolated PG proves zero writes, shared-lock/read same connection, missing/unknown/admitted posture cases. Missing/writer-only/throwing port remains closed; no fake writer marker or plugin env predicate.
4. Exact closed-body byte comparisons and admitted body with only one enum difference; calculator/authoritative flags remain false. Existing writer guard/validation/DML/event parameters retained; pre-transaction mode rejection before a hint read; row-dependent rejection behavior unchanged.
5. Matching mutations: ignore admitted posture, reuse another org's hint, tie authoritativeResults to admission, remove readonly guard; named assertions go red and source restores byte-for-byte. Filtered tests excluded from pass counts.
6. Public OpenAPI build/guard and local SDK generation if tracked generated prose changes; current-source quality, relevant service/HTTP/frontend neighbors, independent review and exact-head required CI.
7. Draft only. No statement of effective calculation, production readiness or whole-business completion. Remaining navigation, owner/manual and explicitly excluded gates stay separately recorded.

Kimi K3.1-pro source-only review (CLI2.3.1, no separate effort option) confirmed the semantic distinction and four visible response routes, not runtime safety. Main owns the above transaction/error/compatibility choices and their proof; review advice is not authorization or evidence of execution.

Core W4C-0 IMPLEMENTATION_CAPABILITY=true documents the resolver/storage/identity seam, not the separate W3 calculator diagnostic. Reading that constant is not authority to flip SEGMENT_CALCULATION_IMPLEMENTED or report authoritative results. Both are preserved. The genuine core database facade starts BEGIN and calls the handler on one client before any callback query; the new reader issues READ ONLY first and releases its transaction before a writer starts.

## Main-owned local evidence (2026-10-25)

| Gate | Actual result and limit |
| --- | --- |
| Baseline service reproduction | Original production: 2 named DTO red + 2 positive controls, 35 filtered exclusions. Original reporter abbreviations caused a harness postcheck failure; main accepted only the independently inspected named assertion results, without repeating the run. |
| Service and narrow reader | Full service 39/39; new readonly-reader file 14/14; zero skipped/pending. |
| Registered HTTP routes | Actual plugin.activate → Express → real service/reader: 14/14. List/detail/create/update exact bodies, one enum delta, no private metadata, unchanged DML/event args, reader completion before writer, independent reference authorization. DB and host-port doubles here are not PG evidence. |
| Real canonical HTTP and database | Fresh own UTF8 PG, 456 migrations and pending 0. Six cases exercise actual MetaSheetServer/core canonical port, four response paths, allowlisted/non-allowlisted/cross-org, authoritative/suspended/default/wildcard states and PostgreSQL readonly DML refusal. Legacy writer/deletion/reference neighbor file 45/45. No real provider IO or tenant. |
| Actual native-client trace | Separate additional case: actual HTTP capability read records READ ONLY, shared advisory lock, state SELECT and COMMIT on one positive native PostgreSQL backend PID, with no DML/DDL. 1 passed, 6 filtered exclusions. This is 7 unique PG cases across phases, not a claim that all 7 ran together on a later head. |
| Fixture failures retained | First PG attempt had 4 passed and 2 errors from illegal fixture initial-authoritative/direct-shadow→suspended SQL. Corrected only the synthetic fixture to walk legal transitions with prior_state/version increments. No SQL trigger or business guard was disabled. Full migrations were not repeated. |
| Mutations | Nonliteral reference bit: 2 named red + 1 control, 11 excluded. Wrong authoritative bit: 1 named red, 13 excluded. Calculator advertisement: 1 named red, 38 excluded. Real PG readonly removed: 1 named red, 5 excluded. Cross-org cached hint: 1 named red, 13 excluded. Every mutation restored exact candidate bytes; PG stopped, data retained. |
| CI registration | New PG suite is exact-listed in the real DB run-list, no-DB exclusion, and sorted strict corpus. W4C2 324 TAP actual passed, zero skipped; W7 full guard 13/13 with the new module under both original bans, no exemption. |
| Contracts/quality | openapi:guard actually rebuilt OpenAPI and local SDK; openapi:validate and validate:all exit 0. Parsed generated OpenAPI differs only in this capability description; existing fields, enums and routes unchanged. Generated SDK diff is one description comment. New reader/HTTP/PG test ESLint and syntax checks passed; final added trace case separately linted. |
| Independent review | Kimi CLI 2.3.1, explicit kimi-code/k3.1-pro, no separate effort option, source-only/no tools, exit 0: no concrete introduced P1/P2. Main independently inspected code and executed the above gates. Advisory review does not certify CI. |

Remote evidence is under artifacts/attendance-w6-capability-fidelity-20261025: original-red-main-audit.json, focused-service-first-state.json, focused-reader-state.json, http-pg-validation-state.json (HTTP passes before registration stop), http-pg-validation-v3-state.json, pg-shared-client-state.json, capability-mutations-state.json, cross-org-mutation-state.json, contract-quality-state.json, generated-contract-main-audit.json and k31-implementation-review-main-disposition.json. Earlier invalid attempts and all failure logs remain retained. CI exact-head terminal success remains pending publication and must not borrow any earlier PR's checks.

No frontend source changes or new public API fields, migrations, dependencies, feature flags, calculator delivery, writer authorization change, owner-ledger ratification, production/UAT/R71 or historical08am root-cause claim.
