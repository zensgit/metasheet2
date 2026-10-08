# DingTalk directory corp-scope design and verification

Status: PHASE-A REVIEW-READY / PHASE-B REQUIRED

Date: 2026-07-25

Runtime flags: unchanged

Deployment: not performed

## 1. Problem

`directory_accounts.external_key` stores a provider value such as `unionId`. The same value may
appear in more than one DingTalk enterprise. The legacy database contract is globally unique on
`(provider, external_key)`, while older workers also matched raw external identities without
including the enterprise.

Relaxing the index and changing the matcher in one deployment is unsafe: a still-running old
worker can observe the newly admitted cross-corp duplicate and link it to the wrong local user.
The fix is therefore an expand/contract sequence, not one combined migration.

Independent review also found three legacy-data hazards:

1. an integration with an empty corp could be changed through the generic update path without
   atomically retagging child accounts;
2. approval-card operator resolution pinned the integration but did not verify that the linked
   account corp still matched its parent integration;
3. duplicate same-corp unionId/openId identity rows were loaded with last-row-wins semantics.

The exact-head adversarial review then found three additional runtime hazards:

4. bind/admit trusted a transaction-external account snapshot and did not prove that the account
   corp still matched its parent integration;
5. unbind could report success while leaving a legacy blank-corp identity behind;
6. the sync matcher read identities through the global pool, so a concurrent identity writer
   could change the match set between the snapshot and the link write.

## 2. Deployment lock

### Phase A: matcher and callback hardening

Phase A keeps the legacy global account-key index unchanged. It must be merged, deployed, and
present on every worker before Phase B is eligible to deploy.

Locked behavior:

1. raw external key, unionId, and openId matching use an injective normalized tuple key;
2. duplicate same-scope identities resolve as ambiguous and never auto-link;
3. apply, same-batch admission, preview, and admin-review matching share the same semantics;
4. bind, admit, and unbind lock the account and parent integration in the same transaction,
   require provider/corp agreement, and perform no identity/link/grant write before that check;
5. sync refreshes an existing account corp from its immutable parent integration;
6. the generic integration update cannot set, clear, or change corp, including an empty legacy
   value;
7. approval callbacks require a nonblank account corp equal to the pinned integration corp;
8. sync serializes the identity match snapshot with identity writers and reads it through the
   same transaction connection; a duplicate that lands later is treated as ambiguous before the
   `already_linked` short-circuit on the next sync;
9. integration corp IDs are printable, whitespace-free ASCII tokens after normalization;
10. no deployment, automatic sync, deprovision, flag, or user-creation behavior changes.

### Phase B: schema expansion

Phase B is a separate stacked PR and deployment. It may merge only after Phase A review, and it
may deploy only after Phase A is deployed and all pre-Phase-A workers have drained.

Its required contract is:

1. canonicalize/backfill child account corp from the authoritative parent integration;
2. fail closed when a child has no nonblank authoritative parent corp;
3. enforce canonical corp shape on directory accounts and external identities;
4. add corp-scoped account and unionId/openId uniqueness before removing the legacy account
   protection;
5. structurally verify every pre-existing named index rather than trusting `IF NOT EXISTS`;
6. retain protection on incompatible rollback;
7. prove upgrade, replay, compatible down, incompatible down, drifted-index refusal, and
   PostgreSQL 14 compatibility against a real database.

## 3. Phase A implementation

The in-memory scope key is `JSON.stringify([normalizedCorpId || null, normalizedProviderId])`.
Delimiter concatenation is not injective because `('a:b', 'c')` and `('a', 'b:c')` collide.

Each identity map has a corresponding ambiguity set. A second different local user claiming the
same scoped external key, unionId, or openId removes the key from the unique map and marks it
ambiguous. Resolution checks ambiguity before any match.

The sync upsert sets `corp_id = EXCLUDED.corp_id`, repairing historical child drift from the
already-immutable integration config. Generic integration editing remains fail closed; it is not
a repair transaction and cannot safely coordinate with a concurrent sync.

Bind/admit/unbind no longer authorize from the pre-read account object. Their shared write helper
locks `directory_accounts` and its parent `directory_integrations`, then requires normalized
provider and corp equality before deriving or mutating any identity. Unbind separately locks
candidate identities; a blank or different-corp candidate aborts the entire transaction rather
than unlinking while leaving stale login identity behind.

Until Phase B's database uniqueness is deployed, sync takes
`SHARE ROW EXCLUSIVE` on `user_external_identities` before loading the match maps through the same
transaction client. This makes the snapshot and link decision one serialized local apply. Phase B
remains mandatory: it prevents a later writer from creating the duplicate at all.

The approval-card callback joins the pinned `directory_integrations` row and requires:

