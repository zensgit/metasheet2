# DingTalk directory corp-scope design and verification

Status: REVIEW-READY

Date: 2026-07-25

Runtime flags: unchanged

Deployment: not performed

## 1. Problem

`directory_accounts.external_key` stores the provider value (`unionId || openId || userId`).
That value can be equal in two DingTalk enterprises. The old unique index covered only
`(provider, external_key)`, so the second enterprise's account insert aborted the whole sync
transaction.

The matching layer had a second, independent issue: openId and unionId maps were corp-scoped,
but the raw `external_key` fallback was not. Relaxing only the database index would therefore
replace a visible sync failure with a possible cross-enterprise auto-link.

## 2. Locked invariants

1. Account-key uniqueness is `(provider, corp_id, external_key)`.
2. Two NULL-corp legacy rows still treat NULL as one scope and cannot duplicate a key.
3. The stored provider value remains raw; `corp_id` is the separate scope column.
4. Raw external-key matching requires equal normalized corp scope.
5. openId and unionId matching remain corp-scoped.
6. Apply and preview use the same scoped map semantics.
7. Same-corp and both-NULL legacy matching remain supported.
8. No runtime flag, automatic sync, deprovision policy, deployment, or production data is changed.

## 3. Migration

Migration:
`zzzz20260725120000_scope_directory_account_external_key_by_corp`

`up()` creates two PostgreSQL 14-compatible partial unique indexes before dropping the legacy
index:

- `idx_directory_accounts_provider_corp_external_key` guards non-NULL corp rows on
  `(provider, corp_id, external_key)`;
- `idx_directory_accounts_provider_null_corp_external_key` guards NULL-corp legacy rows on
  `(provider, external_key)`.

Together they preserve NULL-as-one-scope behavior without relying on PostgreSQL 15
`NULLS NOT DISTINCT`. Existing data satisfying global uniqueness necessarily satisfies both
replacement indexes.

`down()` recreates the legacy global index before removing either scoped index. Once legitimate
cross-corp duplicates exist, downgrade fails loudly and leaves both scoped protections in place.
It never silently deletes or rewrites directory data.

## 4. Matching changes

The directory matching map now keys raw identities with the same corp-scoped key builder already
used by openId and unionId. The change is applied at all matching state transitions:

- initial identity-map load;
- real sync matching;
- same-batch auto-admission map updates;
- preview sentinel map updates;
- admin review recommendation conflict checks.

The last item also requires corp equality before either the generated external key or the legacy
raw fallback can match.

## 5. RED-before and verification

Before the product change, the revised real-DB suite produced three discriminating failures:

| Probe | Old result |
| --- | --- |
| Equal key inserted under two corp scopes | old global unique index rejected corp B |
| Two real syncs with equal unionId | corp B sync transaction rolled back |
| Corp-B account versus corp-A raw identity | account was linked to corp-A local user |

Positive controls stayed green: distinct keys coexisted and a same-corp raw identity linked.

After the fix:

- real-DB directory cluster: 33/33;
- related directory unit cluster: 36/36;
- full backend unit suite: 459 files, 6357/6357;
- real-DB CI wiring and values-free contracts: 82/82;
- TypeScript: `tsc --noEmit` clean;
- migration upgrade/replay, NULL-scope uniqueness, and data-incompatible downgrade protection pass;
- `git diff --check` passes.

Discriminating mutations:

1. Restoring raw unscoped matching reds both the real-sync cross-corp test and the review-helper
   cross-corp test.
2. Restoring global `(provider, external_key)` uniqueness reds the upgrade coexistence and
   downgrade-safety tests.

## 6. Deliberate non-goals

- No staging or production deployment.
- No flag enablement.
- No automatic directory sync or deprovision enablement.
- No creation of a new MetaSheet user.
- No change to the separate policy that currently prevents one local user from holding multiple
  linked DingTalk directory accounts. If UAT requires simultaneous old-corp and new-corp links for
  one local user, that policy needs an owner decision and a separate design/test slice.
- No rewrite of historical two-corp gate documents; they remain evidence of the old failure.

## 7. Post-merge UAT gate

After review, merge, and an explicitly authorized staging deployment:

1. apply the migration and verify the new index exists;
2. run one manual sync for the target integration;
3. verify the sync commits its departments and accounts without enabling schedules or deprovision;
4. bind the target account to the existing MetaSheet user through the approved admin path;
5. send a fresh approval card and verify its callback resolves within the same corp;
6. keep all unrelated runtime flags unchanged.

The code and database proof in this PR do not substitute for that staging UAT.
