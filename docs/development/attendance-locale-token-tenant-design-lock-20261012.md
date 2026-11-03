# Attendance locale verifier token tenant contract

Baseline: 2ee3531faa978ec01865c4b89423707137bd3830.
Scope: existing locale verifier authentication lifecycle only. Local development authorized by owner instruction 按建议执行, operational gate work; public publication, live acceptance and deployment remain separate decisions.

Problem: the workflow initially checks the token tenant, but the locale consumer can subsequently refresh or log in, accept inconclusive tenant proof, and adopt an unverified replacement before browser/holiday operations.

When AUTH_EXPECTED_TENANT_ID is configured, each accepted candidate and the final effective token must pass the shared strict server tenant proof. Password login must include that expected tenant. Missing/wrong tenant, unsuccessful/malformed auth response or unavailable proof cannot authorize browser/holiday actions. Successful proof must precede candidate adoption. A tenant-proof failure must propagate rather than become a permissive warning/fallback. No expected tenant retains established unbound local compatibility.

Use the existing shared verifier; avoid a new auth framework, configuration switch or backend permission change. Keep logs values-free. Existing locale contract and behavior tests remain in their current CI chains.

| Gate | Required evidence |
| --- | --- |
| Counterexample | Bound wrong/missing/malformed/unsuccessful tenant response and replacement cannot enter browser/action phase |
| Positive | Bound verified token and expected-tenant login pass; unbound local behavior preserved |
| Lifecycle | Every refresh/login replacement verified before adoption; final effective token verified before browser actions |
| Regression | Existing locale specs plus acceptance/auth neighbor suites pass on Mac mini |
| Mutation | Neutering tenant verification makes a matching regression fail; saved bytes restored |
| Independent review | Astra reviews final implementation and tests separately from Sol implementation |
| Quality | Syntax, diff check and required validation pass for a concrete local commit |

Out of scope: global directory/audit reads, global settings/RBAC provisioning, perf consumer/provenance changes, endpoint configuration, new synthetic org/account, scheduled CI enablement, branch protection, deployment and real data. Live acceptance remains HOLD until an approved disposable synthetic target/routing/account/effects contract exists. This narrow code fix alone cannot make the full shared-runtime suite synthetic-only.
