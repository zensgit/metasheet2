# W21 first-event recovery: current-source joint verification

This restores the existing governed BOM line-update record projection, distinct from BOM collaboration success-event listening. Source and receiver remain default off. Other PLM object/state/delete mappings are not inferred or implemented by this slice.

Yuantus has a transactional audit/counter/four-cell outbox, immutable operator target and scoped CAS worker. MetaSheet has a fixed token/source/sheet/four-field binding, same-transaction inbox/row/revision/ledger/audit/durable event, fresh permissions and native record-lock checks. Source text fields remain database-protected after disabling; local fields remain editable under normal rights. No implicit grants or source writeback.

## Verified current-source behavior

Final rehearsal06: **33 checks passed**, 5.414seconds, exit0, cleanuptrue, **2131 runtime inputs unchanged**. The maintained driver is `scripts/rehearse_plm_record_crossstack.py` in the companion Yuantus checkout and receiver is `packages/core-backend/tests/e2e/plm-record-ingress-crossstack.mts` in MetaSheet. It creates three Yuantus authority/business databases plus a fourth MetaSheet PostgreSQL database, runs actual current migrations, ordinary token middleware and real loopback HTTP, source write_line and durable record consumer/AutomationService. Real provisioning CLI dry-run/apply is asserted before serving.

Coverage includes full-source-write rollback, large integer text, idempotent source writes, future sequence refusal/recovery, lost ACK followed by same-receipt recovery, altered-event conflict, concurrent source counters, dual-worker lease/CAS/expiry, token revoke, normal JWT refusal, live source AUTH42→RBAC900 revocation with RBAC42 decoy, and four source occurrences producing exactly four real local automation executions. The four source columns stay protected while local automation writes its own field. Only the record consumer is drained; other consumers are not claimed delivered.

## Review repairs and tests

Astra ultra identified a downgrade race: empty preflight could be followed by a concurrent committed binding and then DROP. Real PostgreSQL reproduced it (24passed/1failed). The final migration acquires all relevant business/ingress tables in one transaction with ACCESS EXCLUSIVE NOWAIT, before checking for evidence. Busy activity produces55P03 and the binding can commit and persist afterward; existing evidence refuses downgrade, idle empty downgrade still works. A first binding-only lock avoided evidence loss but permitted a lock cycle, so it was replaced by the fail-fast all-table acquisition. Final receiver PG suite: **25passed/0failed/0skipped**, owned resources cleaned.

Unexpected AutomationService record-handler errors were swallowed and ACKed. A red control failed in durable mode while legacy behavior passed; durable mode now rejects so the dispatcher retries, retaining legacy semantics. Four unit modules: **106passed**. Four native guard/census modules: **81passed**; new write/fence sites are classified with their actual permission/lock/fixed-string constraints rather than excluded. OAPI source extraction now uses TypeScript AST so multiline route middleware is verified without matching tokens inside callback bodies. Exact flag manifest: **48passed**. Full backend TypeScript passes; actionlint and diff check pass. Targeted lint has no errors and one explicit-any warning on the PostgreSQL row adapter.

Yuantus separately has196passed/1optionalPGskip in its nine-module collection; a subsequent explicit private PG run passes both producer migration variants plus the full tenant upgrade/isolation/downgrade test (3passed/0skipped). Counts overlap and are not summed. Application runtime matches all71locked Python dependencies including SQLAlchemy2.0.45; Python3.11.15, Node20.20.2, PostgreSQL15.17. Remote CI is a separate pending gate, not substituted by these local results.

## Reproduce and limits

```sh
python scripts/rehearse_plm_record_crossstack.py \
  --metasheet-root /absolute/path/to/metasheet2 \
  --node /absolute/path/to/node20 \
  --pg-bin /absolute/path/to/postgresql/bin \
  --output /absolute/path/to/new-evidence-directory
```

Use Yuantus Python3.11 with requirements.lock and installed companion Node dependencies. The output directory must not already exist. Check status/exit/cleanup and before/after input hashes; preserve failures. Fixtures contain synthetic data only. Source target CLI: `yuantus plm-record-target TARGETS.json --tenant TENANT --org ORG --apply`; scoped worker: `yuantus plm-record-worker --tenant TENANT --org ORG --once`. Receiver CLI: `node --import tsx packages/core-backend/scripts/plm-record-ingress-provision.ts BINDING.json --dry-run` (then explicit --apply). Credentials stay in deployment-owned environment variables, never binding JSON.

This is actual feature-route/migration/cross-process evidence, using a minimal MetaSheet predecessor schema, not full MetaSheet fresh-install/server lifecycle, global JWT middleware integration, customer bindings, production TLS/SSO/enterprise Webhook, native CAD or long-term acceptance. Global API allowlist behavior is separately exercised through the actual gate function and route census. Do not merge/deploy/enable from these results. Kimi last returned quota403; this turn Grok4.7(xhigh) read two wire/fixture files but did not finish a report within the bounded attempt and was interrupted/closed. Its Python U+2028/U+2029 escaping hypothesis was refuted by the actual ensure_ascii=False runtime and passing shared fixtures; it is not an accepted finding or review pass. Astra's bounded review and the parent's reproductions are the independent-review evidence.