```text
normalized(account.corp_id) is nonblank
and normalized(account.corp_id) = normalized(integration.corp_id)
```

A drifted linked account therefore resolves as unlinked and cannot approve.

## 4. Verification ledger

Phase A must retain these discriminating controls:

| Guard | Negative control | Positive control |
| --- | --- | --- |
| raw identity corp scope | corp-B account never links corp-A raw identity | same-corp raw identity links |
| injective tuple key | delimiter-containing corp/provider pair does not collide | equal normalized tuple matches |
| duplicate identity ambiguity | two local users with one same-corp unionId produce no link | one identity links |
| child corp repair | blank account corp becomes parent integration corp on sync | ordinary sync still completes |
| immutable tenant | empty/set, set/change, and set/clear generic edits reject | same-corp resend succeeds |
| callback corp pin | drifted linked account cannot act | same-corp linked account acts |
| preview scoped sentinel wiring | same-corp shared union/open/external identity pair counts once | distinct same-corp identity still counts |
| bind/unbind scope | corp-A legacy identity does not block or get deleted by corp B | same-corp lifecycle succeeds |
| authoritative bind scope | drifted account corp rejects with zero identity/link writes | same-corp bind succeeds |
| legacy unbind scope | blank/different-corp identity aborts without severing the link | same-corp identity is deleted |
| match snapshot serialization | concurrent identity writer blocks until sync's link decision commits | later duplicate is reconciled as ambiguous |
| corp token grammar | embedded ASCII/Unicode whitespace rejects | ordinary DingTalk corp token succeeds |
| admission fixture/runtime parity | authoritative account with NULL corp rolls back the admission savepoint | same-corp authoritative account admits |

Local exact-worktree verification:

- focused unit suites: 43/43;
- focused real-PostgreSQL 15 suites: 55/55;
- required attendance directory/user-org real-DB regressions: 14/14;
- required admission real-DB regressions: 9/9, including a NULL-corp rollback with zero
  `users`/link/identity residue;
- combined affected real-PostgreSQL 15 files: 86/86;
- required real-DB wiring and values-free contracts: 82/82;
- TypeScript: `tsc --noEmit` clean;
- `git diff --check` clean.

Ten discriminating mutations were killed:

1. neutering duplicate-provider-identity ambiguity changed `ambiguous` to `none`;
2. restoring delimiter concatenation made two different corp/provider tuples match;
3. removing callback account/integration corp equality let a drifted account approve;
4. removing sync-time corp refresh left the historical account corp blank;
5. reopening empty-to-set generic integration edits completed the forbidden update;
6. removing normalized corp comparison let a whitespace-drifted same-corp identity bind a second
   local user.
7. removing the in-transaction account/integration corp equality let a drifted account bind;
8. suppressing the unbind identity-scope refusal severed the link while retaining the stale
   identity;
9. replacing the identity table lock with a no-op let the concurrent writer pass before the link
   decision.
10. removing preview's three corp-scoped sentinel writes counted a same-corp duplicate DingTalk
    identity twice while preserving the distinct-account positive control.

Required CI is a separate head-scoped gate and is not claimed here until the pushed Phase A head
settles.

The worker-drain evidence required before Phase B is a separate operational gate. Its design and
verification record is
`docs/development/dingtalk-directory-worker-drain-design-and-verification-20260726.md`.

## 5. Non-goals and owner gates

- Phase A does not allow equal account keys across enterprises; Phase B owns that schema change.
- Neither phase is a staging or production deployment authorization.
- Automatic directory sync and deprovision remain disabled.
- No new MetaSheet user is created.
- The separate policy limiting one local user to one linked DingTalk account is unchanged.
- The persisted DingTalk identity external-key encoding remains compatible with existing OAuth
  rows. The in-memory wrong-match collision is fixed here; any future persisted-key version is a
  separate compatibility migration.
- Staging UAT and runtime enablement remain owner gates.

## 6. Required order

1. review and merge Phase A;
2. deploy Phase A with no flag changes;
3. build/deploy the exact Phase A SHA through the controlled-host provenance path, prove the
   managed project and fixed staging ingress each resolve to that one backend, verify no alternate
   staging upstream exists, then capture `WORKER_DRAIN_GATE_PASS` while an exclusive host change
   window is held;
4. review and merge Phase B;
5. keep that host change window exclusive and deploy Phase B in the same controlled migration
   window; if any privileged Docker/Compose mutation occurs after the PASS, discard the evidence
   and repeat step 3;
6. run the post-fix two-corp staging UAT;
7. bind only the explicitly authorized DingTalk account to the existing MetaSheet user;
8. verify a fresh approval-card callback stays within the same corp.

The Phase A code and database tests do not substitute for steps 2-8.
