# Expired archive object claim and lease takeover

Status: bounded local development, Draft/HOLD, runtime OFF. Original D1 D-L remains
the contract; exact-SHA owner ratification is required before D2+ merge/runtime.
This increment advances its deletion claim and legal-hold race. Full provider
reconciliation, receipt/reference release, key destruction, D-H2 and staging remain open.

## Contract

- Use an additive migration and a checked, restricted SECURITY DEFINER entrypoint.
  No runtime role/grants, caller, route, timer, provider/KMS call or activation.
- Require READ COMMITTED and repeat admission predicates. Acquire the canonical
  sheet fence, sorted keys, exact-identity generations, jobs/plans/active holds,
  object/reference rows and immutable binding before locking/mutating the intent.
- Before `ready|failed_retryable -> deleting`, require a persisted immutable store UUID and exact
  generation/object/version/ciphertext digest/size/expiry/staging/key correspondence.
  Manual pre-upload bindings may establish this authority; missing legacy binding
  refuses. Caller-supplied provider namespace never establishes authority.
- Claim CAS binds intent identity, request, operation key, state and row version;
  assign worker owner, increment fence/attempt, and derive the bounded lease from
  database time. Freeze the provider binding and preserve it across all takeovers.
  `failed_retryable` is an original-contract retry source; this increment creates
  no transition into it. Keep that distinction explicit in synthetic fixtures.
- Takeover requires `deleting`, the exact previous owner/fence/lease/row version and
  lease expiry at database time. Increment the worker fence and lease; keep the
  provider operation key and all immutable object/store bindings unchanged.
- Preserve immutable identities and old admission/hold negatives. Permit only the
  two closed claim/takeover transition shapes; deleted/receipt remain unreachable.
  PUBLIC base DML and helper/command execution remain revoked. Only a future approved
  non-owner, non-superuser role with minimal EXECUTE and no base mutation/authority
  DDL may invoke the command. Owner/superuser arbitrary DDL is outside this boundary.
- Retain every archive, attachment, object and key reference. Claim-first means late
  hold insertion refuses and rolls back its entire statement; hold-first atomically
  cancels the intent and claim writes zero. Neither test invokes a provider.

## Verification

Owned synthetic PostgreSQL only: positive claim/takeover, two workers, active lease
refusal, stale owner/fence/version/lease, missing/drifted store binding, key-first
ordering before intent, both actual blocked hold-versus-deleting orders, restricted
role direct-DML/GUC/helper denial and exact returned bindings. Unit invalid inputs,
transaction/result validation and values-free errors; whole-file CI selector and
no-DB exclusion; replay migration UNION and refusal-safe rollback. Load-bearing
lease/CAS/idempotency/binding/hold mutations must fail and source restore exactly.
Record final fresh tests, source hashes, owned process/role/database cleanup and
configured quality scope. Remote CI and actual provider crash goldens are separate.
